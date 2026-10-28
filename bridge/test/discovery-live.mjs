// Opt-in native macOS probe: node --test bridge/test/discovery-live.mjs
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { createAdvertiser } from '../lib/discovery/advertiser.js'
import { privateInterfaces } from '../lib/discovery/interfaces.js'
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
async function until(check) {
  const deadline = Date.now() + 10000
  while (Date.now() < deadline) { if (check()) return; await delay(50) }
  throw new Error('Native DNS-SD observation timed out')
}
function observe(args) {
  const child = spawn('/usr/bin/dns-sd', args, { stdio: ['ignore', 'pipe', 'pipe'] })
  let output = '', error
  child.stdout.on('data', chunk => { output += chunk.toString() })
  child.stderr.on('data', () => {})
  child.on('error', value => { error = value })
  return { output: () => { if (error) throw error; return output }, async close() { if (child.exitCode !== null || child.signalCode !== null) return; await new Promise(resolve => { child.once('exit', resolve); child.kill('SIGTERM') }) } }
}

test('native DNS-SD discovers and resolves the pure-JavaScript advertiser, then observes goodbye', { skip: process.platform !== 'darwin', timeout: 30000 }, async t => {
  const addresses = privateInterfaces().filter(value => !value.includes(':'))
  assert.ok(addresses.length, 'a private IPv4 interface is required for this live macOS probe')
  const values = { hostId: randomUUID(), name: 'Discovery Check', port: 47399, addresses: addresses.slice(0, 1) }
  const browser = observe(['-B', '_dshm._tcp', 'local'])
  t.after(() => browser.close())
  const advertiser = await createAdvertiser(values)
  t.after(() => advertiser.close())
  assert.equal(advertiser.status().state, 'advertising')
  const name = advertiser.status().serviceName
  await until(() => browser.output().split('\n').some(line => /Add/.test(line) && line.includes(name)))
  const resolver = observe(['-L', name, '_dshm._tcp', 'local'])
  t.after(() => resolver.close())
  await until(() => resolver.output().includes(`host=${values.hostId}`) && resolver.output().includes('v=1') && resolver.output().includes(`:${values.port}`))
  await advertiser.close()
  await until(() => browser.output().split('\n').some(line => /Rmv/.test(line) && line.includes(name)))
})
