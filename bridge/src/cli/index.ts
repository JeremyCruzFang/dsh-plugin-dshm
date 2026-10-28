import QRCode from 'qrcode'
import { parseConfig } from '../config.js'
import { localRequest } from '../host/local.js'
import type { HostPairing, HostStatus, HostDevice } from '../host/types.js'
import { installCli, cliInject } from '../projection/host.js'
export const name = 'dshm-cli'
export const inject = cliInject
export async function run(args: readonly string[]): Promise<number> {
  const directory = parseConfig(undefined).stateDir
  const [command, id, ...extra] = args
  if (extra.length || !['pair', 'devices', 'revoke', 'status'].includes(command ?? '') || (command === 'revoke' ? !id : id !== undefined)) {
    console.error('Usage: dsh dshm pair | devices | revoke <id> | status'); return 2
  }
  try {
    if (command === 'pair') {
      const value = await localRequest<HostPairing>(directory, 'POST', '/pair', {})
      console.log(await QRCode.toString(value.url, { type: 'terminal', small: true }))
      console.log(`Pairing expires at ${value.expiresAt}. One use. Keep this QR private.`)
    } else if (command === 'devices') {
      const { devices } = await localRequest<{ devices: HostDevice[] }>(directory, 'GET', '/devices')
      console.log(JSON.stringify(devices, null, 2))
    } else if (command === 'revoke') {
      const result = await localRequest<{ revoked: boolean }>(directory, 'POST', '/revoke', { deviceId: id })
      if (!result.revoked) { console.error('Device not found'); return 1 }
      console.log('Device revoked')
    } else console.log(JSON.stringify(await localRequest<HostStatus>(directory, 'GET', '/status'), null, 2))
    return 0
  } catch { console.error('DSHM bridge is unavailable in this DSH_HOME. Start the host profile first.'); return 1 }
}
export function apply(context: unknown): void { installCli(context, run) }
