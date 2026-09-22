#!/usr/bin/env node

import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { execFileSync, spawnSync } from 'node:child_process'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const desktopPackage = JSON.parse(
  readFileSync(path.join(root, 'apps/desktop/package.json'), 'utf8')
)
const version = desktopPackage.version
const dist = path.join(root, 'dist')
const debianVersion = version.replace('-', '~').replace(/\+.*/, '')
const verifyExisting = process.argv.includes('--verify-existing')

function run(command, args, options = {}) {
  execFileSync(command, args, { cwd: root, stdio: 'inherit', ...options })
}

function gitCommitTimestamp() {
  try {
    return execFileSync('git', ['log', '-1', '--format=%ct'], {
      cwd: root,
      encoding: 'utf8'
    }).trim()
  } catch {
    return undefined
  }
}

const sourceDateEpoch = process.env.SOURCE_DATE_EPOCH || gitCommitTimestamp()

// fpm proves GNU ar's deterministic mode by archiving an EMPTY member and
// grepping `ar -tv` for "0/0 ... 1970". Probe the same behavior and drop the
// variable when the deb step cannot honor it, instead of failing the update.
function fpmCanHonorSourceDateEpoch() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'grammar-ar-probe-'))
  try {
    const empty = path.join(dir, 'empty')
    const archive = path.join(dir, 'probe.a')
    writeFileSync(empty, '')
    const create = spawnSync('ar', ['-qcD', archive, empty], { stdio: 'ignore' })
    if (create.status !== 0) return false
    const list = spawnSync('ar', ['-tv', archive], {
      encoding: 'utf8',
      env: { ...process.env, TZ: 'UTC', LANG: 'C', LC_TIME: 'C' }
    })
    return list.status === 0 && /0\/0.*1970/.test(list.stdout)
  } catch {
    return false
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

const environment = { ...process.env }
if (sourceDateEpoch && fpmCanHonorSourceDateEpoch()) {
  environment.SOURCE_DATE_EPOCH = sourceDateEpoch
} else {
  delete environment.SOURCE_DATE_EPOCH
  if (sourceDateEpoch) {
    console.warn(
      'Grammar build: this host\'s ar/fpm cannot build deterministic debs; continuing without SOURCE_DATE_EPOCH.'
    )
  }
}

// Keep the process explicit: the local package always passes the same checks
// as CI, and produces only the two Linux artifacts users can install.
if (!verifyExisting) {
  // Reinstall from the lockfile the rebase just adopted so unattended runs
  // cannot build against node_modules left over from an older upstream.
  run('npm', ['ci'], { env: environment })
  run('npm', ['run', 'build:prod'], { env: environment })
  const builderArgs = (target) => [
    'exec',
    '--workspace',
    '@zennotes/desktop',
    '--',
    'electron-builder',
    '--linux',
    target,
    '--publish',
    'never'
  ]

  run('npm', builderArgs('AppImage'), { env: environment })

  try {
    run('npm', builderArgs('deb'), { env: environment })
  } catch (error) {
    if (!environment.SOURCE_DATE_EPOCH || !Number.isInteger(error.status)) throw error

    // FPM has its own ar capability check. If that check disagrees with our
    // preflight, preserve the already-built AppImage and retry only the deb
    // without the optional reproducible-build timestamp rather than aborting
    // the one-command downstream update.
    const fallbackEnvironment = { ...environment }
    delete fallbackEnvironment.SOURCE_DATE_EPOCH
    console.warn(
      'Grammar build: Debian packaging rejected SOURCE_DATE_EPOCH; retrying without it.'
    )
    run('npm', builderArgs('deb'), { env: fallbackEnvironment })
  }
}

const artifactPrefix = `ZenNotes-Grammar-${version}-linux-`
const artifacts = readdirSync(dist)
  .filter((name) => name.startsWith(artifactPrefix) && /\.(AppImage|deb)$/.test(name))
  .sort()
  .map((name) => path.join(dist, name))

const missingFormat = ['.AppImage', '.deb'].filter(
  (extension) => !artifacts.some((artifact) => artifact.endsWith(extension))
)
if (missingFormat.length > 0) {
  throw new Error(`Packaging did not produce: ${missingFormat.join(', ')}`)
}

const deb = artifacts.find((artifact) => artifact.endsWith('.deb'))
if (deb && existsSync('/usr/bin/dpkg-deb')) {
  const packageVersion = execFileSync('dpkg-deb', ['--field', deb, 'Version'], {
    encoding: 'utf8'
  }).trim()
  if (packageVersion !== debianVersion) {
    throw new Error(`Debian package version ${packageVersion} does not match ${debianVersion}`)
  }

  const fileList = execFileSync('dpkg-deb', ['--contents', deb])
  if (!fileList.includes(Buffer.from('resources/downstream-edition.json'))) {
    throw new Error('The Debian package is missing downstream-edition.json')
  }
}

const checksums = artifacts
  .map((artifact) => {
    const hash = createHash('sha256').update(readFileSync(artifact)).digest('hex')
    return `${hash}  ${path.basename(artifact)}`
  })
  .join('\n')
const checksumPath = path.join(dist, `ZenNotes-Grammar-${version}-SHA256SUMS.txt`)
writeFileSync(checksumPath, `${checksums}\n`)

console.log(`Built ${artifacts.length} Grammar Edition artifact(s).`)
console.log(`Checksums: ${path.relative(root, checksumPath)}`)
