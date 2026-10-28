import { copies } from './copy.mjs'
const install = { macos: 'https://tailscale.com/docs/install/mac', windows: 'https://tailscale.com/docs/install/windows', other: 'https://tailscale.com/docs/install' }
export function setupPresentation(status, copy = copies.en) {
  if (!status) return { title: copy.checkingTailscale, detail: '', ready: false }
  const ready = status.state === 'running' && Boolean(status.bridgeListening)
  const state = status.state !== 'running' ? status.state : !ready ? 'bridge-not-ready' : status.connectedDevices > 0 ? 'connected' : 'ready'
  const [title, detail] = Object.hasOwn(copy.states, state) ? copy.states[state] : copy.states.unavailable
  return { title, detail, ready }
}

export function createRemoteSetup(React, { Button }) {
  const h = React.createElement
  const link = (href, label) => h('a', { className: 'dshm-link-button', href, target: '_blank', rel: 'noopener noreferrer' }, label, ' ↗')
  return function RemoteSetup({ api, onPair, pairingBusy, copy }) {
    const [status, setStatus] = React.useState(null), [error, setError] = React.useState('')
    const [busy, setBusy] = React.useState(false), [opened, setOpened] = React.useState(false), [checking, setChecking] = React.useState(false)
    const live = React.useRef(true), pending = React.useRef(false)
    const check = async (manual = false) => {
      if (pending.current) return
      pending.current = true
      if (manual) setChecking(true)
      try { const value = await api('remoteSetup'); if (live.current) { setStatus(value); setError('') } }
      catch { if (live.current) { setStatus(null); setError('setupError') } }
      finally { pending.current = false; if (live.current) setChecking(false) }
    }
    React.useEffect(() => {
      live.current = true
      void check()
      const timer = setInterval(() => { void check() }, 5000)
      return () => { live.current = false; clearInterval(timer) }
    }, [])
    const open = async () => {
      if (busy) return
      setBusy(true); setError(''); setOpened(false)
      try { await api('openTailscale', {}); if (live.current) setOpened(true) }
      catch { if (live.current) setError('openError') }
      finally { if (live.current) setBusy(false) }
    }
    const view = setupPresentation(status, copy)
    return h('div', { className: 'dshm-panel', id: 'dshm-remote-setup' },
      h('p', null, copy.intro),
      h('ol', { className: 'dshm-setup-steps' },
        h('li', null, h('h3', null, copy.step1),
          h('p', { role: 'status', 'aria-live': 'polite', 'aria-atomic': true }, error && !status ? copy.unavailableStatus : view.title),
          view.detail ? h('p', null, view.detail) : null,
          h('div', { className: 'dshm-actions' },
            status?.state === 'not-installed' || status?.state === 'unsupported' ? link(install[status.platform] ?? install.other, copy.getComputer) : null,
            // Keep keyboard focus during short requests; handlers prevent repeats.
            status?.canOpenApp ? h(Button, { variant: 'outline', 'aria-disabled': busy, 'aria-busy': busy, onClick: open }, busy ? copy.opening : copy['button.open']) : null,
            h(Button, { variant: 'outline', 'aria-disabled': busy || checking, 'aria-busy': checking, onClick: () => { if (!busy) void check(true) } }, checking ? copy.checking : copy['button.check'])),
          status?.state === 'not-installed' ? h('p', null, copy.installDetail) : null,
          opened ? h('p', { role: 'status' }, copy.opened) : null),
        h('li', null, h('h3', null, copy.step2),
          h('p', null, copy['step2.detail']),
          link('https://tailscale.com/docs/install/ios', copy.getPhone)),
        h('li', null, h('h3', null, copy.step3),
          h('p', null, copy['step3.detail']),
          h(Button, { variant: 'primary', disabled: !view.ready || pairingBusy, onClick: onPair }, copy['button.pairRemote']),
          h('p', null, copy['step3.check']))),
      error ? h('p', { className: 'dshm-error', role: 'alert' }, copy[error]) : null)
  }
}
