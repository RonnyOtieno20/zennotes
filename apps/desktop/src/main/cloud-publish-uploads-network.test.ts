import { createServer, type IncomingMessage } from 'node:http'
import { once } from 'node:events'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { AddressInfo } from 'node:net'
import { afterEach, expect, it } from 'vitest'
import { publishWithStagedUploads } from '@zennotes/shared-domain/cloud-publish-uploads'
import { desktopPublishAssetPlatform } from './cloud-publish-assets'
import { createCloudSyncClient } from './cloud-sync-client'

// A fake Cloud and object store on loopback: the real desktop client stages each
// attachment with a streamed PUT, then publishes naming the upload.

const directories: string[] = []

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

async function readBody(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = []
  for await (const chunk of request) chunks.push(Buffer.from(chunk))
  return Buffer.concat(chunks)
}

async function fixture(stagedUploads: boolean) {
  const vault = await mkdtemp(path.join(os.tmpdir(), 'zennotes-publish-network-'))
  directories.push(vault)
  const files = [Buffer.alloc(700_000, 7), Buffer.alloc(1_300_000, 9)]
  await writeFile(path.join(vault, 'a.png'), files[0]!)
  await writeFile(path.join(vault, 'b.png'), files[1]!)

  const puts: Array<{ url: string; headers: IncomingMessage['headers']; body: Buffer }> = []
  const publishes: Array<{ method: string; contentType: string; payload: Record<string, unknown>; files: number }> = []
  const server = createServer(async (request, response) => {
    try {
      const body = await readBody(request)
      const url = request.url ?? ''
      if (url === '/api/v1/shares/uploads' && request.method === 'POST') {
        if (!stagedUploads) {
          response.writeHead(404, { 'Content-Type': 'application/json' })
          response.end(JSON.stringify({ message: 'Not Found' }))
          return
        }
        const { assets } = JSON.parse(body.toString()) as { assets: Array<{ ref: string }> }
        const host = request.headers.host
        response.writeHead(201, { 'Content-Type': 'application/json' })
        response.end(JSON.stringify({
          data: {
            id: '01upload',
            expires_at: '2026-10-09T21:00:00Z',
            uploads: assets.map((asset) => ({ ref: asset.ref, method: 'PUT', url: `http://${host}/storage/${asset.ref}?sig=1`, headers: { Host: host } }))
          }
        }))
        return
      }
      if (url.startsWith('/storage/') && request.method === 'PUT') {
        puts.push({ url, headers: request.headers, body })
        response.writeHead(200)
        response.end()
        return
      }
      if (url.startsWith('/api/v1/shares')) {
        const contentType = request.headers['content-type'] ?? ''
        let payload: Record<string, unknown>
        let fileCount = 0
        if (contentType.startsWith('multipart/form-data')) {
          const form = await new Request('http://localhost/', { method: 'POST', headers: { 'Content-Type': contentType }, body }).formData()
          payload = JSON.parse(form.get('payload') as string)
          fileCount = form.getAll('assets[]').length
        } else {
          payload = JSON.parse(JSON.parse(body.toString()).payload)
        }
        publishes.push({ method: request.method ?? '', contentType, payload, files: fileCount })
        response.writeHead(request.method === 'POST' ? 201 : 200, { 'Content-Type': 'application/json' })
        response.end(JSON.stringify({ id: 1, slug: 'trip', url: 'http://localhost/s/trip' }))
        return
      }
      response.writeHead(404)
      response.end()
    } catch (error) {
      response.writeHead(500)
      response.end(String(error))
    }
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address() as AddressInfo
  const client = createCloudSyncClient(`http://127.0.0.1:${address.port}`, 'test-only-token')
  const platform = desktopPublishAssetPlatform(client, {
    localPath: (rel) => path.join(vault, rel),
    readRemote: async () => { throw new Error('not remote') }
  })
  const input = {
    note_path: 'Trip.md',
    title: 'Trip',
    markdown: '![](a.png) ![](b.png)',
    assets: [
      { ref: 'a.png', name: 'a.png', mime: 'image/png', path: 'a.png' },
      { ref: 'b.png', name: 'b.png', mime: 'image/png', path: 'b.png' }
    ]
  }
  const close = async () => {
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
  return { client, platform, input, files, puts, publishes, close }
}

it('stages attachments with streamed PUTs that carry their length, then publishes naming the upload', async () => {
  const { client, platform, input, files, puts, publishes, close } = await fixture(true)
  try {
    const result = await publishWithStagedUploads(client, input, platform)
    await publishWithStagedUploads(client, input, platform, { shareId: result.id })

    expect(puts.slice(0, 2).map((put) => put.url).sort()).toEqual(['/storage/a.png?sig=1', '/storage/b.png?sig=1'])
    for (const put of puts) {
      const expected = put.url.startsWith('/storage/a.png') ? files[0]! : files[1]!
      expect(put.headers['content-length']).toBe(String(expected.byteLength))
      expect(put.headers['transfer-encoding']).toBeUndefined()
      expect(put.headers['content-type']).toBe('image/png')
      expect(put.headers.authorization).toBeUndefined()
      expect(put.body.equals(expected)).toBe(true)
    }
    expect(publishes).toEqual([
      expect.objectContaining({ method: 'POST', files: 0, payload: expect.objectContaining({ upload_id: '01upload', asset_refs: ['a.png', 'b.png'] }) }),
      expect.objectContaining({ method: 'PUT', files: 0, payload: expect.objectContaining({ upload_id: '01upload', asset_refs: ['a.png', 'b.png'] }) })
    ])
  } finally {
    await close()
  }
})

it('publishes in one multipart request when the service answers 404 for staged uploads', async () => {
  const { client, platform, input, puts, publishes, close } = await fixture(false)
  try {
    await publishWithStagedUploads(client, input, platform)

    expect(puts).toEqual([])
    expect(publishes).toEqual([
      expect.objectContaining({ method: 'POST', files: 2, payload: expect.objectContaining({ asset_refs: ['a.png', 'b.png'] }) })
    ])
    expect(publishes[0]?.payload).not.toHaveProperty('upload_id')
  } finally {
    await close()
  }
})
