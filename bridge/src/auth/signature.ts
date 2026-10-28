import crypto from 'node:crypto'

export const authMessage = (nonce: string, hostId: string, fingerprint: string): Buffer => Buffer.concat([
  Buffer.from('dshm-auth-v1'), Buffer.from(nonce, 'base64url'), Buffer.from(hostId), Buffer.from(fingerprint),
])
export function publicKeyFromSpki(value: string): crypto.KeyObject {
  const bytes = Buffer.from(value, 'base64')
  if (bytes.toString('base64') !== value || bytes.length > 256) throw new Error('Invalid public key encoding')
  const key = crypto.createPublicKey({ key: bytes, type: 'spki', format: 'der' })
  if (key.asymmetricKeyType !== 'ec' || key.asymmetricKeyDetails?.namedCurve !== 'prime256v1') throw new Error('P-256 key required')
  return key
}
export function verifySignature(publicKey: string, nonce: string, hostId: string, fingerprint: string, signature: string): boolean {
  try {
    const bytes = Buffer.from(signature, 'base64')
    if (bytes.toString('base64') !== signature || bytes.length > 80) return false
    return crypto.verify('sha256', authMessage(nonce, hostId, fingerprint), { key: publicKeyFromSpki(publicKey), dsaEncoding: 'der' }, bytes)
  } catch { return false }
}
