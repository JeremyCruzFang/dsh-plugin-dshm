import crypto from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import type { HostControls } from './types.js'
import { writePrivate } from '../pairing/state.js'

interface ControlRecord { pid: number; socket: string; token: string }
function record(directory: string): ControlRecord {
  const value = JSON.parse(fs.readFileSync(path.join(directory, 'control.json'), 'utf8')) as Partial<ControlRecord>
  if (!Number.isInteger(value.pid) || typeof value.socket !== 'string' || typeof value.token !== 'string' || value.token.length !== 64) throw new Error('Invalid local bridge control record')
  return value as ControlRecord
}
function equal(left: string, right: string): boolean {
  const a = Buffer.from(left), b = Buffer.from(right)
  return a.length === b.length && crypto.timingSafeEqual(a, b)
}
export async function startLocalControl(directory: string, controls: HostControls): Promise<{ close(): Promise<void> }> {
  const file = path.join(directory, 'control.json')
  if (fs.existsSync(file)) {
    const old = record(directory)
    let live = true
    try { process.kill(old.pid, 0) } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') live = false }
    if (live) throw new Error('A bridge already owns this home; use its existing host controls')
  }
  const token = crypto.randomBytes(32).toString('hex')
  const suffix = crypto.randomBytes(6).toString('hex')
  const socket = process.platform === 'win32' ? `\\\\.\\pipe\\dshm-${suffix}` : path.join(directory, `control-${suffix}.sock`)
  const server = http.createServer(async (req, res) => {
    res.setHeader('Content-Type', 'application/json'); res.setHeader('Cache-Control', 'no-store')
    if (!equal(req.headers.authorization ?? '', `Bearer ${token}`)) { res.writeHead(401); res.end('{"error":"unauthorized"}'); return }
    const reply = (code: number, value: unknown) => { res.writeHead(code); res.end(JSON.stringify(value)) }
    try {
      if (req.method === 'GET' && req.url === '/status') { reply(200, controls.status()); return }
      if (req.method === 'GET' && req.url === '/devices') { reply(200, { devices: controls.devices() }); return }
      if (req.method !== 'POST') { reply(404, { error: 'not-found' }); return }
      let body = ''
      for await (const chunk of req) { body += String(chunk); if (Buffer.byteLength(body) > 4096) { reply(413, { error: 'too-large' }); return } }
      const input: unknown = JSON.parse(body || '{}')
      if (!input || typeof input !== 'object' || Array.isArray(input)) { reply(400, { error: 'invalid-params' }); return }
      if (req.url === '/pair' && !Object.keys(input).length) { reply(200, await controls.pair()); return }
      if (req.url === '/cancel' && !Object.keys(input).length) { controls.cancelPair(); reply(200, {}); return }
      if (req.url === '/revoke' && Object.keys(input).length === 1 && typeof (input as { deviceId?: unknown }).deviceId === 'string') {
        reply(200, { revoked: controls.revoke((input as { deviceId: string }).deviceId) }); return
      }
      reply(400, { error: 'invalid-params' })
    } catch { reply(500, { error: 'host-control-failed' }) }
  })
  server.requestTimeout = 5000; server.headersTimeout = 5000
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(socket, () => { server.off('error', reject); resolve() }) })
  if (process.platform !== 'win32') fs.chmodSync(socket, 0o600)
  writePrivate(file, JSON.stringify({ pid: process.pid, socket, token }))
  return { async close() {
    await new Promise<void>(resolve => server.close(() => resolve()))
    if (fs.existsSync(file) && equal(record(directory).token, token)) fs.rmSync(file)
    if (process.platform !== 'win32') fs.rmSync(socket, { force: true })
  } }
}
export async function localRequest<T>(directory: string, method: 'GET' | 'POST', route: string, body?: unknown): Promise<T> {
  const { socket, token } = record(directory)
  return new Promise<T>((resolve, reject) => {
    const request = http.request({ socketPath: socket, path: route, method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, timeout: 6000 }, res => {
      let text = ''
      res.on('data', chunk => { text += String(chunk); if (Buffer.byteLength(text) > 1024 * 1024) request.destroy(new Error('Oversized host control response')) })
      res.on('end', () => { try { if (res.statusCode !== 200) throw new Error('Host control request failed'); resolve(JSON.parse(text) as T) } catch (error) { reject(error) } })
    })
    request.on('timeout', () => request.destroy(new Error('Host control timed out'))); request.on('error', reject)
    request.end(body === undefined ? undefined : JSON.stringify(body))
  })
}
