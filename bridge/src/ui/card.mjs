// DMP-shaped host controls; all native module/slot knowledge stays in projection/.
import { useCopy, guidanceCopy } from './copy.mjs'
import { createRemoteSetup } from './remote-setup.mjs'
export function createSettingsCard(React, { Button }, apiBase) {
  const h = React.createElement
  const RemoteSetup = createRemoteSetup(React, { Button })
  const icon = (kind) => h('svg', { width: 18, height: 18, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.8, 'aria-hidden': true }, h('path', { d: kind === 'pair' ? 'M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4zM14 14h2v2h-2zM18 14h2v6h-6v-2' : 'M5 7h14M9 7V4h6v3M7 7l1 13h8l1-13M10 10v7M14 10v7' }))
  const style = `.dshm-card{color:var(--dsw-alias-label-primary);font:inherit;font-size:16px;line-height:1.5;display:grid;gap:24px}.dshm-card h2,.dshm-card h3,.dshm-card p{margin:0}.dshm-card h2{font-size:20px}.dshm-card h3{font-size:16px}.dshm-card button{min-height:44px;gap:8px}.dshm-card button:focus-visible,.dshm-link-button:focus-visible{outline:2px solid var(--dsw-alias-label-primary);outline-offset:3px}.dshm-row{display:flex;align-items:center;justify-content:space-between;gap:16px;flex-wrap:wrap}.dshm-muted{color:var(--dsw-alias-label-secondary);font-size:14px}.dshm-panel{padding:16px;border:1px solid var(--dsw-alias-border-primary,currentColor);border-radius:var(--dsw-radius-md,12px);display:grid;gap:12px}.dshm-qr{display:block;width:256px;max-width:100%;height:auto;background:white;border-radius:8px}.dshm-devices{list-style:none;margin:0;padding:0;display:grid;gap:12px}.dshm-device{padding:14px 0;border-bottom:1px solid var(--dsw-alias-border-primary,currentColor)}.dshm-actions{display:flex;gap:8px;flex-wrap:wrap}.dshm-setup-steps{margin:0;padding-left:24px;display:grid;gap:24px}.dshm-setup-steps li{display:grid;gap:12px;min-width:0}.dshm-link-button{display:inline-flex;align-items:center;min-height:44px;padding:8px 12px;border:1px solid var(--dsw-alias-border-primary,currentColor);border-radius:var(--dsw-radius-md,12px);color:inherit;text-decoration:underline;box-sizing:border-box}.dshm-error{color:var(--dsw-alias-danger-label,#b42318)}.dshm-guidance{padding:14px 16px;background:var(--dsw-alias-bg-layer-3);border-radius:var(--dsw-radius-md,12px)}@media(max-width:480px){.dshm-row{align-items:flex-start}.dshm-qr{width:224px}}`
  return function SettingsCard() {
    const { language, copy } = useCopy(React)
    const [status, setStatus] = React.useState(null), [devices, setDevices] = React.useState([])
    const [pairing, setPairing] = React.useState(null), [busy, setBusy] = React.useState(false)
    const [error, setError] = React.useState(''), [confirm, setConfirm] = React.useState(null), [now, setNow] = React.useState(Date.now())
    const [remoteOpen, setRemoteOpen] = React.useState(false)
    const pairPanel = React.useRef(null)
    React.useEffect(() => { if (pairing) pairPanel.current?.focus() }, [pairing?.expiresAt])
    const api = async (route, body) => {
      const response = await fetch(`${apiBase}/${route}`, { method: body === undefined ? 'GET' : 'POST', credentials: 'same-origin', cache: 'no-store', headers: body === undefined ? {} : { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(6000) })
      if (!response.ok) throw new Error(route === 'pairRemote' && response.status === 409 ? '409' : 'requestError')
      return response.json()
    }
    const refresh = async () => { const [next, list] = await Promise.all([api('status'), api('devices')]); setStatus(next); setDevices(list.devices); if (!next.pairing.active) setPairing(null) }
    React.useEffect(() => {
      let live = true
      const poll = async () => { try { const [next, list] = await Promise.all([api('status'), api('devices')]); if (live) { setStatus(next); setDevices(list.devices); if (!next.pairing.active) setPairing(null) } } catch { if (live) setError('bridgeError') } }
      void poll(); const timer = setInterval(poll, 2000), clock = setInterval(() => setNow(Date.now()), 1000)
      return () => { live = false; clearInterval(timer); clearInterval(clock) }
    }, [])
    const action = async (work) => { setBusy(true); setError(''); try { await work(); await refresh() } catch (failure) { setError(failure.message) } finally { setBusy(false) } }
    const seconds = pairing ? Math.max(0, Math.ceil((Date.parse(pairing.expiresAt) - now) / 1000)) : 0
    const button = (label, onClick, variant = 'outline', glyph) => h(Button, { variant, disabled: busy, onClick }, glyph ? icon(glyph) : null, label)
    return h('section', { className: 'dshm-card', 'aria-label': copy.cardLabel, lang: language },
      h('style', null, style),
      h('div', { className: 'dshm-row' }, h('div', null, h('h2', null, 'DSHM'), h('p', { className: 'dshm-muted' }, status ? `${copy.connectedCount(status.connectedDevices)} · ${status.addresses.length ? copy.listening : copy.noNetwork}` : copy.loading)), button(busy ? copy.working : copy.pair, () => action(async () => { const next = await api('pair', {}); setNow(Date.now()); setPairing(next) }), 'primary', 'pair')),
      error ? h('div', { className: 'dshm-panel', role: 'alert' }, h('p', { className: 'dshm-error' }, copy[error] ?? copy.requestError), button(copy.retry, () => action(refresh))) : null,
      pairing && seconds > 0 ? h('div', { className: 'dshm-panel', ref: pairPanel, tabIndex: -1, 'aria-label': copy.qrLabel }, h('h3', null, copy.scan), h('img', { className: 'dshm-qr', src: `data:image/svg+xml;base64,${btoa(pairing.svg)}`, alt: copy.qrAlt }), h('p', { role: 'timer', 'aria-live': 'off' }, copy.expires(`${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`)), button(copy.cancelPair, () => action(async () => { await api('cancelPair', {}); setPairing(null) }))) : null,
      ...(status?.guidance ?? []).map(text => h('p', { className: 'dshm-guidance', key: text }, guidanceCopy(text, copy))),
      status?.discovery.state === 'unavailable' ? h('p', { role: 'status' }, copy.bonjour) : null,
      h('div', { className: 'dshm-row' }, h('h3', null, copy.away), h(Button, { variant: 'outline', 'aria-expanded': remoteOpen, 'aria-controls': 'dshm-remote-setup', onClick: () => setRemoteOpen(!remoteOpen) }, remoteOpen ? copy.closeSetup : copy.openSetup)),
      remoteOpen ? h(RemoteSetup, { api, copy, pairingBusy: busy, onPair: () => action(async () => { const next = await api('pairRemote', {}); setNow(Date.now()); setPairing(next) }) }) : null,
      h('div', null, h('h3', null, copy.devices), devices.length ? h('ul', { className: 'dshm-devices' }, ...devices.map(device => h('li', { className: 'dshm-device', key: device.deviceId }, h('div', { className: 'dshm-row' }, h('div', null, h('strong', null, device.name), h('p', { className: 'dshm-muted' }, `${device.connected ? device.connectedVia === 'tailscale' ? copy.viaTailscale : device.connectedVia === 'lan' ? copy.viaLAN : copy.connected : copy.offline} · ${device.lastSeenAt ? copy.lastSeen(new Date(device.lastSeenAt).toLocaleString(language)) : copy.notConnected}`)), confirm === device.deviceId ? h('div', null, h('p', null, copy.revokeQuestion(device.name)), h('div', { className: 'dshm-actions' }, button(copy.cancel, () => setConfirm(null)), button(copy.revokeDevice, () => action(async () => { await api('revoke', { deviceId: device.deviceId }); setConfirm(null) }), 'outline', 'revoke'))) : button(copy.revoke, () => setConfirm(device.deviceId), 'outline', 'revoke'))))) : h('p', { className: 'dshm-muted' }, copy.noDevices)))
  }
}
