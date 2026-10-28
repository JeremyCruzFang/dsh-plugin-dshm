import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { advertisementRecords, createAdvertiser } from '../lib/discovery/advertiser.js'

const initial = { hostId: 'test-host-id', name: 'Test Mac', port: 47390, addresses: ['192.168.22.5'] }
function transports() {
  const instances = []
  function factory(options) {
    const socket = new EventEmitter()
    socket.options = options; socket.sent = []; socket.destroyed = false
    socket.respond = (packet, remote, callback) => { socket.sent.push({ packet: structuredClone(packet), remote: typeof remote === 'object' ? remote : undefined }); (typeof remote === 'function' ? remote : callback)?.() }
    socket.destroy = callback => { socket.destroyed = true; callback?.() }
    instances.push(socket)
    queueMicrotask(() => socket.emit('ready'))
    return socket
  }
  return { factory, instances }
}

test('discovery records contain only bound private addresses and public host/version TXT', () => {
  const { serviceName, records } = advertisementRecords({ ...initial, name: 'Long.\\电脑'.repeat(20), addresses: ['192.168.22.5', 'fd12::3'] })
  assert.ok(Buffer.byteLength(serviceName) <= 63)
  assert.equal(/[.\\]/.test(serviceName), false)
  assert.deepEqual(records.filter(record => ['A', 'AAAA'].includes(record.type)).map(record => record.data), ['192.168.22.5', 'fd12::3'])
  assert.deepEqual(records.find(record => record.type === 'TXT').data.map(value => value.toString()), ['host=test-host-id', 'v=1'])
  assert.equal(records.find(record => record.type === 'SRV').data.port, 47390)
  for (const address of ['0.0.0.0', '::', '8.8.8.8', 'example.com']) assert.throws(() => advertisementRecords({ ...initial, addresses: [address] }))
})

test('advertiser answers matching queries, withdraws replaced addresses and joins shutdown', async () => {
  const mock = transports(), states = []
  const advertiser = await createAdvertiser(initial, state => states.push(state), mock.factory)
  const first = mock.instances[0]
  assert.equal(first.options.interface, initial.addresses[0])
  assert.equal(advertiser.status().state, 'advertising')
  assert.equal(first.sent.length, 1)
  first.emit('query', { questions: [{ name: '_unrelated._tcp.local', type: 'PTR' }] }, { port: 5353 })
  assert.equal(first.sent.length, 1)
  first.emit('query', { questions: [{ name: '_DSHM._TCP.LOCAL.', type: 'PTR' }] }, { port: 5353 })
  assert.equal(first.sent.length, 2)
  first.emit('query', { id: 51, questions: [{ name: '_dshm._tcp.local', type: 'PTR' }] }, { port: 23456, address: '192.168.22.9' })
  assert.equal(first.sent.at(-1).packet.id, 51)
  assert.equal(first.sent.at(-1).remote.port, 23456)
  await advertiser.update({ ...initial, port: 47391, addresses: ['192.168.22.6'] })
  assert.ok(first.sent.at(-1).packet.answers.every(record => record.ttl === 0))
  assert.equal(first.destroyed, true)
  const second = mock.instances[1]
  assert.equal(second.sent[0].packet.answers.find(record => record.type === 'SRV').data.port, 47391)
  assert.deepEqual(second.sent[0].packet.answers.filter(record => record.type === 'A').map(record => record.data), ['192.168.22.6'])
  await advertiser.update({ ...initial, port: 47391, addresses: ['192.168.22.6'] })
  assert.equal(mock.instances.length, 2)
  await advertiser.close()
  assert.equal(second.destroyed, true)
  assert.equal(advertiser.status().state, 'stopped')
})

test('removing all listener interfaces withdraws discovery until an interface returns', async () => {
  const mock = transports()
  const advertiser = await createAdvertiser(initial, undefined, mock.factory)
  await advertiser.update({ ...initial, addresses: [] })
  assert.equal(advertiser.status().state, 'unavailable')
  assert.equal(mock.instances[0].destroyed, true)
  await advertiser.update(initial)
  assert.equal(advertiser.status().state, 'advertising')
  await advertiser.close()
})


test('startup without a bound private interface is unavailable without opening UDP sockets', async () => {
  const mock = transports()
  const advertiser = await createAdvertiser({ ...initial, port: 0, addresses: [] }, undefined, mock.factory)
  assert.equal(advertiser.status().state, 'unavailable')
  assert.equal(mock.instances.length, 0)
  await advertiser.update(initial)
  assert.equal(advertiser.status().state, 'advertising')
  await advertiser.close()
})
