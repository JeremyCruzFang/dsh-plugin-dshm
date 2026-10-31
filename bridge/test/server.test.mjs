import test from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import https from 'node:https'
import net from 'node:net'
import { once } from 'node:events'
import tls from 'node:tls'
import os from 'node:os'
import path from 'node:path'
import { startServer } from '../lib/server/index.js'
import { HostState } from '../lib/pairing/state.js'
import { PairingWindow } from '../lib/pairing/window.js'
import { isPrivateAddress, isTailscale } from '../lib/discovery/interfaces.js'
import { publicKeyFromSpki, verifySignature, authMessage } from '../lib/auth/signature.js'
import { Client, delay } from '../../tools/mock-host/test/client.mjs'

function directory(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshm-007-server-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  return dir
}
test('only explicit private addresses bind, with loopback reserved for explicit test config', () => {
  for (const address of ['0.0.0.0','::','8.8.8.8','example.com','127.0.0.1','::1']) assert.equal(isPrivateAddress(address), false)
  for (const address of ['10.1.2.3','172.16.0.1','192.168.1.2','100.64.0.1','fd7a:115c:a1e0::1']) assert.equal(isPrivateAddress(address), true)
  assert.equal(isPrivateAddress('127.0.0.1', true), true)
  assert.equal(isPrivateAddress('::1', true), true)
  assert.equal(isTailscale('100.127.255.255'), true)
  assert.equal(isTailscale('100.128.0.1'), false)
})
test('wildcard and public bind requests fail before creating identity state', async t => {
  const dir = directory(t)
  for (const address of ['0.0.0.0', '::', '8.8.8.8']) {
    await assert.rejects(startServer({ stateDir:dir, port:0, addresses:[address], version:'test', dshVersion:'test', dshStatus:'ok', caps:[], connect:async () => { throw new Error('must not connect') } }), /private or loopback/)
    assert.deepEqual(fs.readdirSync(dir), [])
  }
})
test('an occupied port rejects startup, releases earlier listeners and allows retry', async t => {
  const blocker = net.createServer()
  t.after(() => { if (blocker.listening) return new Promise(resolve => blocker.close(resolve)) })
  blocker.listen({ host: '::1', port: 0, ipv6Only: true })
  await once(blocker, 'listening')

  // IPv4 binds first. The IPv6 conflict must also roll back the IPv4 listener.
  const options = {
    stateDir: directory(t), port: blocker.address().port, addresses: ['127.0.0.1', '::1'],
    version: 'test', dshVersion: 'test', dshStatus: 'ok', caps: [], quiet: true,
    async connect() { throw new Error('unexpected client') },
  }
  await assert.rejects(startServer(options), { code: 'EADDRINUSE' })
  await new Promise(resolve => blocker.close(resolve))
  const bridge = await startServer(options)
  t.after(() => bridge.close())
  assert.equal(bridge.port, options.port)
  assert.deepEqual(bridge.addresses, options.addresses)
})

test('TLS identity persists; registry retains revoked records and private file modes', t => {
  const dir = directory(t), first = new HostState(dir), second = new HostState(dir)
  assert.equal(first.hostId, second.hostId); assert.equal(first.fingerprint, second.fingerprint)
  const keys = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
  const id = first.pair({ name: 'Fake phone', model: 'Test', publicKey: keys.publicKey.export({ format:'der',type:'spki' }).toString('base64'), secureEnclave:false })
  assert.equal(first.revoke(id), true); second.reload(); assert.ok(second.devices[id].revokedAt)
  for (const file of ['key.pem','cert.pem','host-id','devices.json']) assert.equal(fs.statSync(path.join(dir, file)).mode & 0o777, 0o600)
})
test('named-curve identity works with the isolated macOS LibreSSL PATH', t => {
  if (process.platform !== 'darwin') return t.skip('macOS LibreSSL compatibility')
  const dir = directory(t), originalPath = process.env.PATH
  try {
    process.env.PATH = '/usr/bin:/bin:/usr/sbin:/sbin'
    const identity = new HostState(dir)
    assert.doesNotThrow(() => tls.createSecureContext({ key: identity.key, cert: identity.cert }))
    const key = crypto.createPrivateKey(identity.key)
    assert.equal(key.asymmetricKeyDetails.namedCurve, 'prime256v1')
    assert.equal(new crypto.X509Certificate(identity.cert).publicKey.asymmetricKeyDetails.namedCurve, 'prime256v1')
  } finally {
    if (originalPath === undefined) delete process.env.PATH
    else process.env.PATH = originalPath
  }
})
test('pairing is explicit, bounded to five attempts, expiring, and single use', t => {
  const dir = directory(t), window = new PairingWindow(dir, true)
  t.after(() => window.close())
  assert.equal(window.verify('wrong'), 'pairing-closed')
  const values = { hostId:'test-host', name:'Fake', fingerprint:'fake', addresses:['127.0.0.1:1234'] }
  const url = window.open(values), otp = new URL(url).searchParams.get('otp')
  assert.equal(Buffer.from(otp, 'base64url').length, 16)
  assert.equal(fs.statSync(path.join(dir,'pairing-url.txt')).mode & 0o777, 0o600)
  assert.equal(window.verify(otp), 'ok'); window.close()
  assert.equal(window.verify(otp), 'pairing-closed')
  window.open(values)
  for (let i=0;i<5;i++) assert.equal(window.verify('wrong'), 'bad-otp')
  assert.equal(window.verify(otp), 'pairing-closed'); assert.equal(fs.existsSync(path.join(dir,'pairing-url.txt')),false)
  window.open(values)
  const time = Date.now(); t.mock.method(Date,'now', () => time+300001)
  assert.equal(window.verify(otp), 'pairing-closed')
})
test('signature binds nonce, host and fingerprint and requires P-256 SPKI', () => {
  const keys = crypto.generateKeyPairSync('ec',{namedCurve:'prime256v1'})
  const pub = keys.publicKey.export({type:'spki',format:'der'}).toString('base64')
  const nonce = crypto.randomBytes(32).toString('base64url')
  const sig = crypto.sign('sha256',authMessage(nonce,'host','pin'),keys.privateKey).toString('base64')
  assert.equal(verifySignature(pub,nonce,'host','pin',sig),true)
  assert.equal(verifySignature(pub,crypto.randomBytes(32).toString('base64url'),'host','pin',sig),false)
  assert.equal(verifySignature(pub,nonce,'other','pin',sig),false)
  assert.equal(verifySignature(pub,nonce,'host','other',sig),false)
  const wrong = crypto.generateKeyPairSync('ec',{namedCurve:'secp384r1'}).publicKey.export({type:'spki',format:'der'}).toString('base64')
  assert.throws(() => publicKeyFromSpki(wrong))
})

test('listener validates requests, streams with ack windows, replaces and revokes connections', async t => {
  let registryReads = 0
  const reload = HostState.prototype.reload
  HostState.prototype.reload = function () { registryReads++; return reload.call(this) }
  t.after(() => { HostState.prototype.reload = reload })
  const dir = directory(t)
  let connects = 0, disposals = 0, calls = 0
  const addresses = ['127.0.0.1']
  const bytes = Buffer.alloc(10 * 1024 * 1024 + 17, 0x69)
  const server = await startServer({ stateDir:dir,port:0,addresses,pairing:true,quiet:true,version:'test',dshVersion:'test',dshStatus:'ok',caps:['timeline'],
    async connect(context) {
      connects++
      return {
        async request(method, _params, signal) {
          calls++
          if (method === 'timeline.text') return { bytes }
          if (method === 'host.info') return { result:{host:context.identity.host,bridgeVersion:'test',dshStatus:'ok',caps:['timeline'],time:new Date().toISOString()} }
          if (method === 'session.interrupt') {
            await new Promise(resolve => signal.addEventListener('abort',resolve,{once:true}))
            return { result:{accepted:true} }
          }
          throw Object.assign(new Error('unsupported'),{code:'unsupported'})
        },
        dispose() { disposals++ },
      }
    },
  })
  t.after(() => server.close())
  const endpoint = { port:server.port, hostId:server.identity.host.hostId, fingerprint:server.fingerprint, pairingUrl:server.pairingUrl }
  const status = await new Promise((resolve,reject) => https.get(`https://127.0.0.1:${server.port}`, {rejectUnauthorized:false}, res => {res.resume();resolve(res.statusCode)}).on('error',reject))
  assert.equal(status,426)
  const unauthed = new Client(endpoint); await unauthed.wait(f=>f.t==='hello')
  unauthed.send({t:'req',id:1,method:'host.info',params:{}})
  assert.equal((await unauthed.wait(f=>f.t==='err')).code,'unauthorized'); await unauthed.close(); assert.equal(connects,0)
  const client = new Client(endpoint), identity = await client.login()
  assert.equal(connects,1)
  assert.equal(server.devices().find(device => device.deviceId === identity.deviceId).connectedVia, 'lan')
  await client.request('host.info', {extra:true}, 'invalid-params'); assert.equal(calls,0)
  const readsBeforeDownload = registryReads, downloadStarted = Date.now()
  const download = await client.request('timeline.text',{sessionId:'fake',itemId:'fake'})
  await delay(100); assert.equal(client.binary.reduce((n,b)=>n+b.length-5,0),4194304)
  let total=0,final=false;const chunks=[]
  while (!final) {
    const frame=client.binary.shift();if(!frame){await delay(5);continue}
    assert.equal(frame.readUInt32BE(0),download.streamId);assert.ok(frame.length-5<=262144);chunks.push(frame.subarray(5));total+=frame.length-5;final=frame[4]===1
    client.send({t:'stream.ack',streamId:download.streamId,bytes:total})
  }
  assert.deepEqual(Buffer.concat(chunks),bytes)
  assert.ok(registryReads - readsBeforeDownload <= Math.ceil((Date.now() - downloadStarted) / 1000), 'acks do not synchronously reload the registry; only the 1s timer may read')
  const id=client.nextId++;client.requests.set(id,'session.interrupt')
  client.send({t:'req',id,method:'session.interrupt',params:{sessionId:'fake'}});await delay(10);client.send({t:'cancel',id})
  assert.equal((await client.wait(f=>f.t==='res'&&f.id===id)).error.code,'cancelled')
  const replaced = new Promise(resolve=>client.ws.once('close',resolve))
  const second = new Client(endpoint);await second.login(identity)
  assert.equal(await replaced,4004)
  const revoked = new Promise(resolve=>second.ws.once('close',resolve));server.revoke(identity.deviceId)
  assert.equal((await second.wait(f=>f.t==='err')).code,'revoked');assert.equal(await revoked,4002)
  const retry = new Client(endpoint);await retry.hello()
  retry.send({t:'auth.response',deviceId:identity.deviceId,sig:'AAAA'})
  assert.equal((await retry.wait(f=>f.t==='err')).code,'revoked');await retry.close()
  await delay(20);assert.equal(disposals,connects)
  assert.deepEqual(server.addresses,['127.0.0.1'])
  addresses.push('::1')
  await server.refreshInterfaces()
  assert.deepEqual(server.addresses,['127.0.0.1','::1'])
  const reboundStatus = await new Promise((resolve,reject) => https.get(`https://[::1]:${server.port}`, {rejectUnauthorized:false}, res => {res.resume();resolve(res.statusCode)}).on('error',reject))
  assert.equal(reboundStatus,426)
  addresses.splice(0,1)
  await server.refreshInterfaces()
  assert.deepEqual(server.addresses,['::1'])
})
