import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createProjectionHost } from '../../lib/projection/native.js'
import { supportsDSH, supportedDSHVersions } from './compatibility.mjs'

test('native compatibility accepts tested carriers and rejects other releases', () => {
  for (const version of ['0.2.1-rc.3', '0.2.1-rc.5']) assert.equal(supportsDSH(version), true)
  for (const version of ['unknown', '', '0.2.1-rc.2', '0.2.1-rc.4', '0.2.1-rc.6', '0.2.1', '0.2.2-alpha.2', '1.0.0', undefined]) {
    assert.equal(supportsDSH(version), false, String(version))
  }
  assert.equal(Object.isFrozen(supportedDSHVersions), true)
})

test('unrecognized native carrier cannot create an owner peer', async () => {
  const host = createProjectionHost({ connection: { createPeer() { throw new Error('must not create peer') } } })
  assert.equal(host.status, 'incompatible')
  await assert.rejects(host.connect('test-device'), { code: 'dsh-incompatible' })
  assert.deepEqual(host.diagnostics(), { createdPeers: 0, disposedPeers: 0, activePeers: 0 })
  await host.dispose()
})

test('native allowlist matches package and release-gate compatibility exactly', async () => {
  const manifest = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'))
  const { testedDSHRange } = await import('../../../tools/release-plugin/check-release.mjs')
  assert.equal(manifest.engines.dsh, supportedDSHVersions.join(' || '))
  assert.equal(testedDSHRange, manifest.engines.dsh)
})
