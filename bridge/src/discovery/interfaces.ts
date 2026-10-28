import net from 'node:net'
import os from 'node:os'

export type BindMode = 'lan' | 'tailscale' | 'all-private'
export function isTailscale(address: string): boolean {
  if (address.toLowerCase().startsWith('fd7a:115c:a1e0:')) return true
  if (net.isIP(address) !== 4) return false
  const [a, b] = address.split('.').map(Number)
  return a === 100 && b >= 64 && b <= 127
}
export function isPrivateAddress(address: string, allowLoopback = false): boolean {
  if (net.isIP(address) === 6) return (allowLoopback && address === '::1') || /^(fc|fd)/i.test(address)
  if (net.isIP(address) !== 4) return false
  const [a, b] = address.split('.').map(Number)
  return (allowLoopback && a === 127) || a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || isTailscale(address)
}
export function privateInterfaces(mode: BindMode = 'all-private'): string[] {
  return [...new Set(Object.values(os.networkInterfaces()).flatMap(entries => (entries ?? [])
    .filter(entry => !entry.internal && isPrivateAddress(entry.address) && (mode === 'all-private' || (mode === 'tailscale' ? isTailscale(entry.address) : !isTailscale(entry.address))))
    .map(entry => entry.address)))].sort()
}
export const endpoint = (address: string, port: number): string => `${net.isIP(address) === 6 ? `[${address}]` : address}:${port}`
