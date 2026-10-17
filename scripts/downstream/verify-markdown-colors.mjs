/** Real Electron dev smoke, disposable profile/config/vault. Run from repo root:
 * node scripts/downstream/verify-markdown-colors.mjs
 * Uses the repository's CDP smoke-test approach, not a browser fixture.
 */
import { spawn } from 'node:child_process'
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import net from 'node:net'
import WebSocket from 'ws'
const root = fileURLToPath(new URL('../../', import.meta.url))
const output = process.env.ZENNOTES_SMOKE_OUTPUT_DIR ?? join(root, 'docs/downstream/markdown-colors')
const temporary = await mkdtemp(join(tmpdir(), 'zennotes-rendered-colors-'))
const vault = join(temporary, 'vault')
const profile = join(temporary, 'profile')
const config = join(temporary, 'config')
await Promise.all([mkdir(output, { recursive: true }), ...[vault, profile, config].map(p => mkdir(p))])
await mkdir(join(vault, 'inbox'))
const note = 'inbox/zztest-markdown-colors.md'
await writeFile(join(vault, note), await readFile(join(root, 'docs/downstream/markdown-colors/sample-note.md'), 'utf8'))
await writeFile(join(profile, 'zennotes.config.json'), JSON.stringify({ workspaceMode: 'local', vaultRoot: vault, remoteWorkspace: null, remoteWorkspaceProfileId: null, remoteWorkspaceProfiles: [], windowState: { x: 40, y: 40, width: 1440, height: 1400, isMaximized: false }, zoomFactor: 1, quickCaptureHotkey: '' }))
await writeFile(join(config, 'config.toml'), '[vim]\nenabled = false\n[editor]\nlive_preview = true\n[appearance]\ntheme_family = "catppuccin"\ntheme_mode = "dark"\ntheme_id = "catppuccin-mocha"\n')
const port = await new Promise((yes, no) => { const s = net.createServer(); s.on('error', no); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => yes(p)) }) })
const runtimeEnv = { ...process.env }; delete runtimeEnv.ELECTRON_RUN_AS_NODE
const child = spawn('npm', ['run', 'dev', '--workspace', '@zennotes/desktop', '--', '--remoteDebuggingPort', String(port)], { cwd: root, detached: true, env: { ...runtimeEnv, ZENNOTES_USER_DATA_PATH: profile, ZENNOTES_CONFIG_DIR: config, ELECTRON_DISABLE_SECURITY_WARNINGS: '1' }, stdio: ['ignore', 'pipe', 'pipe'] })
let childExit = null; child.on('exit', code => { childExit = code }); child.on('error', error => { childExit = String(error) });
let log = ''; for (const pipe of [child.stdout, child.stderr]) pipe.on('data', d => { log = (log + d).slice(-30000) })
const pause = ms => new Promise(r => setTimeout(r, ms))
const pending = new Map(); let serial = 0; let socket
function send(method, params = {}) { return new Promise((yes, no) => { const id = ++serial; const timer = setTimeout(() => { pending.delete(id); no(new Error(`CDP timeout: ${method}`)) }, 20000); pending.set(id, { yes, no, timer }); socket.send(JSON.stringify({ id, method, params })) }) }
async function evaluate(expression) { const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text); return r.result?.value }
async function until(expression) { const deadline = Date.now() + 15000; do { if (await evaluate(expression)) return; await pause(120) } while (Date.now() < deadline); throw new Error(`Timed out: ${expression}`) }
async function snap(name) { await pause(300); const { data } = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false }); await writeFile(join(output, name + '.png'), Buffer.from(data, 'base64')); console.log('Screenshot:', name) }
function check(ok, message) { if (!ok) throw new Error(message); console.log('PASS:', message) }
try {
 let page; const deadline = Date.now() + 90000
 do { if (childExit !== null) throw new Error('Electron dev exited: ' + childExit); try { const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(1500) })).json(); page = targets.find(t => t.type === 'page' && /localhost|127\.0\.0\.1/.test(t.url)); if (page) break } catch {} await pause(250) } while (Date.now() < deadline)
 if (!page) throw new Error('Electron dev page unavailable')
 socket = new WebSocket(page.webSocketDebuggerUrl)
 await new Promise((yes, no) => { socket.once('open', yes); socket.once('error', no) })
 socket.on('message', raw => { const r = JSON.parse(raw); const p = pending.get(r.id); if (p) { pending.delete(r.id); clearTimeout(p.timer); r.error ? p.no(new Error(r.error.message)) : p.yes(r.result) } })
 await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1400, deviceScaleFactor: 1, mobile: false })
 await until('!!window.zen && !!document.querySelector("[data-sidebar-type]")')
 // Open through the actual sidebar, then import the exact URL Vite loaded.
 // A reconstructed /@fs URL can create a second, disconnected Zustand store.
 await evaluate(`document.querySelector('[data-sidebar-type="folder"][data-sidebar-folder="inbox"][data-sidebar-collapsed="true"]')?.click()`)
 await until(`!!document.querySelector('[data-sidebar-path="${note}"]')`)
 await evaluate(`document.querySelector('[data-sidebar-path="${note}"]').click()`)
 await evaluate(`(async () => {
  const url = performance.getEntriesByType('resource').find(r => new URL(r.name).pathname.endsWith('/packages/app-core/src/store.ts'))?.name;
  if (!url) throw new Error('The app store module URL was not found');
  window.colorStore = (await import(url)).useStore;
 })()`)
 await until(`colorStore.getState().activeNote?.path === ${JSON.stringify(note)}`)
 check(await evaluate(`colorStore.getState().activeNote?.path === ${JSON.stringify(note)}`), 'harness controls the store used by the visible window')
 await until('document.body.innerText.includes("Advanced SQL Concepts")')
 await pause(1500)
 await evaluate('document.querySelector("[data-whats-new-close]")?.click()')
 const setMode = mode => evaluate(`colorStore.getState().setPaneModeForPath(colorStore.getState().activePaneId, ${JSON.stringify(note)}, ${JSON.stringify(mode)})`)
 const setTheme = async (id, mode) => { await evaluate(`colorStore.setState({ themeFamily: 'catppuccin', themeId: ${JSON.stringify(id)}, themeMode: ${JSON.stringify(mode)} })`); await until(`document.documentElement.dataset.theme === ${JSON.stringify(id)}`) }
 const evidence = { electron: await evaluate('navigator.userAgent'), fixture: temporary, checks: [], themes: [] }
 for (const [id, mode] of [['catppuccin-mocha', 'dark'], ['catppuccin-latte', 'light']]) {
  await setTheme(id, mode)
  await setMode('preview'); await until('!!document.querySelector(".prose-zen h1")')
  await evaluate('document.querySelector(".prose-zen").parentElement.scrollTop = 0')
  const preview = await evaluate(`(() => { const css = s => getComputedStyle(document.querySelector('.prose-zen ' + s)).color; return {h1:css('h1'),h2:css('h2'),h3:css('h3'),h4:css('h4'),h5:css('h5'),h6:css('h6'),bold:css('strong'),italic:css('em'),quote:css('blockquote'),header:css('th'),body:css('p'),quoteBold:css('blockquote strong'),quoteItalic:css('blockquote em')}; })()`)
  check(new Set([preview.h1, preview.h2, preview.h3, preview.body]).size === 4, `${mode} Preview uses distinct heading colours`)
  check(preview.bold !== preview.body && preview.italic !== preview.body, `${mode} Preview colours emphasis`)
  await snap(`${mode}-preview`)
  await setMode('edit'); await until('!!document.querySelector(".cm-wysiwyg .cm-editor .tok-strong")')
  const edit = await evaluate(`(() => { const css = s => getComputedStyle(document.querySelector('.cm-editor ' + s)).color; return {h1:css('.tok-heading1'),h2:css('.tok-heading2'),h3:css('.tok-heading3'),h4:css('.tok-heading4'),h5:css('.tok-heading5'),h6:css('.tok-heading6'),bold:css('.tok-strong'),italic:css('.tok-emphasis'),quote:css('.cm-wq-quote'),header:css('.cm-live-table th'),quoteBold:css('.cm-wq-quote .tok-strong'),quoteItalic:css('.cm-wq-quote .tok-emphasis')}; })()`)
  if (edit.quoteBold !== preview.quoteBold || edit.quoteItalic !== preview.quoteItalic) console.log('Quote diagnostics:', JSON.stringify({preview,edit,dom:await evaluate("document.querySelector('.cm-wq-quote').innerHTML")}))
  for (const key of Object.keys(edit)) check(edit[key] === preview[key], `${mode} Edit/Preview ${key} colours match`)
  check(edit.quoteBold === preview.bold && edit.quoteItalic === preview.italic, `${mode} quote retains nested emphasis colours`)
  await snap(`${mode}-live-preview`)
  await evaluate('colorStore.getState().setLivePreview(false)'); await until('!!document.querySelector(".cm-md-heading-3")')
  const source = await evaluate(`(() => { const css = s => getComputedStyle(document.querySelector('.cm-editor ' + s)).color; return {h1:css('.tok-heading1'),h2:css('.tok-heading2'),h3:css('.tok-heading3'),h4:css('.tok-heading4'),h5:css('.tok-heading5'),h6:css('.tok-heading6'),bold:css('.tok-strong'),italic:css('.tok-emphasis'),quote:css('.cm-md-quote'),header:css('.cm-md-table-header'),quoteBold:css('.cm-md-quote .tok-strong'),quoteItalic:css('.cm-md-quote .tok-emphasis')}; })()`)
  for (const key of Object.keys(source)) check(source[key] === preview[key], `${mode} source/Preview ${key} colours match`)
  evidence.checks.push({ id, preview, edit, source })
  await evaluate('colorStore.getState().setLivePreview(true)')
 }
 // Exercise the real Appearance control and persistence, not just a dataset edit.
 await evaluate('colorStore.getState().setSettingsOpen(true)')
 await until(`!![...document.querySelectorAll('button')].find(el => el.textContent.trim() === 'Appearance')`)
 await evaluate(`[...document.querySelectorAll('button')].find(el => el.textContent.trim() === 'Appearance').click()`)
 await until('!!document.querySelector("[data-settings-search-id=\\"colorful-markdown\\"]") || document.body.innerText.includes("Coloured headings and emphasis")')
 const toggled = await evaluate(`(() => { const target = [...document.querySelectorAll('button')].find(el => el.getAttribute('role') === 'switch' && el.closest('[data-settings-search-id="colorful-markdown"]')); if (!target) return false; target.click(); return true })()`)
 if (!toggled) { console.log('Settings DOM:', await evaluate('document.body.innerText.slice(-6000)')); throw new Error('Appearance toggle not found') }
 await until('document.documentElement.dataset.colorfulMarkdown === "false"')
 check(await evaluate('JSON.parse(localStorage.getItem("zen:prefs:v2")).colorfulMarkdown === false'), 'Appearance toggle persists false')
 await evaluate('colorStore.getState().setSettingsOpen(false)')
 await setMode('preview'); await until('!!document.querySelector(".prose-zen h1")')
 check(await evaluate(`['h1','h2','h3','strong','em'].every(role => getComputedStyle(document.querySelector('.prose-zen '+role)).color === getComputedStyle(document.querySelector('.prose-zen p')).color)`), 'disabled Preview headings and emphasis are monochrome')
 await snap('light-preview-monochrome')
 await setMode('edit'); await until('!!document.querySelector(".cm-wysiwyg .cm-editor .tok-strong")')
 check(await evaluate(`['.tok-heading1','.tok-heading2','.tok-heading3','.tok-strong','.tok-emphasis'].every(role => getComputedStyle(document.querySelector('.cm-editor '+role+':not(.tok-meta-code)')).color === getComputedStyle(document.querySelector('.cm-content')).color)`), 'disabled Live Preview headings and emphasis are monochrome')
 await evaluate('colorStore.getState().setLivePreview(false)'); await until('!!document.querySelector(".cm-md-heading-3")')
 check(await evaluate(`['.tok-heading1','.tok-heading2','.tok-heading3','.tok-strong','.tok-emphasis'].every(role => getComputedStyle(document.querySelector('.cm-editor '+role+':not(.tok-meta-code)')).color === getComputedStyle(document.querySelector('.cm-content')).color)`), 'disabled source headings and emphasis are monochrome')
 await evaluate('colorStore.getState().setLivePreview(true)')
 await setMode('preview'); await until('!!document.querySelector(".prose-zen h1")')
 await evaluate('colorStore.getState().setColorfulMarkdown(true)')
 // Exercise every built-in variant in the real renderer using actual preview DOM.
 const themes = await evaluate(`(async () => (await import('/@fs/${root}packages/app-core/src/lib/themes.ts')).THEMES)()`)
 for (const theme of themes) {
  await evaluate(`colorStore.setState({themeId:${JSON.stringify(theme.id)},themeFamily:${JSON.stringify(theme.family)},themeMode:${JSON.stringify(theme.mode)}})`)
  await until(`document.documentElement.dataset.theme === ${JSON.stringify(theme.id)}`)
  const result = await evaluate(`(() => {
   const canvas=document.createElement('canvas'), ctx=canvas.getContext('2d');
   const rgb=c=>{ctx.clearRect(0,0,1,1);ctx.fillStyle=c;ctx.fillRect(0,0,1,1);return [...ctx.getImageData(0,0,1,1).data].slice(0,3)};
   const lum=c=>rgb(c).map(v=>{v/=255;return v<=.04045?v/12.92:((v+.055)/1.055)**2.4}).reduce((s,v,i)=>s+v*[.2126,.7152,.0722][i],0);
   const background=el=>{
    const layers=[];for(let node=el;node;node=node.parentElement) layers.unshift(getComputedStyle(node).backgroundColor);
    ctx.clearRect(0,0,1,1);ctx.fillStyle='white';ctx.fillRect(0,0,1,1);
    for(const color of layers){ctx.fillStyle=color;ctx.fillRect(0,0,1,1)}
    const [r,g,b]=ctx.getImageData(0,0,1,1).data;return lum('rgb('+r+' '+g+' '+b+')');
   };
   const roles=['h1','h2','h3','h4','h5','h6','strong','em','blockquote','th'];
   return roles.map(role=>{const el=document.querySelector('.prose-zen '+role);const fg=lum(getComputedStyle(el).color),bg=background(el);return {role,contrast:(Math.max(bg,fg)+.05)/(Math.min(bg,fg)+.05)};});
  })()`)
  evidence.themes.push({ id: theme.id, roles: result })
 }
 const failures = evidence.themes.flatMap(t => t.roles.filter(r => r.contrast < 4.5).map(r => ({id:t.id,...r})))
 await writeFile(join(output, 'electron-evidence.json'), JSON.stringify(evidence, null, 2) + '\n')
 check(!failures.length, `all ${themes.length} built-in variants have >=4.5:1 role contrast: ${JSON.stringify(failures)}`)
 await pause(900)
 check((await readFile(join(config,'config.toml'),'utf8')).includes('colorful_markdown = true'), 'portable config contains Appearance preference')
 console.log('Disposable data:', temporary)
} catch (e) { if (socket?.readyState === WebSocket.OPEN) { try { console.error('Failure UI:', await evaluate('document.body.innerText.slice(-7000)')); console.error('Store modules:', await evaluate("performance.getEntriesByType('resource').filter(r => r.name.includes('store.ts')).map(r => r.name)")); await snap('failure') } catch {} } console.error(log.slice(-5000)); throw e }
finally { socket?.terminate(); for (const p of pending.values()) clearTimeout(p.timer); try { process.kill(-child.pid, 'SIGTERM') } catch {} await writeFile(join(output, 'dev.log'), log) }
