import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import qrcode from 'qrcode'
import { writePrivate } from './state.js'

export class PairingWindow {
  private state?: { otp: Buffer; expires: number; attempts: number }
  private timer?: ReturnType<typeof setTimeout>
  private currentUrl?: string
  constructor(private readonly directory: string, private readonly quiet: boolean) {}
  get url(): string | undefined { return this.currentUrl }
  get expiresAt(): string | undefined { return this.state ? new Date(this.state.expires).toISOString() : undefined }
  open(values: { hostId: string; name: string; fingerprint: string; addresses: string[] }): string {
    this.close()
    const otp = crypto.randomBytes(16)
    this.state = { otp, expires: Date.now() + 300000, attempts: 0 }
    const params = new URLSearchParams({ v: '1', host: values.hostId, name: values.name, fp: values.fingerprint, addrs: values.addresses.join(','), otp: otp.toString('base64url'), exp: String(Math.floor(this.state.expires / 1000)) })
    this.currentUrl = `dshm://pair?${params}`
    writePrivate(path.join(this.directory, 'pairing-url.txt'), this.currentUrl)
    this.timer = setTimeout(() => this.close(), 300000); this.timer.unref()
    if (!this.quiet) {
      const url = this.currentUrl
      void qrcode.toString(url, { type: 'terminal', small: true }).then(qr => { if (this.currentUrl === url) console.log(qr) })
      console.log('DSHM pairing open for five minutes (one use). Keep the QR private.')
    }
    return this.currentUrl
  }
  verify(value: string): 'ok' | 'bad-otp' | 'pairing-closed' {
    if (!this.state || Date.now() >= this.state.expires || this.state.attempts >= 5) { this.close(); return 'pairing-closed' }
    this.state.attempts++
    const received = Buffer.from(value, 'base64url')
    const matches = received.length === this.state.otp.length && received.toString('base64url') === value && crypto.timingSafeEqual(received, this.state.otp)
    if (!matches) { if (this.state.attempts >= 5) this.close(); return 'bad-otp' }
    return 'ok'
  }
  close(): void {
    clearTimeout(this.timer); this.timer = undefined; this.state = undefined; this.currentUrl = undefined
    fs.rmSync(path.join(this.directory, 'pairing-url.txt'), { force: true })
  }
}
