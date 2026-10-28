import { createHash, randomUUID } from 'node:crypto'
import { DmpError } from '../errors.js'
import type { DmpObject } from '../types.js'

interface Upload {
  id: string; streamId: number; sessionId: string; name: string; mime: string; size: number; sha256: string
  chunks: Buffer[]; received: number; final: boolean; timer?: ReturnType<typeof setTimeout>
}
/** Connection-local upload buffers; no unverified bytes cross the projection boundary. */
export class Uploads {
  private uploads = new Map<string, Upload>()
  private streams = new Map<number, Upload>()
  constructor(private readonly allocate: () => number, private readonly send: (frame: DmpObject) => unknown,
    private readonly commit: (sessionId: string, name: string, mime: string, bytes: Uint8Array, signal: AbortSignal) => Promise<{ attachmentId: string }>) {}
  private touch(upload: Upload): void {
    clearTimeout(upload.timer)
    upload.timer = setTimeout(() => { this.remove(upload); this.send({ t: 'stream.abort', streamId: upload.streamId, code: 'timeout' }) }, 30000)
    upload.timer.unref()
  }
  private remove(upload: Upload): void {
    clearTimeout(upload.timer); this.uploads.delete(upload.id); this.streams.delete(upload.streamId)
  }
  begin(params: DmpObject): DmpObject {
    const limit = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(String(params.mime)) ? 20 * 1024 * 1024 : 32 * 1024 * 1024
    if (Number(params.size) > limit) throw new DmpError('too-large', 'Attachment exceeds upload limit', { limit })
    if (this.uploads.size >= 3) throw new DmpError('busy')
    const upload: Upload = { id: randomUUID(), streamId: this.allocate(), sessionId: String(params.sessionId), name: String(params.name), mime: String(params.mime),
      size: Number(params.size), sha256: String(params.sha256), chunks: [], received: 0, final: false }
    this.uploads.set(upload.id, upload); this.streams.set(upload.streamId, upload); this.touch(upload)
    return { uploadId: upload.id, streamId: upload.streamId }
  }
  receive(frame: Buffer, maxChunkBytes: number): void {
    if (frame.length < 5 || frame.length - 5 > maxChunkBytes || (frame[4] & ~1)) throw new DmpError('bad-frame')
    const upload = this.streams.get(frame.readUInt32BE(0))
    if (!upload || upload.final) throw new DmpError('bad-frame')
    const bytes = frame.subarray(5)
    if (upload.received + bytes.length > upload.size) throw new DmpError('bad-frame')
    upload.chunks.push(bytes); upload.received += bytes.length; upload.final = frame[4] === 1
    this.touch(upload)
    // Ack every chunk, which is stricter than the required 1 MiB cadence.
    this.send({ t: 'stream.ack', streamId: upload.streamId, bytes: upload.received })
  }
  async finish(id: string, signal: AbortSignal): Promise<{ attachmentId: string }> {
    const upload = this.uploads.get(id)
    if (!upload) throw new DmpError('not-found')
    if (!upload.final) throw new DmpError('invalid-params', 'Upload has no final frame')
    this.remove(upload)
    if (upload.received !== upload.size) throw new DmpError('invalid-params', 'Upload size mismatch')
    const bytes = Buffer.concat(upload.chunks)
    if (createHash('sha256').update(bytes).digest('hex') !== upload.sha256) throw new DmpError('invalid-params', 'Upload hash mismatch')
    if (signal.aborted) throw new DmpError('cancelled')
    return this.commit(upload.sessionId, upload.name, upload.mime, bytes, signal)
  }
  abort(streamId: number): void { const upload = this.streams.get(streamId); if (upload) this.remove(upload) }
  dispose(): void { for (const upload of this.uploads.values()) this.remove(upload) }
}
