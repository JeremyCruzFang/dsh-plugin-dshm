# DSHM bridge

[简体中文](README.zh-CN.md)

Control DeepSeek Harness sessions on your computer from the DSHM app on your
iPhone or iPad. The agent keeps running on your computer; the bridge connects
your paired device over your local network or your own VPN.

## Requirements and compatibility

- DeepSeek Harness **0.2.1-rc.3 or 0.2.1-rc.5**. Plugin 0.1.1 adds support for
  **0.2.1-rc.5**, the npm `latest` release verified on 2026-10-30. These are
  exact tested versions; other releases, including the separate 0.2.2 alpha
  channel, are not automatically compatible.
- A running DSH desktop app or `dsh web` on your computer, and a compatible DSHM
  iPhone/iPad build. This npm package does not install the iOS app.
- Node 24 or later in the DSH runtime, and `openssl` on its PATH for the initial
  local TLS certificate.
- Both devices on a network that permits direct communication, or on your own
  connected VPN such as Tailscale.

The bridge has been exercised with DSH 0.2.1-rc.3 on macOS, including the desktop
app and isolated `dsh web`. Plugin 0.1.1 is also tested against real DSH
0.2.1-rc.5 in isolated `dsh web`, including approvals, reconnects, file transfers,
path restrictions and restart. The new 0.1.1 / rc.5 combination still needs a
Windows native check; macOS results do not substitute for Windows verification. Physical-phone network acceptance is also separate from
the local test-client and Simulator results. Mainland China is outside the v1
release scope; mainland network reachability is not claimed.

## Install in DSH

1. Open the **Plugins** page in the DSH instance you want to control.
2. Install this package spec using the page's package installation control:

   ```text
   dsh-plugin-dshm
   ```

3. Let DSH's plugin manager install the bundle and dependencies. Restart DSH
   when requested, then open **Settings → DSHM**.

Use DSH's plugin manager rather than editing its profile files or copying files
into the installed application. The plugin is installed into the selected DSH
profile; installing it into one profile does not enable every other profile.

DSH 0.2.1 installs packages by name from npm; there is no central DSH plugin
market. No DSHM custom plugin index is published for this release.

## Pair your device

### Guided remote setup

Phone not on the same Wi-Fi as this computer? Use Tailscale. On the same Wi-Fi,
nothing else is needed. Open **Settings → DSHM → Not on the same Wi-Fi**.
The optional helper checks the official Tailscale app on Windows/macOS, links
to its official installer instructions, and can open the installed app on the
DSH host. Complete installation, system approvals and browser sign-in yourself.
If viewing DSH from another computer, install Tailscale on the **DSH host**.
The plugin does not embed a VPN, install software automatically, or change
Tailscale accounts, DNS, routes, exit nodes, firewall or proxy settings.

Install Tailscale on your iPhone/iPad, sign in to the same personal account,
and connect both ends. For organization accounts, both devices must belong to
the same permitted tailnet; account sign-in does not override access policy.
Then select **Pair for remote access** and scan the fresh QR in DSHM. An older
LAN-only pairing does not automatically acquire the new VPN address: forget
the old computer in DSHM, revoke its old device entry on the host, and pair again.
An active earlier QR is replaced when you explicitly create the fresh one.

The card distinguishes PC readiness from **Phone connected over Tailscale**.
Test with your phone on cellular or a different Wi-Fi.
**Pair a device** remains available for ordinary LAN use without Tailscale.
Missing software, canceled installation, sign-out and unavailable status checks
do not disable local pairing. Removing this plugin leaves Tailscale installed.
Fresh-install and remote-phone acceptance of this helper remain pending.
Earlier Windows LAN/remote tests used the previous package.

The helper reads local Tailscale state only while setup is open or when you
request remote pairing. It returns connection state and local VPN addresses,
not account identities, login links or peer inventories. Tailscale is a separate
service with its own account and privacy terms; DSHM's pinned TLS remains in use
over that VPN.

### Local pairing

1. Keep DSH running. On the computer, open **Settings → DSHM → Pair a device**.
2. In DSHM on your iPhone or iPad, add a computer and scan the displayed QR code.
3. Allow local-network access when prompted. The computer's DSHM card should
   show your device as **Connected**.

The QR code is private, single use and valid for five minutes. Do not share it
or include it in screenshots or support reports. **Cancel pairing** closes the
window; if it expires, start a new one. Pair only devices you trust: paired
devices can view sessions and files, send prompts and answer tool approvals.

To disconnect a lost or unwanted device, use **Settings → DSHM → Revoke**, then
confirm **Revoke device**. This closes its active connection and prevents that
pairing from reconnecting. Pair again if you later want to restore access.

## Network setup

- **macOS:** allow **DeepSeek Harness** in **System Settings → Privacy & Security
  → Local Network**. If you run `dsh web` in Terminal or another terminal app,
  allow that app too. DSHM on iOS also needs Local Network permission.
- **Windows:** if Windows Firewall asks about the DSH host process, allow it on
  your trusted **Private networks**. Keep **Public networks** disabled. The
  bridge does not change firewall rules for you; Windows runtime verification
  remains pending.
- **Wi-Fi:** start with the same trusted home/work Wi-Fi. Guest networks,
  hotspots and router client isolation may prevent devices from reaching each
  other even when both have internet access.
- **Proxies and VPNs:** enable **bypass LAN/local networks** on both devices, or
  temporarily turn the interfering proxy off to check the route. Keep LAN and
  the chosen VPN's device addresses reachable; a rule that routes all traffic
  through a proxy can prevent pairing.
- **Not on the same Wi-Fi:** connect both devices to the same Tailscale network (or
  another VPN you control) and permit traffic between them. Keep the computer
  awake and DSH running. DSHM does not provide a cloud relay for session traffic. Bonjour may
  not cross a VPN; pair while both devices can reach an address included by the
  computer.

The bridge normally listens on TCP **47390** on private/LAN and Tailscale
addresses. It uses a separate listener from DSH's Web UI. Do not expose that
port by router port forwarding or change DSH's Web server to a public bind.
Bonjour discovery uses the local network. If discovery sees your computer but
connection fails, check permissions, VPN/proxy bypass and client isolation first.

If enabling DSHM reports `EADDRINUSE`, another listener already owns the
address and port. Check for a second DSH instance running the bridge. Once
the port is free, enable DSHM again.

## What is sent, and where

The bridge sends session messages, tool results, approvals, selected files and
declared deliverables to your authenticated, paired device over pinned TLS.
Prompts, answers and attachments from that device go back to DSH on your
computer. The bridge runs no cloud agent and has no analytics service or relay
for session traffic. It does not read or forward DSH's provider-credential store.
DSH itself still contacts the model providers and tools you configured, under
their own settings.

On the LAN, Bonjour announces the bridge's host identity/version and private
addresses for discovery. Local bridge identity and pairing records stay under
`$DSH_HOME/dshm/` (`~/.dsh/dshm/` with the default DSH home); private files should
never be pasted into issues. Installing a package or using a remote plugin
index makes DSH contact the package registry/index host.

**Optional push notifications use a separate proxy and Apple Push Notification
service (APNs).** Without a configured `pushProxyUrl`, the bridge makes no push
network requests and does not advertise push support. Configuring a URL enables
periodic health checks; push support is advertised only while the proxy is
reachable and the bridge's session observer is working. This package includes the bridge sender; the proxy and app are separate. iOS push registration,
the Notification Service Extension and real locked-phone delivery remain
separate work; they have not been verified by the local backend tests.

For push registration, the app sends its APNs device token and sandbox/production
environment to the selected HTTPS proxy. The proxy stores that routing mapping
and encrypts its authentication secret under a separate wrapping key. The app
shares the returned registration and a separate notification-content key with
the paired bridge over DMP. The bridge stores these keys and preferences in its
private `$DSH_HOME/dshm/push.json` file (mode 0600). The APNs provider key stays
only in the proxy's secret configuration; it is never supplied to the bridge.

When notifications are configured and registered, the bridge sends the proxy
an encrypted session title and short event summary, plus an opaque push ID,
event category, grouping ID and request signature. The proxy forwards the
ciphertext and a generic fallback alert to APNs. The proxy and APNs do not
receive the notification-content key or decrypted title/summary; routing
metadata, timing and payload size remain visible, and the proxy receives the
client IP at the network layer. The application logs counters only and stores
hashed IP quota buckets. Push does not upload files or full transcripts, and
an authenticated live connection suppresses sends to that device.

Unregistering notifications or revoking a device removes its local push
registration before a best-effort request to delete the proxy mapping. If the
proxy is unreachable, remote deletion is not confirmed; uninstalling the
package alone does not delete a remote mapping. Alerts already accepted by
APNs cannot be recalled. Terminal output remains read-only; the bridge does
not provide an interactive remote terminal.

## Remove the bridge

1. In **Settings → DSHM**, revoke devices you no longer want to authorize.
2. Open **Plugins**, find `dsh-plugin-dshm`, and remove it from the active
   profile through DSH's plugin manager. Repeat for any other profile where you
   installed it, including an optional `dshm` CLI profile.
3. Restart the affected DSH host when requested. The DSHM settings card and its
   listener should be gone from that host.

Uninstalling the package is separate from deleting its private identity and
pairing state. Preserve `$DSH_HOME/dshm/` if you intend to reinstall. If you
deliberately choose a full reset, stop every DSH host using that home first and
remove only the bridge's `dshm` state directory; existing devices will need to
forget the old host and pair again. Do not delete the whole DSH home or its
credentials/session directories. Uninstall does not remove your DSH sessions.

## New DSH release checklist (maintainers)

1. Review upstream DSH changes, especially the projection APIs and bundle
   loader. In an unpublished candidate, update the explicit runtime allowlist
   and `engines.dsh` together so DSH can install it for isolated verification.
   Do not publish or claim support before the following tests pass.
2. Install the candidate DSH runtime through its normal distribution and run
   `pnpm -C bridge test:integration` against it in the isolated `.dsh-test` home.
   Review the explicit runtime version guard in `bridge/src/projection/native.ts`
   as part of the compatibility change; changing package metadata alone does
   not enable a new runtime. Adapt the test carrier path if needed; do not
   bypass a failure or test against the old runtime while claiming the new one. Record the
   actual DSH version and results. Complete the Windows checklist before
   claiming a newly supported Windows combination.
3. Run `pnpm -C bridge test`, `pnpm -C protocol validate` and
   `pnpm -C protocol gen:check`. Fix compatibility changes only inside the
   appropriate boundary and review the results.
4. **Only after the real-DSH suite passes**, finalize `engines.dsh` as the explicit
   tested versions/range. Never assume an entire future minor release is safe.
   Update the tested range in `tools/release-plugin/check-release.mjs` with the
   recorded evidence, keeping it aligned with the runtime compatibility guard.
   Regenerate and validate the plugin index from `bridge/package.json`, keeping
   its compatibility field identical.
5. Bump the bridge version, update these READMEs, inspect `npm pack --dry-run`,
   and install/boot the exact tarball through the isolated plugin manager.
6. Audit the exact release tarball and record its SHA-256 before publication.
   The owner signs in to npm and publishes that audited tarball with lifecycle
   scripts disabled. Verify installation by name through DSH's plugin manager
   in an isolated profile. Never publish a replacement over an existing version.

The public repository is a plugin-only source snapshot. Shared protocol source,
fixtures and integration tools remain in the private development repository;
monorepo build/test commands above require that maintainer checkout. The npm
package includes its protocol runtime and dependency license notices, so users
do not need those development sources. No private monorepo history, iOS app or
push-proxy source is included in the public repository.

Licensed under [MIT](LICENSE). See [CHANGELOG](CHANGELOG.md) for release changes.

[Source](https://github.com/JeremyCruzFang/dsh-plugin-dshm) ·
[Issues](https://github.com/JeremyCruzFang/dsh-plugin-dshm/issues)
