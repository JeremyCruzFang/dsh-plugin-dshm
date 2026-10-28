import type { Device, HostInfo } from 'dshm-protocol/types'
import type { RemoteSetupStatus } from './tailscale.js'
export type HostDevice = Omit<Device, 'current'> & { connected: boolean; connectedVia?: 'lan' | 'tailscale' | 'other' }
export interface HostStatus {
  host: HostInfo
  bridgeVersion: string
  dshVersion: string
  dshStatus: string
  addresses: string[]
  port: number
  connectedDevices: number
  pairing: { active: boolean; expiresAt?: string }
  discovery: { state: string; serviceName: string; error?: string }
  guidance: string[]
}
export interface HostPairing { url: string; svg: string; expiresAt: string }
export interface HostControls {
  status(): HostStatus
  pair(): Promise<HostPairing>
  cancelPair(): void
  devices(): HostDevice[]
  revoke(id: string): boolean
  remoteSetup(): Promise<RemoteSetupStatus>
  openTailscale(): Promise<void>
  pairRemote(): Promise<HostPairing | undefined>
}
