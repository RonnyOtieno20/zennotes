import { promises as fs, type PathLike, type StatOptions } from 'node:fs'
import { vi } from 'vitest'

/**
 * Two files saved one after the other on Windows: neighbouring records with
 * the same reuse count. A Windows file id is 64 bits (the reuse count above
 * the record number), and once the count passes 31 these two round to one
 * value as JS numbers. As bigints they stay apart.
 */
export const NEIGHBOUR_FILE_IDS = [0x0028000000037683n, 0x0028000000037684n] as const

/**
 * Report Windows file ids for the paths ending in the given suffixes, the way
 * Node does: the full id from a bigint stat, a rounded number otherwise.
 * Call `mockRestore()` on the result.
 */
export function useWindowsFileIds(ids: Record<string, bigint>) {
  const stat = fs.stat.bind(fs)
  return vi.spyOn(fs, 'stat').mockImplementation((async (target: PathLike, options?: StatOptions) => {
    const stats = await stat(target, options)
    const id = Object.entries(ids).find(([suffix]) => String(target).endsWith(suffix))?.[1]
    if (id === undefined) return stats
    return Object.assign(stats, options?.bigint ? { ino: id, dev: 7n } : { ino: Number(id), dev: 7 })
  }) as typeof fs.stat)
}
