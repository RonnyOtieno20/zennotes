import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { gunzipSync, gzipSync } from 'node:zlib'
import { afterEach, describe, expect, it } from 'vitest'
import { createHash, randomBytes } from 'node:crypto'
import type { CloudSyncContent } from '@zennotes/bridge-contract/cloud-sync'
import { generateCloudE2eeKey } from '@zennotes/shared-domain/cloud-e2ee'
import { CloudVaultCipher } from '@zennotes/shared-domain/cloud-e2ee-vault'
import { rewriteBackupArchive } from './cloud-backup-archive'

const directories: string[] = []
afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

async function scratch(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'zennotes-archive-'))
  directories.push(directory)
  return directory
}

function plain(bytes: Uint8Array, encoding: 'utf8' | 'base64', mediaType: string): CloudSyncContent {
  return {
    encoding,
    data: encoding === 'utf8' ? Buffer.from(bytes).toString('utf8') : Buffer.from(bytes).toString('base64'),
    sha256: createHash('sha256').update(bytes).digest('hex'),
    byte_length: bytes.byteLength,
    media_type: mediaType
  }
}

describe('rewriteBackupArchive', () => {
  it('turns an encrypted vault archive into a readable one, item by item', async () => {
    const accountKey = generateCloudE2eeKey()
    const encryption = await CloudVaultCipher.prepareVault('Private', accountKey, 1)
    const cipher = await CloudVaultCipher.open({ id: 'vault-enc', encryption }, accountKey, 1)
    const files = [
      { path: 'Notes/Caf\u00e9 "plans".md', kind: 'text' as const, content: plain(Buffer.from('# Plans\n\nBring {braces} and [brackets] and "quotes"\\.\n'), 'utf8', 'text/markdown') },
      { path: 'attachements/photo.png', kind: 'binary' as const, content: plain(randomBytes(200_000), 'base64', 'image/png') },
      { path: 'Empty.md', kind: 'text' as const, content: plain(Buffer.alloc(0), 'utf8', 'text/markdown') }
    ]
    const sealedItems = []
    for (const [index, file] of files.entries()) {
      const { pathId, meta } = await cipher.sealMeta(file.path, file.kind, file.content)
      sealedItems.push({
        item_id: `item-${index}`,
        path: pathId,
        kind: 'binary',
        revision: index + 1,
        meta,
        content: await cipher.sealContent(file.content)
      })
    }
    const header = { format_version: 1, snapshot_id: 'snap-1', vault_id: 'vault-enc', cursor: 9, created_at: '2026-10-12T00:00:00+00:00' }
    const archiveText = `${JSON.stringify(header).slice(0, -1)},"items":[${sealedItems.map((item) => JSON.stringify(item)).join(',')}]}`
    const directory = await scratch()
    const source = path.join(directory, 'sealed.json.gz')
    const target = path.join(directory, 'readable.json.gz')
    // Small gzip blocks force items to straddle chunk boundaries.
    await writeFile(source, gzipSync(Buffer.from(archiveText), { chunkSize: 1024 }))

    const result = await rewriteBackupArchive(source, target, (item) => cipher.openArchiveItem(item as never))
    expect(result.items).toBe(3)
    const readable = JSON.parse(gunzipSync(await readFile(target)).toString('utf8'))
    expect(readable).toMatchObject(header)
    expect(readable.items.map((item: { path: string }) => item.path)).toEqual(files.map((file) => file.path))
    for (const [index, file] of files.entries()) {
      expect(readable.items[index]).toEqual({ item_id: `item-${index}`, path: file.path, kind: file.kind, revision: index + 1, content: file.content })
    }
  })

  it('refuses an archive that is not the service format, without writing a readable copy', async () => {
    const directory = await scratch()
    const source = path.join(directory, 'odd.json.gz')
    const target = path.join(directory, 'out.json.gz')
    await writeFile(source, gzipSync(Buffer.from('{"format_version":1,"other":[1,2],"items":[]}')))
    await expect(rewriteBackupArchive(source, target, async (item) => item)).rejects.toThrow(/could not read this backup archive/)
    await writeFile(source, gzipSync(Buffer.from('{"format_version":1,"items":[{"a":1}')))
    await expect(rewriteBackupArchive(source, `${target}2`, async (item) => item)).rejects.toThrow(/could not read this backup archive/)
  })
})
