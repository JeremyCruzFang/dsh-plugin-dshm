import { homedir } from 'node:os'
import { resolve } from 'node:path'
import { proxyURL } from './push/controller.js'

export interface Config {
  port: number
  bindMode: 'lan' | 'tailscale' | 'all-private'
  addresses?: string[]
  pairOnStart: boolean
  quiet: boolean
  stateDir: string
  pushProxyUrl?: string
}
export function parseConfig(input: unknown): Config {
  if (input !== undefined && (input === null || typeof input !== 'object' || Array.isArray(input))) throw new Error('DSHM configuration must be an object')
  const value = (input ?? {}) as Record<string, unknown>
  const allowed = new Set(['port', 'bindMode', 'addresses', 'pairOnStart', 'quiet', 'pushProxyUrl'])
  for (const key of Object.keys(value)) if (!allowed.has(key)) throw new Error(`Unknown DSHM configuration field: ${key}`)
  const port = value.port ?? 47390
  if (typeof port !== 'number' || !Number.isInteger(port) || port < 0 || port > 65535) throw new Error('DSHM port must be 0..65535')
  const mode = value.bindMode ?? 'all-private'
  if (!['lan', 'tailscale', 'all-private'].includes(String(mode))) throw new Error('Invalid DSHM bindMode')
  if (value.addresses !== undefined && (!Array.isArray(value.addresses) || !value.addresses.length || value.addresses.some(address => typeof address !== 'string'))) throw new Error('DSHM addresses must be a nonempty list of IP literals')
  for (const field of ['pairOnStart', 'quiet']) if (value[field] !== undefined && typeof value[field] !== 'boolean') throw new Error(`DSHM ${field} must be boolean`)
  return { port, bindMode: mode as Config['bindMode'], addresses: value.addresses as string[] | undefined,
    pairOnStart: value.pairOnStart === true, quiet: value.quiet === true,
    pushProxyUrl: proxyURL(value.pushProxyUrl),
    stateDir: resolve(process.env.DSH_HOME ?? resolve(homedir(), '.dsh'), 'dshm') }
}
