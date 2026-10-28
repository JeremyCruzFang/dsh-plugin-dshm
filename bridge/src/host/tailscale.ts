import { execFile, spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { isIP } from 'node:net'
import path from 'node:path'
import { isTailscale } from '../discovery/interfaces.js'

export type TailscaleState = 'unsupported' | 'not-installed' | 'needs-login' | 'needs-approval' | 'stopped' | 'starting' | 'running' | 'offline' | 'unavailable'
export interface TailscaleStatus {
  platform: 'macos' | 'windows' | 'other'
  state: TailscaleState
  canOpenApp: boolean
  addresses: string[]
}
export interface RemoteSetupStatus extends TailscaleStatus {
  bridgeListening: boolean
  connectedDevices: number
}
interface Installation { cli: string; app?: string }
interface Adapter {
  platform: NodeJS.Platform
  installation(): Installation | undefined
  read(cli: string): Promise<string>
  open(app: string): Promise<void>
  now(): number
}

// Do not search cwd/PATH for a program invoked by privileged host UI controls.
export function findInstallation(platform: NodeJS.Platform, env = process.env, exists = existsSync): Installation | undefined {
  if (platform === 'darwin') {
    const app = '/Applications/Tailscale.app', cli = `${app}/Contents/MacOS/Tailscale`
    return exists(cli) ? { cli, ...(exists(app) ? { app } : {}) } : undefined
  }
  if (platform === 'win32') {
    const root = env.ProgramFiles ?? 'C:\\Program Files'
    if (!path.win32.isAbsolute(root) || root.startsWith('\\\\')) return
    const cli = path.win32.join(root, 'Tailscale', 'tailscale.exe')
    const app = path.win32.join(root, 'Tailscale', 'tailscale-ipn.exe')
    return exists(cli) ? { cli, ...(exists(app) ? { app } : {}) } : undefined
  }
}

function readStatus(cli: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(cli, ['status', '--json', '--peers=false'], { encoding: 'utf8', timeout: 4000, maxBuffer: 256 * 1024, windowsHide: true }, (error, stdout) => {
      // Even failures can contain a login URL. Never propagate native errors.
      if (error) reject(new Error('Tailscale status unavailable'))
      else resolve(stdout)
    })
  })
}

function openApp(app: string): Promise<void> {
  return new Promise((resolve, reject) => {
    if (process.platform === 'darwin') {
      execFile('/usr/bin/open', ['-a', app], { timeout: 4000, maxBuffer: 4096 }, error => error ? reject(new Error('Could not open Tailscale')) : resolve())
    } else {
      // The official tray app outlives this request; never kill it on a UI timeout.
      const child = spawn(app, [], { detached: true, stdio: 'ignore', windowsHide: false })
      child.once('error', () => reject(new Error('Could not open Tailscale')))
      child.once('spawn', () => { child.unref(); resolve() })
    }
  })
}

const object = (value: unknown): Record<string, unknown> | undefined => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined

/** Only allowlisted state leaves this boundary; CLI data is never logged or stored. */
export function parseStatus(text: string): Pick<TailscaleStatus, 'state' | 'addresses'> {
  const invalid = { state: 'unavailable', addresses: [] } as const
  if (Buffer.byteLength(text) > 256 * 1024) return { ...invalid, addresses: [] }
  let value: Record<string, unknown> | undefined
  try { value = object(JSON.parse(text)) } catch { return { ...invalid, addresses: [] } }
  if (!value) return { ...invalid, addresses: [] }
  const self = object(value.Self)
  const known: Record<string, TailscaleState> = { NeedsLogin: 'needs-login', NeedsMachineAuth: 'needs-approval', Stopped: 'stopped', Starting: 'starting', NoState: 'starting' }
  if (typeof value.BackendState !== 'string') return { ...invalid, addresses: [] }
  if (value.BackendState !== 'Running') return { state: Object.hasOwn(known, value.BackendState) ? known[value.BackendState] : 'unavailable', addresses: [] }
  if (self?.KeyExpired === true) return { state: 'needs-login', addresses: [] }
  if (self?.Online === false) return { state: 'offline', addresses: [] }
  if (self?.Online !== true || !Array.isArray(value.TailscaleIPs)) return { ...invalid, addresses: [] }
  const addresses = [...new Set(value.TailscaleIPs.filter((ip): ip is string => typeof ip === 'string' && Boolean(isIP(ip)) && isTailscale(ip)))].slice(0, 8)
  return { state: addresses.length ? 'running' : 'starting', addresses }
}

export function createTailscaleControls(adapter: Adapter = {
  platform: process.platform, installation: () => findInstallation(process.platform), read: readStatus, open: openApp, now: Date.now,
}) {
  let cached: TailscaleStatus | undefined, expires = 0, pending: Promise<TailscaleStatus> | undefined
  const platform = adapter.platform === 'darwin' ? 'macos' : adapter.platform === 'win32' ? 'windows' : 'other'
  return {
    async status(fresh = false): Promise<TailscaleStatus> {
      if (!fresh && cached && adapter.now() < expires) return cached
      if (pending) return pending
      pending = (async (): Promise<TailscaleStatus> => {
        const base: Omit<TailscaleStatus, 'state'> = { platform, canOpenApp: false, addresses: [] }
        if (platform === 'other') return { ...base, state: 'unsupported' }
        try {
          const installation = adapter.installation()
          if (!installation) return { ...base, state: 'not-installed' }
          const present = { ...base, canOpenApp: Boolean(installation.app) }
          try { return { ...present, ...parseStatus(await adapter.read(installation.cli)) } }
          catch { return { ...present, state: 'unavailable' } }
        } catch { return { ...base, state: 'unavailable' } }
      })()
      try { cached = await pending; expires = adapter.now() + 5000; return cached }
      finally { pending = undefined }
    },
    async open(): Promise<void> {
      const installation = adapter.installation()
      if (!installation?.app) throw new Error('Tailscale app unavailable')
      await adapter.open(installation.app)
      expires = 0
    },
  }
}

/** Ready-to-pair is based on a current bound address, never just an installed app. */
export function createRemoteControls(
  server: { addresses: string[]; devices(): { connectedVia?: string }[]; refreshInterfaces(): Promise<void> },
  tailscale: ReturnType<typeof createTailscaleControls>,
  pair: () => Promise<import('./types.js').HostPairing>,
) {
  const remoteSetup = async (fresh = false): Promise<RemoteSetupStatus> => {
    const status = await tailscale.status(fresh)
    return { ...status, bridgeListening: status.state === 'running' && status.addresses.some(address => server.addresses.includes(address)),
      connectedDevices: server.devices().filter(device => device.connectedVia === 'tailscale').length }
  }
  return { remoteSetup, openTailscale: () => tailscale.open(), async pairRemote() {
    await server.refreshInterfaces()
    if (!(await remoteSetup(true)).bridgeListening) return
    return pair()
  } }
}
