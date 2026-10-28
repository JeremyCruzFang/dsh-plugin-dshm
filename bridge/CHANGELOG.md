# Changelog

## 0.1.0 — 2026-10-28

Initial DSHM bridge release for DeepSeek Harness 0.2.1-rc.3.

- Pair an iPhone or iPad using a short-lived code and pinned TLS; authenticate
  paired devices and revoke access from the DSH settings card.
- Follow sessions, send prompts, answer approvals/questions and transfer files
  over a reachable private network or the user's own VPN.
- English and Simplified Chinese settings card with optional Tailscale setup
  guidance under “Not on the same Wi-Fi / 不在同一 Wi-Fi”.
- Optional encrypted push sender; proxy deployment and real-device notification
  delivery are separate from this package's local verification.
- MIT license and a separate plugin-only public source repository. The iOS app,
  private development history and push-proxy source are not part of this release.

Fresh-install and remote-phone acceptance of the new Tailscale setup helper
remain pending. Earlier Windows LAN/remote tests used the previous package.
