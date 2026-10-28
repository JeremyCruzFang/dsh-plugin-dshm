import { createHmac } from 'node:crypto'
import type { DmpObject, ProjectionHost } from '../types.js'
import { DmpError } from '../errors.js'
import { PushObserver, type PushObservation } from './observer.js'
import { PushStore, type PushRegistration } from './store.js'
import { collapseId, encryptPayload, keyBytes, shorten, type PushPayload } from './payload.js'

export interface PushMethods {
  register(deviceId: string, params: DmpObject): void
  unregister(deviceId: string): void
  watch(sessionId: string): () => void
}
interface Options {
  stateDir: string
  proxyUrl: string
  hostId: string
  projection: ProjectionHost
  connected(deviceId: string): boolean
  devices(): string[]
  capability(enabled: boolean): void
  fetch?: typeof fetch
  now?: () => number
  probeIntervalMs?: number
  // Unit tests replace only the observer; production always uses the DMP peer.
  observerFactory?: (emit: (value: PushObservation) => void, failure: () => void) => { start(): Promise<void>; close(): Promise<void> }
}

export function proxyURL(input: unknown): string | undefined {
  if (input === undefined) return
  if (typeof input !== 'string') throw new Error('Invalid pushProxyUrl')
  let url: URL
  try { url = new URL(input) } catch { throw new Error('Invalid pushProxyUrl') }
  const loopback = ['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname)
  if (!(url.protocol === 'https:' || url.protocol === 'http:' && loopback) || url.username || url.password || url.search || url.hash || !['', '/'].includes(url.pathname)) throw new Error('pushProxyUrl requires an HTTPS origin (HTTP only on loopback for tests)')
  return url.origin
}

export class PushController implements PushMethods {
  readonly store: PushStore
  readonly counters = { sent: 0, suppressed: 0, failures: 0, revoked: 0 }
  private readonly transport: typeof fetch
  private readonly now: () => number
  private readonly lifetime = new AbortController()
  private observer?: { start(): Promise<void>; close(): Promise<void> }
  private timer?: ReturnType<typeof setInterval>
  private probing?: Promise<void>
  private reachable = false
  private closed = false
  private readonly watching = new Map<string, number>()
  private readonly requests = new Map<string, Set<AbortController>>()
  private readonly pending = new Set<Promise<void>>()
  constructor(private readonly options: Options) {
    this.transport = options.fetch ?? fetch; this.now = options.now ?? Date.now
    this.store = new PushStore(options.stateDir, options.proxyUrl)
  }
  async start(): Promise<void> {
    await this.probe()
    this.timer = setInterval(() => { void this.probe() }, this.options.probeIntervalMs ?? 30000)
    this.timer.unref()
  }
  private available(value: boolean): void {
    this.reachable = value && !this.closed
    this.options.capability(this.reachable)
  }
  async probe(): Promise<void> {
    if (this.closed) return
    if (this.probing) return this.probing
    this.probing = (async () => {
      try {
        const response = await this.transport(`${this.options.proxyUrl}/healthz`, {
          redirect: 'error', signal: AbortSignal.any([this.lifetime.signal, AbortSignal.timeout(3000)]),
        })
        if (!response.ok) throw new Error('Proxy unavailable')
        const reader = response.body?.getReader()
        if (!reader) throw new Error('Proxy unavailable')
        let bytes = Buffer.alloc(0)
        try {
          for (;;) {
            const value = await reader.read()
            if (value.done) break
            if (bytes.length + value.value.length > 1024) throw new Error('Invalid proxy health')
            bytes = Buffer.concat([bytes, value.value])
          }
        } finally { await reader.cancel().catch(() => {}) }
        const health: unknown = JSON.parse(bytes.toString('utf8'))
        if (!health || typeof health !== 'object' || !('service' in health) || health.service !== 'dshm-push' || !('v' in health) || health.v !== 1) throw new Error('Invalid proxy health')
        this.prune()
        if (!this.observer) {
          const initial: PushObservation[] = []
          let starting = true
          const failed = () => {
            this.counters.failures++; this.available(false)
            const observer = this.observer; this.observer = undefined
            if (observer) this.track(observer.close())
          }
          const observe = (value: PushObservation) => { if (starting) initial.push(value); else this.observe(value) }
          const observer = this.options.observerFactory?.(observe, failed) ?? new PushObserver(this.options.projection, observe, failed, this.now)
          this.observer = observer
          try { await observer.start() } catch { if (this.observer === observer) this.observer = undefined; await observer.close(); throw new Error('Observer unavailable') }
          starting = false
          if (!this.closed && this.observer === observer) {
            this.available(true)
            for (const value of initial) this.observe(value)
          }
        }
        if (!this.closed && this.observer) this.available(true)
      } catch { this.counters.failures++; this.available(false) }
    })().finally(() => { this.probing = undefined })
    return this.probing
  }
  register(deviceId: string, params: DmpObject): void {
    if (!this.reachable) throw new DmpError('unsupported')
    if (!this.options.devices().includes(deviceId)) throw new DmpError('revoked')
    const old = this.store.records.get(deviceId)
    let current: PushRegistration
    try { current = this.store.register(deviceId, params) } catch { throw new DmpError('invalid-params', 'Push registration could not be stored') }
    this.connected(deviceId)
    if (old && old.proxyUrl === this.options.proxyUrl && old.pushId !== current.pushId) {
      this.track(this.post(deviceId, old, 'DELETE', `/v1/register/${encodeURIComponent(old.pushId)}`, Buffer.alloc(0)))
    }
  }
  unregister(deviceId: string): void { this.remove(deviceId) }
  revoke(deviceId: string): void {
    this.connected(deviceId)
    try { this.remove(deviceId); this.counters.revoked++ } catch { this.counters.failures++ }
  }
  private remove(deviceId: string): void {
    const old = this.store.remove(deviceId)
    this.connected(deviceId)
    if (old && old.proxyUrl === this.options.proxyUrl) this.track(this.post(deviceId, old, 'DELETE', `/v1/register/${encodeURIComponent(old.pushId)}`, Buffer.alloc(0)))
  }
  private prune(): void {
    const valid = new Set(this.options.devices())
    for (const id of this.store.records.keys()) if (!valid.has(id)) this.revoke(id)
  }
  /** Called at authentication to cancel a pending notification for this device. */
  connected(deviceId: string): void { for (const request of this.requests.get(deviceId) ?? []) request.abort() }
  watch(sessionId: string): () => void {
    this.watching.set(sessionId, (this.watching.get(sessionId) ?? 0) + 1)
    let stopped = false
    return () => {
      if (stopped) return
      stopped = true
      const count = (this.watching.get(sessionId) ?? 1) - 1
      if (count) this.watching.set(sessionId, count); else this.watching.delete(sessionId)
    }
  }
  observe(observation: PushObservation): void {
    if (this.closed) return
    try {
      for (const [deviceId, record] of this.store.records) {
        if (record.proxyUrl !== this.options.proxyUrl || !this.options.devices().includes(deviceId)) continue
        let payload: PushPayload
        const base = { v: 1 as const, hostId: this.options.hostId, sessionId: observation.sessionId,
          title: shorten(observation.title || 'DSH session', 120), sentAt: new Date(this.now()).toISOString() }
        if (observation.type === 'interaction') {
          const interaction = observation.interaction
          if (!interaction.blocking || record.seenInteractions.includes(interaction.interactionId)) continue
          // Mark an opening even when it is suppressed in the foreground. A
          // later observer reconnect must not turn that old opening into a push.
          record.seenInteractions.push(interaction.interactionId)
          this.store.save()
          if (!record.prefs.approvals) { this.counters.suppressed++; continue }
          const summary = interaction.kind === 'approval' ? `Wants to run: ${interaction.approval.command ?? interaction.approval.title}` : interaction.questions[0]?.question ?? 'Needs your answer'
          payload = { ...base, kind: interaction.kind, interactionId: interaction.interactionId, body: shorten(summary, 180) }
        } else {
          if (observation.reason === 'cancelled') continue
          const error = observation.reason === 'error'
          if (error ? !record.prefs.errors : !record.prefs.turnFinished || observation.startedAt === undefined || observation.endedAt - observation.startedAt < 30000 || this.watching.has(observation.sessionId)) continue
          const previous = record.lastSent[observation.sessionId]
          if (previous !== undefined && this.now() - previous < 30000) continue
          payload = { ...base, kind: error ? 'error' : 'turn', body: error ? 'The agent stopped with an error' : 'The agent finished its turn' }
        }
        if (this.options.connected(deviceId) || !this.reachable) { this.counters.suppressed++; continue }
        if (observation.type === 'turn') { record.lastSent[observation.sessionId] = this.now(); this.store.save() }
        const body = Buffer.from(JSON.stringify({ pushId: record.pushId, kind: payload.kind, collapseId: collapseId(payload.hostId, payload.sessionId), ciphertext: encryptPayload(payload, keyBytes(record.notifKey)) }))
        if (this.pending.size >= 64) { this.counters.failures++; continue }
        this.track(this.post(deviceId, record, 'POST', '/v1/push', body))
      }
    } catch { this.counters.failures++ }
  }
  private track(work: Promise<void>): void {
    const guarded = work.catch(() => { this.counters.failures++ }).finally(() => this.pending.delete(guarded))
    this.pending.add(guarded)
  }
  private async post(deviceId: string, registration: PushRegistration, method: 'POST' | 'DELETE', path: string, body: Buffer): Promise<void> {
    if (this.closed || method === 'POST' && (this.options.connected(deviceId) || this.store.records.get(deviceId) !== registration)) return
    const controller = new AbortController()
    const requests = this.requests.get(deviceId) ?? new Set<AbortController>(); this.requests.set(deviceId, requests); requests.add(controller)
    try {
      const signature = createHmac('sha256', keyBytes(registration.pushSecret)).update(body).digest('base64')
      const response = await this.transport(this.options.proxyUrl + path, { method, redirect: 'error',
        headers: { 'content-type': 'application/json', 'X-DSHM-Signature': signature }, ...(method === 'POST' ? { body: body.toString('utf8') } : {}),
        signal: AbortSignal.any([controller.signal, this.lifetime.signal, AbortSignal.timeout(3000)]),
      })
      await response.body?.cancel()
      if (!response.ok) throw new Error('Proxy refused request')
      if (method === 'POST') this.counters.sent++
    } catch {
      if (!controller.signal.aborted && !this.closed) { this.counters.failures++; this.available(false) }
    } finally { requests.delete(controller); if (!requests.size) this.requests.delete(deviceId) }
  }
  async settle(): Promise<void> { await Promise.allSettled([...this.pending]) }
  async close(): Promise<void> {
    this.closed = true; this.available(false); this.lifetime.abort(); clearInterval(this.timer)
    await this.probing; await this.observer?.close(); this.observer = undefined
    await this.settle(); this.watching.clear()
  }
}
