import { execFileSync } from 'node:child_process'
import { accessSync, constants as fsConstants } from 'node:fs'
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  probeNvmInstall,
  resetLoginShellResolutionForTests,
  resolveCommandViaLoginShell,
  resolveLoginShellPathDirs,
  setLoginShellTimeoutForTests
} from './login-shell-path'

const onPosix = process.platform !== 'win32'

function shellExists(shellPath: string): boolean {
  try {
    accessSync(shellPath, fsConstants.X_OK)
    return true
  } catch {
    return false
  }
}

// The interactive-shell test needs a real zsh or bash to source rc files.
const interactiveShell = ['/bin/zsh', '/bin/bash'].find(shellExists) ?? null

async function makeExecutable(filePath: string, body = '#!/bin/sh\nexit 0\n'): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true })
  await writeFile(filePath, body)
  await chmod(filePath, 0o755)
}

describe('resolveCommandViaLoginShell', () => {
  // The core of issue #73: GUI apps inherit a minimal PATH, so a bare command
  // name can't be resolved. A login shell sources the user's profile and
  // returns an absolute path. `sh` is guaranteed present on POSIX systems.
  it.skipIf(!onPosix)('resolves a ubiquitous command to an absolute path', async () => {
    const resolved = await resolveCommandViaLoginShell('sh')
    expect(resolved).toBeTruthy()
    expect(path.isAbsolute(resolved as string)).toBe(true)
    expect(path.basename(resolved as string)).toBe('sh')
  })

  it('returns null for a command that does not exist', async () => {
    expect(await resolveCommandViaLoginShell('zen-not-a-real-binary-9f3a2b')).toBeNull()
  })

  it('rejects unsafe command names without spawning a shell', async () => {
    expect(await resolveCommandViaLoginShell('rg; rm -rf /')).toBeNull()
    expect(await resolveCommandViaLoginShell('$(touch /tmp/zen-pwned)')).toBeNull()
    expect(await resolveCommandViaLoginShell('rg fzf')).toBeNull()
    expect(await resolveCommandViaLoginShell('')).toBeNull()
  })
})

describe('rc-file-only PATH entries (#634)', () => {
  const savedEnv: Record<string, string | undefined> = {}
  let tempHome: string | null = null

  afterEach(async () => {
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    resetLoginShellResolutionForTests()
    if (tempHome) await rm(tempHome, { recursive: true, force: true })
    tempHome = null
  })

  function overrideEnv(overrides: Record<string, string | undefined>): void {
    for (const [key, value] of Object.entries(overrides)) {
      if (!(key in savedEnv)) savedEnv[key] = process.env[key]
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }

  // The reported shape: node is only on PATH because ~/.zshrc (an
  // interactive-only file for zsh) prepends nvm's bin directory. A plain
  // login shell never reads it; the interactive pass must. The rc files also
  // print a banner to prove marker parsing survives rc noise.
  it.skipIf(!onPosix || !interactiveShell)(
    'finds a command whose PATH entry only exists in interactive rc files',
    async () => {
      tempHome = await mkdtemp(path.join(os.tmpdir(), 'zen-login-shell-'))
      const binDir = path.join(tempHome, 'rc-managed', 'bin')
      const tool = 'zen-rc-only-tool'
      await makeExecutable(path.join(binDir, tool))

      const pathLine = `export PATH="${binDir}:$PATH"`
      await writeFile(path.join(tempHome, '.zshrc'), `echo "welcome banner"\n${pathLine}\n`)
      await writeFile(path.join(tempHome, '.bashrc'), `echo "welcome banner"\n${pathLine}\n`)
      await writeFile(path.join(tempHome, '.bash_profile'), `. "$HOME/.bashrc"\n`)

      // A ZDOTDIR exported by the host shell would redirect zsh to the real
      // config instead of the temp HOME's rc files.
      overrideEnv({ HOME: tempHome, SHELL: interactiveShell as string, ZDOTDIR: undefined })
      resetLoginShellResolutionForTests()

      expect(await resolveCommandViaLoginShell(tool)).toBe(path.join(binDir, tool))
    }
  )
})

// Julie (Discord, 2026-10-09) launched ZenNotes from a terminal; opening
// Settings > CLI spawned interactive shells that took her terminal and never
// exited, and the page sat on "Checking install status..." for good.
describe('shells started from a terminal', () => {
  const savedEnv: Record<string, string | undefined> = {}
  let tempDir: string | null = null
  const marker = (dirs: string): string => `printf '\\n__ZENNOTES_LOGIN_SHELL__%s' "${dirs}"`

  afterEach(async () => {
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    resetLoginShellResolutionForTests()
    if (tempDir) await rm(tempDir, { recursive: true, force: true })
    tempDir = null
  })

  function overrideEnv(overrides: Record<string, string>): void {
    for (const [key, value] of Object.entries(overrides)) {
      if (!(key in savedEnv)) savedEnv[key] = process.env[key]
      process.env[key] = value
    }
  }

  // A killed process lingers as a zombie until its parent reaps it; that
  // counts as gone.
  function running(pid: number): boolean {
    try {
      return !execFileSync('ps', ['-o', 'stat=', '-p', String(pid)], { encoding: 'utf8' }).trim().startsWith('Z')
    } catch {
      return false
    }
  }

  async function gone(pid: number): Promise<boolean> {
    for (let i = 0; i < 40; i++) {
      if (!running(pid)) return true
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    return false
  }

  // Stands in for an interactive shell stuck on an rc prompt: it ignores
  // SIGTERM, as interactive shells do, and never prints the marker.
  it.skipIf(!onPosix)('gives up on a shell that ignores SIGTERM and leaves none of it running', async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), 'zen-stuck-shell-'))
    const pids = path.join(tempDir, 'pids')
    const stuck = path.join(tempDir, 'stuck-shell')
    await makeExecutable(stuck, `#!/bin/sh\ntrap '' TERM\necho $$ > "${pids}"\nsleep 30 &\necho $! >> "${pids}"\nwait\n`)
    overrideEnv({ SHELL: stuck, HOME: tempDir })
    resetLoginShellResolutionForTests()
    setLoginShellTimeoutForTests(1000)

    const started = Date.now()
    const dirs = await resolveLoginShellPathDirs()
    // The standard shells tried after it still answer.
    expect(dirs.length).toBeGreaterThan(0)
    expect(Date.now() - started).toBeLessThan(4000)
    const [shellPid, sleepPid] = (await readFile(pids, 'utf8')).trim().split('\n').map(Number)
    expect(await gone(shellPid)).toBe(true)
    expect(await gone(sleepPid)).toBe(true)
  })

  it.skipIf(!onPosix)('runs the shell in a session of its own, without a terminal', async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), 'zen-tty-shell-'))
    const report = path.join(tempDir, 'report')
    const shell = path.join(tempDir, 'tty-shell')
    await makeExecutable(
      shell,
      `#!/bin/sh\nif (exec 3</dev/tty) 2>/dev/null; then tty=open; else tty=none; fi\necho "$tty $$ $(ps -o pgid= -p $$)" > "${report}"\n${marker('/usr/bin:/bin')}\n`
    )
    overrideEnv({ SHELL: shell, HOME: tempDir })
    resetLoginShellResolutionForTests()

    expect(await resolveLoginShellPathDirs()).toEqual(['/usr/bin', '/bin'])
    const [tty, pid, group] = (await readFile(report, 'utf8')).trim().split(/\s+/)
    // /dev/tty only tells the probes apart when the tests run in a terminal.
    // The new session also makes the shell lead its own process group, which
    // shows anywhere and is what lets a timeout kill the whole group.
    expect(group).toBe(pid)
    expect(tty).toBe('none')
  })

  it.skipIf(!onPosix)('shares one shell between callers that ask at the same time', async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), 'zen-shared-shell-'))
    const runs = path.join(tempDir, 'runs')
    const shell = path.join(tempDir, 'counting-shell')
    await makeExecutable(shell, `#!/bin/sh\necho run >> "${runs}"\nsleep 0.3\n${marker('/usr/bin:/bin')}\n`)
    overrideEnv({ SHELL: shell, HOME: tempDir })
    resetLoginShellResolutionForTests()

    const [dirs, sh, ls] = await Promise.all([
      resolveLoginShellPathDirs(),
      resolveCommandViaLoginShell('sh'),
      resolveCommandViaLoginShell('ls')
    ])
    expect(dirs).toEqual(['/usr/bin', '/bin'])
    expect(sh).toBeTruthy()
    expect(ls).toBeTruthy()
    expect((await readFile(runs, 'utf8')).trim().split('\n')).toHaveLength(1)
  })
})

describe('probeNvmInstall', () => {
  const savedNvmDir = process.env.NVM_DIR
  let nvmDir: string | null = null

  afterEach(async () => {
    if (savedNvmDir === undefined) delete process.env.NVM_DIR
    else process.env.NVM_DIR = savedNvmDir
    resetLoginShellResolutionForTests()
    if (nvmDir) await rm(nvmDir, { recursive: true, force: true })
    nvmDir = null
  })

  async function seedNvm(versions: string[], defaultAlias?: string): Promise<void> {
    nvmDir = await mkdtemp(path.join(os.tmpdir(), 'zen-nvm-'))
    for (const version of versions) {
      await makeExecutable(path.join(nvmDir, 'versions', 'node', version, 'bin', 'node'))
      await makeExecutable(path.join(nvmDir, 'versions', 'node', version, 'bin', 'npm'))
    }
    if (defaultAlias) {
      await mkdir(path.join(nvmDir, 'alias'), { recursive: true })
      await writeFile(path.join(nvmDir, 'alias', 'default'), `${defaultAlias}\n`)
    }
    process.env.NVM_DIR = nvmDir
  }

  it.skipIf(!onPosix)('prefers the default alias when it names a concrete version', async () => {
    await seedNvm(['v22.14.0', 'v24.1.0'], 'v22.14.0')
    expect(await probeNvmInstall('node')).toBe(
      path.join(nvmDir as string, 'versions', 'node', 'v22.14.0', 'bin', 'node')
    )
  })

  it.skipIf(!onPosix)('falls back to the newest install without a concrete default', async () => {
    await seedNvm(['v22.14.0', 'v24.1.0'], 'lts/*')
    expect(await probeNvmInstall('npm')).toBe(
      path.join(nvmDir as string, 'versions', 'node', 'v24.1.0', 'bin', 'npm')
    )
  })

  it.skipIf(!onPosix)('only answers for the node toolchain', async () => {
    await seedNvm(['v24.1.0'])
    expect(await probeNvmInstall('rg')).toBeNull()
  })
})
