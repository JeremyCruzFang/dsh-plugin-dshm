import { KeyObject, randomBytes, X509Certificate } from 'node:crypto'
import { Integer, Utf8String } from 'asn1js'
import { AttributeTypeAndValue, Certificate, RelativeDistinguishedNames } from 'pkijs'

/** Make a local TLS identity using the runtime's Web Crypto, including on Windows. */
export async function createCertificate() {
  const keys = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])
  const name = new RelativeDistinguishedNames({ typesAndValues: [
    new AttributeTypeAndValue({ type: '2.5.4.3', value: new Utf8String({ value: 'DSHM Bridge' }) }),
  ] })
  const serial = randomBytes(16)
  serial[0] = (serial[0] & 0x7f) | 1
  const certificate = new Certificate({ version: 2, serialNumber: new Integer({ valueHex: serial }),
    subject: name, issuer: name })
  certificate.notBefore.value = new Date()
  certificate.notAfter.value = new Date(Date.now() + 825 * 86400000)
  await certificate.subjectPublicKeyInfo.importKey(keys.publicKey)
  await certificate.sign(keys.privateKey, 'SHA-256')
  const cert = new X509Certificate(Buffer.from(certificate.toSchema().toBER(false))).toString()
  const key = KeyObject.from(keys.privateKey).export({ type: 'pkcs8', format: 'pem' })
  return { key, cert }
}
