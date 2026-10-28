// DSH publishes its active locale on <html lang>; other carriers use the browser language.
export function languageFor(hostLanguage, browserLanguage) {
  const language = typeof hostLanguage === 'string' && hostLanguage.trim() ? hostLanguage : browserLanguage
  return /^zh(?:[-_]|$)/i.test(language ?? '') ? 'zh-CN' : 'en'
}
const readLanguage = () => languageFor(globalThis.document?.documentElement.lang, globalThis.navigator?.language)
function subscribeLanguage(listener) {
  const element = globalThis.document?.documentElement
  const observer = element && typeof MutationObserver !== 'undefined' ? new MutationObserver(listener) : undefined
  observer?.observe(element, { attributes: true, attributeFilter: ['lang'] })
  globalThis.addEventListener?.('languagechange', listener)
  return () => { observer?.disconnect(); globalThis.removeEventListener?.('languagechange', listener) }
}
export function useCopy(React) {
  const language = React.useSyncExternalStore(subscribeLanguage, readLanguage, () => 'en')
  return { language, copy: copies[language] }
}
export const copies = {
  en: {
    intro: 'Phone not on the same Wi-Fi as this computer? Use Tailscale. On the same Wi-Fi, nothing else is needed.',
    step1: 'Connect this computer', step2: 'Connect your iPhone or iPad',
    'step2.detail': 'Install Tailscale, sign in to the same account, and connect.',
    step3: 'Pair with a fresh code',
    'step3.detail': 'Connect Tailscale on both devices first. Paired on Wi-Fi before? Forget the computer in DSHM, revoke the old device below, then pair here.',
    'step3.check': 'Test with your phone on cellular or a different Wi-Fi.',
    'button.pairRemote': 'Pair for remote access', 'button.open': 'Open Tailscale', 'button.check': 'Check again', away: 'Not on the same Wi-Fi',
    states: {
      'not-installed': ['Install Tailscale on this computer', 'Use the official installer, then check again.'],
      'needs-login': ['Sign in to Tailscale', 'Open Tailscale and finish signing in.'],
      'needs-approval': ['Waiting for approval', 'Ask your Tailscale admin to approve this computer.'],
      stopped: ['Tailscale is disconnected', 'Open Tailscale and choose Connect.'],
      starting: ['Tailscale is starting', 'Check again in a moment.'],
      offline: ['Tailscale is offline', "Check this computer's internet connection."],
      unavailable: ["Couldn't check Tailscale", 'Open Tailscale, then check again.'],
      unsupported: ['Set up your VPN manually', 'Automatic checks support Windows and macOS. Same-network pairing still works.'],
      'bridge-not-ready': ['Tailscale connected, DSHM not ready yet', 'Check again in a few seconds. If it persists, check the firewall.'],
      ready: ['Ready for remote pairing', 'No phone has connected over Tailscale yet.'],
      connected: ['Phone connected over Tailscale', ''],
    },
    '409': 'Connect Tailscale on this computer, check again, then make a new code.',
    requestError: 'DSHM could not complete this request. Try again.',
    bridgeError: 'The bridge is unavailable. Check the host, then retry.',
    setupError: 'Could not check remote setup. Check the host and retry. Local pairing is still available.',
    openError: 'Could not open Tailscale on the host. Open it from the Start menu or Applications, then check again.',
    checkingTailscale: 'Checking Tailscale…', unavailableStatus: 'Status unavailable', opening: 'Opening…', checking: 'Checking…',
    getComputer: 'Get Tailscale for this computer', getPhone: 'Get Tailscale for iPhone or iPad',
    installDetail: 'Run the installer on the computer running DSH. Complete installation and sign-in yourself; canceling leaves local pairing available.',
    opened: 'Tailscale was opened on the host. Complete sign-in or choose Connect there, then return here.',
    cardLabel: 'DSHM remote access', connectedCount: count => `${count} connected`, listening: 'Listening', noNetwork: 'No private network', loading: 'Loading bridge…',
    working: 'Working…', pair: 'Pair a device', retry: 'Retry', qrLabel: 'Pairing QR code', scan: 'Scan with your iPhone', qrAlt: 'DSHM one-use pairing QR code',
    expires: time => `Expires in ${time}`, cancelPair: 'Cancel pairing',
    guidanceMac: 'Allow DeepSeek Harness under System Settings → Privacy & Security → Local Network. If you run dsh web in a terminal, allow that terminal too.',
    guidanceWindows: 'Allow DeepSeek Harness on Private networks when Windows Firewall asks. Keep Public networks disabled.',
    bonjour: 'Bonjour is unavailable on this network. Pairing still includes the host’s direct addresses.',
    closeSetup: 'Close remote setup', openSetup: 'Set up remote access', devices: 'Paired devices',
    viaTailscale: 'Connected via Tailscale', viaLAN: 'Connected via local network', connected: 'Connected', offline: 'Offline',
    lastSeen: date => `Last seen ${date}`, notConnected: 'Not connected yet', revokeQuestion: name => `Revoke ${name}?`,
    cancel: 'Cancel', revokeDevice: 'Revoke device', revoke: 'Revoke', noDevices: 'No paired devices.',
  },
  'zh-CN': {
    intro: '手机和这台电脑不在同一 Wi-Fi？使用 Tailscale。在同一 Wi-Fi 下无需其他设置。',
    step1: '连接这台电脑', step2: '连接 iPhone 或 iPad',
    'step2.detail': '安装 Tailscale，登录同一账户并连接。',
    step3: '用新的配对码配对',
    'step3.detail': '请先在两台设备上连接 Tailscale。之前在 Wi-Fi 下配对过？在 DSHM 中移除这台电脑，在下方撤销旧设备，然后在此重新配对。',
    'step3.check': '请让手机使用蜂窝网络或其他 Wi-Fi 进行测试。',
    'button.pairRemote': '配对以远程访问', 'button.open': '打开 Tailscale', 'button.check': '再次检查', away: '不在同一 Wi-Fi',
    states: {
      'not-installed': ['在这台电脑上安装 Tailscale', '使用官方安装程序，然后再次检查。'],
      'needs-login': ['登录 Tailscale', '打开 Tailscale 并完成登录。'],
      'needs-approval': ['等待批准', '请 Tailscale 管理员批准这台电脑。'],
      stopped: ['Tailscale 未连接', '打开 Tailscale 并选择“连接”。'],
      starting: ['Tailscale 正在启动', '请稍后再次检查。'],
      offline: ['Tailscale 离线', '请检查这台电脑的网络连接。'],
      unavailable: ['无法检查 Tailscale', '打开 Tailscale 后再次检查。'],
      unsupported: ['请手动设置 VPN', '自动检查仅支持 Windows 和 macOS。同一网络配对仍可使用。'],
      'bridge-not-ready': ['Tailscale 已连接，DSHM 尚未就绪', '请几秒后再次检查。如持续出现，请检查防火墙。'],
      ready: ['可以远程配对', '尚无手机通过 Tailscale 连接。'],
      connected: ['手机已通过 Tailscale 连接', ''],
    },
    '409': '请在这台电脑上连接 Tailscale，再次检查后生成新的配对码。',
    requestError: 'DSHM 无法完成此请求，请重试。', bridgeError: '桥接不可用，请检查电脑后重试。',
    setupError: '无法检查远程设置，请检查电脑后重试。局域网配对仍可使用。',
    openError: '无法在电脑上打开 Tailscale。请从“开始”菜单或“应用程序”中打开，然后再次检查。',
    checkingTailscale: '正在检查 Tailscale…', unavailableStatus: '状态不可用', opening: '正在打开…', checking: '正在检查…',
    getComputer: '获取电脑版 Tailscale', getPhone: '获取 iPhone 或 iPad 版 Tailscale',
    installDetail: '请在运行 DSH 的电脑上安装，并亲自完成安装和登录。取消后仍可在局域网配对。',
    opened: '已在电脑上打开 Tailscale。请完成登录或选择“连接”，然后返回此处。',
    cardLabel: 'DSHM 远程访问', connectedCount: count => `${count} 台设备已连接`, listening: '正在监听', noNetwork: '没有私有网络', loading: '正在加载桥接…',
    working: '正在处理…', pair: '配对设备', retry: '重试', qrLabel: '配对二维码', scan: '用 iPhone 扫描', qrAlt: 'DSHM 一次性配对二维码',
    expires: time => `${time} 后过期`, cancelPair: '取消配对',
    guidanceMac: '请在“系统设置 → 隐私与安全性 → 本地网络”中允许 DeepSeek Harness。如果在终端运行 dsh web，也请允许该终端。',
    guidanceWindows: 'Windows 防火墙询问时，请允许 DeepSeek Harness 访问专用网络，并保持公用网络禁用。',
    bonjour: '此网络上的 Bonjour 不可用，配对仍包含电脑的直接连接地址。',
    closeSetup: '关闭远程设置', openSetup: '设置远程访问', devices: '已配对设备',
    viaTailscale: '已通过 Tailscale 连接', viaLAN: '已通过局域网连接', connected: '已连接', offline: '离线',
    lastSeen: date => `上次连接：${date}`, notConnected: '尚未连接', revokeQuestion: name => `撤销 ${name} 的访问权限？`,
    cancel: '取消', revokeDevice: '撤销设备', revoke: '撤销', noDevices: '没有已配对设备。',
  },
}
export function guidanceCopy(text, copy) {
  for (const key of ['guidanceMac', 'guidanceWindows']) if (text === copies.en[key]) return copy[key]
  return text
}
