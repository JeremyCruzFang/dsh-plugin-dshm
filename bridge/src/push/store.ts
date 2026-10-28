import { chmodSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { methodValidators } from 'dshm-protocol/contract'
import type { PushRegisterParams } from 'dshm-protocol/types'
import { writePrivate } from '../pairing/state.js'
import { keyBytes } from './payload.js'

export interface PushRegistration extends PushRegisterParams {
  proxyUrl: string
  seenInteractions: string[]
  lastSent: Record<string, number>
}
export function registrationParams(input: unknown): PushRegisterParams {
  if (!methodValidators['push.register'].params(input)) throw new Error('Invalid push registration')
  const value = input as PushRegisterParams
  keyBytes(value.pushSecret); keyBytes(value.notifKey)
  if (!/^[A-Za-z0-9_-]{16,256}$/.test(value.pushId)) throw new Error('Invalid push registration')
  return structuredClone(value)
}

/** The bridge needs both keys to send; its private host directory is the boundary. */
export class PushStore {
  readonly file: string
  readonly records = new Map<string, PushRegistration>()
  constructor(directory: string, readonly proxyUrl: string) {
    mkdirSync(directory, { recursive: true, mode: 0o700 })
    this.file = join(directory, 'push.json')
    if (!existsSync(this.file)) return
    chmodSync(this.file, 0o600)
    const raw: unknown = JSON.parse(readFileSync(this.file, 'utf8'))
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Invalid push registry')
    for (const [id, candidate] of Object.entries(raw)) {
      if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) throw new Error('Invalid push registry')
      const { proxyUrl: origin, seenInteractions, lastSent, ...params } = candidate
      const registration = registrationParams(params)
      if (typeof origin !== 'string' || !Array.isArray(seenInteractions) || seenInteractions.some(value => typeof value !== 'string') ||
          !lastSent || typeof lastSent !== 'object' || Array.isArray(lastSent) || Object.values(lastSent).some(value => typeof value !== 'number' || !Number.isFinite(value))) throw new Error('Invalid push registry')
      // A URL change must not disclose a previous proxy's credentials elsewhere.
      this.records.set(id, { ...registration, proxyUrl: origin, seenInteractions, lastSent })
    }
  }
  save(): void { writePrivate(this.file, JSON.stringify(Object.fromEntries(this.records))) }
  register(deviceId: string, params: unknown): PushRegistration {
    const value = registrationParams(params), old = this.records.get(deviceId)
    const record = { ...value, proxyUrl: this.proxyUrl,
      seenInteractions: old?.seenInteractions ?? [], lastSent: old?.lastSent ?? {} }
    this.records.set(deviceId, record)
    try { this.save() } catch (error) { if (old) this.records.set(deviceId, old); else this.records.delete(deviceId); throw error }
    return record
  }
  remove(deviceId: string): PushRegistration | undefined {
    const old = this.records.get(deviceId)
    if (!old) return
    this.records.delete(deviceId)
    try { this.save() } catch (error) { this.records.set(deviceId, old); throw error }
    return old
  }
}
