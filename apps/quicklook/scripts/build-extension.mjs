// Builds the Quick Look extension (ZenNotesQuickLook.appex) into a packaged
// ZenNotes.app. electron-builder's afterPack hook calls this for each macOS
// architecture, before the app is signed. electron-builder never signs
// anything under Contents/PlugIns, so the extension arrives signed here, with
// its own entitlements (Quick Look only loads sandboxed extensions) and the
// same identity the app is signed with.
import { execFile } from 'node:child_process'
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const run = promisify(execFile)
const here = dirname(fileURLToPath(import.meta.url))
const workspace = join(here, '..')
const sources = join(workspace, 'macos')

export const QUICKLOOK_BUNDLE = 'ZenNotesQuickLook.appex'
const OPENER_BUNDLE = 'ZenNotesQuickLookOpener.xpc'
const SWIFT_TARGETS = { arm64: 'arm64-apple-macos12.0', x64: 'x86_64-apple-macos12.0' }

let viewerBuild = null

/** The viewer page, built once per process: both architectures share it. */
export function buildQuickLookViewer() {
  viewerBuild ??= run('npm', ['run', 'build:nocheck'], { cwd: workspace, maxBuffer: 64 * 1024 * 1024 }).then(() => {
    if (!existsSync(join(workspace, 'dist', 'quicklook.js'))) {
      throw new Error('The Quick Look viewer build produced no dist/quicklook.js.')
    }
    return join(workspace, 'dist')
  })
  return viewerBuild
}

/**
 * @param {object} options
 * @param {string} options.appPath  the packaged ZenNotes.app
 * @param {'arm64'|'x64'} options.arch
 * @param {string} options.appId    the app's bundle identifier
 * @param {string} options.version
 * @param {{ identity: string, keychain: string | null, timestamp?: string } | null} options.signing
 *   null signs ad hoc; `timestamp` names the server the app's own signing uses (mac.timestamp)
 * @param {boolean} [options.selfTest]  compile the button self-test used when validating a build
 */
export async function buildQuickLookExtension({ appPath, arch, appId, version, signing, selfTest = false }) {
  const target = SWIFT_TARGETS[arch]
  if (!target) throw new Error(`Unsupported Quick Look architecture: ${arch}`)
  const viewer = await buildQuickLookViewer()
  const work = await mkdtemp(join(tmpdir(), 'zennotes-quicklook-'))
  try {
    const appex = join(work, QUICKLOOK_BUNDLE)
    const opener = join(appex, 'Contents', 'XPCServices', OPENER_BUNDLE)
    await mkdir(join(appex, 'Contents', 'MacOS'), { recursive: true })
    await mkdir(join(opener, 'Contents', 'MacOS'), { recursive: true })
    await writePlist(join(sources, 'Extension', 'Info.plist'), join(appex, 'Contents', 'Info.plist'), appId, version)
    await writePlist(join(sources, 'Opener', 'Info.plist'), join(opener, 'Contents', 'Info.plist'), appId, version)

    const sdk = (await run('xcrun', ['--show-sdk-path', '--sdk', 'macosx'])).stdout.trim()
    const swift = ['swiftc', '-target', target, '-sdk', sdk, '-O']
    const extensionSources = (await readdir(join(sources, 'Extension')))
      .filter((name) => name.endsWith('.swift'))
      .map((name) => join(sources, 'Extension', name))
    await run('xcrun', [
      ...swift,
      ...(selfTest ? ['-D', 'QUICKLOOK_SELFTEST'] : []),
      '-parse-as-library', '-application-extension',
      '-module-name', 'ZenNotesQuickLook',
      '-Xlinker', '-e', '-Xlinker', '_NSExtensionMain',
      '-framework', 'Cocoa', '-framework', 'Quartz', '-framework', 'WebKit', '-framework', 'UniformTypeIdentifiers',
      '-o', join(appex, 'Contents', 'MacOS', 'ZenNotesQuickLook'),
      ...extensionSources
    ], { maxBuffer: 16 * 1024 * 1024 })
    await run('xcrun', [
      ...swift,
      '-module-name', 'ZenNotesQuickLookOpener',
      '-framework', 'AppKit',
      '-o', join(opener, 'Contents', 'MacOS', 'ZenNotesQuickLookOpener'),
      join(sources, 'Opener', 'main.swift')
    ], { maxBuffer: 16 * 1024 * 1024 })
    await cp(viewer, join(appex, 'Contents', 'Resources', 'viewer'), { recursive: true })

    // Inside out: the opener, then the extension that contains it.
    await sign(opener, signing, null)
    await sign(appex, signing, join(sources, 'Extension', 'Extension.entitlements'))

    const plugIns = join(appPath, 'Contents', 'PlugIns')
    await mkdir(plugIns, { recursive: true })
    await rm(join(plugIns, QUICKLOOK_BUNDLE), { recursive: true, force: true })
    await run('ditto', [appex, join(plugIns, QUICKLOOK_BUNDLE)])
  } finally {
    await rm(work, { recursive: true, force: true })
  }
}

async function writePlist(template, destination, appId, version) {
  const text = (await readFile(template, 'utf8')).replaceAll('__APP_ID__', appId).replaceAll('__VERSION__', version)
  await writeFile(destination, text)
}

async function sign(bundle, signing, entitlements) {
  const args = ['--force', '--options', 'runtime']
  if (signing) {
    args.push('--sign', signing.identity, signing.timestamp ? `--timestamp=${signing.timestamp}` : '--timestamp')
    if (signing.keychain) args.push('--keychain', signing.keychain)
  } else {
    args.push('--sign', '-')
  }
  if (entitlements) args.push('--entitlements', entitlements)
  await run('codesign', [...args, bundle])
}
