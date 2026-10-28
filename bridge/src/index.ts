import QRCode from 'qrcode'
import { createAdvertiser } from './discovery/advertiser.js'
import { startLocalControl } from './host/local.js'
import type { HostControls } from './host/types.js'
import { createTailscaleControls, createRemoteControls } from './host/tailscale.js'
import { installHostRoutes } from './projection/host.js'
import { readFileSync } from 'node:fs'
import { DmpError } from './errors.js'
import { parseConfig } from './config.js'
import { createMethods, CreationLedger, capabilities } from './methods/index.js'
import { startServer } from './server/index.js'
import { createProjectionHost, onDispose } from './projection/index.js'
import { PushController } from './push/controller.js'
export { inject } from './projection/index.js'

export const name = 'dshm-bridge'
const packageVersion: unknown = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version
if (typeof packageVersion !== 'string' || !packageVersion.length) throw new Error('Missing bridge package version')
const running = new Map<string, Awaited<ReturnType<typeof startServer>> & { diagnostics: () => unknown }>()
/** Trusted in-process host controls; never exposed as an unauthenticated route. */
export function getRunningBridge(stateDir: string) { return running.get(stateDir) }

export async function apply(context: unknown, input?: unknown): Promise<void> {
  const config = parseConfig(input)
  const projection = await createProjectionHost(context)
  const ledger = new CreationLedger()
  let server: Awaited<ReturnType<typeof startServer>>
  let discovery: Awaited<ReturnType<typeof createAdvertiser>> | undefined
  let local: Awaited<ReturnType<typeof startLocalControl>> | undefined
  let push: PushController | undefined
  let pushSetupFailures = 0
  try {
    server = await startServer({ stateDir: config.stateDir, port: config.port, bindMode: config.bindMode,
      onAuthenticated: deviceId => push?.connected(deviceId),
      onRevoked: deviceId => push?.revoke(deviceId),
      onAddresses: async (addresses, port) => { await discovery?.update({ hostId: server.identity.host.hostId, name: server.identity.host.name, addresses, port }) },
      addresses: config.addresses, pairing: config.pairOnStart, quiet: config.quiet,
      version: packageVersion as string, dshVersion: projection.version, dshStatus: projection.status, caps: projection.status === 'ok' ? capabilities : [],
      async connect(methodContext) {
        if (projection.status !== 'ok') return {
          async request(method) {
            if (method !== 'host.info') throw new DmpError(projection.status === 'incompatible' ? 'dsh-incompatible' : 'dsh-unavailable')
            return { result: { host: methodContext.identity.host, bridgeVersion: methodContext.identity.version,
              dshVersion: projection.version, dshStatus: projection.status, caps: [], time: new Date().toISOString() } }
          },
          dispose() {},
        }
        const peer = await projection.connect(methodContext.deviceId)
        return createMethods(peer, { ...methodContext, get push() { return push } }, ledger)
      },
    })
    if (config.pushProxyUrl && projection.status === 'ok') {
      try {
        push = new PushController({ stateDir: config.stateDir, proxyUrl: config.pushProxyUrl,
          hostId: server.identity.host.hostId, projection,
          connected: id => server.devices().some(device => device.deviceId === id && device.connected),
          devices: () => server.devices().map(device => device.deviceId),
          capability: enabled => server.setCapabilities(enabled ? [...capabilities, 'push'] : capabilities),
        })
        await push.start()
      } catch { pushSetupFailures++; await push?.close(); push = undefined }
    }
    discovery = await createAdvertiser({ hostId: server.identity.host.hostId, name: server.identity.host.name, addresses: server.addresses, port: server.port })
    const tailscale = createTailscaleControls()
    const pair: HostControls['pair'] = async () => { const url = server.openPairing(); return { url, svg: await QRCode.toString(url, { type: 'svg', errorCorrectionLevel: 'M', margin: 4 }), expiresAt: server.pairingExpiresAt! } }
    const controls: HostControls = {
      status: () => ({ host: server.identity.host, bridgeVersion: packageVersion as string, dshVersion: projection.version, dshStatus: projection.status, addresses: server.addresses, port: server.port, connectedDevices: server.devices().filter(device => device.connected).length, pairing: { active: Boolean(server.pairingUrl), ...(server.pairingExpiresAt ? { expiresAt: server.pairingExpiresAt } : {}) }, discovery: discovery!.status(), guidance: process.platform === 'darwin' ? ['Allow DeepSeek Harness under System Settings → Privacy & Security → Local Network. If you run dsh web in a terminal, allow that terminal too.'] : process.platform === 'win32' ? ['Allow DeepSeek Harness on Private networks when Windows Firewall asks. Keep Public networks disabled.'] : [] }),
      pair,
      cancelPair: () => server.cancelPairing(), devices: () => server.devices(), revoke: id => server.revoke(id),
      ...createRemoteControls(server, tailscale, pair),
    }
    installHostRoutes(context, controls)
    local = await startLocalControl(config.stateDir, controls)
  } catch (error) { await push?.close(); await local?.close(); await discovery?.close(); if (server!) await server.close(); await projection.dispose(); throw error }
  running.set(config.stateDir, { ...server, get port() { return server.port }, get addresses() { return server.addresses },
    get pairingUrl() { return server.pairingUrl }, diagnostics: () => ({ ...projection.diagnostics?.(), ...(config.pushProxyUrl ? { push: { ...push?.counters, setupFailures: pushSetupFailures } } : {}) }) })
  onDispose(context, async () => {
    running.delete(config.stateDir)
    await push?.close()
    await local?.close()
    await discovery?.close()
    await server.close()
    await projection.dispose()
  })
}
