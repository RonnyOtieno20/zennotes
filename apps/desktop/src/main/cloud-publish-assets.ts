import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { readFile, stat } from 'node:fs/promises'
import type { CloudPublishUploadTarget } from '@zennotes/bridge-contract/cloud-sync'
import type { CloudPublishAssetPlatform } from '@zennotes/shared-domain/cloud-publish-uploads'
import type { PublishAssetSource } from './cloud-sync-client'

/**
 * Where a published note's attachments come from: a local vault's files on
 * disk (resolved through the vault's traversal guard by the caller), or a
 * remote vault's, fetched from its server.
 */
export interface DesktopPublishAssetFiles {
  /** The file's absolute path in a local vault, or null when the vault is remote. */
  localPath(vaultRelativePath: string): string | null
  readRemote(vaultRelativePath: string): Promise<Uint8Array>
}

export interface PublishAssetUploader {
  uploadPublishAsset(target: CloudPublishUploadTarget, source: PublishAssetSource): Promise<void>
}

type PublishAssetHandle = Pick<PublishAssetSource, 'file' | 'bytes'>

/**
 * The desktop side of a staged publish: hash each attachment as it streams off
 * the disk, then PUT it from disk again, so a 100 MB note is never held in
 * memory or carried across IPC. A remote vault's files arrive as bytes.
 */
export function desktopPublishAssetPlatform(
  uploader: PublishAssetUploader,
  files: DesktopPublishAssetFiles
): CloudPublishAssetPlatform<PublishAssetHandle> {
  return {
    async describe(asset) {
      const file = files.localPath(asset.path)
      if (file !== null) {
        const info = await stat(file)
        if (!info.isFile()) throw new Error(`ZenNotes could not read the attachment “${asset.ref}”.`)
        return { byteLength: info.size, sha256: await hashFile(file), handle: { file } }
      }
      const bytes = await files.readRemote(asset.path)
      return {
        byteLength: bytes.byteLength,
        sha256: createHash('sha256').update(bytes).digest('hex'),
        handle: { bytes }
      }
    },
    async upload(target, asset) {
      await uploader.uploadPublishAsset(target, {
        mime: asset.mime,
        byteLength: asset.byteLength,
        ...asset.handle
      })
    },
    async readBase64(asset) {
      const file = files.localPath(asset.path)
      const bytes = file !== null ? await readFile(file) : Buffer.from(await files.readRemote(asset.path))
      return bytes.toString('base64')
    }
  }
}

async function hashFile(file: string): Promise<string> {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(file)) hash.update(chunk as Buffer)
  return hash.digest('hex')
}
