import { createCipheriv, createHash, randomBytes } from 'node:crypto'

export type PushKind = 'approval' | 'question' | 'turn' | 'error'
export interface PushPayload {
  v: 1
  kind: PushKind
  hostId: string
  sessionId: string
  interactionId?: string
  title: string
  body: string
  sentAt: string
}
export const shorten = (text: string, length: number): string => Array.from(text).slice(0, length).join('')
export function keyBytes(value: unknown): Buffer {
  if (typeof value !== 'string') throw new Error('Invalid push key')
  const bytes = Buffer.from(value, 'base64')
  if (bytes.length !== 32 || bytes.toString('base64') !== value) throw new Error('Invalid push key')
  return bytes
}
export function encryptPayload(payload: PushPayload, key: Uint8Array, nonce: Uint8Array = randomBytes(12)): string {
  if (key.byteLength !== 32 || nonce.byteLength !== 12) throw new Error('Invalid push encryption parameters')
  const cipher = createCipheriv('aes-256-gcm', key, nonce)
  cipher.setAAD(Buffer.from('dshm-push-v1'))
  return Buffer.concat([nonce, cipher.update(JSON.stringify(payload), 'utf8'), cipher.final(), cipher.getAuthTag()]).toString('base64')
}
export const collapseId = (hostId: string, sessionId: string): string => createHash('sha256').update(hostId).update('\0').update(sessionId).digest('base64url')
