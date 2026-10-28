import test from 'node:test'
import assert from 'node:assert/strict'
import { installHostRoutes, installCli, cliInject } from '../../lib/projection/host.js'

function fixture(overrides = {}) {
  const routes = new Map(), calls = []
  installHostRoutes({ connection: { fetch: { register(route) { routes.set(route.path, route) } } } }, {
    status: () => ({ connectedDevices: 1, pairing: { active: false } }),
    devices: () => [{ deviceId: 'synthetic-device', connected: true }],
    pair: async () => { calls.push('pair'); return { url: 'synthetic-pairing', svg: '<svg/>', expiresAt: '2026-10-26T01:00:00.000Z' } },
    cancelPair: () => { calls.push('cancel') },
    revoke: id => { calls.push(['revoke', id]); return id === 'synthetic-device' },
    remoteSetup: async () => ({ state: 'stopped', bridgeListening: false, connectedDevices: 0 }),
    openTailscale: async () => { calls.push('openTailscale') },
    pairRemote: async () => undefined,
    ...overrides,
  })
  const request = (path, method = 'GET', body) => routes.get(`/api/dshm/${path}`).fetch(new Request(`http://localhost/api/dshm/${path}`, { method, ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }) }))
  return { routes, calls, request }
}

test('host controls use exact native owner routes and no-store responses', async () => {
  const { routes, calls, request } = fixture()
  assert.deepEqual([...routes.keys()], ['status', 'devices', 'remoteSetup', 'openTailscale', 'pairRemote', 'pair', 'cancelPair', 'revoke'].map(name => `/api/dshm/${name}`))
  assert.deepEqual(routes.get('/api/dshm/pair').methods, ['POST'])
  assert.equal(routes.get('/api/dshm/pair').requestBody, 'buffered')
  const status = await request('status')
  assert.equal(status.headers.get('cache-control'), 'no-store')
  assert.equal((await status.json()).connectedDevices, 1)
  assert.equal((await (await request('devices')).json()).devices[0].deviceId, 'synthetic-device')
  assert.equal((await (await request('pair', 'POST', {})).json()).url, 'synthetic-pairing')
  assert.deepEqual(await (await request('cancelPair', 'POST', {})).json(), {})
  assert.deepEqual(await (await request('revoke', 'POST', { deviceId: 'synthetic-device' })).json(), { revoked: true })
  assert.equal((await request('revoke', 'POST', { deviceId: 'missing' })).status, 404)
  assert.deepEqual(calls, ['pair', 'cancel', ['revoke', 'synthetic-device'], ['revoke', 'missing']])
})

test('invalid control input never reaches state mutation', async () => {
  const { calls, request } = fixture()
  for (const [route, body] of [['openTailscale', { path: 'untrusted.exe' }], ['pairRemote', { address: '8.8.8.8' }], ['pair', { surprise: true }], ['cancelPair', []], ['revoke', {}], ['revoke', { deviceId: '' }], ['revoke', { deviceId: 'x'.repeat(257) }], ['revoke', { deviceId: 'synthetic-device', extra: 1 }]]) {
    assert.equal((await request(route, 'POST', body)).status, 400)
  }
  assert.deepEqual(calls, [])
})

test('remote setup failure does not open pairing or return native errors', async () => {
  const { calls, request, routes } = fixture()
  assert.equal((await (await request('remoteSetup')).json()).state, 'stopped')
  assert.equal((await request('pairRemote', 'POST', {})).status, 409)
  assert.deepEqual(calls, [])
  assert.deepEqual(await (await request('openTailscale', 'POST', {})).json(), { opened: true })
  assert.deepEqual(calls, ['openTailscale'])
  const hostile = new Request('http://localhost/api/dshm/openTailscale', { method: 'POST', body: '{}' })
  assert.equal((await routes.get('/api/dshm/openTailscale').fetch(hostile)).status, 400)
})

test('remote control exceptions return fixed recoverable errors without native output', async () => {
  const fail = async () => { throw new Error('synthetic-private-native-output') }
  const { request } = fixture({ remoteSetup: fail, openTailscale: fail, pairRemote: fail })
  for (const [name, method, body] of [['remoteSetup', 'GET'], ['openTailscale', 'POST', {}], ['pairRemote', 'POST', {}]]) {
    const response = await request(name, method, body)
    assert.equal(response.status, 503)
    assert.ok(!(await response.text()).includes('synthetic-private-native-output'))
  }
})

test('custom-profile CLI runs only after launcher readiness and exits with runner status', async () => {
  let callback, disposed = 0, stop, calls = [], resolveRun
  const pending = new Promise(resolve => { resolveRun = resolve })
  installCli({
    get(name) { return { cmdlineArgs: { get: () => ['status'] }, appExit: code => calls.push(['exit', code]), appReady: { onReady: value => { callback = value; return () => { disposed++ } } } }[name] },
    effect(create) { stop = create() },
  }, args => { calls.push(['run', ...args]); return pending })
  assert.deepEqual(cliInject, ['cmdlineArgs', 'appExit', 'appReady'])
  assert.deepEqual(calls, [])
  callback(); assert.deepEqual(calls, [['run', 'status']])
  resolveRun(0); await pending; await Promise.resolve()
  assert.deepEqual(calls.at(-1), ['exit', 0])
  stop(); assert.equal(disposed, 1)
  assert.throws(() => installCli({ get() {} }, async () => 0), /DSH profile launcher/)
})
