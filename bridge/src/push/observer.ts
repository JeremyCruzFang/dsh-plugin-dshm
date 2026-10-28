import { eventValidators, methodValidators } from 'dshm-protocol/contract'
import type { Interaction, SessionDetail, SessionSummary, SessionsWatchResult, SessionWatchResult, TimelineItem } from 'dshm-protocol/types'
import type { DmpEvent, ProjectionHost, ProjectionPeer, ProjectionWatch } from '../types.js'

export type PushObservation =
  | { type: 'interaction'; sessionId: string; title: string; interaction: Interaction }
  | { type: 'turn'; sessionId: string; title: string; itemId: string; reason: 'completed' | 'cancelled' | 'error'; startedAt: number | undefined; endedAt: number }

interface Disposable { dispose(): void | Promise<void> }
interface Session {
  summary: SessionSummary
  revision: number
  cancellation: AbortController
  watch?: ProjectionWatch
  observedAt: number
  activeSince?: number
  starts: Map<number, number>
  unnumberedStart?: number
  ends: Set<string>
}
const active = (session: SessionSummary) => ['running', 'needs-input'].includes(session.status) || session.pendingInteractions > 0

/** An independent DMP peer keeps push observation alive without a mobile connection. */
export class PushObserver {
  private readonly lifetime = new AbortController()
  private readonly sessions = new Map<string, Session>()
  private readonly resources = new Set<Disposable>()
  private readonly released = new WeakSet<Disposable>()
  private readonly opening = new Set<Promise<void>>()
  private readonly disposing = new Set<Promise<void>>()
  private peer?: ProjectionPeer
  private startedAt = 0
  private starting?: Promise<void>
  private closing?: Promise<void>
  private closed = false
  private failed = false

  constructor(private readonly projection: ProjectionHost, private readonly emit: (value: PushObservation) => void,
    private readonly onFailure: () => void, private readonly now: () => number = Date.now) {}

  start(): Promise<void> {
    if (this.closed) return Promise.reject(new Error('Push observer is closed'))
    if (!this.starting) {
      this.startedAt = this.now()
      this.starting = this.open().catch(() => { this.fail(); throw new Error('Push observer unavailable') })
    }
    return this.starting
  }

  private async open(): Promise<void> {
    this.peer = await this.acquire(this.projection.connect('dshm-push-observer'), this.lifetime.signal)
    this.lifetime.signal.throwIfAborted()
    const queued: DmpEvent[] = []
    let ready = false
    const watch = await this.acquire(this.peer.watch('sessions.watch', { includeArchived: true }, event => {
      this.guard(() => { if (ready) this.listEvent(event); else queued.push(event) })
    }, this.lifetime.signal), this.lifetime.signal)
    this.lifetime.signal.throwIfAborted()
    if (!methodValidators['sessions.watch'].result({ ...watch.result, subId: 'push-observer' })) throw new Error('Invalid DMP snapshot')
    const snapshot = watch.result as unknown as SessionsWatchResult
    for (const summary of snapshot.sessions) this.summary(summary)
    ready = true
    for (const event of queued) this.listEvent(event)
    await Promise.all([...this.opening])
    this.lifetime.signal.throwIfAborted()
  }

  private summary(summary: SessionSummary): void {
    const existing = this.sessions.get(summary.sessionId)
    if (existing) {
      if (active(summary) && !active(existing.summary)) existing.activeSince = this.now()
      existing.summary = summary
      existing.revision++
      return
    }
    if (!active(summary) || this.closed) return
    const observedAt = this.now()
    const session: Session = { summary, revision: 0, cancellation: new AbortController(), observedAt, activeSince: observedAt, starts: new Map(), ends: new Set() }
    this.sessions.set(summary.sessionId, session)
    // Idle list updates can precede the final timeline event. Keep an observed
    // session's watch until removal or observer close, including later turns.
    const pending = this.watchSession(session).catch(() => {
      if (!session.cancellation.signal.aborted && !this.closed) this.fail()
    }).finally(() => { this.opening.delete(pending) })
    this.opening.add(pending)
  }

  private listEvent(event: DmpEvent): void {
    if (event.kind !== 'session.upsert' && event.kind !== 'session.remove') return
    this.validate(event)
    if (event.kind === 'session.upsert') this.summary(event.data.session as SessionSummary)
    else {
      const id = event.data.sessionId as string, session = this.sessions.get(id)
      if (session) {
        this.sessions.delete(id)
        session.cancellation.abort()
        if (session.watch) void this.release(session.watch)
      }
    }
  }

  private async watchSession(session: Session): Promise<void> {
    const signal = AbortSignal.any([this.lifetime.signal, session.cancellation.signal])
    const queued: DmpEvent[] = []
    const revision = session.revision
    let ready = false
    const watch = await this.acquire(this.peer!.watch('session.watch', { sessionId: session.summary.sessionId }, event => {
      this.guard(() => {
        if (signal.aborted) return
        if (ready) this.sessionEvent(session, event)
        else queued.push(event)
      })
    }, signal), signal)
    if (signal.aborted) { await this.release(watch); return }
    session.watch = watch
    if (!methodValidators['session.watch'].result({ ...watch.result, subId: 'push-observer' })) throw new Error('Invalid DMP snapshot')
    const snapshot = watch.result as unknown as SessionWatchResult
    if (snapshot.session.summary.sessionId !== session.summary.sessionId) throw new Error('Mismatched DMP session')
    // A newer list update may already have arrived while this watch was opening.
    if (session.revision === revision) session.summary = snapshot.session.summary
    for (const item of [...snapshot.items].sort((a, b) => a.order.seq - b.order.seq || a.order.index - b.order.index)) this.item(session, item, true)
    for (const interaction of snapshot.interactions) this.interaction(session, interaction)
    ready = true
    for (const event of queued) this.sessionEvent(session, event)
  }

  private sessionEvent(session: Session, event: DmpEvent): void {
    if (!['timeline.upsert', 'session.update', 'interaction.open', 'session.reset'].includes(event.kind)) return
    this.validate(event)
    if (event.kind === 'timeline.upsert') this.item(session, event.data.item as TimelineItem, false)
    else if (event.kind === 'interaction.open') this.interaction(session, event.data.interaction as Interaction)
    else if (event.kind === 'session.update') {
      const summary = (event.data.session as SessionDetail).summary
      if (summary.sessionId !== session.summary.sessionId) throw new Error('Mismatched DMP session')
      this.summary(summary)
    } else throw new Error('DMP session reset')
  }

  private interaction(session: Session, interaction: Interaction): void {
    if (interaction.sessionId !== session.summary.sessionId) throw new Error('Mismatched DMP interaction')
    this.publish({ type: 'interaction', sessionId: interaction.sessionId, title: session.summary.title ?? 'DSHM', interaction })
  }

  private item(session: Session, item: TimelineItem, initial: boolean): void {
    if (item.kind === 'user_message') {
      const time = Date.parse(item.time)
      if (item.turn === undefined) session.unnumberedStart = Math.min(session.unnumberedStart ?? time, time)
      else {
        session.starts.set(item.turn, Math.min(session.starts.get(item.turn) ?? time, time))
        if (session.starts.size > 256) session.starts.delete(session.starts.keys().next().value!)
      }
      return
    }
    if (item.kind !== 'turn_end' || session.ends.has(item.itemId)) return
    session.ends.add(item.itemId)
    if (session.ends.size > 256) session.ends.delete(session.ends.values().next().value!)
    const endedAt = Date.parse(item.time)
    const knownStart = item.turn === undefined ? session.unnumberedStart : session.starts.get(item.turn)
    const startedAt = knownStart ?? session.activeSince
    // Snapshot history is a timing baseline, not a new notification. The exception
    // is a turn that finishes after we observed it running while watch setup waits.
    const eligible = endedAt >= this.startedAt && (!initial || knownStart !== undefined && endedAt >= session.observedAt)
    if (item.turn === undefined) session.unnumberedStart = undefined
    else session.starts.delete(item.turn)
    if (eligible) {
      session.activeSince = undefined
      this.publish({ type: 'turn', sessionId: session.summary.sessionId, title: session.summary.title ?? 'DSHM', itemId: item.itemId,
        reason: item.reason, startedAt: startedAt !== undefined && startedAt <= endedAt ? startedAt : undefined, endedAt })
    }
  }

  private validate(event: DmpEvent): void {
    if (!eventValidators[event.kind](event.data)) throw new Error('Invalid DMP event')
  }

  private publish(value: PushObservation): void { if (!this.closed) this.emit(value) }
  private guard(action: () => void): void { if (!this.closed) { try { action() } catch { this.fail() } } }
  private fail(): void {
    if (this.closed || this.failed) return
    this.failed = true
    // A callback must never throw through the projection's event emitter.
    try { this.onFailure() } catch { /* Caller failure cannot stop cleanup. */ }
    void this.close()
  }

  private acquire<T extends Disposable>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
    return new Promise((resolve, reject) => {
      let settled = false
      const finish = () => { settled = true; clearTimeout(timer); signal.removeEventListener('abort', aborted) }
      const aborted = () => { if (!settled) { finish(); reject(new Error('Push observer cancelled')) } }
      const timer = setTimeout(() => { if (!settled) { finish(); reject(new Error('Push observer timed out')) } }, 30000)
      signal.addEventListener('abort', aborted, { once: true })
      operation.then(resource => {
        if (settled || signal.aborted || this.closed) { void this.release(resource); aborted(); return }
        finish(); this.resources.add(resource); resolve(resource)
      }, () => { if (!settled) { finish(); reject(new Error('Push observer unavailable')) } })
      if (signal.aborted) aborted()
    })
  }

  private release(resource: Disposable): Promise<void> {
    if (this.released.has(resource)) return Promise.resolve()
    this.released.add(resource)
    this.resources.delete(resource)
    const pending = new Promise<void>(resolve => {
      const timer = setTimeout(resolve, 5000)
      Promise.resolve().then(() => resource.dispose()).catch(() => {}).finally(() => { clearTimeout(timer); resolve() })
    }).finally(() => { this.disposing.delete(pending) })
    this.disposing.add(pending)
    return pending
  }

  close(): Promise<void> {
    if (!this.closing) {
      this.closed = true
      this.lifetime.abort()
      this.sessions.clear()
      for (const resource of this.resources) void this.release(resource)
      this.closing = Promise.all([...this.disposing]).then(() => {})
    }
    return this.closing
  }
}
