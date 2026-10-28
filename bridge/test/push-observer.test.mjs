import test from 'node:test'
import assert from 'node:assert/strict'
import { PushObserver } from '../lib/push/observer.js'

const epoch = Date.parse('2026-10-27T00:00:00.000Z')
const time = value => new Date(value).toISOString()
const tick = () => new Promise(resolve => setImmediate(resolve))
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done }); return { promise, resolve } }
const summary = (sessionId, status = 'running', extra = {}) => ({ sessionId, title: `Session ${sessionId}`, status, pendingInteractions: 0,
  updatedAt: time(epoch), archived: false, pinned: false, ...extra })
const snapshot = (session, items = [], interactions = []) => ({ session: { summary: session }, items, interactions,
  cursor: { throughSeq: Math.max(0, ...items.map(item => item.seq)) }, removedItemIds: [], hasMoreBefore: false, resumed: false, queue: [] })
const item = (seq, kind, timestamp, turn, extra = {}) => ({ itemId: `item-${seq}`, seq, order: { seq, index: 0 }, kind,
  time: time(timestamp), ...(turn === undefined ? {} : { turn }), ...(kind === 'user_message' ? { text: 'synthetic test', attachments: [] } : { reason: 'completed' }), ...extra })
const approval = (sessionId = 's1', interactionId = 'approval-1') => ({ sessionId, interactionId, kind: 'approval', blocking: true,
  createdAt: time(epoch), approval: { toolName: 'shell', toolKind: 'shell', title: 'Run synthetic test', command: 'npm test' } })
const question = (sessionId = 's1') => ({ sessionId, interactionId: 'question-1', kind: 'question', blocking: false,
  createdAt: time(epoch), questions: [{ questionId: 'q1', question: 'Continue?', multiSelect: false, options: [{ label: 'Yes' }] }] })
const upsert = value => ({ kind: 'session.upsert', data: { session: value } })
const timeline = value => ({ kind: 'timeline.upsert', data: { item: value, throughSeq: value.seq } })

function fakeProjection(initial = [], options = {}) {
  const calls = [], sessions = new Map()
  const list = { emit() {}, disposed: 0 }
  const peer = {
    disposed: 0,
    async watch(method, params, emit, signal) {
      calls.push({ method, params, signal })
      if (method === 'sessions.watch') {
        list.emit = emit
        const result = await (options.list?.(emit, signal) ?? { sessions: initial, workspaces: [] })
        return { result, dispose() { list.disposed++ } }
      }
      const state = { emit, disposed: 0, signal }
      sessions.set(params.sessionId, state)
      const result = await (options.session?.(params.sessionId, emit, signal) ?? snapshot(initial.find(value => value.sessionId === params.sessionId) ?? summary(params.sessionId)))
      return { result, dispose() { state.disposed++ } }
    },
    dispose() { this.disposed++ },
  }
  const host = { version: 'test', status: 'ok', async connect(deviceId) { calls.push({ deviceId }); return options.connect ? options.connect(peer) : peer }, dispose() {} }
  return { host, peer, calls, sessions, list }
}

test('independent observer watches archived active sessions and initial/live interactions without a mobile client', async () => {
  const active = summary('s1', 'needs-input', { archived: true, pendingInteractions: 1 })
  const fake = fakeProjection([summary('idle', 'idle'), active], { session: () => snapshot(active, [], [approval()]) })
  const values = [], observer = new PushObserver(fake.host, value => values.push(value), () => assert.fail('unexpected failure'), () => epoch)
  await observer.start()
  assert.equal(fake.calls[0].deviceId, 'dshm-push-observer')
  assert.deepEqual(fake.calls[1].params, { includeArchived: true })
  assert.deepEqual([...fake.sessions.keys()], ['s1'])
  assert.equal(values.length, 1)
  assert.equal(values[0].interaction.interactionId, 'approval-1')
  fake.sessions.get('s1').emit({ kind: 'interaction.open', data: { interaction: question() } })
  assert.equal(values[1].interaction.blocking, false, 'policy filtering belongs to the controller')
  await observer.close()
  assert.equal(fake.list.disposed, 1)
  assert.equal(fake.sessions.get('s1').disposed, 1)
  assert.equal(fake.peer.disposed, 1)
})

test('buffers list and session events during watch setup and preserves a newer session title', async () => {
  const waitList = deferred(), waitSession = deferred()
  const fake = fakeProjection([], { list: () => waitList.promise, session: () => waitSession.promise })
  const values = [], observer = new PushObserver(fake.host, value => values.push(value), () => assert.fail('unexpected failure'), () => epoch)
  const starting = observer.start()
  await tick()
  fake.list.emit(upsert(summary('s1', 'running')))
  waitList.resolve({ sessions: [], workspaces: [] })
  await tick()
  fake.list.emit(upsert(summary('s1', 'needs-input', { title: 'Latest title', pendingInteractions: 1 })))
  fake.sessions.get('s1').emit({ kind: 'interaction.open', data: { interaction: approval() } })
  assert.equal(values.length, 0)
  waitSession.resolve(snapshot(summary('s1')))
  await starting
  assert.equal(fake.calls.filter(call => call.method === 'session.watch').length, 1)
  assert.equal(values.length, 1)
  assert.equal(values[0].title, 'Latest title')
  await observer.close()
})

test('uses snapshot user-message timing, suppresses history, and retains a watch through an early idle list update', async () => {
  const running = summary('s1')
  const fake = fakeProjection([running], { session: () => snapshot(running, [
    item(1, 'user_message', epoch - 100000, 1), item(2, 'turn_end', epoch - 60000, 1), item(3, 'user_message', epoch - 35000, 2),
  ]) })
  const values = [], observer = new PushObserver(fake.host, value => values.push(value), () => assert.fail('unexpected failure'), () => epoch)
  await observer.start()
  assert.deepEqual(values, [])
  fake.list.emit(upsert(summary('s1', 'idle')))
  assert.equal(fake.sessions.get('s1').disposed, 0, 'list status may reach idle before the final timeline event')
  const ended = item(4, 'turn_end', epoch + 5000, 2)
  fake.sessions.get('s1').emit(timeline(ended))
  fake.sessions.get('s1').emit(timeline(ended))
  assert.equal(values.length, 1)
  assert.equal(values[0].startedAt, epoch - 35000)
  assert.equal(values[0].endedAt - values[0].startedAt, 40000)
  await observer.close()
})

test('separate queued turn numbers keep their own starts and retain completion/error reasons', async () => {
  const fake = fakeProjection([summary('s1')]), values = []
  const observer = new PushObserver(fake.host, value => values.push(value), () => assert.fail('unexpected failure'), () => epoch)
  await observer.start()
  const send = value => fake.sessions.get('s1').emit(timeline(value))
  send(item(1, 'user_message', epoch + 1000, 1))
  send(item(2, 'user_message', epoch + 20000, 2))
  send(item(3, 'user_message', epoch + 25000, 1))
  send(item(4, 'turn_end', epoch + 40000, 1))
  send(item(5, 'turn_end', epoch + 60000, 2, { reason: 'error' }))
  assert.deepEqual(values.map(value => [value.startedAt, value.endedAt, value.reason]), [
    [epoch + 1000, epoch + 40000, 'completed'], [epoch + 20000, epoch + 60000, 'error'],
  ])
  await observer.close()
})

test('an end arriving inside the initial snapshot is emitted only with a matching observed turn', async () => {
  const fake = fakeProjection([summary('s1')], { session: () => snapshot(summary('s1', 'idle'), [
    item(1, 'user_message', epoch - 60000, 1), item(2, 'turn_end', epoch - 1000, 1),
    item(3, 'turn_end', epoch + 1000, 2),
    item(4, 'user_message', epoch - 40000, 3), item(5, 'turn_end', epoch + 2000, 3),
  ]) })
  const values = [], observer = new PushObserver(fake.host, value => values.push(value), () => assert.fail('unexpected failure'), () => epoch)
  await observer.start()
  assert.equal(values.length, 1)
  assert.equal(values[0].itemId, 'item-5')
  assert.equal(values[0].startedAt, epoch - 40000)
  await observer.close()
})

test('running status is a conservative fallback when DMP has no user-message timing', async () => {
  let now = epoch
  const fake = fakeProjection([summary('s1')]), values = []
  const observer = new PushObserver(fake.host, value => values.push(value), () => assert.fail('unexpected failure'), () => now)
  await observer.start()
  fake.sessions.get('s1').emit(timeline(item(1, 'turn_end', epoch + 31000, 1)))
  assert.equal(values[0].startedAt, epoch)
  fake.list.emit(upsert(summary('s1', 'idle')))
  now += 40000
  fake.list.emit(upsert(summary('s1')))
  fake.sessions.get('s1').emit(timeline(item(2, 'turn_end', epoch + 80000, 2, { reason: 'cancelled' })))
  assert.equal(values[1].startedAt, epoch + 40000)
  assert.equal(values[1].reason, 'cancelled')
  await observer.close()
})

test('session removal closes its watch, drops late events and permits a later new active session', async () => {
  const fake = fakeProjection([summary('s1')]), values = []
  const observer = new PushObserver(fake.host, value => values.push(value), () => assert.fail('unexpected failure'), () => epoch)
  await observer.start()
  const old = fake.sessions.get('s1')
  fake.list.emit({ kind: 'session.remove', data: { sessionId: 's1' } })
  await tick()
  assert.equal(old.disposed, 1)
  assert.equal(old.signal.aborted, true)
  old.emit({ kind: 'interaction.open', data: { interaction: approval() } })
  assert.equal(values.length, 0)
  fake.list.emit(upsert(summary('s2')))
  await tick()
  fake.sessions.get('s2').emit({ kind: 'interaction.open', data: { interaction: approval('s2') } })
  assert.equal(values[0].sessionId, 's2')
  await observer.close()
})

test('close aborts an in-flight watch and releases its eventual result without emitting', async () => {
  const wait = deferred(), fake = fakeProjection([summary('s1')], { session: () => wait.promise })
  const values = [], observer = new PushObserver(fake.host, value => values.push(value), () => assert.fail('close is not failure'), () => epoch)
  const starting = observer.start()
  const rejected = assert.rejects(starting, /Push observer unavailable/)
  await tick()
  await observer.close()
  assert.equal(fake.sessions.get('s1').signal.aborted, true)
  wait.resolve(snapshot(summary('s1'), [], [approval()]))
  await rejected
  await tick()
  assert.equal(fake.sessions.get('s1').disposed, 1)
  assert.equal(fake.peer.disposed, 1)
  assert.deepEqual(values, [])
  await observer.close()
  assert.equal(fake.peer.disposed, 1)
})

test('close releases a connection that resolves after cancellation', async () => {
  const wait = deferred(), fake = fakeProjection([], { connect: () => wait.promise })
  const observer = new PushObserver(fake.host, () => assert.fail('closed'), () => assert.fail('close is not failure'), () => epoch)
  const starting = assert.rejects(observer.start(), /Push observer unavailable/)
  await observer.close()
  wait.resolve(fake.peer)
  await starting
  await tick()
  assert.equal(fake.peer.disposed, 1)
  assert.equal(fake.calls.filter(call => call.method).length, 0)
})

test('malformed events, resets and consumer failures never escape into the projection', async () => {
  for (const failure of ['invalid', 'reset', 'consumer']) {
    const fake = fakeProjection([summary('s1')])
    let failures = 0
    const observer = new PushObserver(fake.host, () => { throw new Error('synthetic consumer failure') }, () => { failures++; throw new Error('synthetic failure callback') }, () => epoch)
    await observer.start()
    const event = failure === 'invalid' ? { kind: 'interaction.open', data: {} }
      : failure === 'reset' ? { kind: 'session.reset', data: { reason: 'rewritten' } }
        : { kind: 'interaction.open', data: { interaction: approval() } }
    assert.doesNotThrow(() => fake.sessions.get('s1').emit(event))
    assert.doesNotThrow(() => fake.sessions.get('s1').emit(event))
    await observer.close()
    assert.equal(failures, 1)
    assert.equal(fake.peer.disposed, 1)
    assert.equal(fake.list.disposed, 1)
    assert.equal(fake.sessions.get('s1').disposed, 1)
  }
})

test('a rejected or malformed watch reports one failure and disposes the peer', async () => {
  for (const session of [() => Promise.reject(new Error('synthetic watch failure')), () => ({ malformed: true })]) {
    const fake = fakeProjection([summary('s1')], { session })
    let failures = 0
    const observer = new PushObserver(fake.host, () => assert.fail('no observation'), () => { failures++ }, () => epoch)
    await assert.rejects(observer.start(), /Push observer unavailable/)
    await observer.close()
    assert.equal(failures, 1)
    assert.equal(fake.peer.disposed, 1)
    assert.equal(fake.list.disposed, 1)
  }
})
