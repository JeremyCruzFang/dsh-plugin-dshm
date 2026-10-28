import test from 'node:test'
import assert from 'node:assert/strict'
import { CreationLedger, createMethods, fitPage } from '../lib/methods/index.js'

const context = { deviceId: 'device-1', identity: { host: { hostId: 'host', name: 'test', platform: 'macos' }, version: 'test', instanceId: 'instance', dshVersion: 'test', dshStatus: 'ok', caps: ['send'] }, emit() {} }
const signal = () => new AbortController().signal
function fakePeer() {
  const sessions = [], calls = []
  let promptFailure = true, createFailure = false
  return { sessions, calls, set createFailure(value) { createFailure = value },
    async create(workspaceId, sessionId) {
      calls.push(['create', workspaceId, sessionId]); sessions.push({ sessionId })
      if (createFailure) { createFailure = false; throw new Error('reply lost after native create') }
      return { sessionId }
    },
    async request(method, params) {
      calls.push([method, params])
      if (method === 'sessions.list') return { sessions }
      if (method === 'session.send' && promptFailure) { promptFailure = false; throw new Error('admission reply lost') }
      return { accepted: true }
    },
    async dispose() {},
  }
}

test('creation ledger retains target across uncertain native create and first-prompt admission', async () => {
  const peer = fakePeer(), ledger = new CreationLedger(), params = { workspaceId: 'workspace', sendId: 'send', text: 'hello' }
  peer.createFailure = true
  await assert.rejects(ledger.create('device', params, peer))
  await assert.rejects(ledger.create('device', params, peer))
  const result = await ledger.create('device', params, peer)
  assert.equal(peer.calls.filter(([method]) => method === 'create').length, 1)
  assert.equal(result.sessionId, peer.sessions[0].sessionId)
  assert.deepEqual(await ledger.create('device', params, peer), result)
  await assert.rejects(ledger.create('device', { ...params, text: 'changed' }, peer), { code: 'conflict' })
})

test('concurrent creations share one native target and parameters', async () => {
  const peer = fakePeer(), ledger = new CreationLedger(), params = { workspaceId: 'workspace', sendId: 'same' }
  const results = await Promise.all(Array.from({ length: 4 }, () => ledger.create('device', params, peer)))
  assert.equal(new Set(results.map(result => result.sessionId)).size, 1)
  assert.equal(peer.calls.filter(([method]) => method === 'create').length, 1)
})

test('unimplemented modes and malformed empty sends cannot reach projection', async () => {
  const peer = fakePeer(), methods = createMethods(peer, context, new CreationLedger())
  await assert.rejects(methods.request('session.send', { text: '', sendId: 'x', sessionId: 'x' }, signal()), { code: 'invalid-params' })
  await assert.rejects(methods.request('session.send', { text: 'x', mode: 'steer' }, signal()), { code: 'unsupported' })
  await assert.rejects(methods.request('session.send', { text: 'x', attachments: ['unowned'] }, signal()), { code: 'unsupported' })
  await assert.rejects(methods.request('files.read', { sessionId: 'x', path: '/private/no-access' }, signal()), { code: 'unsupported' })
  assert.deepEqual(peer.calls, [])
})

test('frame budget shrinks complete oldest display groups; resume is never partially merged', () => {
  const items = Array.from({ length: 6 }, (_, index) => ({ itemId: String(index), order: { seq: Math.floor(index / 2), index: index % 2 }, text: 'x'.repeat(210000) }))
  const result = fitPage({ items, hasMoreBefore: false, resumed: false })
  assert.equal(result.items.length, 4); assert.equal(result.hasMoreBefore, true)
  assert.deepEqual(result.items.map(item => item.itemId), ['2', '3', '4', '5'])
  assert.throws(() => fitPage({ items, resumed: true }), { code: 'too-large' })
})


test('device subscriptions use public registry views and unsubscribe removes the observer', async () => {
  const records = [{ deviceId: 'device-1', name: 'phone', model: 'test', secureEnclave: false, pairedAt: '2026-10-26T00:00:00.000Z', current: true }]
  const observers = new Set(), events = []
  const devices = {
    list: () => structuredClone(records),
    rename(id, name) { const device = records.find(d => d.deviceId === id); device.name = name; for (const observer of observers) observer(); return structuredClone(device) },
    revoke(id) { records.splice(records.findIndex(d => d.deviceId === id), 1); for (const observer of observers) observer() },
    watch(changed) { observers.add(changed); return () => observers.delete(changed) },
  }
  const methods = createMethods(fakePeer(), { ...context, devices, identity: { ...context.identity, caps: ['devices'] }, emit(sub, event) { events.push({ sub, event }) } }, new CreationLedger())
  const { result: initial } = await methods.request('devices.watch', {}, signal())
  assert.equal(initial.devices[0].current, true)
  const { result } = await methods.request('devices.rename', { deviceId: 'device-1', name: 'renamed' }, signal())
  assert.equal(result.device.name, 'renamed')
  assert.equal(events.at(-1).sub, initial.subId)
  assert.equal(events.at(-1).event.kind, 'devices.replace')
  await methods.request('unsubscribe', { subId: initial.subId }, signal())
  assert.equal(observers.size, 0)
  await methods.request('devices.revoke', { deviceId: 'device-1' }, signal())
  assert.deepEqual((await methods.request('devices.list', {}, signal())).result.devices, [])
  await methods.request('devices.watch', {}, signal())
  await methods.dispose()
  assert.equal(observers.size, 0)
})
