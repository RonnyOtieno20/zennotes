#!/usr/bin/env node

import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
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
const environment = {
  ...process.env,
  ...(sourceDateEpoch ? { SOURCE_DATE_EPOCH: sourceDateEpoch } : {})
}

// Keep the process explicit: the local package always passes the same checks
// as CI, and produces only the two Linux artifacts users can install.
if (!verifyExisting) {
  run('npm', ['run', 'build:prod'], { env: environment })
  run(
    'npm',
    [
      'exec',
      '--workspace',
      '@zennotes/desktop',
      '--',
      'electron-builder',
      '--linux',
      'AppImage',
      'deb',
      '--publish',
      'never'
    ],
    { env: environment }
  )
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
