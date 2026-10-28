import test from 'node:test'
import assert from 'node:assert/strict'
import { createTailscaleControls, createRemoteControls, findInstallation, parseStatus } from '../lib/host/tailscale.js'
import { setupPresentation } from '../src/ui/remote-setup.mjs'

const running = { BackendState: 'Running', Self: { Online: true }, TailscaleIPs: ['100.64.2.3', 'fd7a:115c:a1e0::2'] }
const parsed = value => parseStatus(JSON.stringify(value))

test('status distinguishes setup states and fails closed on unknown or broken CLI output', () => {
  for (const [native, state] of Object.entries({ NeedsLogin: 'needs-login', NeedsMachineAuth: 'needs-approval', Stopped: 'stopped', Starting: 'starting', NoState: 'starting' })) {
    assert.deepEqual(parsed({ BackendState: native, TailscaleIPs: running.TailscaleIPs }), { state, addresses: [] })
  }
  for (const value of [null, [], {}, { BackendState: 'new-version-state' }, { BackendState: 'constructor' }, { BackendState: 'Running' }]) assert.equal(parsed(value).state, 'unavailable')
  assert.equal(parseStatus('not JSON').state, 'unavailable')
  assert.equal(parseStatus(' '.repeat(256 * 1024 + 1)).state, 'unavailable')
  assert.deepEqual(parsed(running), { state: 'running', addresses: running.TailscaleIPs })
  assert.equal(parsed({ ...running, Self: { Online: false } }).state, 'offline')
  assert.equal(parsed({ ...running, Self: { Online: true, KeyExpired: true } }).state, 'needs-login')
  assert.equal(parsed({ ...running, TailscaleIPs: [] }).state, 'starting')
})

test('only valid local VPN IPs cross the boundary; account, health, auth URLs and peer data are discarded', () => {
  const result = parsed({ ...running, AuthURL: 'synthetic-secret-login-url', User: { value: 'synthetic-private-user' }, Health: ['synthetic-private-error'], Peer: { value: 'synthetic-private-peer' },
    TailscaleIPs: [...running.TailscaleIPs, '8.8.8.8', '192.168.1.1', 'fd7a:115c:a1e0:not-an-ip', '100.64.2.3', null, 4] })
  assert.deepEqual(result, { state: 'running', addresses: running.TailscaleIPs })
  assert.ok(!JSON.stringify(result).includes('synthetic-'))
})

test('installation detection uses fixed official paths, including Program Files spaces; never PATH/cwd/UNC', () => {
  const mac = '/Applications/Tailscale.app'
  assert.deepEqual(findInstallation('darwin', {}, p => [mac, `${mac}/Contents/MacOS/Tailscale`].includes(p)), { cli: `${mac}/Contents/MacOS/Tailscale`, app: mac })
  const calls = []
  const windows = findInstallation('win32', { ProgramFiles: 'D:\\Program Files' }, p => { calls.push(p); return true })
  assert.deepEqual(windows, { cli: 'D:\\Program Files\\Tailscale\\tailscale.exe', app: 'D:\\Program Files\\Tailscale\\tailscale-ipn.exe' })
  assert.equal(calls.length, 2)
  assert.equal(findInstallation('win32', { ProgramFiles: 'relative' }, () => true), undefined)
  assert.equal(findInstallation('win32', { ProgramFiles: '\\\\server\\share' }, () => true), undefined)
  assert.equal(findInstallation('linux', {}, () => true), undefined)
  assert.equal(findInstallation('darwin', { PATH: '/untrusted' }, () => false), undefined)
})

test('probes coalesce and expire; failed discovery/read are recoverable and never expose raw errors', async () => {
  let now = 0, reads = 0, installed = false, fail = false, resolveRead
  const adapter = { platform: 'win32', now: () => now, installation: () => installed ? { cli: 'fixed-cli', app: 'fixed-app' } : undefined,
    read: async cli => { assert.equal(cli, 'fixed-cli'); reads++; if (fail) throw new Error('synthetic-private-error'); return new Promise(resolve => { resolveRead = resolve }) }, open: async () => {} }
  const controls = createTailscaleControls(adapter)
  assert.equal((await controls.status()).state, 'not-installed'); assert.equal(reads, 0)
  installed = true; now = 5001
  const a = controls.status(), b = controls.status()
  assert.equal(reads, 1)
  resolveRead(JSON.stringify(running))
  assert.deepEqual(await a, await b)
  await controls.status(); assert.equal(reads, 1)
  fail = true; now += 5001
  const bad = await controls.status()
  assert.equal(bad.state, 'unavailable'); assert.equal(bad.canOpenApp, true)
  assert.ok(!JSON.stringify(bad).includes('synthetic-private-error'))
  const unsupported = createTailscaleControls({ ...adapter, platform: 'linux', installation() { throw new Error('must not probe') } })
  assert.equal((await unsupported.status()).state, 'unsupported')
})

test('opening the app is explicit and uses only the discovered path; missing app never launches a command', async () => {
  let opened = [], installed = true
  const controls = createTailscaleControls({ platform: 'darwin', now: () => 0, installation: () => installed ? { cli: 'fixed-cli', app: 'fixed-app' } : undefined,
    read: async () => JSON.stringify({ BackendState: 'Stopped' }), open: async app => { opened.push(app) } })
  await controls.status(); assert.deepEqual(opened, [])
  await controls.open(); assert.deepEqual(opened, ['fixed-app'])
  installed = false
  await assert.rejects(controls.open(), /unavailable/)
  assert.deepEqual(opened, ['fixed-app'])
})

test('UI never treats PC-only readiness as a verified phone connection or permits premature remote pairing', () => {
  for (const state of ['not-installed', 'needs-login', 'needs-approval', 'stopped', 'starting', 'offline', 'unavailable', 'unsupported', 'future']) assert.equal(setupPresentation({ state }).ready, false)
  assert.equal(setupPresentation({ state: 'running', bridgeListening: false, connectedDevices: 0 }).ready, false)
  const ready = setupPresentation({ state: 'running', bridgeListening: true, connectedDevices: 0 })
  assert.equal(ready.ready, true); assert.match(ready.detail, /No phone has connected/)
  assert.match(setupPresentation({ state: 'running', bridgeListening: true, connectedDevices: 1 }).title, /Phone connected/)
})

test('remote pairing refreshes real listeners and state, preserves an existing QR when unavailable, and counts only VPN-authenticated devices', async () => {
  let state = 'stopped', bound = [], pairs = 0, refreshed = 0, freshRead = false
  const controls = createRemoteControls({ get addresses() { return bound }, devices: () => [{ connectedVia: 'lan' }, {}, { connectedVia: 'tailscale' }],
    async refreshInterfaces() { refreshed++ } }, { async status(fresh) { freshRead = fresh; return { state, addresses: ['100.64.2.3'], platform: 'windows', canOpenApp: true } }, async open() {} },
    async () => { pairs++; return { url: 'synthetic-fresh-qr', svg: '<svg/>', expiresAt: 'future' } })
  assert.equal(await controls.pairRemote(), undefined)
  assert.equal(pairs, 0); assert.equal(refreshed, 1); assert.equal(freshRead, true)
  state = 'running'; bound = ['192.168.1.2']
  assert.equal(await controls.pairRemote(), undefined); assert.equal(pairs, 0)
  bound = ['192.168.1.2', '100.64.2.3']
  assert.equal((await controls.pairRemote()).url, 'synthetic-fresh-qr'); assert.equal(pairs, 1)
  assert.equal((await controls.remoteSetup()).connectedDevices, 1)
  state = 'stopped'
  assert.equal(await controls.pairRemote(), undefined); assert.equal(pairs, 1)
})
