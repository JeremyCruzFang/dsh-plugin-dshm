import test from 'node:test'
import assert from 'node:assert/strict'
import { createDecipheriv, createHmac } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseConfig } from '../lib/config.js'
import { capabilities, createMethods, CreationLedger } from '../lib/methods/index.js'
import { PushController, proxyURL } from '../lib/push/controller.js'
import { collapseId, encryptPayload, keyBytes } from '../lib/push/payload.js'
import { PushStore } from '../lib/push/store.js'

const origin = 'http://127.0.0.1:54321'
const epoch = Date.parse('2026-10-27T00:00:00.000Z')
const signal = () => new AbortController().signal
// These are fixed synthetic test keys, shared by no device or deployment.
const registration = (suffix = 'a', prefs = {}) => ({ pushId: `test-push-id-${suffix.padEnd(16, 'x')}`,
  pushSecret: Buffer.alloc(32, 17).toString('base64'), notifKey: Buffer.alloc(32, 23).toString('base64'), env: 'sandbox',
  prefs: { approvals: true, turnFinished: true, errors: true, ...prefs } })

function directory(t) {
  const dir = mkdtempSync(join(tmpdir(), 'dshm-013-push-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}
function decrypt(ciphertext, key = registration().notifKey) {
  const bytes = Buffer.from(ciphertext, 'base64')
  const cipher = createDecipheriv('aes-256-gcm', keyBytes(key), bytes.subarray(0, 12))
  cipher.setAAD(Buffer.from('dshm-push-v1')); cipher.setAuthTag(bytes.subarray(-16))
  return JSON.parse(Buffer.concat([cipher.update(bytes.subarray(12, -16)), cipher.final()]).toString('utf8'))
}
function interaction(id, { kind = 'approval', blocking = true, sessionId = 'session-a', title = 'Test session' } = {}) {
  const base = { interactionId: id, sessionId, kind, blocking, createdAt: new Date(epoch).toISOString() }
  return { type: 'interaction', sessionId, title, interaction: kind === 'approval'
    ? { ...base, approval: { title: 'Test command', command: 'npm test', risk: 'low' } }
    : { ...base, questions: [{ questionId: 'q', question: 'Continue testing?', options: [], multiSelect: false }] } }
}
const turn = (sessionId = 'session-a', duration = 30000, reason = 'completed') => ({
  type: 'turn', sessionId, itemId: `turn-${sessionId}`, title: 'Test session', startedAt: epoch, endedAt: epoch + duration, reason,
})

async function harness(t, options = {}) {
  const stateDir = options.stateDir ?? directory(t), requests = [], capabilitiesSeen = [], connected = new Set()
  const devices = new Set(options.devices ?? ['device-a'])
  let now = epoch, healthy = true, emit, observerFailure, observerStarts = 0, observerCloses = 0
  let requestHandler = options.requestHandler
  const controller = new PushController({ stateDir, proxyUrl: options.proxyUrl ?? origin, hostId: 'test-host',
    projection: { async connect() { throw new Error('Unit tests must not connect to DSH') } },
    connected: id => connected.has(id), devices: () => [...devices], now: () => now,
    capability: enabled => capabilitiesSeen.push(enabled), probeIntervalMs: 3600000,
    observerFactory(onObservation, onFailure) {
      emit = onObservation; observerFailure = onFailure
      return { async start() { observerStarts++; for (const observation of options.initialObservations ?? []) onObservation(observation) }, async close() { observerCloses++ } }
    },
    async fetch(url, init = {}) {
      if (new URL(url).pathname === '/healthz') {
        if (healthy instanceof Error) throw healthy
        return Response.json(healthy === true ? { service: 'dshm-push', v: 1 } : healthy)
      }
      const request = { url, method: init.method, headers: new Headers(init.headers), body: Buffer.from(init.body ?? ''), signal: init.signal }
      requests.push(request)
      if (requestHandler) return requestHandler(request)
      return new Response(null, { status: init.method === 'DELETE' ? 204 : 200 })
    },
  })
  t.after(() => controller.close())
  if (options.start !== false) await controller.start()
  return { controller, stateDir, requests, capabilitiesSeen, connected, devices,
    emit: value => emit(value), failObserver: () => observerFailure(),
    setTime: value => { now = value }, setHealthy: value => { healthy = value },
    setRequestHandler: value => { requestHandler = value },
    get observerStarts() { return observerStarts }, get observerCloses() { return observerCloses },
    posts: () => requests.filter(request => request.method === 'POST'),
    payloads: () => requests.filter(request => request.method === 'POST').map(request => decrypt(JSON.parse(request.body).ciphertext)),
  }
}
function assertSigned(request, params = registration()) {
  assert.equal(request.headers.get('x-dshm-signature'), createHmac('sha256', keyBytes(params.pushSecret)).update(request.body).digest('base64'))
}

test('default configuration and base capabilities omit push; proxy URLs have a safe origin boundary', () => {
  assert.equal(parseConfig({}).pushProxyUrl, undefined)
  assert.equal(capabilities.includes('push'), false)
  assert.equal(proxyURL('https://push.example.test/'), 'https://push.example.test')
  assert.equal(proxyURL(origin), origin)
  for (const value of ['http://push.example.test', 'https://user:password@push.example.test', 'https://push.example.test/path', 'https://push.example.test/?query=1', 'https://push.example.test/#fragment']) assert.throws(() => proxyURL(value))
})

test('push registration persists privately, reloads and rejects invalid keys without replacing valid state', t => {
  const stateDir = directory(t), store = new PushStore(stateDir, origin), params = registration()
  store.register('device-a', params)
  assert.equal(statSync(store.file).mode & 0o777, 0o600)
  assert.deepEqual(new PushStore(stateDir, origin).records.get('device-a'), { ...params, proxyUrl: origin, seenInteractions: [], lastSent: {} })
  for (const key of ['AAAA', Buffer.alloc(31).toString('base64'), params.notifKey + '\n']) {
    assert.throws(() => store.register('device-a', { ...params, notifKey: key }))
    assert.throws(() => store.register('device-a', { ...params, pushSecret: key }))
  }
  assert.throws(() => store.register('device-a', { ...params, pushId: '../invalid' }))
  assert.equal(store.records.get('device-a').notifKey, params.notifKey)
  assert.deepEqual(JSON.parse(readFileSync(store.file, 'utf8'))['device-a'].prefs, params.prefs)
})

test('encryption exactly matches the shared Swift interoperability fixture', () => {
  const fixture = JSON.parse(readFileSync(new URL('../../protocol/fixtures/push-payload-v1.json', import.meta.url), 'utf8'))
  assert.equal(JSON.stringify(fixture.payload), fixture.plaintextJSON)
  assert.equal(encryptPayload(fixture.payload, keyBytes(fixture.keyBase64), Buffer.from(fixture.nonceBase64, 'base64')), fixture.ciphertext)
  assert.deepEqual(decrypt(fixture.ciphertext, fixture.keyBase64), fixture.payload)
  assert.notEqual(collapseId('ab', 'c'), collapseId('a', 'bc'))
})

test('blocking approval and question send signed encrypted payloads; continued questions do not', async t => {
  const h = await harness(t); h.controller.register('device-a', registration())
  const approval = interaction('approval-1', { title: '🧪'.repeat(130) })
  approval.interaction.approval.command = '🔬'.repeat(200)
  h.emit(approval); h.emit(interaction('question-1', { kind: 'question' })); h.emit(interaction('continued-1', { kind: 'question', blocking: false }))
  await h.controller.settle()
  assert.deepEqual(h.payloads().map(payload => payload.kind), ['approval', 'question'])
  for (const request of h.posts()) {
    assertSigned(request)
    const body = JSON.parse(request.body), payload = decrypt(body.ciphertext)
    assert.deepEqual(Object.keys(body).sort(), ['ciphertext', 'collapseId', 'kind', 'pushId'])
    assert.equal(body.collapseId, collapseId('test-host', 'session-a'))
    assert.equal(payload.hostId, 'test-host'); assert.equal(payload.sessionId, 'session-a')
    assert.equal(payload.sentAt, new Date(epoch).toISOString())
    assert.ok(Array.from(payload.body).length <= 180)
    assert.ok(!request.body.includes(Buffer.from('Wants to run')))
  }
  assert.equal(Array.from(h.payloads()[0].title).length, 120)
  assert.equal(h.controller.counters.sent, 2)
})

test('a live authenticated device suppresses its pushes, including replay after disconnect', async t => {
  const h = await harness(t, { devices: ['device-a', 'device-b'] })
  h.controller.register('device-a', registration('a')); h.controller.register('device-b', registration('b'))
  h.connected.add('device-a'); h.emit(interaction('live-1')); await h.controller.settle()
  assert.deepEqual(h.posts().map(request => JSON.parse(request.body).pushId), [registration('b').pushId])
  h.connected.delete('device-a'); h.emit(interaction('live-1')); await h.controller.settle()
  assert.equal(h.posts().length, 1)
  h.connected.add('device-a'); h.emit(turn()); await h.controller.settle()
  assert.equal(h.posts().length, 2)
  assert.equal(JSON.parse(h.posts()[1].body).pushId, registration('b').pushId)
})

test('authentication aborts a pending network request without withdrawing capability', async t => {
  let aborted = false
  const h = await harness(t, { requestHandler: request => new Promise((resolve, reject) => {
    request.signal.addEventListener('abort', () => { aborted = true; reject(request.signal.reason) }, { once: true })
  }) })
  h.controller.register('device-a', registration()); h.emit(interaction('abort-1'))
  assert.equal(h.posts().length, 1)
  h.connected.add('device-a'); h.controller.connected('device-a'); await h.controller.settle()
  assert.equal(aborted, true); assert.equal(h.controller.counters.sent, 0)
  assert.equal(h.controller.counters.failures, 0); assert.equal(h.capabilitiesSeen.at(-1), true)
})

test('interaction deduplication survives controller reload and preference changes', async t => {
  const stateDir = directory(t), first = await harness(t, { stateDir })
  first.controller.register('device-a', registration()); first.emit(interaction('dedup-1')); first.emit(interaction('dedup-1'))
  await first.controller.settle(); assert.equal(first.posts().length, 1); await first.controller.close()
  const second = await harness(t, { stateDir })
  second.emit(interaction('dedup-1')); await second.controller.settle(); assert.equal(second.posts().length, 0)
  second.controller.register('device-a', registration('a', { approvals: false }))
  second.emit(interaction('prefs-off')); await second.controller.settle()
  second.controller.register('device-a', registration()); second.emit(interaction('prefs-off')); second.emit(interaction('dedup-2'))
  await second.controller.settle(); assert.equal(second.posts().length, 1)
  assert.equal(second.payloads()[0].interactionId, 'dedup-2')
})

test('persisted registrations receive a new pending approval from the initial observer snapshot', async t => {
  const stateDir = directory(t), store = new PushStore(stateDir, origin)
  store.register('device-a', registration())
  const h = await harness(t, { stateDir, initialObservations: [interaction('pending-at-start')] })
  await h.controller.settle()
  assert.equal(h.posts().length, 1)
  assert.equal(h.payloads()[0].interactionId, 'pending-at-start')
  assertSigned(h.posts()[0]); assert.equal(h.capabilitiesSeen.at(-1), true)
})

test('replacing a push ID signs DELETE with the previous key and retains the new registration', async t => {
  const h = await harness(t), old = registration('old'), replacement = { ...registration('new'), pushSecret: Buffer.alloc(32, 41).toString('base64') }
  h.controller.register('device-a', old)
  h.controller.register('device-a', replacement); await h.controller.settle()
  assert.equal(h.requests.length, 1); assert.equal(h.requests[0].method, 'DELETE')
  assert.equal(h.requests[0].url, `${origin}/v1/register/${old.pushId}`); assertSigned(h.requests[0], old)
  assert.equal(h.controller.store.records.get('device-a').pushId, replacement.pushId)
  assert.equal(new PushStore(h.stateDir, origin).records.get('device-a').pushSecret, replacement.pushSecret)
  h.controller.register('device-a', { ...replacement, prefs: { approvals: false, turnFinished: true, errors: true } })
  await h.controller.settle(); assert.equal(h.requests.length, 1)
  h.emit(turn()); await h.controller.settle(); assert.equal(h.posts().length, 1)
  assertSigned(h.posts()[0], replacement)
})

test('each device preference gates approval/question, turn and error independently', async t => {
  const h = await harness(t, { devices: ['approval-device', 'turn-device', 'error-device'] })
  h.controller.register('approval-device', registration('approval', { turnFinished: false, errors: false }))
  h.controller.register('turn-device', registration('turn', { approvals: false, errors: false }))
  h.controller.register('error-device', registration('error', { approvals: false, turnFinished: false }))
  h.emit(interaction('prefs-approval')); h.emit(interaction('prefs-question', { kind: 'question' }))
  h.emit(turn('turn-session')); h.emit(turn('error-session', 1, 'error')); await h.controller.settle()
  const pairs = h.posts().map(request => { const body = JSON.parse(request.body); return [body.pushId, body.kind] })
  assert.deepEqual(pairs, [[registration('approval').pushId, 'approval'], [registration('approval').pushId, 'question'], [registration('turn').pushId, 'turn'], [registration('error').pushId, 'error']])
})

test('turn threshold and error debounce are per device/session and persist across restart', async t => {
  const stateDir = directory(t), h = await harness(t, { stateDir, devices: ['device-a', 'device-b'] })
  h.controller.register('device-a', registration('a')); h.controller.register('device-b', registration('b'))
  h.emit(turn('session-a', 29999)); h.emit({ ...turn('unknown-start'), startedAt: undefined }); h.emit(turn('cancelled', 60000, 'cancelled'))
  await h.controller.settle(); assert.equal(h.posts().length, 0)
  h.connected.add('device-a'); h.emit(turn()); await h.controller.settle(); assert.equal(h.posts().length, 1)
  h.connected.delete('device-a'); h.emit(turn('session-a', 1, 'error')); await h.controller.settle()
  assert.equal(h.posts().length, 2); assert.equal(JSON.parse(h.posts()[1].body).pushId, registration('a').pushId)
  h.setTime(epoch + 29999); h.emit(turn('session-a', 1, 'error')); await h.controller.settle(); assert.equal(h.posts().length, 2)
  h.emit(turn('session-b', 1, 'error')); await h.controller.settle(); assert.equal(h.posts().length, 4)
  h.setTime(epoch + 30000); h.emit(turn('session-a')); await h.controller.settle(); assert.equal(h.posts().length, 6)
  await h.controller.close()
  const reloaded = await harness(t, { stateDir, devices: ['device-a', 'device-b'] })
  reloaded.setTime(epoch + 30001); reloaded.emit(turn('session-a', 1, 'error')); await reloaded.controller.settle()
  assert.equal(reloaded.posts().length, 0)
})

test('any session watcher suppresses long-turn pushes until all watches end; errors still notify', async t => {
  const h = await harness(t); h.controller.register('device-a', registration())
  const stop1 = h.controller.watch('session-a'), stop2 = h.controller.watch('session-a')
  h.emit(turn()); stop1(); stop1(); h.emit(turn()); await h.controller.settle(); assert.equal(h.posts().length, 0)
  h.emit(turn('session-a', 1, 'error')); await h.controller.settle(); assert.equal(h.posts().length, 1)
  stop2(); h.setTime(epoch + 30000); h.emit(turn()); await h.controller.settle(); assert.equal(h.posts().length, 2)
})

test('unregister/revoke delete private state and sign DELETE, even when the proxy is unavailable', async t => {
  const h = await harness(t); h.controller.register('device-a', registration())
  h.controller.unregister('device-a'); await h.controller.settle()
  assert.equal(h.controller.store.records.size, 0); assert.equal(h.requests[0].method, 'DELETE')
  assert.equal(h.requests[0].body.length, 0); assertSigned(h.requests[0])
  assert.equal(h.requests[0].url, `${origin}/v1/register/${registration().pushId}`)
  h.controller.register('device-a', registration()); h.setRequestHandler(() => { throw new Error('Synthetic offline proxy') })
  assert.doesNotThrow(() => h.controller.revoke('device-a')); await h.controller.settle()
  assert.equal(h.controller.store.records.size, 0); assert.equal(h.controller.counters.revoked, 1)
  assert.equal(h.controller.counters.failures, 1); assert.equal(h.capabilitiesSeen.at(-1), false)
  assert.deepEqual(JSON.parse(readFileSync(h.controller.store.file, 'utf8')), {})
  assertSigned(h.requests[1]); assert.doesNotThrow(() => h.controller.unregister('device-a'))
})

test('capability requires a valid proxy probe and observer, withdraws on failures, and recovers', async t => {
  const h = await harness(t, { start: false })
  assert.throws(() => h.controller.register('device-a', registration()), { code: 'unsupported' })
  h.setHealthy({ service: 'other-service', v: 1 }); await h.controller.probe()
  assert.equal(h.capabilitiesSeen.at(-1), false); assert.equal(h.observerStarts, 0)
  h.setHealthy(true); await h.controller.start(); assert.equal(h.capabilitiesSeen.at(-1), true)
  assert.throws(() => h.controller.register('not-paired', registration()), { code: 'revoked' })
  assert.throws(() => h.controller.register('device-a', { ...registration(), notifKey: 'invalid' }), { code: 'invalid-params' })
  h.controller.register('device-a', registration()); h.failObserver(); await h.controller.settle()
  assert.equal(h.capabilitiesSeen.at(-1), false); assert.equal(h.observerCloses, 1)
  await h.controller.probe(); assert.equal(h.capabilitiesSeen.at(-1), true); assert.equal(h.observerStarts, 2)
  h.setHealthy(new Error('Synthetic failed health probe')); await h.controller.probe(); assert.equal(h.capabilitiesSeen.at(-1), false)
  h.setHealthy(true); await h.controller.probe(); h.setRequestHandler(() => new Response(null, { status: 503 }))
  h.emit(interaction('network-failure')); await h.controller.settle(); assert.equal(h.capabilitiesSeen.at(-1), false)
  assert.doesNotThrow(() => h.emit(interaction('still-offline')))
})

test('changing proxy URL never forwards a previous origin’s credentials or DELETE', async t => {
  const stateDir = directory(t), old = new PushStore(stateDir, origin)
  old.register('device-a', registration())
  const h = await harness(t, { stateDir, proxyUrl: 'https://replacement.example.test' })
  h.emit(interaction('new-origin')); h.controller.unregister('device-a'); await h.controller.settle()
  assert.equal(h.requests.length, 0); assert.equal(h.controller.store.records.size, 0)
  new PushStore(stateDir, origin).register('revoked-device', registration('revoked'))
  const prune = await harness(t, { stateDir, devices: [] })
  await prune.controller.settle(); assert.equal(prune.requests.length, 1); assert.equal(prune.requests[0].method, 'DELETE')
  assert.equal(prune.controller.store.records.size, 0)
})

test('DMP methods route registration to the authenticated device and clean watched-session subscriptions', async t => {
  const h = await harness(t), stopped = []
  const peer = { async request() { throw new Error('Push methods must not reach the projection peer') },
    async watch(method, params) { return { result: { items: [], session: { sessionId: params.sessionId } }, dispose() { stopped.push(params.sessionId) } } }, async dispose() {} }
  const identity = { caps: [...capabilities, 'push'] }
  const methods = createMethods(peer, { identity, deviceId: 'device-a', push: h.controller, emit() {} }, new CreationLedger())
  t.after(() => methods.dispose())
  assert.deepEqual(await methods.request('push.register', registration(), signal()), { result: {} })
  assert.equal(h.controller.store.records.has('device-a'), true)
  const { result } = await methods.request('session.watch', { sessionId: 'session-a' }, signal())
  h.emit(turn()); await h.controller.settle(); assert.equal(h.posts().length, 0)
  await methods.request('unsubscribe', { subId: result.subId }, signal())
  h.emit(turn()); await h.controller.settle(); assert.equal(h.posts().length, 1)
  assert.deepEqual(stopped, ['session-a'])
  await methods.request('session.watch', { sessionId: 'session-b' }, signal()); await methods.dispose()
  assert.deepEqual(stopped, ['session-a', 'session-b'])
  const offlineMethods = createMethods(peer, { identity: { caps: [] }, deviceId: 'device-a', push: h.controller, emit() {} }, new CreationLedger())
  await assert.rejects(offlineMethods.request('push.register', registration(), signal()), { code: 'unsupported' })
  assert.deepEqual(await offlineMethods.request('push.unregister', {}, signal()), { result: {} })
  await h.controller.settle(); assert.equal(h.controller.store.records.size, 0)
  await offlineMethods.dispose()
})
