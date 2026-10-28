import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { homedir } from 'node:os'
import type { ContentMethod, DmpEvent, DmpObject, ProjectionHost, ProjectionPeer, ProjectionWatch, WatchMethod } from '../types.js'
import { createProjectionFold, type Fold, type FoldState, type NativeRecord } from './fold-recording.mjs'
import { FileProjection } from './files.js'
import { interactionIdentity, expectedInteractionIds } from './interactions.js'

// This file is the carrier boundary. No native namespace or service type escapes.
interface NativePeer { dispose(): Promise<void> | void }
interface Context {
  permissionPresets: { resolve(preset: string): { approval: string } }
  connection: {
    createPeer(options: { principal: { kind: 'owner' }; interactions: 'answer' }): NativePeer
    createSharedFetchHandler(prefix: string): { fetch(request: Request, peer: NativePeer): Promise<Response> }
  }
  typertGateway: {
    invoke(options: { namespace: string; method: string; args: DmpObject; peer: NativePeer; signal: AbortSignal }): Promise<unknown>
    wireStream: { open(endpoint: string, payload: { args: DmpObject }, uplink: AsyncIterable<never>, peer: NativePeer, signal: AbortSignal): Promise<AsyncIterable<unknown>> }
  }
  on(event: 'dispose', handler: () => void | Promise<void>): void
}
const object = (value: unknown): DmpObject => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as DmpObject : {}
const array = (value: unknown): unknown[] => Array.isArray(value) ? value : []
const string = (value: unknown, fallback = ''): string => typeof value === 'string' ? value : fallback
const number = (value: unknown, fallback = 0): number => typeof value === 'number' && Number.isFinite(value) ? value : fallback
const iso = (value: unknown) => new Date(number(value)).toISOString()
const clone = <T>(value: T): T => structuredClone(value)
const fault = (code: string, message = code) => Object.assign(new Error(message), { code })
const empty = async function* (): AsyncGenerator<never> {}
async function observe<T>(work: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return work
  signal.throwIfAborted()
  let abort!: () => void
  const cancelled = new Promise<never>((_, reject) => { abort = () => reject(fault('cancelled')); signal.addEventListener('abort', abort, { once: true }) })
  try { return await Promise.race([work, cancelled]) } finally { signal.removeEventListener('abort', abort) }
}
const signalFor = (lifetime: AbortSignal, request?: AbortSignal) => AbortSignal.any([lifetime, ...(request ? [request] : []), AbortSignal.timeout(30000)])
const order = (left: DmpObject, right: DmpObject) => number(object(left.order).seq) - number(object(right.order).seq) || number(object(left.order).index) - number(object(right.order).index)
function mapped(error: unknown): Error {
  const code = string(object(error).code)
  const message = string(object(error).message)
  // The registry's observation methods throw plain errors for removed or
  // foreign jobs. Do not expose registry diagnostics or report them as a
  // server fault when a foreground job has already left the live roster.
  if (/^unknown job /.test(message) || /^job .+ belongs to another session$/.test(message)) return fault('not-found')
  if (code === 'gateway/bad-request' || code.startsWith('gateway/input') || code.startsWith('gateway/arguments')) return fault('invalid-params')
  if (code.includes('not-found')) return fault('not-found')
  if (code.includes('busy')) return fault('busy')
  if (code === 'session/steer-unavailable' || code.includes('conflict')) return fault('conflict')
  if (code === 'session/model-unavailable' || code === 'session/attachment-invalid') return fault('invalid-params')
  if (code.includes('cancelled') || object(error).name === 'AbortError') return fault('cancelled')
  if (object(error).name === 'TimeoutError') return fault('timeout')
  if (code.includes('peer-disposed')) return fault('dsh-unavailable')
  if (['not-found', 'conflict', 'invalid-params', 'too-large', 'unsupported'].includes(code)) return error as Error
  return fault('internal', 'DSH operation failed')
}

interface SessionState {
  id: string
  metadata: DmpObject
  fold: Fold
  records: NativeRecord[]
  nativeSeq: number
  listeners: Set<(event: DmpEvent) => void>
  ready: Promise<void>
  followReady: boolean
  cancel: AbortController
  changed: Set<() => void>
  identifying: Set<string>
  expiredInteractions: Set<string>
}
interface Delivery { id: string; nativeId: string; sessionId: string; value: DmpObject; answered: boolean }
interface Attachment { deviceId: string; sessionId: string; content: DmpObject; size: number; expires: number; sendId?: string }
interface Diagnostics { createdPeers: number; disposedPeers: number; activePeers: number }
export const inject = ['connection', 'typertGateway', 'sessionController', 'permissionPresets']
export function onDispose(context: unknown, handler: () => void | Promise<void>): void { (context as Context).on('dispose', handler) }

export function createProjectionHost(context: unknown): ProjectionHost & { diagnostics(): Diagnostics } {
  const ctx = context as Context
  let version = 'unknown'
  for (const base of [process.argv[1], process.execPath].filter((value): value is string => Boolean(value))) {
    try {
      const loader = createRequire(resolve(base))
      const entry = loader.resolve('@deepseek-ai/dsh-app-boot')
      let directory = dirname(entry)
      for (let depth = 0; depth < 4; depth++, directory = dirname(directory)) {
        try {
          const manifest = object(JSON.parse(readFileSync(resolve(directory, 'package.json'), 'utf8')))
          if (manifest.name === '@deepseek-ai/dsh-app-boot') { version = string(manifest.version, 'unknown'); break }
        } catch { /* Only package metadata candidates; never inspect user state. */ }
      }
      if (version !== 'unknown') break
    } catch { /* The bundle may not run under a DSH CLI carrier. */ }
  }
  const status = version === '0.2.1-rc.3' ? 'ok' : 'incompatible'
  const diagnostics: Diagnostics = { createdPeers: 0, disposedPeers: 0, activePeers: 0 }
  const peers = new Set<LivePeer>()
  const attachments = new Map<string, Attachment>()
  return {
    version, status,
    async connect(deviceId) {
      if (status !== 'ok') throw fault('dsh-incompatible')
      const native = ctx.connection.createPeer({ principal: { kind: 'owner' }, interactions: 'answer' })
      diagnostics.createdPeers++; diagnostics.activePeers++
      const peer = new LivePeer(ctx, native, deviceId, attachments, () => { peers.delete(peer); diagnostics.disposedPeers++; diagnostics.activePeers-- })
      peers.add(peer)
      try { await peer.start(); return peer } catch (error) { await peer.dispose(); throw mapped(error) }
    },
    async dispose() { await Promise.all([...peers].map(peer => peer.dispose())); attachments.clear() },
    diagnostics: () => ({ ...diagnostics }),
  }
}

export class LivePeer implements ProjectionPeer {
  private lifetime = new AbortController()
  private streams = new Set<Promise<void>>()
  private workspaces = new Map<string, DmpObject>()
  private nativeSummaries = new Map<string, DmpObject>()
  private sessions = new Map<string, SessionState>()
  private deliveries = new Map<string, Delivery>()
  private listListeners = new Set<(event: DmpEvent) => void>()
  private clientId = ''
  private disposed = false
  private archived = new Set<string>()
  private pinned = new Set<string>()
  private files: FileProjection
  constructor(private ctx: Context, private peer: NativePeer, private deviceId: string, private attachments: Map<string, Attachment>, private onDisposed: () => void) {
    this.files = new FileProjection({
      home: resolve(process.env.DSH_HOME ?? resolve(homedir(), '.dsh')),
      session: async (id, signal) => { const state = await this.ensure(id, signal); return { cwd: string(state.metadata.cwd), records: state.records } },
      call: (namespace, method, args, signal) => this.rawCall(namespace, method, args, signal),
      fetch: request => this.ctx.connection.createSharedFetchHandler('/api').fetch(request, this.peer),
      changeState: (id, seq, value) => { const state = this.sessions.get(id); if (state) this.accept(state, { source: 'change-state', frame: { seq, ...value }, atMs: 0 }) },
    })
  }

  private rawCall(namespace: string, method: string, args: DmpObject, signal?: AbortSignal): Promise<unknown> {
    return this.ctx.typertGateway.invoke({ namespace, method, args, peer: this.peer, signal: signalFor(this.lifetime.signal, signal) })
  }
  private async call(namespace: string, method: string, args: DmpObject, signal?: AbortSignal): Promise<DmpObject> {
    try { return object(await this.rawCall(namespace, method, args, signal)) }
    catch (error) { throw mapped(error) }
  }
  private startStream(endpoint: string, args: DmpObject, consume: (frame: DmpObject) => void | Promise<void>, readyType: string, cancel = this.lifetime, onFailure?: () => void): Promise<void> {
    let resolveReady!: () => void, rejectReady!: (error: unknown) => void
    const ready = new Promise<void>((resolve, reject) => { resolveReady = resolve; rejectReady = reject })
    const work = (async () => {
      try {
        const stream = await this.ctx.typertGateway.wireStream.open(endpoint, { args }, empty(), this.peer, cancel.signal)
        for await (const raw of stream) {
          const frame = object(raw)
          await consume(frame)
          if (frame.type === readyType) resolveReady()
        }
        if (!cancel.signal.aborted) { onFailure?.(); rejectReady(fault('dsh-unavailable')) }
      } catch (error) { if (!cancel.signal.aborted) onFailure?.(); rejectReady(cancel.signal.aborted ? fault('cancelled') : mapped(error)) }
    })()
    this.streams.add(work); void work.finally(() => this.streams.delete(work))
    return Promise.race([ready, new Promise<void>((_, reject) => {
      const timer = setTimeout(() => reject(fault('timeout')), 15000)
      void ready.then(() => clearTimeout(timer), () => clearTimeout(timer))
    })])
  }
  async start(): Promise<void> {
    await Promise.all([
      this.startStream('workspace/follow', {}, frame => this.workspaceFrame(frame), 'baseline'),
      this.startStream('session/control', {}, frame => this.controlFrame(frame), 'baseline'),
      this.startStream('$events', {}, frame => this.eventFrame(frame), 'ready'),
    ])
    await this.refresh()
  }
  private workspaceFrame(frame: DmpObject): void {
    if (frame.type === 'baseline' || frame.type === 'replace') {
      const value = object(frame.value), before = new Set(this.workspaces.keys())
      this.workspaces.clear()
      for (const raw of array(value.items)) { const workspace = object(raw); this.workspaces.set(string(workspace.workspaceId), workspace); before.delete(string(workspace.workspaceId)); this.listEmit('workspace.upsert', { workspace: this.workspace(workspace) }) }
      for (const workspaceId of before) this.listEmit('workspace.remove', { workspaceId })
      this.archived = new Set(array(value.archivedSessionIds).map(value => string(value)))
      this.pinned = new Set(array(value.pinnedSessionIds).map(value => string(value)))
    } else if (frame.type === 'upsert') {
      const workspace = object(frame.workspace); this.workspaces.set(string(workspace.workspaceId), workspace); this.listEmit('workspace.upsert', { workspace: this.workspace(workspace) })
    } else if (frame.type === 'remove') { this.workspaces.delete(string(frame.workspaceId)); this.listEmit('workspace.remove', { workspaceId: frame.workspaceId }) }
    else if (frame.type === 'archived') this.archived = new Set(array(frame.archivedSessionIds).map(value => string(value)))
    else if (frame.type === 'pinned') this.pinned = new Set(array(frame.pinnedSessionIds).map(value => string(value)))
    if (['archived', 'pinned'].includes(string(frame.type))) for (const summary of this.nativeSummaries.values()) this.listEmit('session.upsert', { session: this.summary(summary) })
  }
  private controlFrame(frame: DmpObject): void {
    if (frame.type === 'baseline') {
      for (const [sessionId, block] of Object.entries(object(object(frame.value).projections))) {
        const state = this.sessions.get(sessionId)
        if (state && object(block).values) this.queueFrom(state, object(object(block).values).inbox)
      }
    } else if (frame.type === 'projection') {
      const state = this.sessions.get(string(frame.sessionId))
      if (state && frame.key === 'inbox') this.queueFrom(state, frame.value)
      if (state && frame.key === 'permissions') this.accept(state, { source: 'permission', frame: { current: object(frame.value).currentValue }, atMs: 0 })
      if (frame.key === 'title') {
        const summary = this.nativeSummaries.get(string(frame.sessionId))
        if (summary) { const projections = object(summary.projections); const values = object(projections.values); values.title = frame.value; summary.projections = { ...projections, values }; this.listEmit('session.upsert', { session: this.summary(summary) }) }
      }
    }
  }
  private async eventFrame(frame: DmpObject): Promise<void> {
    if (frame.type === 'ready') { this.clientId = string(frame.clientId); return }
    if (frame.type === 'waterfall' && ['approval/request', 'user-questions/request'].includes(string(frame.event))) {
      const sessionId = string(frame.agentId)
      const state = await this.ensure(sessionId)
      const request = object(frame.request)
      const nativeId = string(frame.eventId)
      state.identifying.add(nativeId)
      let identity
      try { identity = await this.waitForProjection(state, () => interactionIdentity(sessionId, string(frame.event), request, state.records)) }
      catch (error) { if (state.cancel.signal.aborted) return; throw error }
      finally { state.identifying.delete(nativeId) }
      if (!identity) {
        this.expireMissingInteractions(state)
        this.accept(state, { source: 'interaction-warning', frame: { kind: frame.event === 'approval/request' ? 'approval' : 'question', status: this.summary(this.nativeSummaries.get(sessionId) ?? { sessionId }).status }, atMs: 0 })
        return
      }
      const { id, callId } = identity
      const previous = this.deliveries.get(id)
      const delivery: Delivery = previous ?? { id, nativeId: '', sessionId, value: frame, answered: false }
      delivery.nativeId = nativeId; delivery.value = frame
      this.deliveries.set(id, delivery)
      state.expiredInteractions.delete(id)
      // Redelivery refreshes routing, not the interaction's identity or lifetime.
      if (!previous) this.accept(state, { source: 'interaction', frame: { ...frame, eventId: id, request: { ...request, ...(callId ? { callId } : {}) } }, atMs: 0 })
      else for (const changed of state.changed) changed()
    } else if (frame.type === 'cancel') {
      const delivery = [...this.deliveries.values()].find(value => value.nativeId === frame.eventId)
      if (delivery) {
        if (!delivery.answered) {
          const state = this.sessions.get(delivery.sessionId)
          if (state) this.accept(state, { source: 'interaction', frame: { type: 'cancel', eventId: delivery.id }, atMs: 0 })
        }
        this.deliveries.delete(delivery.id)
      }
    } else if (frame.type === 'emit' && string(frame.event).startsWith('api-session/')) {
      const args = array(frame.args), id = string(args[0])
      if (frame.event === 'api-session/removed') { this.nativeSummaries.delete(id); this.sessions.get(id)?.cancel.abort(); this.sessions.delete(id); this.listEmit('session.remove', { sessionId: id }); return }
      // A cold-safe list read also refreshes titles, activity, and running state.
      await this.refresh()
    }
  }
  private listEmit(kind: string, data: DmpObject): void { for (const emit of this.listListeners) emit({ kind, data }) }
  private workspace(value: DmpObject): DmpObject { return { workspaceId: value.workspaceId, title: string(value.title), path: string(value.path), updatedAt: iso(value.updatedAt) } }
  private summary(value: DmpObject): DmpObject {
    const id = string(value.sessionId), values = object(object(value.projections).values)
    const cached = this.sessions.get(id)?.fold.state()
    const pending = [...this.deliveries.values()].filter(delivery => delivery.sessionId === id && !delivery.answered).length
    const workspace = [...this.workspaces.values()].find(workspace => array(workspace.sessionIds).includes(id) || workspace.path === value.cwd)
    const model = object(values.modelSelection), selected = object(model.next ?? model.lastUsed)
    return {
      sessionId: id, title: typeof values.title === 'string' ? values.title : null,
      status: pending ? 'needs-input' : value.running ? 'running' : object(cached?.session.summary).status === 'error' ? 'error' : 'idle',
      pendingInteractions: pending, updatedAt: iso(value.updatedAt), archived: this.archived.has(id), pinned: this.pinned.has(id),
      ...(workspace ? { workspaceId: workspace.workspaceId } : {}), ...(value.parentSessionId ? { parentSessionId: value.parentSessionId } : {}),
      ...(selected.provider && selected.model ? { model: { provider: selected.provider, model: selected.model, ...(selected.reasoningEffort ? { effort: selected.reasoningEffort } : {}) } } : {}),
    }
  }
  private async refresh(signal?: AbortSignal): Promise<void> {
    const result = await this.call('session', 'list', { _request: {} }, signal)
    const seen = new Set<string>()
    for (const raw of array(result.items)) { const value = object(raw), id = string(value.sessionId); seen.add(id); this.nativeSummaries.set(id, value); this.listEmit('session.upsert', { session: this.summary(value) }) }
    for (const id of this.nativeSummaries.keys()) if (!seen.has(id)) { this.nativeSummaries.delete(id); this.listEmit('session.remove', { sessionId: id }) }
  }
  private queueFrom(state: SessionState, value: unknown): void {
    if (value && typeof value === 'object') this.accept(state, { source: 'queue', frame: object(value), atMs: 0 })
  }
  private accept(state: SessionState, record: NativeRecord, emit = true): void {
    record.nativeSeq = state.nativeSeq
    state.records.push(clone(record))
    for (const entry of state.fold.accept(record)) {
      if (entry.from !== 'server' || entry.frame.t !== 'ev') continue
      const event = { kind: string(entry.frame.kind), data: object(entry.frame.data) }
      if (emit) for (const listener of state.listeners) listener(event)
      if (event.kind === 'session.update') this.listEmit('session.upsert', { session: object(event.data.session).summary })
    }
    for (const changed of state.changed) changed()
  }
  private async waitForProjection<T>(state: SessionState, probe: () => T | undefined, signal?: AbortSignal, deadline = Date.now() + 2000): Promise<T | undefined> {
    const cancellation = AbortSignal.any([this.lifetime.signal, state.cancel.signal, ...(signal ? [signal] : [])])
    cancellation.throwIfAborted()
    const initial = probe()
    if (initial !== undefined) return initial
    return new Promise<T | undefined>((resolve, reject) => {
      const finish = (error?: Error, value?: T) => {
        clearTimeout(timer); state.changed.delete(check); cancellation.removeEventListener('abort', abort)
        if (error) reject(error); else resolve(value)
      }
      const check = () => { try { const value = probe(); if (value !== undefined) finish(undefined, value) } catch (error) { finish(error as Error) } }
      const abort = () => finish(fault('cancelled'))
      const timer = setTimeout(() => finish(), Math.max(0, deadline - Date.now()))
      state.changed.add(check); cancellation.addEventListener('abort', abort, { once: true })
      check()
    })
  }
  private expireMissingInteractions(state: SessionState): void {
    const ids = expectedInteractionIds(state.id, state.records).filter(id => !this.deliveries.has(id) && !state.expiredInteractions.has(id))
    for (const id of ids) state.expiredInteractions.add(id)
    if (ids.length) this.accept(state, { source: 'interaction-expire', frame: { ids, status: this.summary(this.nativeSummaries.get(state.id) ?? { sessionId: state.id }).status }, atMs: 0 })
  }
  private async interactionsReady(state: SessionState, signal?: AbortSignal, deadline = Date.now() + 2000): Promise<void> {
    const ready = await this.waitForProjection(state, () => state.followReady && !state.identifying.size &&
      expectedInteractionIds(state.id, state.records).every(id => this.deliveries.has(id) || state.expiredInteractions.has(id)) ? true : undefined, signal, deadline)
    // A durable audit can outlive its native waterfall after a crash. Keep the
    // session readable, but never present an unanswerable row as live.
    if (!ready) this.expireMissingInteractions(state)
  }
  private async loadChanges(state: SessionState, seq: number): Promise<DmpObject> {
    const url = new URL('http://localhost/api/changes.summary')
    url.search = new URLSearchParams({ sessionId: state.id, seq: String(seq) }).toString()
    try {
      const response = await this.ctx.connection.createSharedFetchHandler('/api').fetch(new Request(url, { signal: signalFor(this.lifetime.signal, state.cancel.signal) }), this.peer)
      if (response.ok) {
        const value = object(await response.json())
        return { seq, available: true, fileCount: number(value.total, array(value.files).length), added: number(value.added), deleted: number(value.deleted) }
      }
    } catch { /* Keep unavailable until the process-local snapshot is confirmed. */ }
    return { seq, available: false }
  }
  private async acceptNative(state: SessionState, frame: DmpObject, emit: boolean): Promise<void> {
    const event = object(frame.event)
    if (event.type !== 'workspace/changes') { this.accept(state, { source: 'session', frame, atMs: 0 }, emit); return }
    // Resolve the process-local snapshot before advancing the native watermark.
    // A concurrent watch/resume must never observe a provisional changes item
    // at the same sequence as its later hydrated replacement.
    const change = await this.loadChanges(state, number(event.seq))
    this.accept(state, { source: 'session', frame, atMs: 0 }, false)
    this.accept(state, { source: 'change-state', frame: change, atMs: 0 }, emit)
  }
  private async ensure(id: string, signal?: AbortSignal): Promise<SessionState> {
    const existing = this.sessions.get(id)
    if (existing) { await observe(existing.ready, signal); return existing }
    if (!this.nativeSummaries.has(id)) await this.refresh()
    // Redelivery and watch can both await the same cold list refresh. Only one
    // follow/fold may own this session after that asynchronous boundary.
    const concurrent = this.sessions.get(id)
    if (concurrent) { await observe(concurrent.ready, signal); return concurrent }
    const native = this.nativeSummaries.get(id)
    if (!native) throw fault('not-found')
    const metadata: DmpObject = { live: true, scenario: 'live', sessionId: id, title: null, recordedAt: iso(native.updatedAt), summary: this.summary(native), cwd: native.cwd }
    const state: SessionState = { id, metadata, fold: createProjectionFold(metadata), records: [], nativeSeq: -1, listeners: new Set(), ready: Promise.resolve(), followReady: false, cancel: new AbortController(), changed: new Set(), identifying: new Set(), expiredInteractions: new Set() }
    this.lifetime.signal.addEventListener('abort', () => state.cancel.abort(), { once: true })
    this.sessions.set(id, state)
    state.ready = this.startStream('session/follow', { request: { address: { kind: 'session', sessionId: id }, assistantStream: true, maxMessages: 200 } }, async frame => {
      if (frame.type === 'snapshot') {
        const cursor = number(frame.cursor, -1)
        let records = array(frame.records).map(object)
        let hasMore = Boolean(frame.hasMore), pages = 0
        while (hasMore) {
          state.cancel.signal.throwIfAborted()
          if (++pages > 500) throw fault('too-large')
          const first = number(object(records[0]?.event).seq, cursor + 1)
          const page = await this.call('session', 'page', { request: { address: { kind: 'session', sessionId: id }, throughSeq: cursor, beforeSeq: first, maxMessages: 200 } }, state.cancel.signal)
          const older = array(page.records).map(object)
          if (!older.length && page.hasMore) throw fault('dsh-incompatible')
          records = [...older, ...records]; hasMore = Boolean(page.hasMore)
        }
        state.fold = createProjectionFold(metadata); state.records = []; state.nativeSeq = -1
        for (const raw of records) {
          const event = object(raw.event), seq = number(event.seq, -1)
          if (seq <= state.nativeSeq) continue
          state.nativeSeq = seq; await this.acceptNative(state, raw, false)
        }
        state.nativeSeq = cursor
        const projectionValues = object(object(frame.projections).values)
        this.queueFrom(state, projectionValues.inbox)
        if (object(projectionValues.permissions).currentValue) this.accept(state, { source: 'permission', frame: { current: object(projectionValues.permissions).currentValue }, atMs: 0 }, false)
        // The follow snapshot may carry an in-progress assistant stream baseline.
        for (const item of array(object(frame.assistantStream).frames)) this.accept(state, { source: 'session', frame: { type: 'assistant-stream', frame: object(item) }, atMs: 0 }, false)
      } else if (frame.type === 'event') {
        const seq = number(object(frame.event).seq, -1)
        if (seq <= state.nativeSeq) return
        if (state.nativeSeq >= 0 && seq !== state.nativeSeq + 1) {
          throw fault('dsh-unavailable')
        }
        state.nativeSeq = seq; await this.acceptNative(state, frame, true)
      } else if (frame.type === 'assistant-stream') this.accept(state, { source: 'session', frame, atMs: 0 })
    }, 'snapshot', state.cancel, () => {
      if (this.sessions.get(id) !== state) return
      this.sessions.delete(id)
      for (const emit of state.listeners) emit({ kind: 'session.reset', data: { reason: 'rewritten' } })
      state.cancel.abort()
    })
    state.ready = state.ready.then(() => { state.followReady = true; for (const changed of state.changed) changed() })
    try { await observe(state.ready, signal); return state } catch (error) { if (!signal?.aborted) { this.sessions.delete(id); state.cancel.abort() } throw error }
  }

  private window(state: FoldState, params: DmpObject): DmpObject {
    const since = params.sinceSeq
    const resumed = typeof since === 'number' && since >= -1 && state.throughSeq >= since && state.throughSeq - since <= 2000
    let items = state.inlineItems.sort(order)
    let hasMoreBefore = false
    if (resumed) items = items.filter(item => number(item.seq) > since)
    else {
      const window = object(params.window), minItems = number(window.minItems, 30), turns = number(window.turns, 3)
      const latestTurn = Math.max(0, ...items.map(item => number(item.turn)))
      const turnStart = items.findIndex(item => number(item.turn) >= Math.max(1, latestTurn - turns + 1))
      const start = Math.min(Math.max(0, items.length - minItems), turnStart < 0 ? items.length : turnStart)
      hasMoreBefore = start > 0; items = items.slice(start)
    }
    const removedItemIds = resumed ? state.removed.filter(([, seq]) => seq > since).map(([id]) => id) : []
    const result: DmpObject = { session: state.session, items, cursor: { throughSeq: state.throughSeq }, hasMoreBefore, resumed, removedItemIds, interactions: state.interactions, queue: state.queue }
    if (resumed && Buffer.byteLength(JSON.stringify(result)) > 950000) return this.window(state, {})
    while (Buffer.byteLength(JSON.stringify(result)) > 950000 && items.length > 1) {
      const firstSeq = number(object(items[0]?.order).seq)
      items = items.filter(item => number(object(item.order).seq) !== firstSeq)
      result.items = items; result.hasMoreBefore = true
    }
    if (Buffer.byteLength(JSON.stringify(result)) > 950000) throw fault('too-large')
    return result
  }
  async watch(method: WatchMethod, params: DmpObject, emit: (event: DmpEvent) => void, signal: AbortSignal): Promise<ProjectionWatch> {
    signal.throwIfAborted()
    if (method === 'jobs.watch' || method === 'job.watch') return this.watchJobs(method, params, emit, signal)
    if (method === 'sessions.watch') {
      await this.refresh(signal)
      const filtered = (event: DmpEvent) => {
        if (event.kind === 'session.upsert' && object(event.data.session).archived && !params.includeArchived) emit({ kind: 'session.remove', data: { sessionId: object(event.data.session).sessionId } })
        else emit(event)
      }
      this.listListeners.add(filtered)
      return { result: this.list(Boolean(params.includeArchived)), dispose: () => { this.listListeners.delete(filtered) } }
    }
    const state = await this.ensure(string(params.sessionId), signal)
    await this.interactionsReady(state, signal)
    const result = this.window(state.fold.state(), params)
    state.listeners.add(emit)
    return { result, dispose: () => { state.listeners.delete(emit) } }
  }
  private list(includeArchived = false): DmpObject { return { workspaces: [...this.workspaces.values()].map(value => this.workspace(value)), sessions: [...this.nativeSummaries.values()].map(value => this.summary(value)).filter(value => includeArchived || !value.archived) } }
  async create(workspaceId: string, sessionId: string, signal: AbortSignal): Promise<{ sessionId: string }> {
    if (!this.workspaces.has(workspaceId)) throw fault('not-found')
    await this.refresh(signal)
    if (this.nativeSummaries.has(sessionId)) return { sessionId }
    const result = await this.call('session', 'create', { request: { workspaceId, sessionId } }, signal)
    await this.refresh(signal)
    return { sessionId: string(result.sessionId) }
  }
  private model(selected: DmpObject): DmpObject { return { provider: selected.provider, model: selected.model, ...(selected.reasoningEffort ? { effort: selected.reasoningEffort } : {}) } }
  private async permissions(signal: AbortSignal): Promise<DmpObject> {
    const catalog = await this.call('permissionPresets', 'catalog', {}, signal)
    return { options: array(catalog.options).map(object).filter(option => option.value !== 'custom').map(option => ({
      preset: option.value, label: string(option.name, string(option.value)),
      ...(option.description ? { description: option.description } : {}),
      // The native display catalog omits this policy. Resolve the advertised
      // preset through its canonical read-only service, never infer from names.
      approval: this.ctx.permissionPresets.resolve(string(option.value)).approval,
    })), defaultPreset: catalog.defaultPreset }
  }
  private job(state: SessionState, native: DmpObject): DmpObject {
    const registration = state.records.find(record => record.source === 'session' && object(record.frame.event).type === 'job/registered' && object(object(record.frame.event).data).jobId === native.id)
    const callId = object(object(object(registration?.frame.event).data).toolCall).callId
    return { jobId: native.id, title: string(native.label), status: native.status === 'stopping' ? 'running' : native.status,
      output: { earliest: number(object(native.output).earliest), total: number(object(native.output).total) },
      ...(native.owner ? { sessionId: native.owner } : {}), ...(callId ? { toolCallId: callId } : {}),
      ...(typeof native.startedAt === 'number' ? { startedAt: iso(native.startedAt) } : {}),
      ...(typeof native.finishedAt === 'number' ? { endedAt: iso(native.finishedAt) } : {}),
    }
  }
  private async reconcileJob(state: SessionState, job: DmpObject, signal: AbortSignal): Promise<void> {
    if (!job.toolCallId) return
    const settled = () => state.fold.state().items.find(item => item.kind === 'tool_call' && item.callId === job.toolCallId && item.output)
    let item = settled()
    if (!item) {
      // Native foreground observation may close before the tool result is
      // committed. The durable timeline output is authoritative (DMP §8.5),
      // so do not announce terminal status before that reconciliation lands.
      await new Promise<void>((resolveReady, reject) => {
        const abort = () => { cleanup(); reject(fault('cancelled')) }
        const listener = () => { if (settled()) { cleanup(); resolveReady() } }
        const timer = setTimeout(() => { cleanup(); reject(fault('timeout')) }, 30000)
        const cleanup = () => { clearTimeout(timer); state.listeners.delete(listener); signal.removeEventListener('abort', abort) }
        state.listeners.add(listener); signal.addEventListener('abort', abort, { once: true }); listener()
        if (signal.aborted) abort()
      })
      item = settled()
    }
    if (item) for (const listener of state.listeners) listener({ kind: 'timeline.upsert', data: { item: state.fold.state().inlineItems.find(value => value.itemId === item.itemId), throughSeq: state.fold.state().throughSeq } })
  }
  private async watchJobs(method: 'jobs.watch' | 'job.watch', params: DmpObject, emit: (event: DmpEvent) => void, signal: AbortSignal): Promise<ProjectionWatch> {
    const state = await this.ensure(string(params.sessionId), signal)
    const cancel = new AbortController(), abort = () => cancel.abort()
    this.lifetime.signal.addEventListener('abort', abort, { once: true }); signal.addEventListener('abort', abort, { once: true })
    const dispose = () => { cancel.abort(); this.lifetime.signal.removeEventListener('abort', abort); signal.removeEventListener('abort', abort) }
    let result: DmpObject = {}, anchored = false, cursor = 0
    try {
      if (method === 'jobs.watch') {
        await this.startStream('job/list', { request: { sessionId: params.sessionId } }, frame => {
          if (frame.type !== 'rows') return
          const jobs = array(frame.jobs).map(object).filter(job => job.kind === 'bash').map(job => this.job(state, job))
          if (!anchored) { result = { jobs }; anchored = true } else emit({ kind: 'jobs.replace', data: { jobs } })
        }, 'rows', cancel)
      } else {
        await this.startStream('job/follow', { request: { sessionId: params.sessionId, jobId: params.jobId, ...(params.fromByte !== undefined ? { from: params.fromByte } : {}) } }, async frame => {
          if (frame.type === 'opened') {
            const native = object(frame.job)
            if (native.kind !== 'bash') throw fault('unsupported')
            cursor = number(frame.from)
            if (cursor > number(object(native.output).total)) throw fault('invalid-params')
            result = { job: this.job(state, native), from: cursor }; anchored = true
          } else if (frame.type === 'output') {
            const chunks = array(frame.chunks).map(object).flatMap(chunk => {
              const bytes = Buffer.from(string(chunk.text)), at = number(chunk.at)
              let start = Math.max(0, cursor - at)
              if (start >= bytes.length) return []
              const requested = start
              while (start < bytes.length && (bytes[start]! & 0xc0) === 0x80) start++
              if (start >= bytes.length) return []
              return [{ at: at + start, text: bytes.subarray(start).toString('utf8'), channel: chunk.channel === 'stderr' ? 'stderr' : 'stdout', ...(chunk.gapBefore || start > requested ? { gapBefore: true } : {}) }]
            })
            cursor = Math.max(cursor, number(frame.next))
            if (frame.lossy && chunks[0]) Object.assign(chunks[0], { lossy: true })
            emit({ kind: 'job.output', data: { chunks, next: cursor } })
          } else if (frame.type === 'status') {
            const job = this.job(state, object(frame.job))
            await this.reconcileJob(state, job, cancel.signal)
            if (!cancel.signal.aborted) emit({ kind: 'job.status', data: { job } })
          }
        }, 'opened', cancel)
      }
      signal.removeEventListener('abort', abort)
      return { result, dispose }
    } catch (error) { dispose(); throw error }
  }
  async request(method: string, params: DmpObject, signal: AbortSignal): Promise<DmpObject> {
    signal.throwIfAborted()
    if (method === 'workspaces.list') return { workspaces: [...this.workspaces.values()].map(value => this.workspace(value)) }
    if (method === 'sessions.list') { await this.refresh(signal); return this.list(Boolean(params.includeArchived)) }
    if (method === 'sessions.create') return this.create(string(params.workspaceId), randomUUID(), signal)
    if (method === 'attachments.begin') { await this.ensure(string(params.sessionId), signal); return {} }
    if (method === 'session.send') {
      this.expireAttachments()
      const attachments = array(params.attachments).map(id => {
        const attachment = this.attachments.get(string(id))
        if (!attachment) throw fault('expired')
        if (attachment.deviceId !== this.deviceId || attachment.sessionId !== params.sessionId) throw fault('invalid-params', 'Attachment does not belong to this session and device')
        if (attachment.sendId && attachment.sendId !== params.sendId) throw fault('conflict', 'Attachment already belongs to an accepted send')
        return attachment
      })
      const result = await this.call('session', 'prompt', { request: { sessionId: params.sessionId, requestId: params.sendId, mode: params.mode ?? 'queue', content: [{ type: 'text', text: params.text }, ...attachments.map(attachment => attachment.content)] } }, signal)
      for (const attachment of attachments) { attachment.sendId = string(params.sendId); attachment.expires = Date.now() + 15 * 60 * 1000 }
      return result
    }
    if (method === 'session.queue.update') return this.call('session', 'updateQueue', { request: { sessionId: params.sessionId, itemId: params.queueItemId, action: { kind: params.action, ...(params.action === 'edit' ? { content: [{ type: 'text', text: params.text }] } : {}) } } }, signal)
    if (method === 'models.catalog') {
      const native = await this.call('session', 'modelCatalog', {}, signal)
      return { providers: [...array(native.groups).map(raw => { const group = object(raw); return { provider: group.id, label: string(group.name, string(group.id)), models: array(group.models).map(rawModel => { const model = object(rawModel); return { model: model.id, label: string(model.name, string(model.id)), efforts: array(object(model.reasoning).efforts).map(effort => string(object(effort).id)) } }) } }), ...array(native.failures).map(raw => { const failure = object(raw); return { provider: failure.id, label: string(failure.name, string(failure.id)), models: [], error: 'Provider model catalog unavailable' } })], ...(object(native.default).model ? { default: this.model(object(native.default)) } : {}) }
    }
    if (method === 'session.setModel') {
      const result = await this.call('session', 'selectModel', { request: { sessionId: params.sessionId, provider: params.provider, model: params.model, ...(params.effort ? { reasoningEffort: params.effort } : {}) } }, signal)
      return { selected: this.model(object(result.selected)), defaultUpdated: false }
    }
    if (method === 'permissions.catalog') return this.permissions(signal)
    if (method === 'session.setPermission') {
      const catalog = await this.permissions(signal), preset = string(params.preset)
      if (!array(catalog.options).some(option => object(option).preset === preset)) throw fault('invalid-params')
      await this.call('commands', 'execute', { agentId: params.sessionId, line: `/permission ${preset}`, submittedAttachments: [] }, signal)
      const readback = await this.call('session', 'projections', { request: { sessionId: params.sessionId } }, signal)
      const current = object(object(readback.values).permissions).currentValue
      if (current !== preset) throw fault('conflict', 'Permission change was not confirmed')
      return { current }
    }
    if (['files.list', 'files.read', 'files.stat', 'changes.summary', 'changes.diff', 'deliverables.list'].includes(method)) return this.files.request(method, params, signal)
    if (method === 'session.interrupt') return this.call('session', 'cancel', { request: { sessionId: params.sessionId } }, signal)
    if (method === 'interactions.list') {
      const deadline = Date.now() + 2000
      await Promise.all([...this.sessions.values()].map(state => this.interactionsReady(state, signal, deadline)))
      return { interactions: [...this.sessions.values()].flatMap(state => state.fold.state().interactions).filter(interaction => this.deliveries.has(string(interaction.interactionId))) }
    }
    if (method === 'interaction.answer') return this.answer(params, signal)
    if (method === 'session.history') {
      const state = await this.ensure(string(params.sessionId), signal), through = number(params.throughSeq, -1)
      const fold = createProjectionFold(state.metadata)
      for (const record of state.records) if (number(record.nativeSeq, -1) <= through) fold.accept(record)
      const all = fold.state().inlineItems.filter(item => number(object(item.order).seq) < number(params.beforeSeq)).sort(order)
      const minimum = number(object(all[Math.max(0, all.length - number(params.limit, 50))]?.order).seq, -1)
      let items = all.filter(item => number(object(item.order).seq) >= minimum)
      while (Buffer.byteLength(JSON.stringify(items)) > 950000 && items.length) { const seq = number(object(items[0]?.order).seq); items = items.filter(item => number(object(item.order).seq) !== seq) }
      if (all.length && !items.length) throw fault('too-large')
      return { items, hasMoreBefore: items.length < all.length }
    }
    throw fault('unsupported')
  }
  private expireAttachments(): void {
    for (const [id, attachment] of this.attachments) if (attachment.expires <= Date.now()) this.attachments.delete(id)
  }
  async upload(sessionId: string, name: string, mime: string, bytes: Uint8Array, signal: AbortSignal): Promise<{ attachmentId: string }> {
    await this.ensure(sessionId, signal)
    this.expireAttachments()
    const image = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(mime)
    if (bytes.byteLength > (image ? 20 : 32) * 1024 * 1024) throw fault('too-large')
    if (this.attachments.size >= 256 || [...this.attachments.values()].reduce((size, attachment) => size + attachment.size, bytes.byteLength) > 128 * 1024 * 1024) throw fault('busy')
    const attachmentId = randomUUID()
    const attachment: Attachment = { deviceId: this.deviceId, sessionId, content: {}, size: bytes.byteLength, expires: Date.now() + 15 * 60 * 1000 }
    // Reserve the shared host budget before awaiting native storage, so uploads
    // from different authenticated connections cannot oversubscribe it.
    this.attachments.set(attachmentId, attachment)
    try {
      if (image) attachment.content = { type: 'image', mediaType: mime, data: Buffer.from(bytes).toString('base64'), name }
      else {
        const url = new URL('http://localhost/api/session/uploadFileBinary')
        url.searchParams.set('sessionId', sessionId); url.searchParams.set('name', name)
        const response = await this.ctx.connection.createSharedFetchHandler('/api').fetch(new Request(url, { method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body: Buffer.from(bytes), signal: signalFor(this.lifetime.signal, signal) }), this.peer)
        const body = object(await response.json())
        if (!response.ok || body.ok !== true) throw mapped(body.error)
        const receiptId = string(object(body.value).receiptId)
        if (!receiptId) throw fault('dsh-incompatible')
        attachment.content = { type: 'file', receiptId }
      }
      return { attachmentId }
    } catch (error) {
      this.attachments.delete(attachmentId)
      throw error
    }
  }
  private async answer(params: DmpObject, signal: AbortSignal): Promise<DmpObject> {
    const id = string(params.interactionId), delivery = this.deliveries.get(id)
    if (!delivery || delivery.answered) throw fault('conflict')
    const answer = object(params.answer), nativeRequest = object(delivery.value.request)
    const approval = delivery.value.event === 'approval/request'
    if ((approval ? 'approval' : 'question') !== answer.kind) throw fault('invalid-params')
    const answers = array(answer.answers).map(object)
    if (!approval) {
      const questions = array(nativeRequest.questions).map(object)
      if (answers.length !== questions.length || new Set(answers.map(a => a.questionId)).size !== questions.length) throw fault('invalid-params')
      for (const question of questions) {
        const selected = answers.find(a => a.questionId === question.id)
        if (!selected || array(selected.selected).some(label => !array(question.options).some(option => object(option).label === label)) || !question.multiSelect && array(selected.selected).length > 1) throw fault('invalid-params')
      }
    }
    const value: unknown = approval ? answer.decision === 'deny' ? 'rejected' : 'allowed-once' : { answers: answers.map(a => ({ id: a.questionId, selected: a.selected, ...(a.custom ? { custom: a.custom } : {}) })) }
    // Mark before dispatch: the native cancellation broadcast may race the response.
    delivery.answered = true
    try {
      const response = await this.ctx.connection.createSharedFetchHandler('/api').fetch(new Request('http://localhost/api/$events/result', {
        method: 'POST', headers: { 'content-type': 'application/json' }, signal,
        body: JSON.stringify({ type: 'client-request', rpcId: randomUUID(), method: '$events/result', payload: { args: { clientId: this.clientId, eventId: delivery.nativeId, outcome: { kind: 'result', value } } } }),
      }), this.peer)
      const result = object(object(await response.json()).result)
      if (!response.ok || result.ok !== true) throw fault('conflict')
      const state = this.sessions.get(delivery.sessionId)
      if (state) this.accept(state, { source: 'answer', frame: { eventId: id, value }, atMs: 0 })
      this.deliveries.delete(id)
      return { settled: true }
    } catch (error) { delivery.answered = false; throw mapped(error) }
  }
  async content(method: ContentMethod, params: DmpObject, signal: AbortSignal): Promise<Uint8Array> {
    if (method === 'files.download' || method === 'deliverables.download') return this.files.content(method, params, signal)
    const state = await this.ensure(string(params.sessionId), signal)
    const item = state.fold.state().items.find(value => method === 'tool.output' ? value.kind === 'tool_call' && value.callId === params.callId : value.itemId === params.itemId && ['user_message','assistant_message','reasoning'].includes(string(value.kind)))
    if (!item) throw fault('not-found')
    return Buffer.from(string(method === 'tool.output' ? object(item.output).text : item.text))
  }
  async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true; this.lifetime.abort()
    for (const state of this.sessions.values()) state.cancel.abort()
    await this.peer.dispose(); await Promise.allSettled(this.streams)
    this.sessions.clear(); this.deliveries.clear(); this.listListeners.clear(); this.onDisposed()
  }
}
