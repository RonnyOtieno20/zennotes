import { constants, promises as fs } from 'node:fs'
import type { FileHandle } from 'node:fs/promises'
import { createHash, randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import path from 'node:path'

const exec = promisify(execFile)
const LAUNCHER_MARKER = '# ZenNotes managed terminal launcher v1'
export interface TerminalRuntime {
  launcherPath: string
  binaryPath: string
  version: string
  sha256: string
}
export interface TerminalRuntimeOptions {
  bundleDir: string
  userData: string
  platform: string
  arch: string
  legacyCommand: string[]
  appPath?: string
}
interface Manifest {
  schemaVersion: number
  protocol: number
  version: string
  platform: string
  arch: string
}
/**
 * Integration protocols this build speaks. A CLI on any other protocol stays
 * out until a ZenNotes release that speaks it, whoever offers it.
 */
export const SUPPORTED_TERMINAL_PROTOCOLS: readonly number[] = [1]

const VERSION_PATTERN = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/

/**
 * Orders two CLI versions by semver precedence (build metadata ignored).
 * Null when either is not a version this can order, so an unorderable pair
 * never replaces anything.
 */
export function compareTerminalVersions(a: string, b: string): number | null {
  const left = VERSION_PATTERN.exec(a)
  const right = VERSION_PATTERN.exec(b)
  if (!left || !right) return null
  for (let part = 1; part <= 3; part++) {
    const diff = Number(left[part]) - Number(right[part])
    if (diff !== 0) return Math.sign(diff)
  }
  const leftPre = left[4]
  const rightPre = right[4]
  if (leftPre === rightPre) return 0
  if (leftPre === undefined) return 1
  if (rightPre === undefined) return -1
  const leftIds = leftPre.split('.')
  const rightIds = rightPre.split('.')
  for (let index = 0; index < Math.max(leftIds.length, rightIds.length); index++) {
    const l = leftIds[index]
    const r = rightIds[index]
    if (l === undefined) return -1
    if (r === undefined) return 1
    if (l === r) continue
    const lNum = /^\d+$/.test(l)
    const rNum = /^\d+$/.test(r)
    if (lNum && rNum) return Math.sign(Number(l) - Number(r))
    if (lNum) return -1
    if (rNum) return 1
    return l < r ? -1 : 1
  }
  return 0
}

const pending = new Map<string, Promise<TerminalRuntime | null>>()
const locks = new Map<string, Promise<unknown>>()
const digest = (data: Buffer): string =>
  createHash('sha256').update(data).digest('hex')

/**
 * Bundle staging and downloaded updates both move `current`; one at a time
 * per userData, or an update could land between a stage's checks and its
 * swap.
 */
function withRuntimeLock<T>(userData: string, run: () => Promise<T>): Promise<T> {
  const previous = locks.get(userData) ?? Promise.resolve()
  const next = previous.catch(() => {}).then(run)
  const settled = next.catch(() => {})
  locks.set(userData, settled)
  void settled.then(() => {
    if (locks.get(userData) === settled) locks.delete(userData)
  })
  return next
}
const quote = (value: string): string => `'${value.replace(/'/g, `'\\''`)}'`

async function atomicWrite(
  target: string,
  content: string,
  mode = 0o600,
): Promise<void> {
  const temporary = `${target}.${randomUUID()}.tmp`
  try {
    await fs.writeFile(temporary, content, { mode, flag: 'wx' })
    await fs.rename(temporary, target)
  } finally {
    await fs.rm(temporary, { force: true })
  }
}

function launcher(options: TerminalRuntimeOptions, current: string): string {
  return [
    '#!/bin/sh',
    LAUNCHER_MARKER,
    'case "${ZENNOTES_CLI_ENGINE:-go}" in',
    `  legacy) ELECTRON_RUN_AS_NODE=1 exec ${options.legacyCommand.map(quote).join(' ')} "$@" ;;`,
    '  go) ;;',
    '  *) echo "zn: ZENNOTES_CLI_ENGINE must be go or legacy." >&2; exit 2 ;;',
    'esac',
    ': "${ZENNOTES_WORKSPACE_SOURCE:=app}"',
    'export ZENNOTES_WORKSPACE_SOURCE',
    ...(options.appPath
      ? [
          `if [ -z "\${ZENNOTES_APP_PATH:-}" ]; then ZENNOTES_APP_PATH=${quote(options.appPath)}; export ZENNOTES_APP_PATH; fi`,
        ]
      : []),
    `exec ${quote(path.join(current, 'zn'))} "$@"`,
    '',
  ].join('\n')
}

/** A failed stage never replaces the active runtime or retries a command. */
export function prepareTerminalRuntime(
  options: TerminalRuntimeOptions,
): Promise<TerminalRuntime | null> {
  const key = `${options.bundleDir}\0${options.userData}`
  const existing = pending.get(key)
  if (existing) return existing
  const operation = withRuntimeLock(options.userData, () => prepare(options)).finally(() => {
    pending.delete(key)
  })
  pending.set(key, operation)
  return operation
}

async function prepare(
  options: TerminalRuntimeOptions,
): Promise<TerminalRuntime | null> {
  let manifest: Manifest
  try {
    manifest = JSON.parse(
      await fs.readFile(path.join(options.bundleDir, 'manifest.json'), 'utf8'),
    )
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT') return null
    // A package that installs the bundle without read access for this user
    // (#869) is not a broken manifest; say what is wrong and how to fix it.
    if (code === 'EACCES' || code === 'EPERM') {
      throw new Error(
        `The bundled terminal at ${options.bundleDir} cannot be read (permission denied). Make that folder readable (chmod 755) or reinstall ZenNotes.`,
        { cause: error },
      )
    }
    throw new Error('The bundled terminal manifest is invalid.', {
      cause: error,
    })
  }
  if (
    manifest.schemaVersion !== 1 ||
    !SUPPORTED_TERMINAL_PROTOCOLS.includes(manifest.protocol) ||
    typeof manifest.version !== 'string' ||
    !/^[a-zA-Z0-9][a-zA-Z0-9.+-]{0,99}$/.test(manifest.version)
  ) {
    throw new Error('The bundled terminal integration manifest is unsupported.')
  }
  if (
    manifest.platform !== options.platform ||
    manifest.arch !== options.arch ||
    !['darwin', 'linux'].includes(options.platform) ||
    !['x64', 'arm64'].includes(options.arch)
  ) {
    throw new Error(
      'The bundled terminal platform or architecture does not match this app.',
    )
  }
  const base = path.join(options.userData, 'cli')
  const runtimeRoot = path.join(base, 'terminal')
  const versions = path.join(runtimeRoot, 'versions')
  const current = path.join(runtimeRoot, 'current')
  const launcherPath = path.join(base, 'zn')
  await fs.mkdir(versions, { recursive: true, mode: 0o700 })
  await readManagedLauncher(launcherPath)
  try {
    if (!(await fs.lstat(current)).isSymbolicLink())
      throw new Error('The active terminal path is not a managed link.')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }

  // Signing can change upstream bytes. Compare with this bundle's executable;
  // the release archive checksum is verified before packaging.
  const bytes = await fs.readFile(path.join(options.bundleDir, 'zn'))
  const sha256 = digest(bytes)
  try {
    const installed = JSON.parse(
      await fs.readFile(path.join(current, 'installed.json'), 'utf8'),
    )
    if (
      installed.sha256 === sha256 &&
      installed.version === manifest.version &&
      digest(await fs.readFile(path.join(current, 'zn'))) === sha256 &&
      ((await fs.stat(path.join(current, 'zn'))).mode & 0o111) !== 0
    ) {
      await atomicWrite(launcherPath, launcher(options, current), 0o755)
      return {
        launcherPath,
        binaryPath: path.join(current, 'zn'),
        version: manifest.version,
        sha256,
      }
    }
  } catch {
    /* Missing or damaged copy is replaced through a fresh stage. */
  }

  // The bundle is the floor this build guarantees, not the only version it
  // allows: a newer CLI that installTerminalUpdate verified and activated
  // stays. Only an intact copy on a protocol this build speaks counts, and a
  // tie goes to the bundle, whose copy carries this build's signature.
  const active = await readActiveTerminalRuntime(options.userData)
  if (active && (compareTerminalVersions(active.version, manifest.version) ?? 0) > 0) {
    await atomicWrite(launcherPath, launcher(options, current), 0o755)
    return active
  }

  const binaryPath = await stageAndActivate({
    runtimeRoot,
    bytes,
    sha256,
    installed: manifest,
    beforeActivate: () => atomicWrite(launcherPath, launcher(options, current), 0o755),
  })
  return { launcherPath, binaryPath, version: manifest.version, sha256 }
}

/**
 * Writes a verified copy of `bytes` as a new version, proves it answers the
 * integration probe with the expected protocol and version, then swaps
 * `current` to it in one rename. Anything that fails before the swap leaves
 * the active version untouched. Afterwards only the new version and the one
 * it replaced stay on disk, the latter so a bad release can be rolled back by
 * hand; a running `zn` keeps its open file either way.
 */
async function stageAndActivate({
  runtimeRoot,
  bytes,
  sha256,
  installed,
  beforeActivate,
}: {
  runtimeRoot: string
  bytes: Buffer
  sha256: string
  installed: Manifest & { installedFrom?: 'update' }
  beforeActivate?: () => Promise<void>
}): Promise<string> {
  const versions = path.join(runtimeRoot, 'versions')
  const current = path.join(runtimeRoot, 'current')
  const previous = await fs
    .readlink(current)
    .then((target) => path.resolve(runtimeRoot, target))
    .catch(() => null)
  const stage = await fs.mkdtemp(path.join(versions, `${installed.version}-`))
  const binaryPath = path.join(stage, 'zn')
  let activated = false
  const next = path.join(runtimeRoot, `current.${randomUUID()}.tmp`)
  try {
    await fs.writeFile(binaryPath, bytes, { mode: 0o755, flag: 'wx' })
    if (digest(await fs.readFile(binaryPath)) !== sha256)
      throw new Error('Terminal copy verification failed.')
    let integration: { protocol?: number; version?: string }
    try {
      const result = await exec(binaryPath, ['--desktop-integration'], {
        timeout: 10000,
        maxBuffer: 65536,
      })
      integration = JSON.parse(result.stdout)
    } catch (error) {
      throw new Error('Terminal integration probe failed.', { cause: error })
    }
    if (
      integration.protocol !== installed.protocol ||
      integration.version !== installed.version
    ) {
      throw new Error(
        `Terminal integration version does not match ${installed.installedFrom === 'update' ? 'the release manifest' : 'the bundled manifest'}.`,
      )
    }
    await atomicWrite(
      path.join(stage, 'installed.json'),
      JSON.stringify({ ...installed, sha256 }) + '\n',
    )
    await beforeActivate?.()
    await fs.symlink(path.relative(runtimeRoot, stage), next)
    await fs.rename(next, current)
    activated = true
  } finally {
    await fs.rm(next, { force: true })
    if (!activated) await fs.rm(stage, { recursive: true, force: true })
  }
  const keep = new Set([stage, previous].filter((dir): dir is string => dir !== null))
  for (const entry of await fs.readdir(versions).catch(() => [] as string[])) {
    const dir = path.join(versions, entry)
    if (!keep.has(dir)) await fs.rm(dir, { recursive: true, force: true }).catch(() => {})
  }
  return binaryPath
}

/**
 * Activates a CLI release that cli-update.ts downloaded and verified against
 * its signed manifest. It only ever moves forward: there must be a managed
 * runtime already (the bundle staged at startup), and the release must be
 * newer than it and speak a protocol this build supports.
 */
export function installTerminalUpdate(options: {
  userData: string
  bytes: Buffer
  version: string
  protocol: number
  platform: string
  arch: string
}): Promise<TerminalRuntime> {
  return withRuntimeLock(options.userData, async () => {
    if (!SUPPORTED_TERMINAL_PROTOCOLS.includes(options.protocol))
      throw new Error(`This version of ZenNotes cannot run zn ${options.version}.`)
    const active = await readActiveTerminalRuntime(options.userData)
    if (!active) throw new Error('There is no managed zn to update yet.')
    if ((compareTerminalVersions(options.version, active.version) ?? 0) <= 0)
      throw new Error(`zn ${active.version} is already as new as ${options.version}.`)
    const sha256 = digest(options.bytes)
    const binaryPath = await stageAndActivate({
      runtimeRoot: path.join(options.userData, 'cli', 'terminal'),
      bytes: options.bytes,
      sha256,
      installed: {
        schemaVersion: 1,
        protocol: options.protocol,
        version: options.version,
        platform: options.platform,
        arch: options.arch,
        installedFrom: 'update',
      },
    })
    return { launcherPath: active.launcherPath, binaryPath, version: options.version, sha256 }
  })
}

/**
 * Reads a launcher this app may replace. One handle, opened without following
 * links, serves both the type check and the content check, so nothing can be
 * swapped in between: the result is a regular file carrying our marker, or
 * null when there is no launcher at all. Anything else is refused.
 */
async function readManagedLauncher(launcherPath: string): Promise<string | null> {
  const refuse = () =>
    new Error(`${launcherPath} is not a managed ZenNotes launcher.`)
  let handle: FileHandle
  try {
    handle = await fs.open(launcherPath, constants.O_RDONLY | constants.O_NOFOLLOW)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT') return null
    if (code === 'ELOOP') throw refuse()
    throw error
  }
  try {
    if (!(await handle.stat()).isFile()) throw refuse()
    const content = await handle.readFile('utf8')
    if (!content.startsWith(`#!/bin/sh\n${LAUNCHER_MARKER}\n`)) throw refuse()
    return content
  } finally {
    await handle.close()
  }
}

/** Retain a verified installed version when a new bundle cannot be activated. */
export async function readActiveTerminalRuntime(
  userData: string,
): Promise<TerminalRuntime | null> {
  const launcherPath = path.join(userData, 'cli', 'zn')
  const current = path.join(userData, 'cli', 'terminal', 'current')
  const binaryPath = path.join(current, 'zn')
  try {
    const installed = JSON.parse(
      await fs.readFile(path.join(current, 'installed.json'), 'utf8'),
    )
    // The mode check and the digest come from one open handle, so the bytes
    // that are hashed are the bytes whose mode was checked.
    const binary = await fs.open(binaryPath, 'r')
    let executable = false
    let bytes: Buffer
    try {
      executable = Boolean((await binary.stat()).mode & 0o111)
      bytes = await binary.readFile()
    } finally {
      await binary.close()
    }
    if (
      !SUPPORTED_TERMINAL_PROTOCOLS.includes(installed.protocol) ||
      typeof installed.version !== 'string' ||
      !executable ||
      digest(bytes) !== installed.sha256 ||
      (await readManagedLauncher(launcherPath)) === null
    )
      return null
    return {
      launcherPath,
      binaryPath,
      version: installed.version,
      sha256: installed.sha256,
    }
  } catch {
    return null
  }
}
