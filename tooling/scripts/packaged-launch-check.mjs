// The honest launch check for a PACKAGED build (CLAUDE.md, verification):
// a CDP page target has to exist and the renderer has to draw the app.
// Electron keeps a crashed main process alive behind an error dialog, and the
// error goes to the dialog, not stdout, so "process alive" and clean logs
// both lie.
//
//   node tooling/scripts/packaged-launch-check.mjs <executable> [--expect-arch x64|arm64] [-- <app args>]
//
// CI runs it on GitHub's Windows ARM64 runner (#928): no maintainer has an
// ARM64 Windows machine, so that is where the native build is proven to start
// before a release ships it. `--expect-arch` reads the machine type from a
// Windows executable's PE header, so an x64 copy cannot pass for ARM64.
//
// Both stores are isolated, and a packaged app honors the overrides only with
// ZEN_PERF=1, so the check never opens anyone's real vault.
import { execFileSync, spawn } from 'node:child_process'
import { mkdir, mkdtemp, open, rm, writeFile } from 'node:fs/promises'
import net from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const PAGE_TIMEOUT_MS = 90_000
const RENDER_TIMEOUT_MS = 60_000

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** The machine type in a Windows executable's PE header. */
async function peMachine(file) {
  const handle = await open(file, 'r')
  try {
    const dos = Buffer.alloc(0x40)
    await handle.read(dos, 0, dos.length, 0)
    if (dos.toString('latin1', 0, 2) !== 'MZ') return null
    const header = Buffer.alloc(6)
    await handle.read(header, 0, header.length, dos.readUInt32LE(0x3c))
    if (header.toString('latin1', 0, 4) !== 'PE\0\0') return null
    const machine = header.readUInt16LE(4)
    return { 0x8664: 'x64', 0xaa64: 'arm64', 0x14c: 'ia32' }[machine] ?? `0x${machine.toString(16)}`
  } finally {
    await handle.close()
  }
}

/** On a Mac, the MacBook's own screen (test windows stay off the external
 *  display); elsewhere, the primary one. Cocoa frames are bottom-left based. */
function windowState() {
  const fallback = { x: 60, y: 60, width: 1200, height: 760, isMaximized: false }
  if (process.platform !== 'darwin') return fallback
  try {
    const script = 'ObjC.import("AppKit"); const s = $.NSScreen.screens; const p = s.objectAtIndex(0).frame; let r = null; for (let i = 0; i < s.count; i++) { const sc = s.objectAtIndex(i); if (/Built-in/.test(ObjC.unwrap(sc.localizedName))) { const f = sc.frame; r = { x: f.origin.x, y: p.size.height - (f.origin.y + f.size.height) } } } JSON.stringify(r)'
    const screen = JSON.parse(execFileSync('osascript', ['-l', 'JavaScript', '-e', script], { encoding: 'utf8' }).trim())
    return screen ? { ...fallback, x: Math.round(screen.x + 40), y: Math.round(screen.y + 40) } : fallback
  } catch {
    return fallback
  }
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address()
      server.close(() => resolve(port))
    })
    server.on('error', reject)
  })
}

function connect(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url)
    let id = 0
    const pending = new Map()
    ws.addEventListener('message', (event) => {
      const message = JSON.parse(String(event.data))
      // Only answers to calls this script made: a numeric id it handed out.
      const answer = typeof message.id === 'number' ? pending.get(message.id) : undefined
      if (typeof answer !== 'function') return
      pending.delete(message.id)
      answer(message)
    })
    ws.addEventListener('open', () =>
      resolve({
        evaluate: (expression) =>
          new Promise((done) => {
            const call = ++id
            pending.set(call, (message) => done(message.result?.result?.value))
            ws.send(
              JSON.stringify({
                id: call,
                method: 'Runtime.evaluate',
                params: { expression, returnByValue: true, awaitPromise: true }
              })
            )
          }),
        close: () => ws.close()
      })
    )
    ws.addEventListener('error', () => reject(new Error(`could not connect to ${url}`)))
  })
}

async function main() {
  const separator = process.argv.indexOf('--', 2)
  const args = separator === -1 ? process.argv.slice(2) : process.argv.slice(2, separator)
  const appArgs = separator === -1 ? [] : process.argv.slice(separator + 1)
  const executable = args[0]
  const archFlag = args.indexOf('--expect-arch')
  const expectArch = archFlag === -1 ? null : args[archFlag + 1]
  if (!executable || (archFlag !== -1 && !expectArch)) {
    console.error('usage: packaged-launch-check.mjs <executable> [--expect-arch x64|arm64] [-- <app args>]')
    process.exit(2)
  }

  const result = { executable, pageTarget: false, rendered: false }
  if (expectArch) {
    result.arch = await peMachine(executable)
    if (result.arch !== expectArch) {
      console.log(JSON.stringify(result))
      console.error(`wanted an executable built for ${expectArch}; this one is ${result.arch ?? 'not a Windows executable'}`)
      process.exit(1)
    }
  }

  const root = await mkdtemp(join(tmpdir(), 'zn-launch-check-'))
  const vault = join(root, 'vault')
  const userData = join(root, 'user-data')
  const config = join(root, 'config')
  await mkdir(join(vault, 'inbox'), { recursive: true })
  await writeFile(join(vault, 'inbox', 'Hello.md'), '# Hello\n\nPackaged launch check.\n')
  await mkdir(userData, { recursive: true })
  await mkdir(config, { recursive: true })
  await writeFile(
    join(userData, 'zennotes.config.json'),
    JSON.stringify({
      workspaceMode: 'local',
      vaultRoot: vault,
      remoteWorkspace: null,
      remoteWorkspaceProfileId: null,
      remoteWorkspaceProfiles: [],
      windowState: windowState(),
      zoomFactor: 1,
      quickCaptureHotkey: ''
    })
  )

  const port = await freePort()
  const started = Date.now()
  const child = spawn(executable, [`--remote-debugging-port=${port}`, ...appArgs], {
    env: { ...process.env, ZEN_PERF: '1', ZENNOTES_USER_DATA_PATH: userData, ZENNOTES_CONFIG_DIR: config },
    stdio: 'ignore'
  })
  const exited = new Promise((resolve) => child.once('exit', resolve))
  // Electron's helper processes outlive a killed main process on Windows
  // unless the whole tree goes.
  const killTree = () => {
    try {
      if (process.platform === 'win32') execFileSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
      else child.kill('SIGKILL')
    } catch {}
  }
  process.once('exit', killTree)

  try {
    let page = null
    while (!page && Date.now() - started < PAGE_TIMEOUT_MS) {
      if (child.exitCode !== null) break
      try {
        const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
        page = targets.find((t) => t.type === 'page' && t.webSocketDebuggerUrl && t.url.includes('index.html'))
      } catch {}
      if (!page) await sleep(250)
    }
    result.pageTarget = !!page
    result.seconds = Number(((Date.now() - started) / 1000).toFixed(1))
    if (page) {
      const cdp = await connect(page.webSocketDebuggerUrl)
      // The sidebar, or the first-run setup in front of it: either way the
      // renderer loaded its bundle and drew the app.
      const drawn = `!!document.querySelector('.zn-sidebar-scroll') || [...document.querySelectorAll('button')].some((b) => b.textContent.trim() === 'Skip setup')`
      while (!result.rendered && Date.now() - started < PAGE_TIMEOUT_MS + RENDER_TIMEOUT_MS) {
        result.rendered = (await cdp.evaluate(drawn)) === true
        if (!result.rendered) await sleep(250)
      }
      result.version = await cdp.evaluate(
        `(async () => { try { return (await window.zen?.getAppInfo?.())?.version ?? null } catch { return null } })()`
      )
      cdp.close()
    }
  } finally {
    killTree()
    await Promise.race([exited, sleep(5000)])
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 }).catch(() => {})
  }

  console.log(JSON.stringify(result))
  process.exit(result.pageTarget && result.rendered ? 0 : 1)
}

await main()
