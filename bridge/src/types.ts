import type { Capability, HostInfo, Device } from 'dshm-protocol/types'
import type { PushMethods } from './push/controller.js'

// This boundary contains only DMP concepts; native types stay in projection/.
export type DmpObject = Record<string, unknown>
export interface DmpEvent { kind: string; data: DmpObject }
export type WatchMethod = 'sessions.watch' | 'session.watch' | 'jobs.watch' | 'job.watch'
export type ContentMethod = 'tool.output' | 'timeline.text' | 'files.download' | 'deliverables.download'
export interface ProjectionWatch { result: DmpObject; dispose(): void | Promise<void> }
export interface ProjectionPeer {
  upload(sessionId: string, name: string, mime: string, bytes: Uint8Array, signal: AbortSignal): Promise<{ attachmentId: string }>
  create(workspaceId: string, sessionId: string, signal: AbortSignal): Promise<{ sessionId: string }>
  request(method: string, params: DmpObject, signal: AbortSignal): Promise<DmpObject>
  watch(method: WatchMethod, params: DmpObject, emit: (event: DmpEvent) => void, signal: AbortSignal): Promise<ProjectionWatch>
  content(method: ContentMethod, params: DmpObject, signal: AbortSignal): Promise<Uint8Array>
  dispose(): void | Promise<void>
}
export interface ProjectionHost {
  version: string
  status: 'ok' | 'incompatible' | 'unavailable'
  connect(deviceId: string): Promise<ProjectionPeer>
  diagnostics?(): { activePeers: number; createdPeers: number; disposedPeers: number }
  dispose(): void | Promise<void>
}
export type Reply = { result: DmpObject } | { bytes: Uint8Array; mime?: string }
export interface ConnectionMethods {
  upload?(sessionId: string, name: string, mime: string, bytes: Uint8Array, signal: AbortSignal): Promise<{ attachmentId: string }>
  request(method: string, params: DmpObject, signal: AbortSignal): Promise<Reply>
  dispose(): void | Promise<void>
}
export interface ServerIdentity {
  host: HostInfo
  version: string
  instanceId: string
  dshVersion: string
  dshStatus: ProjectionHost['status']
  caps: Capability[]
}
export interface DeviceService {
  list(): Device[]
  rename(deviceId: string, name: string): Device
  revoke(deviceId: string): void
  watch(changed: () => void): () => void
}
export interface MethodContext {
  push?: PushMethods
  uploads: { begin(params: DmpObject): DmpObject; finish(uploadId: string, signal: AbortSignal): Promise<{ attachmentId: string }> }
  devices: DeviceService
  deviceId: string
  identity: ServerIdentity
  emit(sub: string, event: DmpEvent): void
}
export interface BridgeServerOptions {
  onAuthenticated?(deviceId: string): void
  onRevoked?(deviceId: string): void
  onAddresses?(addresses: string[], port: number): Promise<void> | void
  stateDir: string
  port: number
  addresses?: string[]
  bindMode?: 'lan' | 'tailscale' | 'all-private'
  pairing?: boolean
  quiet?: boolean
  version: string
  dshVersion: string
  dshStatus: ProjectionHost['status']
  caps: Capability[]
  connect(context: MethodContext): Promise<ConnectionMethods>
}
