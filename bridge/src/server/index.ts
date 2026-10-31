import crypto from 'node:crypto'
import https from 'node:https'
import os from 'node:os'
import { WebSocket, WebSocketServer, type RawData } from 'ws'
import { frameValidators, methodValidators, eventValidators, schemas } from 'dshm-protocol/contract'
import type { BridgeServerOptions, ConnectionMethods, DmpObject, ServerIdentity } from '../types.js'
import { verifySignature, publicKeyFromSpki } from '../auth/signature.js'
import { Uploads } from './uploads.js'
import { RequestRateLimit } from './rate-limit.js'
import { DmpError } from '../errors.js'
import type { Device } from 'dshm-protocol/types'
import { HostState } from '../pairing/state.js'
import { PairingWindow } from '../pairing/window.js'
import { endpoint, isPrivateAddress, isTailscale, privateInterfaces } from '../discovery/interfaces.js'

export const limits = { maxTextFrameBytes: 1048576, maxChunkBytes: 262144, streamWindowBytes: 4194304 } as const
const processInstanceId = crypto.randomUUID()
const errorCodes = new Set<string>(schemas['common.schema.json'].$defs.ErrorCode.enum)
const errorValue = (code: string, details?: DmpObject): DmpObject => ({ code, message: code, retryable: ['busy', 'timeout', 'dsh-unavailable', 'internal'].includes(code), ...(details ? { details } : {}) })
const rawBuffer = (value: RawData): Buffer => Array.isArray(value) ? Buffer.concat(value) : Buffer.isBuffer(value) ? value : Buffer.from(value)
const now = (): string => new Date().toISOString()
interface Download { id: number; bytes: Buffer; sent: number; acked: number; emptySent?: boolean; timer?: ReturnType<typeof setTimeout> }
interface Listener { server: https.Server; wss: WebSocketServer }
interface LiveClient { ws: WebSocket; address: string; via: 'lan' | 'tailscale' | 'other'; deviceId?: string; refuse(code: string, closeCode: number): void; cleanup(): Promise<void> }

export async function startServer(options: BridgeServerOptions) {
  if (!Number.isInteger(options.port) || options.port < 0 || options.port > 65535) throw new Error('Invalid DSHM listener port')
  if (options.addresses?.some(address => !isPrivateAddress(address, true))) throw new Error('Listener requires explicit private or loopback IP addresses')
  const state = new HostState(options.stateDir)
  const pairing = new PairingWindow(options.stateDir, options.quiet ?? false)
  // A crashed process must not leave a usable-looking pairing URL behind.
  pairing.close()
  const identity: ServerIdentity = {
    host: { hostId: state.hostId, name: os.hostname(), platform: process.platform === 'darwin' ? 'macos' : process.platform === 'win32' ? 'windows' : 'linux' },
    version: options.version, instanceId: processInstanceId, dshVersion: options.dshVersion, dshStatus: options.dshStatus, caps: options.caps,
  }
  const deviceObservers = new Set<() => void>()
  const notifyDevices = (): void => { for (const changed of deviceObservers) changed() }
  const listeners = new Map<string, Listener>(), clients = new Set<LiveClient>(), active = new Map<string, LiveClient>()
  let port = options.port, closed = false, refreshing: Promise<void> | undefined
  const desiredAddresses = (): string[] => [...new Set(options.addresses ?? privateInterfaces(options.bindMode))].sort()
  const currentEndpoints = (): string[] => [...listeners.keys()].map(address => endpoint(address, port))
  const openPairing = (): string => {
    if (closed) throw new Error('Bridge stopped')
    if (!listeners.size) throw new Error('No private interface is listening')
    return pairing.open({ hostId: state.hostId, name: identity.host.name, fingerprint: state.fingerprint, addresses: currentEndpoints() })
  }
  const revoke = (deviceId: string, defer = false): boolean => {
    const existed = state.revoke(deviceId)
    if (existed) {
      options.onRevoked?.(deviceId)
      notifyDevices()
      const close = () => active.get(deviceId)?.refuse('revoked', 4002)
      if (defer) setImmediate(close); else close()
    }
    return existed
  }
  const onConnection = (ws: WebSocket, address: string, remote: string | undefined): void => {
    let pickedVersion = false, authStarted = false, authenticated = false, connection: ConnectionMethods | undefined
    let deviceId: string | undefined, nextStream = 1, lastActivity = Date.now(), disposed = false
    let connectionReady: Promise<void> | undefined
    const rate = new RequestRateLimit()
    const lifecycle = new AbortController(), requests = new Map<number, AbortController>(), streams = new Map<number, Download>()
    const nonce = crypto.randomBytes(32).toString('base64url')
    const send = (frame: DmpObject): boolean => {
      if (ws.readyState !== WebSocket.OPEN) return false
      if (!frameValidators.server(frame)) { ws.close(4000, 'internal'); return false }
      const encoded = JSON.stringify(frame)
      if (Buffer.byteLength(encoded) > limits.maxTextFrameBytes) { ws.close(4000, 'too-large'); return false }
      ws.send(encoded); return true
    }
    const uploads = new Uploads(() => nextStream++, send, async (sessionId, name, mime, bytes, signal) => {
      if (!connection?.upload) throw new DmpError('unsupported')
      return connection.upload(sessionId, name, mime, bytes, signal)
    })
    const refuse = (code: string, closeCode = 4001): void => {
      send({ t: 'err', ...errorValue(code) }); ws.close(closeCode, code)
    }
    const cleanup = async (): Promise<void> => {
      if (disposed) return
      disposed = true; lifecycle.abort()
      clearTimeout(authTimeout); clearInterval(idleTimer)
      for (const controller of requests.values()) controller.abort()
      for (const stream of streams.values()) clearTimeout(stream.timer)
      streams.clear(); uploads.dispose(); clients.delete(client)
      if (deviceId && active.get(deviceId) === client) active.delete(deviceId)
      await connectionReady?.catch(() => {})
      await connection?.dispose()
    }
    const remoteAddress = remote?.replace(/^::ffff:/, '') ?? ''
    const client: LiveClient = { ws, address, via: isTailscale(remoteAddress) ? 'tailscale' : isPrivateAddress(remoteAddress, true) ? 'lan' : 'other', refuse, cleanup }; clients.add(client)
    const authTimeout = setTimeout(() => refuse('unauthorized'), 15000)
    const idleTimer = setInterval(() => { if (Date.now() - lastActivity >= 60000) refuse('timeout', 4000) }, 5000)
    authTimeout.unref(); idleTimer.unref()
    send({ t: 'hello', v: [1], host: identity.host, bridge: { version: identity.version, instanceId: identity.instanceId }, dsh: { status: identity.dshStatus, version: identity.dshVersion }, caps: identity.caps, limits })
    send({ t: 'auth.challenge', nonce })
    const pump = (stream: Download): void => {
      if (ws.readyState !== WebSocket.OPEN || !streams.has(stream.id)) return
      while (stream.sent < stream.bytes.length && stream.sent - stream.acked < limits.streamWindowBytes) {
        const count = Math.min(limits.maxChunkBytes, limits.streamWindowBytes - stream.sent + stream.acked, stream.bytes.length - stream.sent)
        const chunk = stream.bytes.subarray(stream.sent, stream.sent + count); stream.sent += count
        const header = Buffer.alloc(5); header.writeUInt32BE(stream.id); header[4] = stream.sent === stream.bytes.length ? 1 : 0
        ws.send(Buffer.concat([header, chunk]))
      }
      if (!stream.bytes.length && !stream.emptySent) {
        stream.emptySent = true; const header = Buffer.alloc(5); header.writeUInt32BE(stream.id); header[4] = 1; ws.send(header)
      }
      clearTimeout(stream.timer)
      stream.timer = setTimeout(() => { streams.delete(stream.id); send({ t: 'stream.abort', streamId: stream.id, code: 'timeout' }) }, 15000)
      stream.timer.unref()
    }
    const download = (bytes: Uint8Array, mime?: string): DmpObject => {
      if (streams.size >= 3) throw Object.assign(new Error('busy'), { code: 'busy' })
      const stream: Download = { id: nextStream++, bytes: Buffer.from(bytes), sent: 0, acked: 0 }
      streams.set(stream.id, stream)
      setImmediate(() => pump(stream))
      return { streamId: stream.id, size: stream.bytes.length, ...(mime ? { mime } : {}) }
    }
    const request = async (frame: DmpObject): Promise<void> => {
      const id = frame.id as number, method = frame.method as string, params = frame.params as DmpObject
      if (requests.has(id)) { refuse('bad-frame', 4000); return }
      if (!rate.take()) { send({ t: 'res', id, ok: false, error: errorValue('busy') }); return }
      const definition = methodValidators[method]
      if (!definition) { send({ t: 'res', id, ok: false, error: errorValue('unknown-method') }); return }
      if (!definition.params(params)) {
        const validationError = definition.params.errors?.[0]
        send({ t: 'res', id, ok: false, error: errorValue('invalid-params', { path: validationError?.instancePath ?? '' }) }); return
      }
      if (requests.size >= 64) { send({ t: 'res', id, ok: false, error: errorValue('busy') }); return }
      const controller = new AbortController(); requests.set(id, controller)
      let timedOut = false
      const timeout = setTimeout(() => { timedOut = true; controller.abort() }, 30000); timeout.unref()
      try {
        await connectionReady
        if (!connection || lifecycle.signal.aborted || controller.signal.aborted) throw Object.assign(new Error('cancelled'), { code: 'cancelled' })
        const operation = connection.request(method, params, controller.signal)
        // Cancellation resolves the protocol request promptly even if a native
        // provider fails to observe its abort signal. Late completion is ignored.
        const cancelled = new Promise<never>((_resolve, reject) => {
          const rejectAbort = (): void => reject(Object.assign(new Error('cancelled'), { code: timedOut ? 'timeout' : 'cancelled' }))
          if (controller.signal.aborted) rejectAbort()
          else controller.signal.addEventListener('abort', rejectAbort, { once: true })
        })
        const reply = await Promise.race([operation, cancelled])
        const result = 'bytes' in reply ? download(reply.bytes, reply.mime) : reply.result
        if (!definition.result(result)) throw Object.assign(new Error('Invalid result'), { code: 'internal' })
        const response = { t: 'res', id, ok: true, result }
        if (Buffer.byteLength(JSON.stringify(response)) > limits.maxTextFrameBytes) throw Object.assign(new Error('Frame budget exceeded'), { code: 'too-large', details: { limit: limits.maxTextFrameBytes } })
        send(response)
      } catch (error: unknown) {
        const candidate = error && typeof error === 'object' ? error as { code?: unknown; details?: unknown } : {}
        const code = typeof candidate.code === 'string' && errorCodes.has(candidate.code) ? candidate.code : 'internal'
        const details = candidate.details && typeof candidate.details === 'object' && !Array.isArray(candidate.details) ? candidate.details as DmpObject : undefined
        send({ t: 'res', id, ok: false, error: errorValue(code, details) })
      } finally { clearTimeout(timeout); requests.delete(id) }
    }
    const authenticate = (id: string): void => {
      deviceId = id; client.deviceId = id; authenticated = true; clearTimeout(authTimeout)
      active.get(id)?.ws.close(4004, 'replaced'); active.set(id, client)
      options.onAuthenticated?.(id)
      const device = state.devices[id]
      device.lastSeenAt = now(); state.save(); notifyDevices()
      send({ t: 'auth.ok', deviceId: id, connectionId: crypto.randomUUID(), via: client.via })
      // Sending auth.ok is deliberately before creating the privileged owner Peer.
      connectionReady = options.connect({ deviceId: id, identity, uploads, devices: {
        list() {
          return Object.entries(state.devices).filter(([, record]) => !record.revokedAt).map(([deviceId, record]): Device => ({
            deviceId, name: record.name, model: record.model, pairedAt: record.pairedAt,
            ...(record.lastSeenAt ? { lastSeenAt: record.lastSeenAt } : {}), secureEnclave: record.secureEnclave, current: deviceId === id,
          }))
        },
        rename(deviceId, name) {
          const record = state.devices[deviceId]
          if (!record || record.revokedAt) throw new DmpError('not-found')
          record.name = name; state.save(); notifyDevices()
          return this.list().find(device => device.deviceId === deviceId)!
        },
        revoke(deviceId) {
          if (!state.devices[deviceId] || state.devices[deviceId].revokedAt) throw new DmpError('not-found')
          revoke(deviceId, true)
        },
        watch(changed) { deviceObservers.add(changed); return () => { deviceObservers.delete(changed) } },
      }, emit(sub, event) {
        if (!authenticated || disposed) return
        if (!eventValidators[event.kind]?.(event.data)) { refuse('internal', 4000); return }
        send({ t: 'ev', sub, kind: event.kind, data: event.data })
      } }).then(value => { connection = value }).catch(() => { refuse('dsh-unavailable', 4000) })
    }
    ws.on('message', (raw: RawData, binary: boolean) => {
      if (disposed || ws.readyState !== WebSocket.OPEN) return
      lastActivity = Date.now()
      if (binary) {
        if (!authenticated) { refuse('unauthorized'); return }
        if (!deviceId || !state.devices[deviceId] || state.devices[deviceId].revokedAt) { refuse('revoked', 4002); return }
        try { uploads.receive(rawBuffer(raw), limits.maxChunkBytes) } catch { refuse('bad-frame', 4000) }
        return
      }
      const bytes = rawBuffer(raw)
      if (bytes.length > limits.maxTextFrameBytes) { refuse('bad-frame', 4000); return }
      let frame: DmpObject
      try {
        const parsed: unknown = JSON.parse(bytes.toString('utf8'))
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('bad-frame')
        frame = parsed as DmpObject
      } catch { refuse(authenticated ? 'bad-frame' : 'unauthorized', authenticated ? 4000 : 4001); return }
      if (!authenticated && !['hello', 'pair.request', 'auth.response'].includes(String(frame.t))) { refuse('unauthorized'); return }
      if (!frameValidators.client(frame)) {
        if (authenticated && typeof frame.t === 'string' && !['hello', 'pair.request', 'auth.response', 'req', 'cancel', 'stream.ack', 'stream.abort', 'ping', 'pong'].includes(frame.t)) return
        refuse('bad-frame', 4000); return
      }
      if (!authenticated) {
        if (frame.t === 'hello' && !pickedVersion && !authStarted) {
          if (frame.v !== 1) { refuse('version-unsupported', 4003); return }
          pickedVersion = true; return
        }
        if (!pickedVersion || authStarted) { refuse('unauthorized'); return }
        if (frame.t === 'pair.request') {
          const verified = pairing.verify(frame.otp as string)
          if (verified !== 'ok') { refuse(verified); return }
          try { publicKeyFromSpki(frame.devicePublicKey as string) } catch { refuse('bad-frame', 4000); return }
          const id = state.pair({ name: frame.deviceName as string, model: frame.deviceModel as string, publicKey: frame.devicePublicKey as string, secureEnclave: frame.secureEnclave as boolean })
          pairing.close(); notifyDevices(); send({ t: 'pair.result', deviceId: id, hostId: state.hostId }); return
        }
        if (frame.t === 'auth.response') {
          authStarted = true; state.reload()
          const id = frame.deviceId as string, device = state.devices[id]
          if (device?.revokedAt) { refuse('revoked', 4002); return }
          if (!device || !verifySignature(device.publicKey, nonce, state.hostId, state.fingerprint, frame.sig as string)) { refuse('unauthorized'); return }
          authenticate(id); return
        }
        refuse('unauthorized'); return
      }
      // The registry timer refreshes disk state; acknowledgements only consult memory.
      if (!deviceId || !state.devices[deviceId] || state.devices[deviceId].revokedAt) { refuse('revoked', 4002); return }
      if (frame.t === 'req') { void request(frame); return }
      if (frame.t === 'cancel') { requests.get(frame.id as number)?.abort(); return }
      if (frame.t === 'ping') { send({ t: 'pong' }); return }
      if (frame.t === 'pong') return
      if (frame.t === 'stream.abort') {
        uploads.abort(frame.streamId as number)
        const stream = streams.get(frame.streamId as number); clearTimeout(stream?.timer); streams.delete(frame.streamId as number); return
      }
      if (frame.t === 'stream.ack') {
        const stream = streams.get(frame.streamId as number), acknowledged = frame.bytes as number
        if (!stream || acknowledged < stream.acked || acknowledged > stream.sent) { refuse('bad-frame', 4000); return }
        stream.acked = acknowledged
        if (stream.acked === stream.bytes.length && (stream.sent > 0 || stream.emptySent)) { clearTimeout(stream.timer); streams.delete(stream.id) }
        else pump(stream)
        return
      }
      refuse('bad-frame', 4000)
    })
    ws.on('error', (error: Error & { code?: string }) => {
      if (error.code === 'WS_ERR_UNSUPPORTED_MESSAGE_LENGTH' && ws.readyState === WebSocket.OPEN) refuse('bad-frame', 4000)
    })
    ws.on('close', () => { void cleanup().catch(() => {}) })
  }
  const addListener = async (address: string): Promise<void> => {
    const server = https.createServer({ key: state.key, cert: state.cert }, (_req, res) => { res.writeHead(426); res.end() })
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen({ host: address, port, ipv6Only: true }, () => { server.removeListener('error', reject); resolve() }) })
    const bound = server.address()
    if (!bound || typeof bound === 'string') throw new Error('No TCP address')
    // ws forwards HTTPS errors to its own EventEmitter. Attach it only after
    // bind succeeds so startup errors reach DSH through the rejected promise.
    const wss = new WebSocketServer({ server, maxPayload: limits.maxTextFrameBytes, perMessageDeflate: { threshold: 1024, serverNoContextTakeover: true, clientNoContextTakeover: true } })
    wss.on('connection', (ws, req) => onConnection(ws, address, req.socket.remoteAddress))
    port = bound.port; listeners.set(address, { server, wss })
  }
  const removeListener = async (address: string): Promise<void> => {
    const listener = listeners.get(address)
    if (!listener) return
    listeners.delete(address)
    const closing = [...clients].filter(client => client.address === address)
    for (const client of closing) { client.ws.close(4005, 'host shutting down'); client.ws.terminate() }
    await Promise.all(closing.map(client => client.cleanup()))
    await new Promise<void>(resolve => listener.wss.close(() => resolve()))
    await new Promise<void>(resolve => listener.server.close(() => resolve()))
  }
  const refreshInterfaces = async (): Promise<void> => {
    if (closed) return
    if (refreshing) return refreshing
    refreshing = (async () => {
      const desired = desiredAddresses()
      for (const address of listeners.keys()) if (!desired.includes(address)) await removeListener(address)
      for (const address of desired) if (!listeners.has(address)) await addListener(address)
      await options.onAddresses?.([...listeners.keys()], port)
    })().finally(() => { refreshing = undefined })
    return refreshing
  }
  try { await refreshInterfaces() } catch (error) { for (const address of listeners.keys()) await removeListener(address); throw error }
  const interfaceTimer = setInterval(() => { void refreshInterfaces().catch(() => { if (!options.quiet) console.error('DSHM: private-interface rebind failed') }) }, 5000)
  interfaceTimer.unref()
  const registryTimer = setInterval(() => {
    try {
      const previous = JSON.stringify(state.devices)
      const previousDevices = state.devices
      state.reload()
      if (JSON.stringify(state.devices) !== previous) notifyDevices()
      for (const [id, old] of Object.entries(previousDevices)) if (!old.revokedAt && (!state.devices[id] || state.devices[id].revokedAt)) options.onRevoked?.(id)
      for (const [id, client] of active) if (!state.devices[id] || state.devices[id].revokedAt) client.refuse('revoked', 4002)
    } catch { for (const client of active.values()) client.refuse('unauthorized', 4001) }
  }, 1000)
  registryTimer.unref()
  if (options.pairing && listeners.size) openPairing()
  return {
    identity, fingerprint: state.fingerprint, get port() { return port }, get addresses() { return [...listeners.keys()] },
    setCapabilities: (caps: ServerIdentity['caps']) => { identity.caps = [...caps] },
    get pairingUrl() { return pairing.url }, get pairingExpiresAt() { return pairing.expiresAt },
    cancelPairing: () => pairing.close(),
    devices: () => Object.entries(state.devices).filter(([, value]) => !value.revokedAt).map(([deviceId, value]) => {
      const client = active.get(deviceId), connected = client?.ws.readyState === WebSocket.OPEN
      return { deviceId, name: value.name, model: value.model, secureEnclave: value.secureEnclave, pairedAt: value.pairedAt, ...(value.lastSeenAt ? { lastSeenAt: value.lastSeenAt } : {}), connected, ...(connected ? { connectedVia: client.via } : {}) }
    }),
    openPairing, revoke, refreshInterfaces,
    async close(): Promise<void> {
      closed = true; clearInterval(interfaceTimer); clearInterval(registryTimer); pairing.close()
      await refreshing?.catch(() => {})
      for (const address of [...listeners.keys()]) await removeListener(address)
    },
  }
}
