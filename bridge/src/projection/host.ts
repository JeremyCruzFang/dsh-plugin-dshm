import type { HostControls } from '../host/types.js'

interface FetchRoute {
  path: string
  methods: string[]
  requestBody: 'buffered'
  fetch(request: Request): Promise<Response>
}
interface HostContext {
  connection: { fetch: { register(route: FetchRoute): unknown } }
}
interface LaunchContext {
  get(name: 'cmdlineArgs'): { get(): readonly string[] } | undefined
  get(name: 'appExit'): ((code: number) => void) | undefined
  get(name: 'appReady'): { onReady(callback: () => void): () => void } | undefined
  effect(create: () => () => void, label: string): unknown
}
const json = (value: unknown, status = 200) => Response.json(value, { status, headers: { 'cache-control': 'no-store' } })
const invalid = () => json({ error: { code: 'invalid-params', message: 'Invalid host-control request' } }, 400)

async function input(request: Request, fields: string[]): Promise<Record<string, unknown> | undefined> {
  if (request.headers.get('content-type')?.split(';', 1)[0]?.trim() !== 'application/json') return
  if (Number(request.headers.get('content-length')) > 2048) return
  const text = await request.text()
  if (Buffer.byteLength(text) > 2048) return
  let value: unknown
  try { value = JSON.parse(text) } catch { return }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return
  const object = value as Record<string, unknown>
  if (Object.keys(object).some(key => !fields.includes(key))) return
  return object
}

/** Native exact routes inherit Connection's authenticated-owner and Host/Origin fence. */
export function installHostRoutes(context: unknown, controls: HostControls): void {
  const ctx = context as HostContext
  const route = (path: string, method: string, handler: (request: Request) => Promise<Response> | Response): void => {
    ctx.connection.fetch.register({ path: `/api/dshm/${path}`, methods: [method], requestBody: 'buffered', async fetch(request) {
      try {
        request.signal.throwIfAborted()
        return await handler(request)
      } catch {
        // Native exceptions can contain paths or configuration. Only fixed UI
        // copy crosses the privileged browser route.
        return json({ error: { code: 'internal', message: 'Host operation failed' } }, 503)
      }
    } })
  }
  route('status', 'GET', () => json(controls.status()))
  route('devices', 'GET', () => json({ devices: controls.devices() }))
  route('remoteSetup', 'GET', async () => json(await controls.remoteSetup()))
  route('openTailscale', 'POST', async request => {
    if (!await input(request, [])) return invalid()
    await controls.openTailscale()
    return json({ opened: true })
  })
  route('pairRemote', 'POST', async request => {
    if (!await input(request, [])) return invalid()
    const pairing = await controls.pairRemote()
    return pairing ? json(pairing) : json({ error: { code: 'not-ready', message: 'Connect Tailscale on this computer and retry.' } }, 409)
  })
  route('pair', 'POST', async request => {
    if (!await input(request, [])) return invalid()
    return json(await controls.pair())
  })
  route('cancelPair', 'POST', async request => {
    if (!await input(request, [])) return invalid()
    controls.cancelPair()
    return json({})
  })
  route('revoke', 'POST', async request => {
    const body = await input(request, ['deviceId'])
    if (!body || typeof body.deviceId !== 'string' || !body.deviceId.length || body.deviceId.length > 256) return invalid()
    if (!controls.revoke(body.deviceId)) return json({ error: { code: 'not-found', message: 'Device was not found' } }, 404)
    return json({ revoked: true })
  })
}

export const cliInject = ['cmdlineArgs', 'appExit', 'appReady']

/** The custom dshm profile owns its arguments; no installed launcher is patched. */
export function installCli(context: unknown, runner: (args: readonly string[]) => Promise<number>): void {
  const ctx = context as LaunchContext
  const args = ctx.get('cmdlineArgs'), exit = ctx.get('appExit'), ready = ctx.get('appReady')
  if (!args || !exit || !ready) throw new Error('DSHM CLI requires the DSH profile launcher')
  ctx.effect(() => ready.onReady(() => {
    void runner(args.get()).then(exit, () => exit(1))
  }), 'dshm: command lifetime')
}
