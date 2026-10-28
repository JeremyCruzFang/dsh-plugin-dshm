import { createHash } from 'node:crypto'
import { isIP } from 'node:net'
import { networkInterfaces, platform } from 'node:os'
import multicastDns from 'multicast-dns'
import { isPrivateAddress } from './interfaces.js'

type Transport = ReturnType<typeof multicastDns>
type TransportOptions = NonNullable<Parameters<typeof multicastDns>[0]>
export interface Advertisement { hostId: string; name: string; port: number; addresses: string[] }
export interface DiscoveryStatus { state: 'advertising' | 'unavailable' | 'stopped'; serviceName: string; error?: string }
type Record = { name: string; ttl: number; flush?: boolean } & (
  { type: 'PTR' | 'A' | 'AAAA'; data: string } |
  { type: 'SRV'; data: { port: number; target: string; priority: number; weight: number } } |
  { type: 'TXT'; data: Buffer[] }
)
const serviceType = '_dshm._tcp.local'
const enumeration = '_services._dns-sd._udp.local'
const normalName = (name: string) => name.toLowerCase().replace(/\.$/, '')

function names(values: Pick<Advertisement, 'hostId' | 'name'>): { serviceName: string; target: string } {
  const suffix = createHash('sha256').update(values.hostId).digest('hex').slice(0, 24)
  let label = `DSHM ${values.name}`.replace(/[.\\\x00-\x1f\x7f]/g, ' ').trim()
  while (Buffer.byteLength(label) > 46) label = [...label].slice(0, -1).join('')
  const serviceName = `${label} ${suffix.slice(0, 8)}`
  return { serviceName, target: `dshm-${suffix}.local` }
}

export function advertisementRecords(values: Advertisement, ttl = 120): { serviceName: string; target: string; records: Record[] } {
  if (!Number.isInteger(values.port) || values.port < 1 || values.port > 65535) throw new Error('Invalid discovery port')
  if (!values.addresses.length || values.addresses.some(address => !isPrivateAddress(address, true))) throw new Error('Discovery requires private listener addresses')
  const { serviceName, target } = names(values), fullName = `${serviceName}.${serviceType}`
  const records: Record[] = [
    { name: enumeration, type: 'PTR', ttl, data: serviceType },
    { name: serviceType, type: 'PTR', ttl, data: fullName },
    { name: fullName, type: 'SRV', ttl, flush: true, data: { port: values.port, target, priority: 0, weight: 0 } },
    { name: fullName, type: 'TXT', ttl, flush: true, data: [Buffer.from(`host=${values.hostId}`), Buffer.from('v=1')] },
    ...[...new Set(values.addresses)].map((address): Record => ({ name: target, type: isIP(address) === 6 ? 'AAAA' : 'A', ttl, flush: true, data: address })),
  ]
  return { serviceName, target, records }
}

function interfaces(addresses: string[]): TransportOptions[] {
  const entries = Object.entries(networkInterfaces())
  return addresses.flatMap<TransportOptions>(address => {
    if (isIP(address) === 4) return [{ interface: address, bind: '0.0.0.0', type: 'udp4' as const, ip: '224.0.0.251', reuseAddr: true }]
    const match = entries.find(([, values]) => values?.some(value => value.address === address))
    if (!match) return []
    const info = match[1]?.find(value => value.address === address)
    const scope = platform() === 'win32' && info?.family === 'IPv6' ? String(info.scopeid) : match[0]
    return [{ interface: `::%${scope}`, bind: '::', type: 'udp6' as const, ip: `ff02::fb%${scope}`, reuseAddr: true }]
  })
}

/** Publishes only bound listener endpoints; this is not an authenticated RPC transport. */
export async function createAdvertiser(initial: Advertisement, changed: (status: DiscoveryStatus) => void = () => {},
  factory: (options: TransportOptions) => Transport = multicastDns) {
  let values = initial, service = { ...names(initial), records: [] as Record[] }, sockets: Transport[] = [], timer: ReturnType<typeof setInterval> | undefined
  let closed = false, status: DiscoveryStatus = { state: 'stopped', serviceName: service.serviceName }, previous = ''
  let sequence = Promise.resolve()
  const setStatus = (state: DiscoveryStatus['state'], error?: string) => {
    status = { state, serviceName: service.serviceName, ...(error ? { error } : {}) }; changed(status)
  }
  const send = (socket: Transport, records = service.records): Promise<void> => new Promise(resolve => {
    const timeout = setTimeout(resolve, 1000); timeout.unref()
    try { socket.respond({ answers: records }, () => { clearTimeout(timeout); resolve() }) } catch { clearTimeout(timeout); resolve() }
  })
  const stop = async () => {
    clearInterval(timer); timer = undefined
    const old = sockets; sockets = []
    await Promise.all(old.map(async socket => {
      await send(socket, service.records.map(record => ({ ...record, ttl: 0 })))
      await new Promise<void>(resolve => {
        const timeout = setTimeout(resolve, 1000); timeout.unref()
        try { socket.destroy(() => { clearTimeout(timeout); resolve() }) } catch { clearTimeout(timeout); resolve() }
      })
    }))
  }
  const update = (next: Advertisement): Promise<void> => {
    sequence = sequence.then(async () => {
      if (closed) return
      const identity = JSON.stringify({ ...next, addresses: [...next.addresses].sort() })
      if (identity === previous && status.state === 'advertising') return
      await stop()
      values = next; previous = identity
      if (!values.addresses.length) { setStatus('unavailable', 'No private listener is available'); return }
      service = advertisementRecords(values)
      let failed = false
      const fail = () => { failed = true; setStatus('unavailable', 'Bonjour could not use a listener interface') }
      for (const options of interfaces(values.addresses)) {
        const socket = factory(options); sockets.push(socket)
        socket.on('error', fail)
        socket.on('warning', error => { if (['EACCES', 'EPERM', 'EADDRNOTAVAIL', 'ENODEV', 'ENETUNREACH', 'EHOSTUNREACH'].includes(String((error as NodeJS.ErrnoException).code))) fail() })
        socket.on('query', (packet, remote) => {
          if (!packet.questions?.some(question => [serviceType, enumeration, `${service.serviceName}.${serviceType}`, service.target].some(name => normalName(question.name) === normalName(name)))) return
          // Legacy DNS clients use a unicast reply; standard mDNS browsers use multicast.
          if (remote.port !== 5353) socket.respond({ id: packet.id, answers: service.records }, remote)
          else void send(socket)
        })
        await new Promise<void>(resolve => {
          const timeout = setTimeout(() => { fail(); resolve() }, 2000)
          const ready = () => { clearTimeout(timeout); resolve() }
          socket.once('ready', ready); socket.once('error', ready)
        })
        await send(socket)
      }
      if (!sockets.length) fail()
      if (!failed) setStatus('advertising')
      timer = setInterval(() => { for (const socket of sockets) void send(socket) }, 60000); timer.unref()
    })
    return sequence
  }
  await update(initial)
  return {
    update,
    status: (): DiscoveryStatus => ({ ...status }),
    async close() { closed = true; await sequence; await stop(); setStatus('stopped') },
  }
}
