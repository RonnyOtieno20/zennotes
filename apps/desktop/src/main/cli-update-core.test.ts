import { execFile } from 'node:child_process'
import { createHash, generateKeyPairSync, sign } from 'node:crypto'
import { mkdir, mkdtemp, readFile, readdir, readlink, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'
import {
  extractBinary,
  parseReleaseManifest,
  runCliUpdate,
  verifyReleaseManifest,
  type CliUpdateDeps,
  type ReleaseKey,
} from './cli-update-core'
import { compareTerminalVersions, prepareTerminalRuntime } from './terminal-runtime'

const exec = promisify(execFile)
const roots: string[] = []
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

// The manifest and parsing tests run everywhere, Windows CI included, so they
// name a platform ZenNotes manages a CLI on; the install tests that execute a
// real `zn` are skipped on Windows and use this machine's own.
const platform = process.platform === 'win32' ? 'linux' : process.platform
const arch = process.arch === 'arm64' ? 'arm64' : 'x64'
const goArch = arch === 'x64' ? 'amd64' : arch
const commit = 'a'.repeat(40)

function keyPair(id = 'test-key'): { key: ReleaseKey; signer: (bytes: Buffer) => Buffer } {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519')
  const raw = Buffer.from(publicKey.export({ format: 'jwk' }).x as string, 'base64url')
  return {
    key: { id, publicKey: raw.toString('base64') },
    signer: (bytes) =>
      Buffer.from(
        JSON.stringify(
          { keyId: id, algorithm: 'ed25519', signature: sign(null, bytes, privateKey).toString('base64') },
          null,
          2,
        ) + '\n',
      ),
  }
}

const releaseUrl = (version: string) =>
  `https://github.com/ZenNotes/tui/releases/download/v${version}/zn_${version}_${platform}_${goArch}.tar.gz`

function manifest(version: string, sha256: string, protocol = 1, url = releaseUrl(version)): Buffer {
  return Buffer.from(
    JSON.stringify(
      {
        schemaVersion: 1,
        release: {
          repository: 'ZenNotes/tui',
          protocol,
          version,
          commit,
          artifacts: { [`${platform}-${arch}`]: { url, sha256 } },
        },
      },
      null,
      2,
    ) + '\n',
  )
}

function fakeZn(version: string, protocol = 1): string {
  return `#!/bin/sh\nif [ "$1" = --desktop-integration ]; then\n  echo '{"protocol":${protocol},"version":"${version}"}'\n  exit\nfi\necho "zn ${version}"\n`
}

async function archiveWith(root: string, script: string): Promise<Buffer> {
  const dir = await mkdtemp(path.join(root, 'archive-'))
  await writeFile(path.join(dir, 'zn'), script, { mode: 0o755 })
  await writeFile(path.join(dir, 'LICENSE'), 'MIT\n')
  const out = path.join(root, `release-${path.basename(dir)}.tar.gz`)
  await exec('tar', ['-czf', out, '-C', dir, 'zn', 'LICENSE'])
  return await readFile(out)
}

/** A managed runtime staged from a bundle, as the app does at startup. */
async function managedRuntime(bundleVersion = '1.0.0') {
  const root = await mkdtemp(path.join(os.tmpdir(), "zn update ' "))
  roots.push(root)
  const bundleDir = path.join(root, 'resources', 'zn-cli')
  await mkdir(bundleDir, { recursive: true })
  await writeBundle(bundleDir, bundleVersion)
  const legacy = path.join(root, 'legacy')
  await writeFile(legacy, '#!/bin/sh\necho legacy\n', { mode: 0o755 })
  const options = {
    bundleDir,
    userData: path.join(root, 'user data'),
    platform,
    arch,
    legacyCommand: [legacy],
  }
  return { root, options }
}

async function writeBundle(bundleDir: string, version: string): Promise<void> {
  await writeFile(path.join(bundleDir, 'zn'), fakeZn(version), { mode: 0o755 })
  await writeFile(
    path.join(bundleDir, 'manifest.json'),
    JSON.stringify({ schemaVersion: 1, protocol: 1, version, platform, arch }),
  )
}

function deps(
  userData: string,
  key: ReleaseKey,
  files: Record<string, Buffer | null>,
  fetched: string[] = [],
): CliUpdateDeps {
  return {
    userData,
    platform,
    arch,
    manifestUrl: 'https://example.test/terminal-release.json',
    signatureUrl: 'https://example.test/terminal-release.json.sig',
    keys: [key],
    fetchBytes: async (url) => {
      fetched.push(url)
      if (!(url in files)) throw new Error(`unexpected fetch ${url}`)
      return files[url] ?? null
    },
    extractBinary,
  }
}

const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex')
const currentTarget = (userData: string) =>
  readlink(path.join(userData, 'cli', 'terminal', 'current'))

describe('compareTerminalVersions', () => {
  it('orders by semver precedence and refuses what it cannot read', () => {
    expect(compareTerminalVersions('0.6.2', '0.6.1')).toBe(1)
    expect(compareTerminalVersions('0.10.0', '0.9.9')).toBe(1)
    expect(compareTerminalVersions('1.0.0', '1.0.0')).toBe(0)
    expect(compareTerminalVersions('1.0.0-rc.1', '1.0.0')).toBe(-1)
    expect(compareTerminalVersions('1.0.0-rc.10', '1.0.0-rc.2')).toBe(1)
    expect(compareTerminalVersions('1.0.0-alpha', '1.0.0-beta')).toBe(-1)
    expect(compareTerminalVersions('1.0.0-alpha', '1.0.0-alpha.1')).toBe(-1)
    expect(compareTerminalVersions('1.0.0+build.5', '1.0.0')).toBe(0)
    expect(compareTerminalVersions('dev', '1.0.0')).toBeNull()
    expect(compareTerminalVersions('1.0', '1.0.0')).toBeNull()
  })
})

describe('verifyReleaseManifest', () => {
  const { key, signer } = keyPair()
  const bytes = manifest('1.1.0', 'b'.repeat(64))

  it('accepts a signature by a trusted key over the exact bytes', () => {
    expect(() => verifyReleaseManifest(bytes, signer(bytes), [key])).not.toThrow()
  })

  it('rejects a manifest changed after signing', () => {
    const tampered = Buffer.from(bytes.toString().replace('1.1.0', '1.1.1'))
    expect(() => verifyReleaseManifest(tampered, signer(bytes), [key])).toThrow(/does not match/)
  })

  it('rejects a key it does not know, even with a valid signature', () => {
    const other = keyPair('other-key')
    expect(() => verifyReleaseManifest(bytes, other.signer(bytes), [key])).toThrow(/does not trust/)
  })

  it('rejects a signature from another key under a trusted id', () => {
    const impostor = keyPair('test-key')
    expect(() => verifyReleaseManifest(bytes, impostor.signer(bytes), [key])).toThrow(/does not match/)
  })

  it('rejects other algorithms and malformed envelopes', () => {
    const envelope = JSON.parse(signer(bytes).toString())
    const rsa = Buffer.from(JSON.stringify({ ...envelope, algorithm: 'rsa' }))
    expect(() => verifyReleaseManifest(bytes, rsa, [key])).toThrow(/Ed25519/)
    expect(() => verifyReleaseManifest(bytes, Buffer.from('nope'), [key])).toThrow(/unreadable/)
    const short = Buffer.from(JSON.stringify({ ...envelope, signature: 'AAAA' }))
    expect(() => verifyReleaseManifest(bytes, short, [key])).toThrow(/malformed/)
  })
})

describe('parseReleaseManifest', () => {
  it('reads this machine’s artifact', () => {
    const release = parseReleaseManifest(manifest('1.1.0', 'b'.repeat(64)), platform, arch)
    expect(release).toEqual({
      version: '1.1.0',
      protocol: 1,
      commit,
      url: releaseUrl('1.1.0'),
      sha256: 'b'.repeat(64),
    })
  })

  it('refuses a download URL other than the release asset its version names', () => {
    const elsewhere = manifest('1.1.0', 'b'.repeat(64), 1, 'https://example.com/zn.tar.gz')
    expect(() => parseReleaseManifest(elsewhere, platform, arch)).toThrow(/format/)
    const otherVersion = manifest('1.1.0', 'b'.repeat(64), 1, releaseUrl('1.0.9'))
    expect(() => parseReleaseManifest(otherVersion, platform, arch)).toThrow(/format/)
  })

  it('refuses malformed checksums, schemas and platforms', () => {
    expect(() => parseReleaseManifest(manifest('1.1.0', 'XYZ'), platform, arch)).toThrow(/format/)
    expect(() => parseReleaseManifest(Buffer.from('{"schemaVersion":2}'), platform, arch)).toThrow(/format/)
    expect(() => parseReleaseManifest(manifest('1.1.0', 'b'.repeat(64)), 'win32', 'x64')).toThrow(/platform/)
  })
})

describe.skipIf(process.platform === 'win32')('runCliUpdate', () => {
  it('reports nothing to update before ZenNotes has staged its own zn', async () => {
    const { options } = await managedRuntime()
    const { key } = keyPair()
    expect(await runCliUpdate(deps(options.userData, key, {}), { install: true })).toEqual({
      kind: 'not-installed',
    })
  })

  it('treats a release without a manifest as nothing to do', async () => {
    const { options } = await managedRuntime()
    await prepareTerminalRuntime(options)
    const { key } = keyPair()
    const files = { 'https://example.test/terminal-release.json': null }
    expect(await runCliUpdate(deps(options.userData, key, files), { install: true })).toEqual({
      kind: 'no-release-info',
    })
  })

  it('downloads nothing when the release is not newer, or speaks another protocol, or install is off', async () => {
    const { options } = await managedRuntime('1.0.0')
    await prepareTerminalRuntime(options)
    const { key, signer } = keyPair()
    const run = async (bytes: Buffer, install: boolean) => {
      const fetched: string[] = []
      const files = {
        'https://example.test/terminal-release.json': bytes,
        'https://example.test/terminal-release.json.sig': signer(bytes),
      }
      const outcome = await runCliUpdate(deps(options.userData, key, files, fetched), { install })
      return { outcome, fetched }
    }
    const same = await run(manifest('1.0.0', 'b'.repeat(64)), true)
    expect(same.outcome).toEqual({ kind: 'up-to-date', installed: '1.0.0', latest: '1.0.0' })
    const older = await run(manifest('0.9.0', 'b'.repeat(64)), true)
    expect(older.outcome.kind).toBe('up-to-date')
    const protocol2 = await run(manifest('2.0.0', 'b'.repeat(64), 2), true)
    expect(protocol2.outcome).toEqual({ kind: 'incompatible', installed: '1.0.0', latest: '2.0.0', protocol: 2 })
    const reportOnly = await run(manifest('1.1.0', 'b'.repeat(64)), false)
    expect(reportOnly.outcome).toEqual({ kind: 'available', installed: '1.0.0', latest: '1.1.0' })
    for (const { fetched } of [same, older, protocol2, reportOnly])
      expect(fetched.some((url) => url.endsWith('.tar.gz'))).toBe(false)
  })

  it('installs a newer signed release, keeps it over an older bundle, and yields to a newer one', async () => {
    const { root, options } = await managedRuntime('1.0.0')
    const bundled = await prepareTerminalRuntime(options)
    const bundledTarget = await currentTarget(options.userData)
    const { key, signer } = keyPair()
    const archive = await archiveWith(root, fakeZn('1.1.0'))
    const bytes = manifest('1.1.0', sha(archive))
    const files = {
      'https://example.test/terminal-release.json': bytes,
      'https://example.test/terminal-release.json.sig': signer(bytes),
      [releaseUrl('1.1.0')]: archive,
    }
    expect(await runCliUpdate(deps(options.userData, key, files), { install: true })).toEqual({
      kind: 'updated',
      from: '1.0.0',
      to: '1.1.0',
    })
    // The command on PATH runs the new release through the same launcher.
    const { stdout } = await exec(bundled!.launcherPath, ['--version'])
    expect(stdout).toBe('zn 1.1.0\n')
    const installed = JSON.parse(
      await readFile(path.join(options.userData, 'cli', 'terminal', 'current', 'installed.json'), 'utf8'),
    )
    expect(installed).toMatchObject({ version: '1.1.0', protocol: 1, installedFrom: 'update' })

    // Next launch: the older bundle is a floor, not a reset.
    const relaunch = await prepareTerminalRuntime(options)
    expect(relaunch?.version).toBe('1.1.0')
    const versions = await readdir(path.join(options.userData, 'cli', 'terminal', 'versions'))
    expect(versions.sort()).toEqual([path.basename(bundledTarget), path.basename(await currentTarget(options.userData))].sort())

    // A ZenNotes update that bundles something newer takes over again.
    await writeBundle(options.bundleDir, '1.2.0')
    const upgraded = await prepareTerminalRuntime(options)
    expect(upgraded?.version).toBe('1.2.0')
    expect((await exec(bundled!.launcherPath, ['--version'])).stdout).toBe('zn 1.2.0\n')
  })

  it('leaves the active zn alone when a download fails its checks', async () => {
    const { root, options } = await managedRuntime('1.0.0')
    const bundled = await prepareTerminalRuntime(options)
    const before = await currentTarget(options.userData)
    const { key, signer } = keyPair()
    const attempt = async (archive: Buffer, declaredSha: string, signature?: Buffer | null) => {
      const bytes = manifest('1.1.0', declaredSha)
      const files = {
        'https://example.test/terminal-release.json': bytes,
        'https://example.test/terminal-release.json.sig': signature === undefined ? signer(bytes) : signature,
        [releaseUrl('1.1.0')]: archive,
      }
      return runCliUpdate(deps(options.userData, key, files), { install: true })
    }
    const good = await archiveWith(root, fakeZn('1.1.0'))
    await expect(attempt(good, 'c'.repeat(64))).rejects.toThrow(/signed checksum/)
    await expect(attempt(good, sha(good), null)).rejects.toThrow(/no signature/)
    const unsigned = keyPair('test-key')
    await expect(
      attempt(good, sha(good), unsigned.signer(manifest('1.1.0', sha(good)))),
    ).rejects.toThrow(/does not match/)
    const lies = await archiveWith(root, fakeZn('1.0.5'))
    await expect(attempt(lies, sha(lies))).rejects.toThrow(/integration version/)
    const broken = await archiveWith(root, '#!/bin/sh\nexit 3\n')
    await expect(attempt(broken, sha(broken))).rejects.toThrow(/integration probe/)

    expect(await currentTarget(options.userData)).toBe(before)
    expect((await exec(bundled!.launcherPath, ['--version'])).stdout).toBe('zn 1.0.0\n')
    expect(await readdir(path.join(options.userData, 'cli', 'terminal', 'versions'))).toEqual([
      path.basename(before),
    ])
  })
})
