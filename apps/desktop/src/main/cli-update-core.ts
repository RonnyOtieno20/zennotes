import { execFile } from 'node:child_process'
import { createHash, createPublicKey, verify } from 'node:crypto'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import {
  compareTerminalVersions,
  installTerminalUpdate,
  readActiveTerminalRuntime,
  SUPPORTED_TERMINAL_PROTOCOLS,
} from './terminal-runtime'

/**
 * Keys whose signature makes a ZenNotes/tui release manifest installable.
 * The private half signs `terminal-release.json` in that repo's release
 * workflow (secret ZN_RELEASE_SIGNING_KEY). Rotating means shipping the new
 * public key here in a desktop release before any CLI release signs with it;
 * until then, builds that only know the old key keep their current CLI.
 */
export const RELEASE_KEYS: readonly ReleaseKey[] = [
  { id: 'zn-release-1', publicKey: 'vNI+cTgFGgg/CKam4WX6jdHisaEbiIjEf3KDjT81+uE=' },
]

export interface ReleaseKey {
  id: string
  /** Raw 32-byte Ed25519 public key, base64. */
  publicKey: string
}

export interface CliRelease {
  version: string
  protocol: number
  commit: string
  url: string
  sha256: string
}

export type CliUpdateOutcome =
  | { kind: 'not-installed' }
  | { kind: 'no-release-info' }
  | { kind: 'up-to-date'; installed: string; latest: string }
  | { kind: 'incompatible'; installed: string; latest: string; protocol: number }
  | { kind: 'available'; installed: string; latest: string }
  | { kind: 'updated'; from: string; to: string }

export interface CliUpdateDeps {
  userData: string
  platform: string
  arch: string
  manifestUrl: string
  signatureUrl: string
  keys: readonly ReleaseKey[]
  /** Resolves null for a 404, which means the release carries no manifest. */
  fetchBytes(url: string, limits: { maxBytes: number; timeoutMs: number }): Promise<Buffer | null>
  /** Returns the bytes of the archive's top-level `zn` entry. */
  extractBinary(archive: Buffer): Promise<Buffer>
}

const exec = promisify(execFile)
const MANIFEST_MAX_BYTES = 64 * 1024
const SIGNATURE_MAX_BYTES = 4 * 1024
const ARCHIVE_MAX_BYTES = 128 * 1024 * 1024
const GO_ARCH: Record<string, string> = { x64: 'amd64', arm64: 'arm64' }
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex')

/**
 * Throws unless `signatureBytes` is an Ed25519 signature, by one of `keys`,
 * over exactly `manifestBytes`. The manifest is never parsed before this
 * passes.
 */
export function verifyReleaseManifest(
  manifestBytes: Buffer,
  signatureBytes: Buffer,
  keys: readonly ReleaseKey[],
): void {
  let envelope: { keyId?: unknown; algorithm?: unknown; signature?: unknown }
  try {
    envelope = JSON.parse(signatureBytes.toString('utf8'))
  } catch {
    throw new Error('The CLI release signature is unreadable.')
  }
  if (envelope.algorithm !== 'ed25519' || typeof envelope.signature !== 'string')
    throw new Error('The CLI release signature is not an Ed25519 signature.')
  const key = keys.find((candidate) => candidate.id === envelope.keyId)
  if (!key) throw new Error('The CLI release is signed with a key this version of ZenNotes does not trust.')
  const raw = Buffer.from(key.publicKey, 'base64')
  const signature = Buffer.from(envelope.signature, 'base64')
  if (raw.length !== 32 || signature.length !== 64)
    throw new Error('The CLI release signature is malformed.')
  const publicKey = createPublicKey({
    key: Buffer.concat([ED25519_SPKI_PREFIX, raw]),
    format: 'der',
    type: 'spki',
  })
  if (!verify(null, manifestBytes, publicKey, signature))
    throw new Error('The CLI release signature does not match its manifest.')
}

/**
 * Reads a verified `terminal-release.json` (the same schema as this repo's
 * apps/desktop/terminal-release.json) down to the one artifact this machine
 * would install. The download URL must be the GitHub release asset the
 * version names, so even a signed manifest cannot point elsewhere.
 */
export function parseReleaseManifest(bytes: Buffer, platform: string, arch: string): CliRelease {
  let value: unknown
  try {
    value = JSON.parse(bytes.toString('utf8'))
  } catch {
    throw new Error('The CLI release manifest is not valid JSON.')
  }
  const fail = (): never => {
    throw new Error('The CLI release manifest is not in a format this version of ZenNotes reads.')
  }
  const root = value as { schemaVersion?: unknown; release?: Record<string, unknown> }
  if (!root || root.schemaVersion !== 1 || !root.release || typeof root.release !== 'object') fail()
  const release = root.release as Record<string, unknown>
  const { repository, protocol, version, commit, artifacts } = release
  if (repository !== 'ZenNotes/tui') fail()
  if (typeof protocol !== 'number' || !Number.isInteger(protocol) || protocol < 1) fail()
  if (typeof version !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9.+-]{0,99}$/.test(version)) fail()
  if (typeof commit !== 'string' || !/^[0-9a-f]{40}$/.test(commit)) fail()
  if (!artifacts || typeof artifacts !== 'object') fail()
  const goArch = GO_ARCH[arch]
  if ((platform !== 'darwin' && platform !== 'linux') || !goArch)
    throw new Error('ZenNotes does not manage a CLI on this platform.')
  const artifact = (artifacts as Record<string, unknown>)[`${platform}-${arch}`] as
    | { url?: unknown; sha256?: unknown }
    | undefined
  if (!artifact || typeof artifact !== 'object') fail()
  const v = version as string
  const expectedUrl = `https://github.com/ZenNotes/tui/releases/download/v${v}/zn_${v}_${platform}_${goArch}.tar.gz`
  if (artifact!.url !== expectedUrl) fail()
  if (typeof artifact!.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(artifact!.sha256)) fail()
  return {
    version: v,
    protocol: protocol as number,
    commit: commit as string,
    url: expectedUrl,
    sha256: artifact!.sha256 as string,
  }
}

/**
 * Reads the archive's top-level `zn` entry to stdout. Archive paths are never
 * extracted to disk, the same rule the packaging stager follows.
 */
export async function extractBinary(archive: Buffer): Promise<Buffer> {
  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'zennotes-cli-update-'))
  try {
    const archivePath = path.join(scratch, 'release.tar.gz')
    await fs.writeFile(archivePath, archive, { mode: 0o600 })
    const { stdout } = await exec('tar', ['-xOzf', archivePath, 'zn'], {
      encoding: 'buffer',
      maxBuffer: 256 * 1024 * 1024,
    })
    if (stdout.length === 0) throw new Error('The CLI release archive has no zn executable.')
    return stdout
  } finally {
    await fs.rm(scratch, { recursive: true, force: true })
  }
}

/**
 * One update pass: read the latest signed release, and when it is newer than
 * the managed CLI and speaks a protocol this build supports, either report it
 * (`install: false`) or download, verify and activate it. Network and
 * verification failures throw; "nothing to do" is an outcome, not an error.
 */
export async function runCliUpdate(
  deps: CliUpdateDeps,
  { install }: { install: boolean },
): Promise<CliUpdateOutcome> {
  const active = await readActiveTerminalRuntime(deps.userData)
  if (!active) return { kind: 'not-installed' }

  const manifestBytes = await deps.fetchBytes(deps.manifestUrl, {
    maxBytes: MANIFEST_MAX_BYTES,
    timeoutMs: 20_000,
  })
  if (!manifestBytes) return { kind: 'no-release-info' }
  const signatureBytes = await deps.fetchBytes(deps.signatureUrl, {
    maxBytes: SIGNATURE_MAX_BYTES,
    timeoutMs: 20_000,
  })
  if (!signatureBytes) throw new Error('The latest CLI release has a manifest but no signature.')
  verifyReleaseManifest(manifestBytes, signatureBytes, deps.keys)
  const release = parseReleaseManifest(manifestBytes, deps.platform, deps.arch)

  const order = compareTerminalVersions(release.version, active.version)
  if (order === null || order <= 0)
    return { kind: 'up-to-date', installed: active.version, latest: release.version }
  if (!SUPPORTED_TERMINAL_PROTOCOLS.includes(release.protocol))
    return {
      kind: 'incompatible',
      installed: active.version,
      latest: release.version,
      protocol: release.protocol,
    }
  if (!install) return { kind: 'available', installed: active.version, latest: release.version }

  const archive = await deps.fetchBytes(release.url, {
    maxBytes: ARCHIVE_MAX_BYTES,
    timeoutMs: 5 * 60_000,
  })
  if (!archive) throw new Error(`The zn ${release.version} download is missing from its release.`)
  if (createHash('sha256').update(archive).digest('hex') !== release.sha256)
    throw new Error(`The zn ${release.version} download does not match its signed checksum.`)
  const bytes = await deps.extractBinary(archive)
  const updated = await installTerminalUpdate({
    userData: deps.userData,
    bytes,
    version: release.version,
    protocol: release.protocol,
    platform: deps.platform,
    arch: deps.arch,
  })
  return { kind: 'updated', from: active.version, to: updated.version }
}
