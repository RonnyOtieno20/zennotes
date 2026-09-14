import { readFileSync } from 'node:fs'
import path from 'node:path'

export type DownstreamUpdatePolicy = 'disabled' | 'upstream'

export interface DownstreamEdition {
  id: string
  displayName: string
  updater: DownstreamUpdatePolicy
  upstreamRepository: string
  releaseTagPrefix: string
}

export const UPSTREAM_EDITION: DownstreamEdition = {
  id: 'upstream',
  displayName: 'ZenNotes',
  updater: 'upstream',
  upstreamRepository: 'ZenNotes/zennotes',
  releaseTagPrefix: 'v'
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

/** Validate untrusted packaged metadata before it changes update behavior. */
export function parseDownstreamEdition(value: unknown): DownstreamEdition {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return UPSTREAM_EDITION
  const candidate = value as Record<string, unknown>
  const id = nonEmptyString(candidate.id)
  const displayName = nonEmptyString(candidate.displayName)
  const upstreamRepository = nonEmptyString(candidate.upstreamRepository)
  const releaseTagPrefix = nonEmptyString(candidate.releaseTagPrefix)
  const updater = candidate.updater
  if (
    !id ||
    !displayName ||
    !upstreamRepository ||
    !releaseTagPrefix ||
    (updater !== 'disabled' && updater !== 'upstream')
  ) {
    return UPSTREAM_EDITION
  }
  return { id, displayName, updater, upstreamRepository, releaseTagPrefix }
}

/**
 * A downstream build carries this resource beside app.asar. Development and
 * stock upstream packages do not, so they retain the normal update channel.
 */
export function getDownstreamEdition(resourcesPath: string = process.resourcesPath): DownstreamEdition {
  try {
    const raw = readFileSync(path.join(resourcesPath, 'downstream-edition.json'), 'utf8')
    return parseDownstreamEdition(JSON.parse(raw))
  } catch {
    return UPSTREAM_EDITION
  }
}
