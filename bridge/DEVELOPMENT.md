# DSHM bridge development and verification

A DSH bundle that serves authenticated DMP v1 from live DSH sessions. It supports
pairing, sessions, timeline/history/resume, queue and steer, approvals and blocking
questions, model and permission selection, confined workspace files, changes,
live deliverables, shell jobs, device management, and image/file attachments.
Only capabilities verified against the supported native carrier are advertised.

## Build and checks

Requirements: Node 24, pnpm 11, and `openssl` on PATH for initial certificate
creation. The tested native carrier is DeepSeek Harness 0.2.1-rc.3 on macOS.

```sh
pnpm -C protocol install --frozen-lockfile
pnpm -C tools/mock-host install --frozen-lockfile
pnpm -C bridge install --frozen-lockfile
pnpm -C bridge build
pnpm -C bridge test
pnpm -C protocol validate
pnpm -C bridge test:integration
```

The integration command installs both this bundle and a test-only deterministic
model bundle through DSH's plugin manager, **only in this checkout's `.dsh-test`
home**. It runs a bounded isolated `dsh web`, drives the real listener with the
mock-host Node client, and waits for the child to stop before returning. No API
key, provider inference or real user session is used. The installed DSH App is
executed as the runtime carrier and is never modified. Do not run two integration
or recorder processes against the same isolated home.

Unit tests exercise the listener, creation ledger, size budget and the shared
projection core. Live integration is opt-in because a normal CI runner does not
have the installed DSH reference runtime. The JavaScript projection reducer is
shared by native streaming and byte-for-byte golden transcript checks; its
TypeScript-facing boundary is declared in `src/projection/fold-recording.d.mts`.

## Bundle and configuration

`cordis.patch.yml` inserts the host plugin and a conditional CLI entry. The host
entry runs in Web/Desktop profiles; the CLI entry runs only in the custom `dshm`
profile. The test bundle supplies this isolated configuration; no real profile
file needs editing:

```yaml
- id: dshm-bridge
  config:
    port: 0
    addresses: [127.0.0.1]
    pairOnStart: true
    quiet: true
```

Default `port` is 47390. `bindMode` is `all-private` (or `lan` / `tailscale`), and
addresses are discovered from private interfaces and refreshed periodically.
An explicit nonempty `addresses` list accepts private IP literals; loopback is
allowed for isolated tests. Wildcard, DNS-name and public binds are rejected.
HTTP requests without a WebSocket upgrade receive 426. No firewall or network
routing configuration is changed.

Pairing is closed by default. M1 operators may explicitly set `pairOnStart: true`;
with `quiet: false` (the default), the bridge prints a terminal QR into the
DSH log. Treat its pixels as a temporary credential. `$DSH_HOME/dshm/pairing-url.txt` contains the same one-use URL for five
minutes. `quiet: true` suppresses printing for automated tests. Pairing closes
on successful use, expiry, five failed attempts, cancellation, or shutdown.
Use the DSHM settings card or CLI to open subsequent windows.

The persistent identity and device registry live under `$DSH_HOME/dshm/`:
`key.pem`, `cert.pem`, `host-id`, and `devices.json`, with mode 0600 and a 0700
parent directory. Private material never enters protocol frames. Paired devices
pin the certificate; restore the identity files together rather than silently
rotating one of them. Revoked records are retained so a revoked device receives
`revoked` and close code 4002. A second connection for one device replaces the
first with 4004. The trusted in-process host handle supports pairing and revoke;
there is no unauthenticated HTTP administration route. Authenticated `devices.*`
methods list, watch, rename and revoke devices without exposing public keys or
other registry internals. Revoking the current device responds before closing it.

## Protocol and operational boundaries

Input frames and method params use the shared strict contract validators before
native dispatch. Owner Peers are created after `auth.ok` and disposed with the
connection. Unsubscribe removes the relevant DMP observer; connection teardown
aborts native streams. Requests have a 30-second bound, authentication a
15-second bound, and idle connections close after 60 seconds. Binary downloads
use 256 KiB chunks, a 4 MiB cumulative-ack window, a 15-second acknowledgment
deadline, and at most three concurrent downloads. A per-connection token bucket
allows a burst of 50 requests and sustains 20 requests/second; excess requests
receive retryable `busy`. The existing 64-in-flight bound also applies. Registry
revocation is refreshed at authentication and every second; acknowledgments and
requests consult memory. Reported bridge versions come from `package.json`.

The process-local creation ledger retains its target session and prompt admission
state for 24 hours. Retries reuse both target and `sendId`; changed parameters
conflict. `hello.bridge.instanceId` identifies the process, so clients must not
retry an uncertain creation after a changed instance id. It is not a durable
exactly-once guarantee.

Snapshot/history pages are budgeted by serialized bytes. Item text caps remain
visible through `truncated`; `timeline.text` and `tool.output` return full bytes.
Resume merges whole changed items and removals, or falls back to a fresh window
when the retained/reconstructed gap cannot safely fit. Display order is fixed
separately from change sequence.

Workspace file paths reject traversal, absolute, Windows-drive and UNC forms,
and resolve symlinks against the session workspace root before native reads.
All four file methods and deliverable downloads deny the configured and resolved
DSH home, including nested workspaces and symlink aliases. Post-read checks
discard bytes/metadata if the target, root or home resolution changed; ADR-006
documents the residual swap-and-restore race of native path-based reads.
Declared deliverables are the explicit exception, accessible only by their
opaque id; they read current bytes and return `not-found` for missing or
nonregular files. Change snapshots expire after a native restart. Job previews
retain native byte offsets; final tool results supply authoritative output.

Uploads accept at most 32 MiB per file or 20 MiB per supported image, with three
simultaneous buffers per connection. Native image admission also validates image
format and dimensions when the prompt is sent.
They acknowledge every chunk, expire after 30 seconds idle, and verify final
size and SHA-256 before native admission. Completed attachment ids are bound to
the device and session, retained for 15 minutes in this bridge process (256 records / 128 MiB
total budget), and survive reconnect during that period. Use a fresh upload
after process restart or expiry. A successful send reserves its attachment ids
for that sendId; retries use that same id. File receipts and image content go
through the native prompt APIs. No provider credentials are used.

Model selection reports `defaultUpdated: false`: the native session selection is
confirmed, but its asynchronous default persistence is not. Permission changes
use the native command path and read back the effective preset. Timed questions
are disabled in the isolated profile; blocking questions are exercised.

Bonjour and the settings/CLI controls were implemented in M3. Native Desktop
was verified in task 011 with its separate owner approval; that approval is not
a standing authorization for later tasks. Windows runtime checks remain with
the owner. Push remains unadvertised unless configured and healthy (below).
Software P-256 test signatures establish the transport contract, not
physical Secure Enclave acceptance. See ADR-006 and the task brief for evidence.


## Optional push sender (task 013)

Set `pushProxyUrl` to the proxy's HTTPS origin through the plugin manager in the
intended profile. Only an origin is accepted: no credentials, path, query or
fragment. HTTP is accepted only on loopback for the test harness. Deploy and
verify the proxy using `push-proxy/README.md` before configuring a real host. No proxy is deployed by this preparation work.
The startup/repeated health check has a three-second network bound and a
30-second retry interval. `push` appears only with a healthy endpoint and a
working DMP observer; without configuration no push network activity occurs.

Authenticated `push.register` stores that device's opaque proxy registration,
two independent 32-byte keys and preferences in `$DSH_HOME/dshm/push.json`, mode
0600. Treat this file as secret: never print, copy into an issue, or commit it.
Keys remain bound to the configured origin that accepted the registration;
changing the URL requires fresh app registration. Unregister and revoke remove
local state before a bounded best-effort proxy DELETE. Replacing a pushId attempts
the same cleanup for the old mapping. The app should obtain one proxy registration
per host/device binding, not share an ID across hosts.

The host-owned observer uses DMP only and continues watching after phones
disconnect. It sends blocking approvals/questions, errors, and completed turns
lasting at least 30 seconds with no foreground session watcher. Live authenticated
recipients are suppressed. Stable interaction IDs and per-session turn throttles
are persisted; errors and network failures produce only counters. There is no
automatic retry of uncertain sends. See DMP §10 and ADR-008 for exact policy,
payload limits and lifecycle details.

Run `pnpm -C push-proxy install --frozen-lockfile --ignore-scripts`, then
`pnpm -C push-proxy test` for the loopback HTTP/2 APNs stub and proxy checks.
`pnpm -C bridge test` covers decisions, storage, observer lifecycle and crypto.
`node tools/push-integration/run.mjs` verifies connected suppression, offline
approval delivery, signature/decryption and cleanup against isolated real DSH
with a fake proxy. Run it separately from the other native harnesses. This does
not contact APNs or establish real-device delivery. Mainland China is excluded
from v1. iOS registration and NSE wiring remain Claude's follow-up work.

## Host controls, discovery and local package installation

The DSHM settings section offers a five-minute QR/countdown, connected status,
last-seen device list, and per-device revoke with an inline confirmation. It
uses DSH's authenticated owner routes and Host/Origin fence. The separate DMP
listener still serves only handshake traffic before authentication.

The optional **Set up remote access** panel probes the official local Tailscale
CLI with a four-second/256-KiB bound and a five-second coalesced cache. Only the
sanitized state and validated local VPN addresses leave the adapter. The native
owner routes `remoteSetup` (GET), `openTailscale` (POST) and `pairRemote` (POST)
have the same admission fence as the existing card. Both POSTs accept only `{}`.
No Tailscale account or network configuration is changed by these controls.
See ADR-010 for platform paths and the trust boundary.

Focused checks: `pnpm -C bridge build && node --test bridge/test/tailscale.test.mjs bridge/src/projection/host.test.mjs`.
For native UI verification, audit/pack first, then run
`node tools/bridge-integration/run-host-ux.mjs --package=.dsh-test/integration/dsh-plugin-dshm-0.1.0.tgz`.
The carrier uses an ephemeral bridge port, so an existing desktop listener is
left alone. Use `verifyOwnerRouteProbe()` and `verifyCli()` from
`tools/bridge-integration/cli-check.mjs` while the carrier is active; keep native
test runs sequential. Do not print the temporary launch URL or QR material.
Stop with `touch .dsh-test/integration/host-ux.stop` and wait for the child to join.
Task 024 records the native Windows/fresh-install/phone acceptance still required.

Bonjour advertises `_dshm._tcp` with exactly `host=<hostId>` and `v=1` in TXT.
Only bound private addresses are published; network refresh and shutdown withdraw
old records. `multicast-dns` uses UDP directly and does not require Apple Bonjour
on Windows. macOS guidance appears on the card, including the terminal permission
when running `dsh web`. Windows guidance asks for Private-network firewall access
and keeps Public networks disabled. No code changes OS permissions or firewall
rules. First certificate creation requires `openssl` on PATH on every platform.

Build and pack from `bridge/` (never publish as part of this task):

```sh
cd bridge
npm pack --pack-destination ../.dsh-test/integration
```

With an explicit isolated `DSH_HOME`, use DSH's plugin manager to install the
absolute tarball path into both `web` and `dshm` profiles. Do not use the real
Desktop profile without owner approval. For example, from the repository root:

```sh
export DSH_HOME="$PWD/.dsh-test"
DSH_CLI="/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh"
"$DSH_CLI" plugin --profile web add "$PWD/.dsh-test/integration/dsh-plugin-dshm-0.1.0.tgz" --ignore-scripts
"$DSH_CLI" plugin --profile dshm add "$PWD/.dsh-test/integration/dsh-plugin-dshm-0.1.0.tgz" --ignore-scripts
"$DSH_CLI" dshm status
"$DSH_CLI" dshm pair
"$DSH_CLI" dshm devices
"$DSH_CLI" dshm revoke DEVICE_ID
```

Keep the Web host running while using these CLI commands. A private Unix socket
(or Windows named pipe) connects CLI to the live host; its random token stays in
`$DSH_HOME/dshm/control.json`, never in argv or CLI output. The CLI prints a QR
only for `pair`; status and devices expose public metadata. Missing hosts and
invalid commands exit nonzero. The package includes the shared contract runtime,
exact schemas and generated declarations, so installation needs no sibling
protocol checkout. Dependencies remain pinned in the lockfile.

`pnpm -C bridge test:host` starts a bounded interactive isolated host for the
settings card and Simulator proof. `pnpm -C bridge test:discovery` checks native
macOS browse/resolve/withdrawal. See `tools/bridge-integration/README.md` for the
private launch handoff, CLI checks and Simulator procedure. Task 007 records the
precise Windows checklist; task 011 records the completed, separately authorized
Desktop verification and restoration.
