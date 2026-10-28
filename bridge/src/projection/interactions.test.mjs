import test from 'node:test'
import assert from 'node:assert/strict'
import { setImmediate as tick } from 'node:timers/promises'
import { LivePeer } from '../../lib/projection/native.js'

const sessionId = 'session-interactions'
const signal = () => new AbortController().signal
const event = (seq, type, data) => ({ type: 'event', event: { seq, type, data, time: seq + 1 } })
const turn = event(0, 'turn/start', { turn: 1 })
const tool = (seq, callId, name = 'bash', args = { command: 'printf fixture' }) => event(seq, 'tool/call', { callId, name, arguments: JSON.stringify(args) })
const waterfall = (nativeId, request, kind = 'approval/request') => ({ type: 'waterfall', event: kind, eventId: nativeId, agentId: sessionId, request })

// A push settles only after the real LivePeer stream consumer has handled it.
// The started promise lets tests hold back the independent follow stream.
class Frames {
  entries = []
  wake
  push(frame) {
    let begin, finish
    const started = new Promise(resolve => { begin = resolve })
    const done = new Promise(resolve => { finish = resolve })
    this.entries.push({ frame, begin, finish }); this.wake?.()
    return { started, done }
  }
  async *read(signal) {
    const abort = () => this.wake?.()
    signal.addEventListener('abort', abort, { once: true })
    try {
      while (!signal.aborted) {
        if (!this.entries.length) await new Promise(resolve => { this.wake = resolve })
        if (signal.aborted) break
        const next = this.entries.shift()
        next.begin()
        try { yield next.frame } finally { next.finish() }
      }
    } finally { signal.removeEventListener('abort', abort) }
  }
}

async function carrier(t, records = [turn], { watch = true, initiallyHidden = false, running = true, otherSessions = {} } = {}) {
  const sessions = new Map([[sessionId, { records, running }], ...Object.entries(otherSessions)])
  const streamKey = (endpoint, id = sessionId) => endpoint === 'session/follow' ? `${endpoint}:${id}` : endpoint
  const streams = new Map(['workspace/follow', 'session/control', '$events', ...[...sessions.keys()].map(id => streamKey('session/follow', id))].map(name => [name, new Frames()]))
  const output = [], answers = [], opened = new Map()
  let disposed = 0, listings = 0
  const ctx = {
    permissionPresets: { resolve: () => ({ approval: 'on-request' }) },
    connection: {
      createSharedFetchHandler: () => ({ async fetch(request) {
        assert.equal(new URL(request.url).pathname, '/api/$events/result')
        answers.push((await request.json()).payload.args)
        return Response.json({ result: { ok: true } })
      } }),
    },
    typertGateway: {
      async invoke({ namespace, method }) {
        assert.equal(`${namespace}/${method}`, 'session/list')
        return { items: initiallyHidden && ++listings === 1 ? [] : [...sessions].map(([id, value]) => ({ sessionId: id, cwd: '/synthetic-workspace', updatedAt: 1, running: value.running })) }
      },
      wireStream: { async open(endpoint, payload, _uplink, _peer, cancel) {
        const id = endpoint === 'session/follow' ? payload.args.request.address.sessionId : sessionId
        const stream = streams.get(streamKey(endpoint, id))
        assert.ok(stream, `Unexpected native stream: ${endpoint}`)
        opened.set(endpoint, (opened.get(endpoint) ?? 0) + 1)
        const records = sessions.get(id).records
        stream.push(endpoint === '$events' ? { type: 'ready', clientId: 'fake-client' }
          : endpoint === 'session/follow' ? { type: 'snapshot', records, cursor: records.at(-1)?.event.seq ?? -1, hasMore: false }
            : { type: 'baseline', value: {} })
        return stream.read(cancel)
      } },
    },
  }
  const peer = new LivePeer(ctx, { dispose() { disposed++ } }, 'fake-device', new Map(), () => {})
  t.after(() => peer.dispose())
  await peer.start()
  if (watch) await peer.watch('session.watch', { sessionId }, value => output.push(value), signal())
  return {
    peer, output, answers, opened,
    push: (endpoint, frame, id = sessionId) => streams.get(streamKey(endpoint, id)).push(frame),
    pending: async () => (await peer.request('interactions.list', {}, signal())).interactions,
    snapshot: async (id = sessionId, emit = () => {}) => (await peer.watch('session.watch', { sessionId: id }, emit, signal())).result,
    answer: (id, answer = { kind: 'approval', decision: 'allow-once' }) => peer.request('interaction.answer', { interactionId: id, answer }, signal()),
    disposed: () => disposed,
  }
}

function onePending(snapshot) {
  assert.equal(snapshot.interactions.length, 1)
  const interaction = snapshot.interactions[0]
  const rows = snapshot.items.filter(item => item.kind === 'interaction' && item.state === 'pending')
  assert.deepEqual(rows.map(item => item.interactionId), [interaction.interactionId])
  assert.ok(!interaction.interactionId.includes('delivery-'), 'delivery ids never become DMP identity')
  return interaction
}

const orphanRecords = (callId = 'orphan-call', auditId = 'orphan-audit') => [
  turn, tool(1, callId), event(2, 'approval/asked', { id: auditId, callId, toolName: 'bash', reason: 'r' }),
]

function oneExpired(snapshot) {
  assert.deepEqual(snapshot.interactions, [])
  const rows = snapshot.items.filter(item => item.kind === 'interaction')
  assert.equal(rows.length, 1)
  assert.equal(rows[0].state, 'expired')
  assert.equal(snapshot.session.summary.pendingInteractions, 0)
  assert.equal(snapshot.session.summary.status, 'idle')
  return rows[0]
}

test('an orphaned durable approval still opens within the bound and expires its unanswerable row', { timeout: 5000 }, async t => {
  const host = await carrier(t, orphanRecords(), { watch: false, running: false })
  const started = performance.now()
  const snapshot = await host.snapshot()
  assert.ok(performance.now() - started < 2500, 'session.watch must return even when no waterfall arrives')
  oneExpired(snapshot)
  assert.deepEqual(await host.pending(), [])
  assert.ok(performance.now() - started < 2500, 'expired durable ids do not start another full wait')
})

test('a late valid delivery revives the expired row with its original id and is answerable', { timeout: 5000 }, async t => {
  const host = await carrier(t, orphanRecords(), { watch: false, running: false })
  const expired = oneExpired(await host.snapshot(sessionId, value => host.output.push(value)))
  await host.push('$events', waterfall('delivery-after-expiry', { callId: 'orphan-call', toolName: 'bash', reason: 'r' })).done
  const snapshot = await host.snapshot()
  const pending = onePending(snapshot)
  assert.equal(pending.interactionId, expired.interactionId)
  assert.equal(snapshot.items.find(item => item.kind === 'interaction').itemId, expired.itemId)
  assert.equal(snapshot.session.summary.status, 'needs-input')
  assert.equal(snapshot.session.summary.pendingInteractions, 1)
  assert.deepEqual(host.output.filter(item => item.kind === 'interaction.open').map(item => item.data.interaction.interactionId), [expired.interactionId])
  assert.deepEqual(await host.answer(expired.interactionId), { settled: true })
  assert.equal(host.answers.at(-1).eventId, 'delivery-after-expiry')
  assert.equal(host.answers.at(-1).outcome.value, 'allowed-once')
  await host.push('session/follow', event(3, 'approval/decided', { id: 'orphan-audit', outcome: 'allowed-once' })).done
  assert.deepEqual(await host.pending(), [])
})

test('global interactions.list returns healthy approvals while waiting for orphan sessions in parallel', { timeout: 5000 }, async t => {
  const healthyRecords = orphanRecords('healthy-call', 'healthy-audit')
  const host = await carrier(t, healthyRecords, { watch: false, otherSessions: {
    'orphan-session-a': { records: orphanRecords('orphan-call-a', 'orphan-audit-a'), running: false },
    'orphan-session-b': { records: orphanRecords('orphan-call-b', 'orphan-audit-b'), running: false },
  } })
  await host.push('$events', waterfall('delivery-healthy', { callId: 'healthy-call', toolName: 'bash', reason: 'r' })).done
  const healthy = onePending(await host.snapshot())
  // History hydrates both native follows without starting the watch/list wait.
  // If interactions.list waits sequentially, these two orphans would take 4 s.
  await Promise.all(['orphan-session-a', 'orphan-session-b'].map(id => host.peer.request('session.history', {
    sessionId: id, beforeSeq: 3, throughSeq: 2, limit: 50,
  }, signal())))
  const started = performance.now()
  const pending = await host.pending()
  assert.ok(performance.now() - started < 2500, 'one orphan must not multiply the global wait bound')
  assert.deepEqual(pending.map(item => item.interactionId), [healthy.interactionId])
  assert.equal((await host.snapshot()).session.summary.status, 'needs-input')
  oneExpired(await host.snapshot('orphan-session-a'))
  oneExpired(await host.snapshot('orphan-session-b'))
})

test('a watch stays readable while an unidentifiable delivery expires and redelivery warns only once', { timeout: 6500 }, async t => {
  const host = await carrier(t, [turn], { watch: false, running: false })
  const request = { toolName: 'bash', reason: 'No matching durable audit' }
  const delivery = host.push('$events', waterfall('delivery-unidentifiable', request))
  await delivery.started; await tick()
  const started = performance.now()
  const snapshot = await host.snapshot(sessionId, value => host.output.push(value))
  assert.ok(performance.now() - started < 2500, 'a correlating waterfall must not block session.watch indefinitely')
  await delivery.done
  assert.deepEqual(snapshot.interactions, [])
  assert.equal(snapshot.session.summary.status, 'idle')
  assert.equal(snapshot.session.summary.pendingInteractions, 0)
  const notices = snapshot.items.filter(item => item.kind === 'notice' && item.level === 'warning')
  assert.equal(notices.length, 1)
  assert.match(notices[0].text, /approval/i)
  assert.match(notices[0].text, /DeepSeek Harness/)
  assert.equal(snapshot.items.filter(item => item.kind === 'interaction').length, 0)

  await host.push('$events', waterfall('delivery-unidentifiable-again', request)).done
  const repeated = await host.snapshot()
  assert.equal(repeated.items.filter(item => item.kind === 'notice' && item.level === 'warning').length, 1)
  assert.deepEqual(await host.pending(), [])
  assert.equal(host.output.filter(item => item.kind === 'interaction.open').length, 0,
    'neither native delivery id becomes a guessed interaction id')
})

test('LivePeer uses the same call identity for waterfall-first and follow-first deliveries', async t => {
  const ids = []
  for (const waterfallFirst of [true, false]) {
    const host = await carrier(t)
    let delivery
    if (waterfallFirst) {
      delivery = host.push('$events', waterfall('delivery-before', { callId: 'approval-call', toolName: 'bash', reason: 'fixture approval' }))
      await delivery.started; await tick()
    }
    await host.push('session/follow', tool(1, 'approval-call')).done
    if (!waterfallFirst) delivery = host.push('$events', waterfall('delivery-after', { callId: 'approval-call', toolName: 'bash', reason: 'fixture approval' }))
    await delivery.done
    const original = onePending(await host.snapshot())
    ids.push(original.interactionId)
    assert.equal(original.toolCallId, 'approval-call')

    await host.push('$events', waterfall('delivery-replaced', { callId: 'approval-call', toolName: 'bash', reason: 'fixture approval' })).done
    await host.push('$events', { type: 'cancel', eventId: waterfallFirst ? 'delivery-before' : 'delivery-after' }).done
    assert.equal(onePending(await host.snapshot()).interactionId, original.interactionId)
    assert.deepEqual((await host.pending()).map(item => item.interactionId), [original.interactionId])
    assert.deepEqual([...new Set(host.output.filter(item => item.kind === 'interaction.open').map(item => item.data.interaction.interactionId))], [original.interactionId])
    assert.deepEqual(await host.answer(original.interactionId), { settled: true })
    assert.equal(host.answers.at(-1).eventId, 'delivery-replaced')
    assert.equal(host.answers.at(-1).outcome.value, 'allowed-once')
    assert.deepEqual(await host.pending(), [])
    assert.equal(host.output.findLast(item => item.kind === 'interaction.close').data.interactionId, original.interactionId)
  }
  assert.equal(ids[0], ids[1])
})

test('legacy questions wait for their exact tool arguments and retain identity in a fresh peer', async t => {
  const questions = [{ id: 'fixture-choice', question: 'Continue the fixture?', header: 'Fixture', multiSelect: true, options: [{ label: 'Continue' }, { label: 'Stop' }] }]
  const argumentsQuestions = questions.map(({ multiSelect, ...question }) => ({ ...question, multi_select: multiSelect }))
  const call = tool(1, 'question-call', 'ask_user_question', { questions: argumentsQuestions })
  const unrelated = tool(2, 'unrelated-call', 'bash', { command: 'printf unrelated' })
  const host = await carrier(t)
  const delivery = host.push('$events', waterfall('delivery-question-first', { questions }, 'user-questions/request'))
  await delivery.started; await tick()
  assert.equal(host.output.filter(item => item.kind === 'interaction.open').length, 0)
  await host.push('session/follow', call).done
  await delivery.done
  const original = onePending(await host.snapshot())
  assert.equal(original.toolCallId, 'question-call')
  await host.peer.dispose()
  assert.equal(host.disposed(), 1)

  const reconnected = await carrier(t, [turn, call, unrelated], { watch: false })
  await reconnected.push('$events', waterfall('delivery-question-new', { questions }, 'user-questions/request')).done
  assert.equal(onePending(await reconnected.snapshot()).interactionId, original.interactionId)
  await reconnected.answer(original.interactionId, { kind: 'question', answers: [{ questionId: 'fixture-choice', selected: ['Continue'] }] })
  assert.equal(reconnected.answers.at(-1).eventId, 'delivery-question-new')
  assert.deepEqual(reconnected.answers.at(-1).outcome.value, { answers: [{ id: 'fixture-choice', selected: ['Continue'] }] })
})

test('an approval without callId waits for its durable audit identity and survives a fresh peer', async t => {
  const request = { toolName: 'bash', reason: 'Allow the synthetic operation' }
  const unrelated = tool(1, 'unrelated-bash-call', 'bash', { command: 'printf unrelated' })
  const audit = event(2, 'approval/asked', { id: 'approval-audit-id', ...request })
  const host = await carrier(t)
  const delivery = host.push('$events', waterfall('delivery-audit-first', request))
  await delivery.started; await tick()
  await host.push('session/follow', unrelated).done
  assert.equal(host.output.filter(item => item.kind === 'interaction.open').length, 0,
    'a running tool is not enough to identify an approval without callId')
  await host.push('session/follow', audit).done
  await delivery.done
  const original = onePending(await host.snapshot())
  assert.equal(original.toolCallId, undefined, 'an unrelated running tool is never attached')
  await host.peer.dispose()

  const reconnected = await carrier(t, [turn, unrelated, audit], { watch: false })
  await reconnected.push('$events', waterfall('delivery-audit-new', request)).done
  assert.equal(onePending(await reconnected.snapshot()).interactionId, original.interactionId)
  await reconnected.answer(original.interactionId)
  assert.equal(reconnected.answers.at(-1).eventId, 'delivery-audit-new')
})

test('unidentifiable waterfalls warn once and leave snapshots readable without guessing', { timeout: 6500 }, async t => {
  const request = { toolName: 'bash', reason: 'Synthetic audit reason' }
  const questions = [{ id: 'ambiguous-question', question: 'Choose?', options: [{ label: 'Continue' }] }]
  const cases = [
    { records: [], frame: waterfall('delivery-missing', request) },
    { records: [event(1, 'approval/asked', { id: 'audit-a', ...request }), event(2, 'approval/asked', { id: 'audit-b', ...request })], frame: waterfall('delivery-ambiguous-approval', request) },
    { records: [tool(1, 'question-a', 'ask_user_question', { questions }), tool(2, 'question-b', 'ask_user_question', { questions })], frame: waterfall('delivery-ambiguous-question', { questions }, 'user-questions/request') },
  ]
  await Promise.all(cases.map(async ({ records, frame }) => {
    const host = await carrier(t, [turn], { running: false })
    for (const record of records) await host.push('session/follow', record).done
    const delivery = host.push('$events', frame)
    await delivery.started; await tick()
    assert.equal(host.output.filter(item => item.kind === 'interaction.open').length, 0)
    await delivery.done
    const started = performance.now()
    const [snapshot, pending] = await Promise.all([host.snapshot(), host.pending()])
    assert.ok(performance.now() - started < 2500, 'reads stay bounded after an unidentifiable delivery')
    assert.deepEqual(snapshot.interactions, [])
    assert.deepEqual(pending, [])
    assert.equal(snapshot.session.summary.status, 'idle')
    assert.equal(snapshot.session.summary.pendingInteractions, 0)
    assert.equal(snapshot.items.filter(item => item.kind === 'interaction' && item.state === 'pending').length, 0)
    const notices = snapshot.items.filter(item => item.kind === 'notice' && item.level === 'warning')
    assert.equal(notices.length, 1)
    assert.match(notices[0].text, /DeepSeek Harness/)
    assert.equal((await host.snapshot()).items.filter(item => item.kind === 'notice' && item.level === 'warning').length, 1,
      'subsequent reads do not duplicate the warning')
    assert.equal(host.output.filter(item => item.kind === 'interaction.open').length, 0)
    if (!records.length) {
      await host.push('$events', { type: 'cancel', eventId: frame.eventId }).done
      assert.deepEqual(await host.pending(), [])
    }
  }))
})

test('concurrent first watchers and delivery share a single follow projection', async t => {
  const audit = event(2, 'approval/asked', { id: 'concurrent-audit', callId: 'concurrent-call', toolName: 'bash' })
  const host = await carrier(t, [turn, tool(1, 'concurrent-call'), audit], { watch: false, initiallyHidden: true })
  const delivery = host.push('$events', waterfall('delivery-concurrent', { callId: 'concurrent-call', toolName: 'bash' }))
  const watches = await Promise.all([
    host.peer.watch('session.watch', { sessionId }, event => host.output.push(event), signal()),
    host.peer.watch('session.watch', { sessionId }, () => {}, signal()),
  ])
  await delivery.done
  assert.equal(host.opened.get('session/follow'), 1)
  assert.equal(onePending(watches[0].result).interactionId, onePending(watches[1].result).interactionId)
  assert.equal((await host.pending()).length, 1)
})
