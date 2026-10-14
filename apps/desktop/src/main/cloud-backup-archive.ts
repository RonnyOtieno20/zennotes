import { createReadStream, createWriteStream } from 'node:fs'
import { pipeline } from 'node:stream/promises'
import { createGunzip, createGzip } from 'node:zlib'

type ArchiveItem = Record<string, unknown>

const OPEN_BRACE = 0x7b
const CLOSE_BRACE = 0x7d
const OPEN_BRACKET = 0x5b
const CLOSE_BRACKET = 0x5d
const QUOTE = 0x22
const BACKSLASH = 0x5c
const COMMA = 0x2c

function isWhitespace(byte: number): boolean {
  return byte === 0x20 || byte === 0x0a || byte === 0x0d || byte === 0x09
}

function unexpectedFormat(): Error {
  return new Error('ZenNotes could not read this backup archive. Download it again.')
}

/**
 * Rewrites a downloaded backup archive one item at a time: the service's
 * archive is a single gzip JSON object whose `items` array carries every
 * file's data inline, so it is scanned, not parsed whole, and only one item is
 * ever held in memory. An end-to-end encrypted vault's archive goes in, a
 * readable archive in the same format comes out.
 */
export async function rewriteBackupArchive(
  sourcePath: string,
  destinationPath: string,
  rewriteItem: (item: ArchiveItem) => Promise<ArchiveItem>
): Promise<{ items: number }> {
  let items = 0
  await pipeline(
    createReadStream(sourcePath),
    createGunzip(),
    async function* (source: AsyncIterable<Buffer>) {
      for await (const piece of rewriteArchiveItems(source, async (item) => {
        items++
        return rewriteItem(item)
      })) {
        yield piece
      }
    },
    createGzip(),
    createWriteStream(destinationPath, { flags: 'wx', mode: 0o600 })
  )
  return { items }
}

export async function* rewriteArchiveItems(
  source: AsyncIterable<Buffer>,
  rewriteItem: (item: ArchiveItem) => Promise<ArchiveItem>
): AsyncGenerator<Buffer> {
  let phase = 'header' as 'header' | 'items' | 'footer'
  let depth = 0
  let inString = false
  let escaped = false
  const header: Buffer[] = []
  const footer: Buffer[] = []
  let item: Buffer[] = []
  let written = 0

  for await (const chunk of source) {
    let start = 0
    for (let index = 0; index < chunk.length; index++) {
      const byte = chunk[index]!
      if (inString) {
        if (escaped) escaped = false
        else if (byte === BACKSLASH) escaped = true
        else if (byte === QUOTE) inString = false
        continue
      }
      if (byte === QUOTE) {
        inString = true
        continue
      }
      if (phase === 'header') {
        if (byte === OPEN_BRACE || byte === OPEN_BRACKET) depth++
        else if (byte === CLOSE_BRACE || byte === CLOSE_BRACKET) depth--
        // The first array one level into the top object must be `items`.
        if (byte === OPEN_BRACKET && depth === 2) {
          header.push(chunk.subarray(start, index + 1))
          const text = Buffer.concat(header).toString('utf8')
          let parsed: unknown
          try {
            parsed = JSON.parse(`${text}]}`)
          } catch {
            throw unexpectedFormat()
          }
          const keys = parsed && typeof parsed === 'object' ? Object.keys(parsed) : []
          if (keys.at(-1) !== 'items') throw unexpectedFormat()
          yield Buffer.from(text, 'utf8')
          phase = 'items'
          start = index + 1
        }
        continue
      }
      if (phase === 'items') {
        if (depth === 2) {
          if (byte === OPEN_BRACE) {
            depth = 3
            start = index
            item = []
          } else if (byte === CLOSE_BRACKET) {
            depth = 1
            phase = 'footer'
            start = index + 1
          } else if (byte !== COMMA && !isWhitespace(byte)) {
            throw unexpectedFormat()
          }
          continue
        }
        if (byte === OPEN_BRACE || byte === OPEN_BRACKET) depth++
        else if (byte === CLOSE_BRACE || byte === CLOSE_BRACKET) depth--
        if (depth === 2) {
          item.push(chunk.subarray(start, index + 1))
          let parsed: unknown
          try {
            parsed = JSON.parse(Buffer.concat(item).toString('utf8'))
          } catch {
            throw unexpectedFormat()
          }
          item = []
          if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw unexpectedFormat()
          const rewritten = await rewriteItem(parsed as ArchiveItem)
          yield Buffer.from(`${written > 0 ? ',' : ''}${JSON.stringify(rewritten)}`, 'utf8')
          written++
        }
        continue
      }
      // Footer: what follows the items array, normally the closing brace.
      if (byte === OPEN_BRACE || byte === OPEN_BRACKET) depth++
      else if (byte === CLOSE_BRACE || byte === CLOSE_BRACKET) depth--
    }
    if (phase === 'header') header.push(chunk.subarray(start))
    else if (phase === 'items' && depth > 2) item.push(chunk.subarray(start))
    else if (phase === 'footer') footer.push(chunk.subarray(start))
  }

  if (phase !== 'footer' || depth !== 0 || inString) throw unexpectedFormat()
  const tail = Buffer.concat(footer).toString('utf8')
  if (tail.trim() !== '}') throw unexpectedFormat()
  yield Buffer.from(`]${tail}`, 'utf8')
}
