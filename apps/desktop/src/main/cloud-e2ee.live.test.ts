/**
 * End-to-end encryption against a running ZenNotes Cloud service, with two
 * desktop "devices" driven through the real sync service, client and crypto.
 * Skipped unless ZEN_E2EE_LIVE_BASE_URL (a local website with CLOUD_E2EE on)
 * and ZEN_E2EE_LIVE_TOKENS (a JSON file of device tokens A and B) are set.
 * ZEN_E2EE_LIVE_DB and ZEN_E2EE_LIVE_MINIO, when set, let it check that no
 * readable marker ever reached the database or object storage.
 */
import { execFileSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { readdirSync, readFileSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { gunzipSync } from 'node:zlib'
import { afterAll, describe, expect, it } from 'vitest'
import type { CloudAccountKeyStore, StoredCloudAccountKey } from '@zennotes/shared-domain/cloud-e2ee-account'
import { createCloudSyncClient } from './cloud-sync-client'
import { DesktopCloudSyncService } from './cloud-sync-service'

const BASE_URL = process.env.ZEN_E2EE_LIVE_BASE_URL
const TOKENS = process.env.ZEN_E2EE_LIVE_TOKENS
const DB = process.env.ZEN_E2EE_LIVE_DB
const MINIO = process.env.ZEN_E2EE_LIVE_MINIO
const PASSPHRASE = 'harbor quiet lantern orbit 42'
const NOTE_MARKER = 'MARKER-ALPHA-7f3e'
const NAME_MARKER = 'SecretPlans9c2b'
const BIG_MARKER = 'BIGFILE-MARKER-41d8'

const scratch: string[] = []
afterAll(async () => {
  await Promise.all(scratch.map((directory) => rm(directory, { recursive: true, force: true })))
})

async function tempDir(label: string): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), `zen-e2ee-live-${label}-`))
  scratch.push(directory)
  return directory
}

function memoryKeyStore(): CloudAccountKeyStore & { value: StoredCloudAccountKey | null } {
  return {
    value: null,
    async load() {
      return this.value
    },
    async save(value) {
      this.value = { ...value }
    },
    async clear() {
      this.value = null
    }
  }
}

async function device(label: 'A' | 'B') {
  const tokens = JSON.parse(await readFile(TOKENS!, 'utf8')) as Record<string, string>
  const keyStore = memoryKeyStore()
  const service = new DesktopCloudSyncService({
    storageDirectory: await tempDir(`state-${label}`),
    accountStatus: async () => ({
      state: 'connected',
      account: {
        base_url: BASE_URL!,
        user: { name: 'E2EE Test', email: 'e2ee@example.test' },
        device: { id: `device-${label}`, name: `Device ${label}`, platform: 'desktop' },
        connected_at: new Date().toISOString()
      }
    }),
    getSecret: async () => tokens[label]!,
    createClient: (baseUrl, token, options) => createCloudSyncClient(baseUrl, token, fetch, options),
    accountKeyStore: () => keyStore
  })
  return { service, keyStore }
}

function filesUnder(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true, recursive: true })
    .filter((entry) => entry.isFile())
    .map((entry) => path.join(entry.parentPath, entry.name))
}

/** Every readable marker found in the service's database files or stored objects. */
async function serverLeaks(markers: string[]): Promise<string[]> {
  const found: string[] = []
  const scan = (label: string, bytes: Buffer) => {
    for (const marker of markers) if (bytes.includes(marker)) found.push(`${label}: ${marker}`)
  }
  if (DB) {
    for (const file of [DB, `${DB}-wal`, `${DB}-journal`]) {
      try {
        scan(path.basename(file), readFileSync(file))
      } catch {
        // That journal file does not exist in this mode.
      }
    }
  }
  if (MINIO) {
    // The MinIO image has no grep: copy its data out and scan it here.
    const copy = await tempDir('minio')
    execFileSync('docker', ['cp', `${MINIO}:/data/.`, copy])
    const files = filesUnder(copy)
    expect(files.length).toBeGreaterThan(0)
    for (const file of files) scan(`object ${path.relative(copy, file)}`, readFileSync(file))
  }
  return found
}

function sql(query: string): string {
  return execFileSync('sqlite3', [DB!, query]).toString().trim()
}

describe.skipIf(!BASE_URL || !TOKENS)('end-to-end encryption against a live service', () => {
  it('sets up, syncs two devices, renames, edits, backs up, migrates, and locks without leaking plaintext', async () => {
    const a = await device('A')
    const b = await device('B')

    // Setup on A; nothing reaches the service until the words are confirmed.
    expect(await a.service.encryptionStatus()).toEqual({ available: true, keyset: false, unlocked: false })
    const setup = await a.service.prepareEncryptionSetup(PASSPHRASE)
    expect(setup.recoveryWords).toHaveLength(24)
    expect((await a.service.encryptionStatus()).keyset).toBe(false)
    await a.service.finishEncryptionSetup(setup.setupId)
    expect(await a.service.encryptionStatus()).toEqual({ available: true, keyset: true, unlocked: true })

    // An encrypted vault with a note, a nested note, a mid-size attachment
    // (downloaded by reference) and a 6 MB file (uploaded directly).
    const rootA = await tempDir('vault-A')
    await mkdir(path.join(rootA, 'Journal', '2026'), { recursive: true })
    await mkdir(path.join(rootA, 'attachements'), { recursive: true })
    await writeFile(path.join(rootA, `${NAME_MARKER}.md`), `# Plans\n\n${NOTE_MARKER} meet at noon.\n`)
    await writeFile(path.join(rootA, 'Journal', '2026', 'Plan.md'), `# Plan\n\n${NOTE_MARKER} second note.\n`)
    await writeFile(path.join(rootA, 'attachements', 'photo.png'), randomBytes(300_000))
    const big = Buffer.from(`${BIG_MARKER}\n`.repeat(Math.ceil(6_200_000 / (BIG_MARKER.length + 1))))
    await writeFile(path.join(rootA, 'attachements', 'big.txt'), big)

    const link = await a.service.createAndLink(rootA, 'Private journal', { encrypted: true })
    const first = await a.service.sync(rootA)
    expect(first.conflicts).toEqual([])
    expect(first.pushed).toBeGreaterThanOrEqual(4)

    if (DB) {
      const rows = sql(`select path || '|' || (meta is not null) || '|' || coalesce(content_encoding, '') from vault_items where vault_id = '${link.vault_id}' and deleted_at is null`).split('\n')
      expect(rows.length).toBeGreaterThanOrEqual(4)
      for (const row of rows) expect(row).toMatch(/^[0-9a-f]{64}\|1\|aes-gcm$/)
      expect(sql(`select name from vaults where id = '${link.vault_id}'`)).toBe('Encrypted vault')
    }
    expect(await serverLeaks([NOTE_MARKER, NAME_MARKER, BIG_MARKER, 'Private journal', 'Journal/2026'])).toEqual([])

    // B unlocks with the passphrase, sees the real name, and pulls every file intact.
    await expect(b.service.unlockEncryption({ passphrase: 'not the passphrase at all' })).rejects.toThrow(/does not unlock/)
    await b.service.unlockEncryption({ passphrase: PASSPHRASE })
    const listed = await b.service.listVaults()
    expect(listed.find((vault) => vault.id === link.vault_id)?.name).toBe('Private journal')
    const rootB = await tempDir('vault-B')
    await b.service.link(rootB, link.vault_id)
    await b.service.sync(rootB)
    for (const file of [`${NAME_MARKER}.md`, 'Journal/2026/Plan.md', 'attachements/photo.png', 'attachements/big.txt']) {
      expect((await readFile(path.join(rootB, file))).equals(await readFile(path.join(rootA, file)))).toBe(true)
    }

    // A rename on A reaches B; an edit on B reaches A.
    await mkdir(path.join(rootA, 'Archive'), { recursive: true })
    await rename(path.join(rootA, `${NAME_MARKER}.md`), path.join(rootA, 'Archive', `${NAME_MARKER}.md`))
    await a.service.sync(rootA)
    await b.service.sync(rootB)
    expect(await readFile(path.join(rootB, 'Archive', `${NAME_MARKER}.md`), 'utf8')).toContain(NOTE_MARKER)
    await writeFile(path.join(rootB, 'Journal', '2026', 'Plan.md'), `# Plan\n\n${NOTE_MARKER} edited on B.\n`)
    await b.service.sync(rootB)
    await a.service.sync(rootA)
    expect(await readFile(path.join(rootA, 'Journal', '2026', 'Plan.md'), 'utf8')).toContain('edited on B')

    // Backups: unlabeled, searchable by real names here, downloadable readable.
    const backup = await a.service.createBackup(rootA, `${NAME_MARKER} label`)
    expect(backup.label).toBeNull()
    const found = await a.service.listBackupItemsPage(rootA, backup.id, { search: 'plan' })
    expect(found.items.map((item) => item.path).sort()).toEqual([`Archive/${NAME_MARKER}.md`, 'Journal/2026/Plan.md'])
    const archive = path.join(await tempDir('archive'), 'backup.json.gz')
    await a.service.downloadBackup(rootA, backup.id, archive)
    const readable = JSON.parse(gunzipSync(await readFile(archive)).toString('utf8')) as { items: Array<{ path: string; content: { data: string } }> }
    expect(readable.items.map((item) => item.path).sort()).toEqual(
      [`Archive/${NAME_MARKER}.md`, 'Journal/2026/Plan.md', 'attachements/big.txt', 'attachements/photo.png'].sort()
    )
    expect(readable.items.find((item) => item.path === 'Journal/2026/Plan.md')?.content.data).toContain('edited on B')
    expect(await serverLeaks([NOTE_MARKER, NAME_MARKER, BIG_MARKER])).toEqual([])

    // Moving a readable vault: A encrypts it, B's link to the old vault is told.
    const rootC = await tempDir('vault-C')
    await writeFile(path.join(rootC, 'Readable.md'), '# Readable\n\nmoving soon\n')
    const readableLink = await a.service.createAndLink(rootC, 'Old notes')
    await a.service.sync(rootC)
    const rootD = await tempDir('vault-D')
    await b.service.link(rootD, readableLink.vault_id)
    await b.service.sync(rootD)
    const moved = await a.service.encryptLinkedVault(rootC)
    expect(moved.vault_id).not.toBe(readableLink.vault_id)
    expect(moved.replaces_vault_id).toBeUndefined()
    expect((await a.service.listVaults()).some((vault) => vault.id === readableLink.vault_id)).toBe(false)
    await expect(b.service.sync(rootD)).rejects.toThrow(/now end-to-end encrypted/)

    // Locked devices stop; the recovery words unlock again.
    await a.service.lockEncryption()
    await expect(a.service.sync(rootA)).rejects.toThrow(/Unlock encryption on this device/)
    await a.service.unlockEncryption({ recoveryWords: setup.recoveryWords.join(' ') })
    const afterUnlock = await a.service.sync(rootA)
    expect(afterUnlock.conflicts).toEqual([])
  }, 600_000)
})
