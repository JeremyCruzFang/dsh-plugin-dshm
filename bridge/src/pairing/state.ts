import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

export interface DeviceRecord {
  name: string
  model: string
  publicKey: string
  secureEnclave: boolean
  pairedAt: string
  lastSeenAt?: string
  revokedAt?: string
}
function writePrivate(file: string, value: string | Buffer): void {
  const temporary = `${file}.${process.pid}.tmp`
  fs.writeFileSync(temporary, value, { mode: 0o600 })
  fs.chmodSync(temporary, 0o600)
  fs.renameSync(temporary, file)
}
export class HostState {
  readonly hostId: string
  readonly key: Buffer
  readonly cert: Buffer
  readonly fingerprint: string
  readonly devicesFile: string
  devices: Record<string, DeviceRecord>
  constructor(readonly directory: string) {
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 }); fs.chmodSync(directory, 0o700)
    const keyFile = path.join(directory, 'key.pem'), certFile = path.join(directory, 'cert.pem')
    if (fs.existsSync(certFile) !== fs.existsSync(keyFile)) throw new Error('Incomplete DSHM TLS identity; restore both certificate and key')
    if (!fs.existsSync(certFile)) {
      const temporaryKey = path.join(directory, 'new-key.pem'), temporaryCert = path.join(directory, 'new-cert.pem')
      try {
        // Node emits named-curve PKCS8. LibreSSL's `req -newkey ec` can encode
        // explicit parameters that Electron's BoringSSL cannot load.
        const keys = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
        writePrivate(temporaryKey, keys.privateKey.export({ type: 'pkcs8', format: 'pem' }))
        execFileSync('openssl', ['req', '-new', '-x509', '-sha256', '-key', temporaryKey, '-out', temporaryCert, '-days', '825', '-subj', '/CN=DSHM Bridge'], { stdio: 'ignore' })
        fs.chmodSync(temporaryKey, 0o600); fs.chmodSync(temporaryCert, 0o600)
        fs.renameSync(temporaryKey, keyFile); fs.renameSync(temporaryCert, certFile)
      } finally {
        fs.rmSync(temporaryKey, { force: true }); fs.rmSync(temporaryCert, { force: true })
      }
    }
    fs.chmodSync(keyFile, 0o600); fs.chmodSync(certFile, 0o600)
    this.key = fs.readFileSync(keyFile); this.cert = fs.readFileSync(certFile)
    this.fingerprint = crypto.createHash('sha256').update(new crypto.X509Certificate(this.cert).raw).digest('base64url')
    const hostIdFile = path.join(directory, 'host-id')
    if (!fs.existsSync(hostIdFile)) writePrivate(hostIdFile, crypto.randomUUID())
    fs.chmodSync(hostIdFile, 0o600)
    this.hostId = fs.readFileSync(hostIdFile, 'utf8').trim()
    this.devicesFile = path.join(directory, 'devices.json')
    if (!fs.existsSync(this.devicesFile)) writePrivate(this.devicesFile, '{}')
    fs.chmodSync(this.devicesFile, 0o600)
    this.devices = this.readDevices()
  }
  readDevices(): Record<string, DeviceRecord> {
    const value: unknown = JSON.parse(fs.readFileSync(this.devicesFile, 'utf8'))
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid DSHM device registry')
    for (const record of Object.values(value)) {
      if (!record || typeof record !== 'object' || typeof record.name !== 'string' || typeof record.model !== 'string' || typeof record.publicKey !== 'string' || typeof record.secureEnclave !== 'boolean' || typeof record.pairedAt !== 'string' || (record.revokedAt !== undefined && typeof record.revokedAt !== 'string')) throw new Error('Invalid DSHM device record')
    }
    return value as Record<string, DeviceRecord>
  }
  reload(): void { this.devices = this.readDevices() }
  save(): void { writePrivate(this.devicesFile, JSON.stringify(this.devices, null, 2)) }
  pair(record: Omit<DeviceRecord, 'pairedAt'>): string {
    this.reload()
    const id = crypto.randomUUID(); this.devices[id] = { ...record, pairedAt: new Date().toISOString() }; this.save(); return id
  }
  revoke(id: string): boolean {
    this.reload()
    const record = this.devices[id]
    if (!record) return false
    record.revokedAt = new Date().toISOString(); this.save(); return true
  }
}
export { writePrivate }
