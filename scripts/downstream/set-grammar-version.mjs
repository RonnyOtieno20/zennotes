#!/usr/bin/env node

import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const upstreamTag = process.argv[2]
const printOnly = process.argv.includes('--print')
const match = /^v(\d+)\.(\d+)\.(\d+)$/.exec(upstreamTag || '')

if (!match) {
  throw new Error('Expected a stable upstream tag in the form vMAJOR.MINOR.PATCH')
}

const [, major, minor, patch] = match
const downstreamVersion = `${major}.${minor}.${Number(patch) + 1}-grammar.1`

if (printOnly) {
  console.log(downstreamVersion)
  process.exit(0)
}

const desktopPackagePath = path.join(root, 'apps/desktop/package.json')
const lockfilePath = path.join(root, 'package-lock.json')
const desktopPackage = JSON.parse(readFileSync(desktopPackagePath, 'utf8'))
const lockfile = JSON.parse(readFileSync(lockfilePath, 'utf8'))

desktopPackage.version = downstreamVersion
if (!lockfile.packages?.['apps/desktop']) {
  throw new Error('Could not find apps/desktop in package-lock.json')
}
lockfile.packages['apps/desktop'].version = downstreamVersion

writeFileSync(desktopPackagePath, `${JSON.stringify(desktopPackage, null, 2)}\n`)
writeFileSync(lockfilePath, `${JSON.stringify(lockfile, null, 2)}\n`)
console.log(downstreamVersion)
