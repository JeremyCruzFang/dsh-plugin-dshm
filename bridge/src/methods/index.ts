import { randomUUID } from 'node:crypto'
import { methods } from 'dshm-protocol/contract'
import { DmpError } from '../errors.js'
import type { ConnectionMethods, DmpObject, MethodContext, ProjectionPeer, ProjectionWatch, Reply } from '../types.js'

export const capabilities = ['sessions', 'timeline', 'timeline.stream', 'send', 'interactions.approval', 'interactions.question', 'send.steer', 'queue.edit', 'model.select', 'permission.select', 'files.read', 'files.download', 'changes', 'deliverables', 'jobs', 'devices', 'attachments']
const implemented = new Set(['host.info', 'unsubscribe', 'sessions.list', 'sessions.watch', 'workspaces.list', 'sessions.create',
  'session.watch', 'session.history', 'session.send', 'session.interrupt', 'interactions.list', 'interaction.answer', 'tool.output', 'timeline.text', 'session.queue.update', 'models.catalog', 'session.setModel', 'permissions.catalog', 'session.setPermission', 'files.list', 'files.read', 'files.stat', 'files.download', 'changes.summary', 'changes.diff', 'deliverables.list', 'deliverables.download', 'jobs.watch', 'job.watch', 'devices.list', 'devices.watch', 'devices.rename', 'devices.revoke', 'attachments.begin', 'attachments.finish', 'push.register', 'push.unregister'])
const maxFrameBytes = 1048576
const clone = <T>(value: T): T => structuredClone(value)
const encodedSize = (result: DmpObject) => Buffer.byteLength(JSON.stringify({ t: 'res', id: Number.MAX_SAFE_INTEGER, ok: true, result }))
const orderSeq = (value: unknown): number => {
  const item = value as { order: { seq: number } }
  return item.order.seq
}

/** Remove oldest complete display groups until a snapshot/page fits. */
export function fitPage(result: DmpObject): DmpObject {
  const out = clone(result)
  if (encodedSize(out) <= maxFrameBytes) return out
  if (!Array.isArray(out.items) || out.resumed === true) throw new DmpError('too-large', 'Snapshot exceeds the frame budget', { limit: maxFrameBytes })
  const items = out.items as unknown[]
  while (items.length && encodedSize(out) > maxFrameBytes) {
    const oldest = Math.min(...items.map(orderSeq))
    const keep = items.filter(item => orderSeq(item) !== oldest)
    if (!keep.length) throw new DmpError('too-large', 'A complete display group exceeds the frame budget', { limit: maxFrameBytes })
    out.items = keep; items.splice(0, items.length, ...keep); out.items = items; out.hasMoreBefore = true
  }
  if (encodedSize(out) > maxFrameBytes) throw new DmpError('too-large', 'Snapshot metadata exceeds the frame budget', { limit: maxFrameBytes })
  return out
}

interface Creation {
  key: string
  parameters: string
  sessionId: string
  expires: number
  created: boolean
  prompted: boolean
  inFlight?: Promise<DmpObject>
}
export class CreationLedger {
  private entries = new Map<string, Creation>()
  async create(deviceId: string, params: DmpObject, peer: ProjectionPeer): Promise<DmpObject> {
    for (const [id, entry] of this.entries) if (!entry.inFlight && entry.expires <= Date.now()) this.entries.delete(id)
    const key = `${deviceId}:${params.sendId}`
    const parameters = JSON.stringify({ workspaceId: params.workspaceId, ...(params.text !== undefined ? { text: params.text } : {}) })
    const old = this.entries.get(key)
    if (old && old.expires <= Date.now()) this.entries.delete(key)
    let entry = this.entries.get(key)
    if (entry && entry.parameters !== parameters) throw new DmpError('conflict', 'sendId already names different creation parameters')
    if (!entry) {
      entry = { key, parameters, sessionId: randomUUID(), expires: Date.now() + 86400000, created: false, prompted: false }
      this.entries.set(key, entry)
    }
    if (entry.inFlight) return entry.inFlight
    const target = entry
    // Socket cancellation must not forget a creation that may already exist.
    // The target identity is reserved before crossing the native boundary.
    const signal = AbortSignal.timeout(30000)
    target.inFlight = (async () => {
      if (!target.created) {
        const snapshot = await peer.request('sessions.list', {}, signal)
        const existing = (snapshot.sessions as Array<{ sessionId: string }>).some(item => item.sessionId === target.sessionId)
        if (!existing) await peer.create(String(params.workspaceId), target.sessionId, signal)
        target.created = true
      }
      if (typeof params.text === 'string' && params.text.length && !target.prompted) {
        await peer.request('session.send', { sessionId: target.sessionId, sendId: params.sendId, text: params.text, mode: 'queue' }, signal)
        target.prompted = true
      }
      return { sessionId: target.sessionId }
    })()
    try { return await target.inFlight } finally { target.inFlight = undefined }
  }
}

export function createMethods(peer: ProjectionPeer, context: MethodContext, ledger: CreationLedger): ConnectionMethods {
  const subscriptions = new Map<string, ProjectionWatch>()
  let disposed = false
  const dispose = async () => {
    if (disposed) return
    disposed = true
    await Promise.allSettled([...subscriptions.values()].map(watch => watch.dispose()))
    subscriptions.clear()
    await peer.dispose()
  }
  return {
    dispose,
    async upload(sessionId, name, mime, bytes, signal) {
      if (disposed) throw new DmpError('dsh-unavailable')
      return peer.upload(sessionId, name, mime, bytes, signal)
    },
    async request(method: string, params: DmpObject, signal: AbortSignal): Promise<Reply> {
      if (disposed) throw new DmpError('dsh-unavailable')
      const removingPush = method === 'push.unregister' && context.push
      if (!implemented.has(method) || !removingPush && methods[method]?.cap && !context.identity.caps.includes(methods[method].cap!)) throw new DmpError('unsupported')
      if (method === 'host.info') return { result: { host: context.identity.host, bridgeVersion: context.identity.version,
        dshVersion: context.identity.dshVersion, dshStatus: context.identity.dshStatus, caps: context.identity.caps, time: new Date().toISOString() } }
      if (method === 'push.register' || method === 'push.unregister') {
        if (!context.push) throw new DmpError('unsupported')
        if (method === 'push.register') context.push.register(context.deviceId, params)
        else context.push.unregister(context.deviceId)
        return { result: {} }
      }
      if (method === 'unsubscribe') {
        const id = String(params.subId), watch = subscriptions.get(id)
        subscriptions.delete(id); await watch?.dispose()
        return { result: {} }
      }
      if (method === 'devices.list') return { result: { devices: context.devices.list() } }
      if (method === 'devices.rename') return { result: { device: context.devices.rename(String(params.deviceId), String(params.name)) } }
      if (method === 'devices.revoke') { context.devices.revoke(String(params.deviceId)); return { result: {} } }
      if (method === 'devices.watch') {
        const subId = randomUUID()
        const stop = context.devices.watch(() => {
          if (!disposed && subscriptions.has(subId)) context.emit(subId, { kind: 'devices.replace', data: { devices: context.devices.list() } })
        })
        subscriptions.set(subId, { result: {}, dispose: stop })
        return { result: { subId, devices: context.devices.list() } }
      }
      if (method === 'attachments.begin') {
        await peer.request(method, params, signal)
        return { result: context.uploads.begin(params) }
      }
      if (method === 'attachments.finish') return { result: await context.uploads.finish(String(params.uploadId), signal) }
      if (method === 'sessions.create') return { result: await ledger.create(context.deviceId, params, peer) }
      if (method === 'session.send') {
        if (params.mode === 'steer' && !context.identity.caps.includes('send.steer') || Array.isArray(params.attachments) && params.attachments.length && !context.identity.caps.includes('attachments')) throw new DmpError('unsupported')
        if ((typeof params.text !== 'string' || !params.text.trim()) && !(Array.isArray(params.attachments) && params.attachments.length)) throw new DmpError('invalid-params', 'Text must not be empty')
      }
      if (method === 'tool.output' || method === 'timeline.text' || method === 'files.download' || method === 'deliverables.download') return { bytes: await peer.content(method, params, signal), mime: method === 'files.download' || method === 'deliverables.download' ? 'application/octet-stream' : 'text/plain; charset=utf-8' }
      if (method === 'sessions.watch' || method === 'session.watch' || method === 'jobs.watch' || method === 'job.watch') {
        const subId = randomUUID()
        const pending: Array<Parameters<MethodContext['emit']>[1]> = []
        let ready = false
        const emit = (event: Parameters<MethodContext['emit']>[1]) => {
          if (disposed || signal.aborted) return
          if (!ready) pending.push(event)
          else if (subscriptions.has(subId)) context.emit(subId, event)
        }
        let watch = await peer.watch(method, params, emit, signal)
        let result: DmpObject
        try { result = fitPage({ ...watch.result, subId }) }
        catch (error) {
          await watch.dispose()
          if (method !== 'session.watch' || watch.result.resumed !== true) throw error
          // A resume merge cannot drop changed items. Reopen as a fresh window.
          pending.length = 0
          const { sinceSeq: _sinceSeq, ...fresh } = params
          watch = await peer.watch(method, fresh, emit, signal)
          try { result = fitPage({ ...watch.result, subId }) } catch (retryError) { await watch.dispose(); throw retryError }
        }
        if (disposed || signal.aborted) { await watch.dispose(); throw new DmpError('cancelled') }
        const stopWatching = method === 'session.watch' ? context.push?.watch(String(params.sessionId)) : undefined
        subscriptions.set(subId, { ...watch, async dispose() { stopWatching?.(); await watch.dispose() } })
        // The RPC response gets enqueued before live events from the new watch.
        setImmediate(() => { ready = true; if (!disposed && subscriptions.has(subId)) for (const event of pending) context.emit(subId, event); pending.length = 0 })
        return { result }
      }
      const result = await peer.request(method, params, signal)
      return { result: method === 'session.history' ? fitPage(result) : result }
    },
  }
}
