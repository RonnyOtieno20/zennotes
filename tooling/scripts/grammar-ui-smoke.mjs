#!/usr/bin/env node
// Real Electron capture using the same CDP workflow as vim-editor-smoke.mjs.
// No live service or user profile: a loopback LanguageTool fixture and zztest note only.
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdir, mkdtemp, writeFile, rm } from 'node:fs/promises'
import http from 'node:http'
import net from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import WebSocket from 'ws'
import { testWindowState } from './test-window-state.mjs'
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const requireDesktop = createRequire(join(repoRoot, 'apps/desktop/package.json'))
const sleep = (ms) => new Promise((done) => setTimeout(done, ms))
const stage = process.argv[2] ?? 'after'
if (!['before', 'after'].includes(stage)) throw new Error('Use before or after')
const output = process.env.ZENNOTES_SMOKE_OUTPUT_DIR ?? join(repoRoot, 'docs/downstream/grammar-ui', stage)
const notePath = 'zztest-grammar-ui.md'
const text =
  '# A little room to write\n\nWe beleive good notes start with a clear thought.\n\nThis are a quiet place to collect ideas.\n\nTry a simpler word to utilise in your next draft.\n'
function fixture(text) {
  const definitions = [
    [
      'beleive',
      ['believe', 'belie', 'belief'],
      'Possible spelling mistake found.',
      'MORFOLOGIK_RULE_EN_US',
      'misspelling',
      'TYPOS'
    ],
    ['are', ['is'], 'The subject “This” needs a singular verb.', 'THIS_NNS', 'grammar', 'GRAMMAR'],
    ['utilise', ['use'], 'Consider a simpler word.', 'SIMPLE_WORDS', 'style', 'STYLE']
  ]
  return {
    matches: definitions.flatMap(([word, values, message, id, issueType, category]) => {
      const offset = text.indexOf(word)
      return offset < 0
        ? []
        : [
            {
              message,
              offset,
              length: word.length,
              replacements: values.map((value) => ({ value })),
              context: { text, offset, length: word.length },
              rule: { id, issueType, category: { id: category, name: category } }
            }
          ]
    })
  }
}
function getFreePort() {
  return new Promise((resolvePromise, rejectPromise) => {
    const server = net.createServer()
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      server.close(() => {
        if (address && typeof address === 'object') resolvePromise(address.port)
        else rejectPromise(new Error('Could not allocate a CDP port'))
      })
    })
    server.on('error', rejectPromise)
  })
}

function httpGetJson(url) {
  return new Promise((resolvePromise, rejectPromise) => {
    const request = http.get(url, (response) => {
      let body = ''
      response.setEncoding('utf8')
      response.on('data', (chunk) => {
        body += chunk
      })
      response.on('end', () => {
        try {
          resolvePromise(JSON.parse(body))
        } catch (error) {
          rejectPromise(error)
        }
      })
    })
    request.on('error', rejectPromise)
    request.setTimeout(1000, () => request.destroy(new Error('CDP request timed out')))
  })
}

class CdpClient {
  constructor(url) {
    this.url = url
    this.id = 1
    this.pending = new Map()
    this.listeners = new Map()
  }

  connect() {
    return new Promise((resolvePromise, rejectPromise) => {
      this.socket = new WebSocket(this.url)
      this.socket.on('open', resolvePromise)
      this.socket.on('error', rejectPromise)
      this.socket.on('message', (raw) => {
        const message = JSON.parse(String(raw))
        if (message.id && this.pending.has(message.id)) {
          const pending = this.pending.get(message.id)
          this.pending.delete(message.id)
          if (message.error) pending.reject(new Error(message.error.message))
          else pending.resolve(message.result ?? {})
          return
        }
        if (message.method) {
          for (const listener of this.listeners.get(message.method) ?? []) {
            listener(message.params ?? {})
          }
        }
      })
    })
  }

  send(method, params = {}) {
    const id = this.id++
    return new Promise((resolvePromise, rejectPromise) => {
      this.pending.set(id, { resolve: resolvePromise, reject: rejectPromise })
      this.socket.send(JSON.stringify({ id, method, params }))
    })
  }

  on(method, listener) {
    const listeners = this.listeners.get(method) ?? []
    listeners.push(listener)
    this.listeners.set(method, listeners)
  }

  close() {
    this.socket?.terminate?.()
    this.socket?.close()
  }
}

async function connectPage(port) {
  const deadline = Date.now() + 20_000
  let lastError = null
  while (Date.now() < deadline) {
    try {
      const targets = await httpGetJson(`http://127.0.0.1:${port}/json/list`)
      const page = targets.find(
        (target) =>
          target.type === 'page' &&
          target.webSocketDebuggerUrl &&
          (String(target.url).startsWith('file:') || String(target.url).includes('index.html'))
      )
      if (page) {
        const client = new CdpClient(page.webSocketDebuggerUrl)
        await client.connect()
        return client
      }
    } catch (error) {
      lastError = error
    }
    await sleep(100)
  }
  throw new Error(`No Electron page target: ${lastError?.message ?? 'timeout'}`)
}

async function evaluate(client, expression) {
  const response = await client.send('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true
  })
  if (response.exceptionDetails) {
    throw new Error(
      response.exceptionDetails.exception?.description ?? response.exceptionDetails.text
    )
  }
  return response.result?.value
}

async function until(client, expression, timeoutMs = 4000, intervalMs = 80) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const value = await evaluate(client, expression)
    if (value) return value
    await sleep(intervalMs)
  }
  return null
}

async function press(client, key, options = {}) {
  const code =
    options.code ?? (key.length === 1 && /[a-z]/i.test(key) ? `Key${key.toUpperCase()}` : key)
  const modifiers = (options.shift ? 8 : 0) | (options.ctrl ? 2 : 0)
  const windowsVirtualKeyCode =
    key === 'Enter'
      ? 13
      : key === 'Escape'
        ? 27
        : key === 'Backspace'
          ? 8
          : key === 'Tab'
            ? 9
            : undefined
  await client.send('Input.dispatchKeyEvent', {
    type: key.length === 1 ? 'keyDown' : 'rawKeyDown',
    key,
    code,
    text: key.length === 1 && !options.ctrl ? key : undefined,
    unmodifiedText: key.length === 1 && !options.ctrl ? key.toLowerCase() : undefined,
    modifiers,
    windowsVirtualKeyCode
  })
  await client.send('Input.dispatchKeyEvent', {
    type: 'keyUp',
    key,
    code,
    modifiers,
    windowsVirtualKeyCode
  })
  await sleep(60)
}

async function keys(client, sequence) {
  for (const key of sequence) await press(client, key)
}

const temp = await mkdtemp(join(tmpdir(), 'zennotes-grammar-ui.'))
const server = http.createServer(async (req, res) => {
  let body = ''
  for await (const chunk of req) body += chunk
  res.setHeader('Content-Type', 'application/json')
  res.end(JSON.stringify(fixture(new URLSearchParams(body).get('text') ?? '')))
})
await new Promise((done) => server.listen(0, '127.0.0.1', done))
await mkdir(output, { recursive: true })
try {
  for (const theme of ['dark', 'light']) {
    const root = join(temp, theme)
    const vault = join(root, 'vault'),
      profile = join(root, 'profile'),
      config = join(root, 'config')
    for (const dir of [vault, profile, config]) await mkdir(dir, { recursive: true })
    await writeFile(join(vault, notePath), text)
    await writeFile(
      join(config, 'config.toml'),
      `[vim]\nenabled = true\n[appearance]\ntheme_id = "${theme}-hard"\n`
    )
    await writeFile(
      join(profile, 'zennotes.config.json'),
      JSON.stringify({
        workspaceMode: 'local',
        vaultRoot: vault,
        remoteWorkspace: null,
        windowState: testWindowState(1320, 900),
        zoomFactor: 1,
        quickCaptureHotkey: ''
      })
    )
    const port = await getFreePort()
    const child = spawn(
      requireDesktop('electron'),
      [
        '--ozone-platform=x11',
        `--remote-debugging-port=${port}`,
        join(repoRoot, 'apps/desktop/out/main/index.js')
      ],
      {
        cwd: repoRoot,
        env: {
          ...process.env,
          ZENNOTES_USER_DATA_PATH: profile,
          ZENNOTES_CONFIG_DIR: config,
          ELECTRON_RUN_AS_NODE: '',
          ELECTRON_DISABLE_SECURITY_WARNINGS: '1'
        },
        stdio: ['ignore', 'pipe', 'pipe']
      }
    )
    let log = ''
    child.stderr.on('data', (chunk) => {
      log = (log + chunk).slice(-8000)
    })
    child.stdout.on('data', (chunk) => {
      log = (log + chunk).slice(-8000)
    })
    let client
    try {
      client = await connectPage(port)
      await client.send('Page.enable')
      await client.send('Emulation.setDeviceMetricsOverride', {
        width: 1280,
        height: 900,
        deviceScaleFactor: 1,
        mobile: false
      })
      await evaluate(
        client,
        `localStorage.setItem('zen:prefs:v2', JSON.stringify({...JSON.parse(localStorage.getItem('zen:prefs:v2') || '{}'), hasCompletedOnboarding:true, themeId:${JSON.stringify(theme + '-hard')}, themeMode:${JSON.stringify(theme)}, vimMode:true, harperEnabled:false, grammarEnabled:true, grammarPreferences:{endpoint:'http://127.0.0.1:${server.address().port}/v2'}}))`
      )
      await client.send('Page.reload')
      await until(client, `!!document.querySelector('[data-sidebar-path="${notePath}"]')`, 30000)
      await sleep(1500)
      await evaluate(
        client,
        `document.querySelector('[data-whats-new-close]')?.click(); document.querySelector('[data-sidebar-path="${notePath}"]')?.click()`
      )
      if (
        !(await until(
          client,
          `document.querySelectorAll('.cm-grammar-diagnostic').length >= 3`,
          15000
        ))
      )
        throw new Error(
          'Fixture diagnostics missing: ' +
            (await evaluate(client, 'document.body.innerText.slice(-1800)'))
        )
      async function shot(name) {
        await sleep(350)
        const result = await client.send('Page.captureScreenshot', {
          format: 'png',
          captureBeyondViewport: false
        })
        await writeFile(join(output, `${theme}-${name}.png`), Buffer.from(result.data, 'base64'))
        console.log(`${stage}/${theme}-${name}.png`)
      }
      await evaluate(
        client,
        `document.querySelector('.cm-grammar-diagnostic').dispatchEvent(new MouseEvent('mousedown', {bubbles:true})); document.querySelector('.cm-content').focus()`
      )
      if (!(await until(client, `!!document.querySelector('.cm-grammar-suggestion-card')`)))
        throw new Error('Popup missing')
      await shot('popup')
      await press(client, 'Escape')
      await evaluate(client, `window.dispatchEvent(new Event('zen:toggle-grammar-review'))`)
      if (!(await until(client, `!!document.querySelector('[data-grammar-panel]')`)))
        throw new Error('Sidebar missing')
      await evaluate(client, `document.querySelector('[data-grammar-idx="0"]')?.click()`)
      await shot('sidebar')
      await press(client, ',', { ctrl: true })
      if (
        !(await until(
          client,
          `Array.from(document.querySelectorAll('button')).some(b => b.textContent.trim() === 'Grammar')`
        ))
      )
        throw new Error('Settings missing')
      await evaluate(
        client,
        `Array.from(document.querySelectorAll('button')).find(b => b.textContent.trim() === 'Grammar')?.click()`
      )
      await until(
        client,
        `!!document.querySelector('[data-settings-search-id="grammar-provider"]')`
      )
      await shot('settings')
      if (stage === 'after') {
        // Enable the real offline Harper engine in this throwaway config only.
        await writeFile(
          join(config, 'config.toml'),
          `[vim]\nenabled = true\n[appearance]\ntheme_id = "${theme}-hard"\n[editor]\nharper_enabled = true\n`
        )
        await evaluate(
          client,
          `localStorage.setItem('zen:prefs:v2', JSON.stringify({...JSON.parse(localStorage.getItem('zen:prefs:v2') || '{}'), harperEnabled:true, grammarEnabled:false}))`
        )
        await client.send('Page.reload')
        await until(client, `!!document.querySelector('[data-sidebar-path="${notePath}"]')`, 30000)
        await evaluate(
          client,
          `document.querySelector('[data-whats-new-close]')?.click(); document.querySelector('[data-sidebar-path="${notePath}"]')?.click()`
        )
        if (!(await until(client, `!!document.querySelector('.cm-harper-lint')`, 30000)))
          throw new Error('Real Harper diagnostics missing')
        await evaluate(client, `document.querySelector('.cm-content').focus()`)
        await keys(client, ']s')
        await keys(client, 'z=')
        if (!(await until(client, `!!document.querySelector('.cm-harper-popup')`)))
          throw new Error('Harper popup missing')
        await shot('harper-popup')
      }
    } catch (err) {
      console.error(log)
      throw err
    } finally {
      client?.close()
      if (child.exitCode === null) {
        child.kill()
        await new Promise((done) => child.once('exit', done))
      }
    }
  }
} finally {
  server.close()
  await rm(temp, { recursive: true, force: true })
}
