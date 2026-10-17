/** Combined-feature smoke in real Electron dev, disposable data and mocked LanguageTool. */
import { spawn } from 'node:child_process'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import http from 'node:http'
import net from 'node:net'
import assert from 'node:assert/strict'
import WebSocket from 'ws'
const root = fileURLToPath(new URL('../../', import.meta.url))
const output = join(root, 'docs/downstream/merge-three-features')
const temporary = await mkdtemp(join(tmpdir(), 'zennotes-merge.'))
const note = 'zztest-three-features.md'
const text = '# Merge feature check\n\nWe beleive good notes help.\n\nThis are a quiet place.\n\n| **Feature** | *Status* |\n| --- | --- |\n| Live tables | Ready |\n| Grammar | Ready |\n\nAfter the table.\n'
const checks = []
const mock = http.createServer(async (req, res) => {
  let body = ''; for await (const chunk of req) body += chunk
  const source = new URLSearchParams(body).get('text') ?? ''
  const matches = [['beleive', ['believe', 'belie', 'belief']], ['are', ['is']]].flatMap(([word, values]) => {
    const offset = source.indexOf(word)
    return offset < 0 ? [] : [{ message: 'Mock grammar issue.', offset, length: word.length,
      replacements: values.map(value => ({value})), context: {text: source, offset, length: word.length},
      rule: {id: 'ZZTEST_' + word, issueType: 'grammar', category: {id: 'GRAMMAR', name: 'Grammar'}} }]
  })
  res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({matches}))
})
await new Promise(resolve => mock.listen(0, '127.0.0.1', resolve))
const port = await new Promise(resolve => { const server = net.createServer(); server.listen(0, '127.0.0.1', () => { const p = server.address().port; server.close(() => resolve(p)) }) })
const profile = join(temporary, 'profile'), config = join(temporary, 'config'), vault = join(temporary, 'vault')
await Promise.all([output, profile, config, vault].map(p => mkdir(p, {recursive:true})))
await writeFile(join(vault, note), text)
await writeFile(join(profile, 'zennotes.config.json'), JSON.stringify({ workspaceMode:'local', vaultRoot:vault, remoteWorkspace:null, remoteWorkspaceProfileId:null, remoteWorkspaceProfiles:[], quickCaptureHotkey:'', windowState:{x:40,y:40,width:1320,height:900,isMaximized:false}, zoomFactor:1 }))
await writeFile(join(config, 'config.toml'), '[vim]\nenabled = true\n[editor]\nlive_preview = true\nharper_enabled = false\n[appearance]\ntheme_family = "catppuccin"\ntheme_mode = "dark"\ntheme_id = "catppuccin-mocha"\ncolorful_markdown = true\n')
const env = {...process.env, ZENNOTES_USER_DATA_PATH:profile, ZENNOTES_CONFIG_DIR:config}; delete env.ELECTRON_RUN_AS_NODE
const child = spawn('npm', ['run','dev','--workspace','@zennotes/desktop','--','--remoteDebuggingPort',String(port)], {cwd:root, detached:true, env, stdio:['ignore','pipe','pipe']})
let log = '', exited = false
child.on('exit', () => {exited = true})
for (const pipe of [child.stdout, child.stderr]) pipe.on('data', d => {log = (log + d).slice(-30000)})
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
let socket, serial=0; const pending = new Map()
function send(method, params={}) { return new Promise((resolve,reject) => { const id=++serial; const timer=setTimeout(()=>{pending.delete(id);reject(new Error('CDP timeout '+method))},20000);pending.set(id,{resolve,reject,timer});socket.send(JSON.stringify({id,method,params})) }) }
async function evaluate(expression) { const result=await send('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true}); if(result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text); return result.result?.value }
async function until(expression) { const deadline=Date.now()+20000; do {if(await evaluate(expression))return;await sleep(100)}while(Date.now()<deadline);throw new Error('Timed out: '+expression) }
function check(ok, message) { assert.ok(ok,message); checks.push(message);console.log('PASS:',message) }
async function press(key, code) { await send('Input.dispatchKeyEvent',{type:'keyDown',key,code,text:key.length===1?key:undefined});await send('Input.dispatchKeyEvent',{type:'keyUp',key,code});await sleep(120) }
async function shot(name) {await evaluate('mergeStore.getState().closeWhatsNew()');await until('!document.querySelector("[data-whats-new-close]")');await sleep(250);const result=await send('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});await writeFile(join(output,name+'.png'),Buffer.from(result.data,'base64'))}
try {
  let page; const deadline=Date.now()+90000
  do {if(exited)throw new Error('Electron dev exited');try {const targets=await(await fetch(`http://127.0.0.1:${port}/json/list`,{signal:AbortSignal.timeout(1000)})).json();page=targets.find(p=>p.type==='page'&&/localhost|127\.0\.0\.1/.test(p.url));if(page)break}catch{}await sleep(200)}while(Date.now()<deadline)
  assert.ok(page,'real Electron dev page available')
  socket=new WebSocket(page.webSocketDebuggerUrl);await new Promise((resolve,reject)=>{socket.once('open',resolve);socket.once('error',reject)})
  socket.on('message',raw=>{const r=JSON.parse(raw);const p=pending.get(r.id);if(p){pending.delete(r.id);clearTimeout(p.timer);r.error?p.reject(new Error(r.error.message)):p.resolve(r.result)}})
  socket.on('message',raw=>{const r=JSON.parse(raw);if(r.method==='Runtime.exceptionThrown')console.error('Renderer exception:',JSON.stringify(r.params))})
  await send('Runtime.enable')
  await send('Page.enable')
  await send('Emulation.setDeviceMetricsOverride',{width:1280,height:900,deviceScaleFactor:1,mobile:false})
  await until('!!window.zen && !!document.querySelector("[data-sidebar-type]")')
  await evaluate(`localStorage.setItem('zen:prefs:v2',JSON.stringify({...JSON.parse(localStorage.getItem('zen:prefs:v2')||'{}'),hasCompletedOnboarding:true,vimMode:true,harperEnabled:false,grammarEnabled:true,grammarPreferences:{endpoint:'http://127.0.0.1:${mock.address().port}/v2'}}))`)
  await new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>{socket.off('message',onMessage);reject(new Error('Reload timeout'))},30000)
    const onMessage=raw=>{if(JSON.parse(raw).method==='Page.loadEventFired'){clearTimeout(timer);socket.off('message',onMessage);resolve()}}
    socket.on('message',onMessage)
    send('Page.reload').catch(reject)
  })
  await until(`!!document.querySelector('[data-sidebar-path="${note}"]')`)
  await sleep(1000)
  await evaluate(`document.querySelector('[data-whats-new-close]')?.click();document.querySelector('[data-sidebar-path="${note}"]').click()`)
  await evaluate(`(async()=>{const url=performance.getEntriesByType('resource').find(r=>new URL(r.name).pathname.endsWith('/packages/app-core/src/store.ts'))?.name;if(!url)throw new Error('store URL missing');window.mergeStore=(await import(url)).useStore})()`)
  await until(`mergeStore.getState().activeNote?.path===${JSON.stringify(note)} && !!mergeStore.getState().editorViewRef`)
  await until('document.querySelectorAll(".cm-grammar-diagnostic").length===2 && !!document.querySelector(".cm-live-table table")')
  const agent=await evaluate('navigator.userAgent'); check(agent.includes('Electron/'),'running real Electron')
  check(await evaluate('mergeStore.getState().livePreview && mergeStore.getState().colorfulMarkdown && mergeStore.getState().vimMode'),'Live Preview, Markdown colours and Vim enabled together')
  await evaluate('window.mergeView=mergeStore.getState().editorViewRef;mergeView.dispatch({selection:{anchor:0}});mergeView.focus()')
  const colours=await evaluate(`({heading:getComputedStyle(document.querySelector('.tok-heading1')).color,body:getComputedStyle(document.querySelector('.cm-content')).color})`)
  check(colours.heading!==colours.body,'Live Preview heading is coloured')
  check(await evaluate('!!document.querySelector(".cm-live-table table")'),'table renders outside selection')
  await press(']','BracketRight');await press('s','KeyS')
  check(await evaluate(`mergeView.state.selection.main.head===mergeView.state.doc.toString().indexOf('beleive')`),']s jumps to first mocked LanguageTool issue')
  await press('z','KeyZ');await press('=','Equal')
  await until('!!document.querySelector(".cm-grammar-suggestion-card")')
  check(await evaluate(`JSON.stringify([...document.querySelectorAll('.cm-grammar-suggestion-card .cm-harper-popup-item:not(.cm-harper-popup-secondary)')].map(b=>b.querySelector('.cm-harper-popup-hint')?.textContent))==='["1","2","3"]'`),'grammar popup shows three numbered suggestions')
  await shot('dark-table-heading-grammar-popup')
  await press('Escape','Escape');await press(']','BracketRight');await press('s','KeyS')
  check(await evaluate(`mergeView.state.selection.main.head===mergeView.state.doc.toString().indexOf('are')`),']s jumps to the next mocked issue')
  await press('z','KeyZ');await press('=','Equal');await until('!!document.querySelector(".cm-grammar-suggestion-card")')
  await press('1','Digit1')
  check(await evaluate(`mergeView.state.doc.toString().includes('This is a quiet place.')`),'number 1 applies replacement')
  await until('document.querySelectorAll(".cm-grammar-diagnostic").length===1')
  await evaluate('mergeView.dispatch({selection:{anchor:0}});mergeView.focus()')
  await press(']','BracketRight');await press('s','KeyS');await press('z','KeyZ');await press('=','Equal')
  await until('!!document.querySelector(".cm-grammar-suggestion-card")')
  await evaluate(`mergeStore.setState({themeId:'catppuccin-latte',themeFamily:'catppuccin',themeMode:'light'})`)
  await until('document.documentElement.dataset.theme==="catppuccin-latte"')
  await shot('light-table-heading-grammar-popup')
  await press('Escape','Escape')
  const cell=await evaluate(`(()=>{const r=document.querySelector('.cm-live-table td').getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()`)
  await send('Input.dispatchMouseEvent',{type:'mousePressed',...cell,button:'left',clickCount:1});await send('Input.dispatchMouseEvent',{type:'mouseReleased',...cell,button:'left',clickCount:1})
  await until('!document.querySelector(".cm-live-table")')
  check(await evaluate(`mergeView.state.doc.lineAt(mergeView.state.selection.main.head).text.includes('| Live tables |')`),'clicking a cell reveals the entire table source at that cell')
  await shot('light-table-source')
  await evaluate('mergeView.dispatch({selection:{anchor:0}})');await until('!!document.querySelector(".cm-live-table table")')
  check(true,'table renders again after cursor leaves it')
  await writeFile(join(output,'combined-evidence.json'),JSON.stringify({electron:agent,note,checks,colours},null,2)+'\n')
} catch(error) {console.error(error);if(socket?.readyState===WebSocket.OPEN){try{console.error(await evaluate('document.body.innerText.slice(-3500)'));await shot('combined-failure')}catch{}}console.error(log.slice(-6000));throw error}
finally {socket?.terminate();for(const p of pending.values())clearTimeout(p.timer);try{process.kill(-child.pid,'SIGTERM')}catch{}await Promise.race([new Promise(resolve=>child.once('exit',resolve)),sleep(5000)]);mock.close();await writeFile(join(output,'dev.log'),log);await rm(temporary,{recursive:true,force:true,maxRetries:5,retryDelay:200})}
