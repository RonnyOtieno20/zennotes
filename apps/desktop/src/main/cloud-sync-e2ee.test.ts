import { createHash, randomBytes } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { CloudSyncContentReference, CloudSyncUpsertMutation } from '@zennotes/bridge-contract/cloud-sync'
import { generateCloudE2eeKey, zne1CiphertextLength } from '@zennotes/shared-domain/cloud-e2ee'
import { CloudE2eeLockedError, CloudVaultCipher } from '@zennotes/shared-domain/cloud-e2ee-vault'
import { createCloudSyncClient } from './cloud-sync-client'
import { stageDesktopCloudContent } from './cloud-sync-download'
import { rememberCloudSyncUploadSource } from './cloud-sync-upload-source'
import { cloudSyncStagedHandle, releaseCloudSyncStagedFile } from '@zennotes/shared-domain/cloud-sync-content'

const INLINE_LIMIT = 5 * 1024 * 1024
const temporaryDirectories: string[] = []

afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

async function encryptedVault() {
  const accountKey = generateCloudE2eeKey()
  const encryption = await CloudVaultCipher.prepareVault('Private', accountKey, 1)
  const cipher = await CloudVaultCipher.open({ id: 'vault-enc', encryption }, accountKey, 1)
  return { cipher, source: { forVault: async (id: string) => (id === 'vault-enc' ? cipher : null) } }
}

async function fileMutation(bytes: Buffer, fileName = 'attachements/film.mov'): Promise<{ mutation: CloudSyncUpsertMutation; sourcePath: string }> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'zennotes-e2ee-source-'))
  temporaryDirectories.push(directory)
  const sourcePath = path.join(directory, path.basename(fileName))
  await writeFile(sourcePath, bytes)
  const mutation: CloudSyncUpsertMutation = {
    type: 'upsert',
    operation_id: 'op-1',
    item_id: 'item-1',
    base_revision: null,
    path: fileName,
    kind: 'binary',
    content: {
      encoding: 'base64',
      data: '',
      sha256: createHash('sha256').update(bytes).digest('hex'),
      byte_length: bytes.byteLength,
      media_type: 'video/quicktime'
    }
  }
  rememberCloudSyncUploadSource(mutation.content, sourcePath)
  return { mutation, sourcePath }
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

async function collect(stream: AsyncIterable<Uint8Array>): Promise<Buffer> {
  const chunks: Uint8Array[] = []
  for await (const chunk of stream) chunks.push(chunk)
  return Buffer.concat(chunks)
}

describe('desktop end-to-end encryption paths', () => {
  it('streams a large file to object storage only as ciphertext, under a path id and sealed metadata', async () => {
    const { cipher, source } = await encryptedVault()
    const bytes = randomBytes(8_100_000)
    const { mutation } = await fileMutation(bytes)
    const sealedLength = zne1CiphertextLength(bytes.byteLength)
    let initiation: Record<string, unknown> | undefined
    let putBody: Buffer | undefined
    let putLength: string | null = null
    const fetchImplementation = vi.fn<typeof fetch>(async (input, options) => {
      const url = String(input)
      if (url.endsWith('/uploads')) {
        initiation = JSON.parse(String(options?.body))
        expect(new Headers(options?.headers).get('X-ZenNotes-Encryption')).toBe('zne1')
        return jsonResponse({
          data: {
            id: 'upload-1',
            operation_id: mutation.operation_id,
            status: 'uploading',
            expected_bytes: sealedLength,
            expires_at: '2099-01-01T00:00:00.000Z',
            upload: { method: 'PUT', url: 'https://objects.example.test/upload-1', headers: {} }
          }
        }, 201)
      }
      if (url.startsWith('https://objects.example.test/')) {
        putLength = new Headers(options?.headers).get('content-length')
        putBody = await collect(options?.body as AsyncIterable<Uint8Array>)
        return new Response(null, { status: 200 })
      }
      if (url.endsWith('/complete')) {
        return jsonResponse({
          data: {
            id: 'upload-1',
            operation_id: mutation.operation_id,
            status: 'completed',
            result: { acknowledged: [{ operation_id: 'op-1', item_id: 'item-1', revision: 1, sequence: 1 }], conflicts: [], cursor: 1 }
          }
        })
      }
      throw new Error(`Unexpected request: ${url}`)
    })
    const client = createCloudSyncClient('https://zennotes.test', 'token', fetchImplementation, {
      endToEndEncryption: true,
      vaultCiphers: source
    })
    const response = await client.mutate('vault-enc', { mutations: [mutation] })
    expect(response.acknowledged).toHaveLength(1)

    expect(initiation).toMatchObject({ kind: 'binary', content: { encoding: 'aes-gcm', byte_length: sealedLength, media_type: 'application/octet-stream' } })
    expect(String(initiation?.path)).toMatch(/^[0-9a-f]{64}$/)
    expect(String(initiation?.path)).toBe(await cipher.pathId('attachements/film.mov'))
    expect(typeof initiation?.meta).toBe('string')
    expect(JSON.stringify(initiation)).not.toContain('film')
    expect(JSON.stringify(initiation)).not.toContain(mutation.content.sha256)
    expect(putLength).toBe(String(sealedLength))
    expect(putBody?.byteLength).toBe(sealedLength)
    expect((initiation?.content as { sha256: string }).sha256).toBe(createHash('sha256').update(putBody!).digest('hex'))
    expect(putBody!.includes(bytes.subarray(0, 64))).toBe(false)
    expect((await collect(cipher.decryptStream([putBody!]))).equals(bytes)).toBe(true)
    // The sealed temp copy is gone once the upload finished.
    expect((await readdir(os.tmpdir())).some((name) => name.startsWith('zennotes-upload-') && existsSync(path.join(os.tmpdir(), name, 'sealed')))).toBe(false)
  }, 60_000)

  it('sends a 5 MiB file directly once encryption pushes it past the inline cap', async () => {
    const { source } = await encryptedVault()
    const bytes = randomBytes(INLINE_LIMIT)
    const { mutation } = await fileMutation(bytes)
    const requested: string[] = []
    const fetchImplementation = vi.fn<typeof fetch>(async (input) => {
      requested.push(String(input))
      throw new Error('stop here')
    })
    const client = createCloudSyncClient('https://zennotes.test', 'token', fetchImplementation, {
      endToEndEncryption: true,
      vaultCiphers: source
    })
    await expect(client.mutate('vault-enc', { mutations: [mutation] })).rejects.toThrow('stop here')
    expect(requested).toEqual(['https://zennotes.test/api/v1/vaults/vault-enc/uploads'])
  }, 60_000)

  it('refuses a file that changed after sync hashed it, before anything is sent', async () => {
    const { source } = await encryptedVault()
    const { mutation, sourcePath } = await fileMutation(randomBytes(INLINE_LIMIT + 10))
    await writeFile(sourcePath, randomBytes(INLINE_LIMIT + 10))
    const fetchImplementation = vi.fn<typeof fetch>()
    const client = createCloudSyncClient('https://zennotes.test', 'token', fetchImplementation, {
      endToEndEncryption: true,
      vaultCiphers: source
    })
    await expect(client.mutate('vault-enc', { mutations: [mutation] })).rejects.toMatchObject({ code: 'DIRECT_UPLOAD_SIZE_MISMATCH' })
    expect(fetchImplementation).not.toHaveBeenCalled()
  }, 60_000)

  it('stops before any request when the vault is locked on this device', async () => {
    const { mutation } = await fileMutation(randomBytes(100))
    const fetchImplementation = vi.fn<typeof fetch>()
    const client = createCloudSyncClient('https://zennotes.test', 'token', fetchImplementation, {
      endToEndEncryption: true,
      vaultCiphers: { forVault: async () => { throw new CloudE2eeLockedError() } }
    })
    await expect(client.mutate('vault-enc', { mutations: [mutation] })).rejects.toBeInstanceOf(CloudE2eeLockedError)
    expect(fetchImplementation).not.toHaveBeenCalled()
  })

  it('decrypts a large download into staging and refuses one that was changed', async () => {
    const { cipher } = await encryptedVault()
    const plaintext = randomBytes(300_000)
    const sealed = await collect(cipher.encryptStream([plaintext]))
    const reference: CloudSyncContentReference = {
      item_id: 'item-1',
      revision: 2,
      encoding: 'base64',
      sha256: createHash('sha256').update(plaintext).digest('hex'),
      byte_length: plaintext.byteLength,
      media_type: 'image/png',
      encrypted: { sha256: createHash('sha256').update(sealed).digest('hex'), byte_length: sealed.byteLength }
    }
    const stagingDirectory = await mkdtemp(path.join(os.tmpdir(), 'zennotes-e2ee-staging-'))
    temporaryDirectories.push(stagingDirectory)
    const instruction = {
      item_id: 'item-1',
      revision: 2,
      content: { encoding: 'aes-gcm' as const, sha256: reference.encrypted!.sha256, byte_length: sealed.byteLength, media_type: 'application/octet-stream' },
      download: { method: 'GET' as const, url: 'https://objects.example.test/item-1', headers: {}, expires_at: '2099-01-01T00:00:00.000Z' }
    }
    const serve = (body: Buffer) => vi.fn<typeof fetch>(async () =>
      new Response(body, { status: 200, headers: { 'Content-Length': String(body.byteLength) } })
    )
    const owner = {}
    const staged = await stageDesktopCloudContent(
      { reference, getInstruction: async () => instruction, previewLimitBytes: 0, decryptor: cipher },
      owner,
      { fetchImplementation: serve(sealed), stagingDirectory }
    )
    const handle = cloudSyncStagedHandle<{ path: string }>(staged, reference)
    expect((await readFile(handle.path)).equals(plaintext)).toBe(true)
    await releaseCloudSyncStagedFile(staged)

    const tampered = Buffer.from(sealed)
    tampered[tampered.byteLength - 20] ^= 0x01
    await expect(stageDesktopCloudContent(
      { reference, getInstruction: async () => instruction, previewLimitBytes: 0, decryptor: cipher },
      owner,
      { fetchImplementation: serve(tampered), stagingDirectory }
    )).rejects.toThrow()
    expect(await readdir(stagingDirectory)).toEqual([])

    await expect(stageDesktopCloudContent(
      { reference, getInstruction: async () => instruction, previewLimitBytes: 0 },
      owner,
      { fetchImplementation: serve(sealed), stagingDirectory }
    )).rejects.toThrow(/no key/)
  }, 60_000)
})
