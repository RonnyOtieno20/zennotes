import { promises as fs, type BigIntStats } from 'node:fs'

/**
 * A file's identity for the guards that tell a case-only rename (the
 * destination is the file itself, on a case-insensitive disk) from a rename
 * onto another file. Always a bigint stat: a Windows file id is 64 bits, a
 * reuse count above the record number, and as a JS number two files saved one
 * after the other round to one value once that count passes 31. Read as
 * numbers, renaming a note onto another note's name looked like a case-only
 * rename, and the rename replaced the other note.
 */
export function fileIdentity(absolutePath: string): Promise<BigIntStats> {
  return fs.stat(absolutePath, { bigint: true })
}

export function isSameFile(a: BigIntStats, b: BigIntStats): boolean {
  return a.dev === b.dev && a.ino === b.ino
}
