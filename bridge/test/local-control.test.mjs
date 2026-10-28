import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, statSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import http from 'node:http'
import { startLocalControl, localRequest } from '../lib/host/local.js'

test('local control requires its private token, validates commands, and removes state on close', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'dshm-control-')); t.after(() => rmSync(directory, { recursive: true, force: true }))
  let pairCount = 0, revoked
  const host = await startLocalControl(directory, { status: () => ({ connectedDevices: 1 }), devices: () => [{ deviceId: 'device' }], pair: async () => { pairCount++; return { url: 'synthetic', svg: '<svg/>', expiresAt: 'future' } }, cancelPair() {}, revoke(id) { revoked = id; return true } })
  t.after(() => host.close())
  const { socket } = JSON.parse(readFileSync(join(directory, 'control.json'), 'utf8'))
  assert.equal(statSync(join(directory, 'control.json')).mode & 0o777, 0o600)
  if (process.platform !== 'win32') assert.equal(statSync(socket).mode & 0o777, 0o600)
  const unauthenticated = await new Promise((resolve, reject) => {
    const req = http.request({ socketPath: socket, path: '/pair', method: 'POST' }, res => { res.resume(); resolve(res.statusCode) }); req.on('error', reject); req.end('{}')
  })
  assert.equal(unauthenticated, 401); assert.equal(pairCount, 0)
  assert.equal((await localRequest(directory, 'GET', '/status')).connectedDevices, 1)
  assert.equal((await localRequest(directory, 'GET', '/devices')).devices[0].deviceId, 'device')
  await localRequest(directory, 'POST', '/pair', {}); assert.equal(pairCount, 1)
  await assert.rejects(localRequest(directory, 'POST', '/pair', { unexpected: true }))
  await localRequest(directory, 'POST', '/revoke', { deviceId: 'device' }); assert.equal(revoked, 'device')
  await localRequest(directory, 'POST', '/cancel', {})
  await host.close()
  assert.equal(existsSync(join(directory, 'control.json')), false)
})
