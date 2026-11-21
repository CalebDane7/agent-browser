# Agent Browser Failure Boundaries

> Receipts, reviews and proofs named in this file are local evidence on the
> maintainer's machine and are not published. Quoted SHA-256 values identify
> them; profile names are generalized to "default profile" and "second profile".

Read this before a change can affect live browser ownership, installation,
Chrome/profile state, broker lifecycle, task targets, focus, approval dialogs,
browser extensions, MetaMask, or publication.

These entries are evidence-backed failure boundaries, not a frozen architecture
or a substitute for current source/runtime evidence. Revalidate versioned APIs,
process layout, profile topology, and current implementation before applying a
past mechanism. Preserve the observable protection and old red; replace the
mechanism when a stronger supported whole closes them better.

Reading this reference grants no authority to launch/reload/focus Chrome,
enroll or reload an extension, cancel/approve a dialog, or inspect/mutate any
profile, credential, wallet, USB, or hardware-wallet state. Each live action
must trace to the current human-authorized result.

## Live Topology And Broker Ownership

- Revalidate roles instead of collapsing them into one “browser owner.” In the
  September 6 private route, the installed wrapper is the supported CLI entry
  and capability validator; its supervisor/broker multiplexes sessions; each
  profile-local MV3 extension owns Chrome tabs; and the pinned engine consumes
  one page-scoped capability. Route through the current proven successor after
  any later cutover. Never launch Chrome or a broker from a candidate, connect a
  raw CDP client, choose a fixed port, or use a copied, temporary, alternate, or
  automation profile as an unproved bypass.
- Preserve the user's one actual Windows Stable Chrome and, until a proven
  cutover, reuse the currently authorized live transport instead of creating
  duplicate browsers or approval prompts. The September 6 route used one shared
  broker generation at a time and profile-local extension connections; those
  are current lifecycle facts, not requirements on a successor architecture.
  A successor may replace them only after proving equivalent profile integrity,
  independent task-owned tabs across agents, reconnect, and exact cleanup.
  A live PID, listening port, or plausible command is not sufficient ownership
  evidence for either topology.
- Never retire a working approved broker merely to test a replacement. First
  prove the replacement mechanism in isolation, make rollback/reapply ready,
  and map the exact live cutover proof. At cutover, serialize the runtime and
  revalidate every affected owner, source/command/process binding, browser and
  transport generations, and client leases immediately before any retirement.
  Ambiguous ownership, an active lease, or an unproved replacement vetoes it.
- Do not silently adopt a stale generation after Chrome, WSL, broker, extension,
  engine, or transport turnover. Recover only through the current owner's
  uniquely bound recovery contract.
- Separate a serving broker from a process draining its old connections. In the
  September 6 observation, an old broker PID could remain for roughly 30 seconds
  after its listening sockets closed. The installed `stop()` begins WebSocket
  close and removes its public endpoints without forcing immediate process exit.
  Bind the old and new socket/process generations and exact task state before
  judging turnover. A lingering PID alone proves neither a duplicate serving
  owner nor failed task-tab cleanup. An endpoint serving under retired authority
  or a task left behind by a failed close is still a red. Once that broker's
  public authority is revoked, the installed supervisor permits a successor
  when its old lock/receipt are absent; old PID exit is not a prerequisite.
  This does not authorize retiring a broker that still serves another user's
  active session. Release that owner's exact lease or obtain exact authority
  before a conflicting cutover. Neither the observed drain duration nor process
  overlap grants permission to kill unrelated processes.

## Targets And Focus

- Candidate and release proof use extension-provisioned task-owned inactive
  targets. A user's existing tab may be claimed only when the user explicitly
  asks for help in that currently selected tab and the current route performs
  its one-shot exact focus proof; it is never a discovery/fallback mechanism.
- The former broker omitted `focus.snapshot` before `tab.claim-active`, so its
  initial user-tab claim could not satisfy the worker's one-shot proof. The
  September 6 installed repair serializes only each profile's snapshot/claim
  pair, including fresh proof after an allocation retry; ordinary page commands
  stay independent. Literal claim, minimized interaction, and detach proved
  that the exact original tab survived. Preserve that separate boundary; normal
  owned-tab proof cannot establish user-tab safety or initial focus authority.
- Agent-initiated inspection, navigation, screenshots, extension work, and
  recovery stay inactive. Website-triggered popups may bring Chrome forward;
  the user accepts that limitation, not agent-driven activation or orphaned
  task popups. Ordinary task tabs must still stay in the background. The
  installed route now exposes narrow explicit `foreground --input-boundary`
  for genuine user input on the exact retained task. R82 proved actual target
  activation; installation retains that owner function in worker `82a32` with
  its matching wrapper/broker. A September 8 installed journey separately proved
  one cooperative return to the exact prior app after the input boundary. A
  later persistent-observer journey separately proved tab away/back cancellation.
  The reloaded second-profile worker subsequently proved previous-tab return and
  cancellation after independent task-window minimization, without transient
  return. These are scoped guarantees, not every Windows condition or a
  force-focus lease or architecture lock. Preserve the exact task
  session while awaiting input, and never restore stale focus over a subsequent
  user choice.
- Close only extension-created task targets whose work has finished. Preserve
  an exact tab still being used with the user or awaiting user-only input, with
  its account/session and owner retained. A claimed user tab is detach-only.
  Never select by title, window order, mutable index, keyboard, mouse, or visual
  proximity.
- If the user changes focus during an operation or proof, preserve that new
  choice. Do not restore a stale baseline over the user's action to manufacture
  foreground equality. Attribute the event from the available evidence and
  reacquire any proof or authority whose exact focus precondition changed.

## Open And Extension Actions

- Wrapper `open` rejects `chrome-extension://` and other browser-internal URLs.
  Extension UI work requires a supported current-owner action bound to the
  exact extension origin, profile, target, browser generation, and transport
  generation. If no such action exists, stop; raw CDP or direct navigation is
  not an equivalent workaround.
- After a failed `open`, preserve its compact error and run only the smallest
  cause-separating observation. Do not repeat the same open without a material
  observed or current-sourced evidence delta. Use a diagnostic only when the
  bound owner exposes it for the implicated boundary; `browser-runtime doctor`
  belongs to the retired controller path, not the private wrapper.

## Chrome Approval Dialogs

- An approval dialog's title, warning text, or `Allow` label does not identify
  its requester. Duplicate, pre-existing, or ambiguous dialogs are
  non-actionable by default: never guess, focus, click, cancel, or approve one
  from its labels, position, or visual proximity.
- Exactly one separately authorized, bounded recovery may cancel requester-free
  orphan dialogs. Before the recovery and immediately before each invocation,
  revalidate every remaining selected dialog as Stable Chrome's exact approval
  UI and pin the exact Chrome PID plus each HWND/runtime identity; prove the
  originating broker/requester dead and prove that no owner receipt, producer
  contract, active requester, or live request socket exists; revalidate the
  selected profile, browser generation, and route unchanged. Capture the exact
  prior focus and restore it even on partial failure unless the user has since
  changed focus; preserve that new choice. Prove those exact dialogs absent
  without touching unrelated UI. If any guard is missing or changes, perform
  no cancellation.
- For a live requester, invoke `Allow` only after the human explicitly consents
  to that exact live request and through a supported owner action that proves
  exactly one current modal and binds its Chrome
  process, window/runtime identity, request socket, browser/consent/transport
  generations, baseline, and expected controls immediately before invocation.
  If any identity or count changes, perform no click. Requester identity proof
  never substitutes for human consent.
- Reuse of the current approved broker should not create another approval
  request. Treat a new prompt during supposed reuse as a causal red, not a
  nuisance to dismiss.
- Native-messaging origin and parent-process identity do not identify a Chrome
  profile, and peer arrival order is untrusted. An unknown profile may bind only
  through the exact live enrollment challenge plus a user gesture in the
  intended profile.
- Toolbar activation or an enabled extension row does not prove the MV3 worker
  received `action.onClicked`. Judge enrollment from secret-free stage/action
  receipts and the resulting exact ready peer, never from visible UI alone.

## MetaMask And Protected Extension State

- Agent Browser transport work never authorizes reading, validating, copying,
  rebuilding, or writing MetaMask, wallet, credential, cookie, token, USB, or
  hardware-wallet state. Presence, absence, or a transport symptom does not make
  that state part of the repair.
- Only a separately explicit wallet/state result may open that boundary. Route
  it through the current wallet/browser-state recovery guidance, bind the exact
  Stable profile and installed extension version, and limit evidence to
  non-secret observables that cannot reconstruct private material. Never print,
  export, persist, or echo a vault, password, seed phrase, private key, cookie,
  token, or recovery secret.
- A separately authorized state write still requires its own exact preimage,
  rollback consumer, version-current storage contract, cold-lifecycle proof,
  literal unlock/account surface, and protection of unrelated extension state.
  A transport repair or successful write supplies none of that authority or
  proof.

## Integration And Publication

- Local repair records (receipts, logs, profile evidence) stay private to the
  maintainer's machine. Publish the runtime, the portable operator skill and
  this guide's lessons, not local evidence. Public setup instructions must
  stand on shipped source and setup documentation. Keep the local operator's
  private account mapping separate from the distributable operator payload.
- Preserve exact source preimages/hashes and unrelated dirty bytes. Work in an
  isolated candidate; do not edit installed/live files in place.
- Before install or publication, inspect the staged diff and affected
  dependencies, exclude secrets and transient IDs, and run every mapped release
  veto. Bind source to installed bytes/process and exercise rollback/reapply
  when installation or runtime ownership changed; do not impose those live
  proofs on an isolated documentation-only change.
- A normal GitHub push requires explicit repository/publication authority and
  every mapped proof for the affected surfaces. `npm publish`, package/release/tag creation, force-push,
  history rewrite, or unrelated cleanup always requires separately exact
  authority. Keep incomplete live proof as `NEEDS_PROOF`.

## Proven Loop Breakers From The Existing-Profile Repair

These are accepted failure boundaries. Do not replay them or semantic
equivalents without new observed/current-sourced evidence that changes the next
real action.

### Private Transport Close And Profile Turnover

- In the September 6, 2026 private-transport lineage, the observed last-window
  close red was an acknowledgment-ordering race:
  removing the final owned window could destroy Chrome's native-messaging port
  before `session.close` returned, leaving the broker ledger at `sessions=1`.
  One proven repair retired and persisted task tabs before acknowledging close,
  deleted endpoint/session state before final window cleanup, and guarded
  deliberate debugger detach against synchronous `onDetach` re-entry. Future
  designs need not retain that mechanism. They must preserve the acknowledged
  close/zero-ledger result; replay synchronous detach and native-port loss when
  those edges still exist in the selected topology.
- An unpacked extension and its service worker are profile-local. Changing the
  worker file does not prove a running profile loaded it, and loading/enabling it
  in one profile does not load it in the others. Reload only each exact enrolled
  profile that needs the new bytes, then bind its new native-host connection and
  broker hello. Do not infer reload from the disk hash or an enabled toggle.
- Enrollment and approval are different facts. An enrolled profile with its
  extension enabled may reconnect automatically to the same authorized local
  transport after ordinary broker or last-window turnover; prove that with one
  offline-profile open, not with another approval click. A fresh approval prompt
  during intended reuse is a red.
- Do not keep one idle Chrome window per profile as a transport primitive. Task
  windows are created on demand and may contain several sessions. The installed
  extension removes an owned window only after all its task records are gone
  and only its own sentinel remains. User/foreign tabs veto whole-window removal.
  An idle profile may disconnect and use the bounded supported bootstrap on its
  next command. Preserve that shared-window lifetime and avoid permanent idle
  tab/window growth.
- Extension-persisted ownership can outlive broker memory. After peer/broker
  turnover, rebind only the exact retained same-session root and descendants.
  Recover capacity only from exact extension inventory: close extension-created
  task tabs, but merely detach a user-claimed current tab.
- Chrome accepts the bare profile directory `Profile` as well as `Default` and
  numbered `Profile N` directories. All producers and consumers of a versioned
  `profileDirectory` field must agree on the same value set. The September 6
  installed provider failure-envelope validator now accepts bare `Profile`.
  Its former exclusion misclassified an already-failed `PROFILE_OFFLINE`
  response; it did not explain a successful launch. Preserve that distinct
  error-reporting boundary when changing the validator: a successful bare-`Profile`
  journey does not exercise a malformed failure envelope.

### September 6 Installed Mechanisms And Proof Limits

Installed background browsing, independent sessions, same-document reconnect,
and exact task cleanup have scoped literal proof. Preserve that evidence;
one-agent current-tab claim, minimized interaction, and detach have separate
literal proof. They do not prove invited multi-agent sharing or foreground
handoff/return; packaging remains a separate release boundary.
The mechanisms below describe this installed revision, not mandatory designs.

- One profile-local extension can debug multiple tabs; sharing an extension or
  profile does not require serializing independent page work. A former
  profile-global queue let one stalled Chrome promise block unrelated tasks.
  The installed worker uses `session:<id>` queues for page commands, tab close,
  and rebind, a separate `teardown:<id>` queue for exact session close, and a
  shared control queue. Teardown has bounded admission capacity even when page
  requests fill ordinary capacity. Preserve independent page progress, exact
  ownership ordering, and reachable teardown; the queue names and design may
  change if those observable guarantees remain supported.
- A timed-out broker request ID cannot simply become unknown. The installed
  broker recognizes exact peer-scoped timeout records for 60 seconds and retains
  at most 128; known late replies are consumed and may invoke exact launch cleanup.
  Actually unknown replies still reject the peer. These are current bounds,
  not required constants. The failure boundary is a known late reply breaking
  an unrelated live session, an old epoch gaining new authority, or unbounded
  timeout history.
- The former provider 5-second timeout could abandon a launch while its broker
  still had a 15-second budget. Installed source now gives the provider 20
  seconds around the broker's 15-second absolute launch budget, carries the
  deadline into extension requests, and retires exact launches that complete
  after expiry. The broker also reconciles known late results. Source presence
  alone does not prove every delayed-completion race. If that contract changes,
  the decisive boundary is caller failure followed by a late root, endpoint, or
  session: the exact owned residue must be retired while neighboring tasks
  survive.
- Tab revocation is role-sensitive. Revocation of the exact root must retire
  that session, endpoint, cleanup authority, and active WebSocket; revocation of
  a descendant removes only that exact handle. A global handle deletion or the
  descendant-only path applied to a root is not cleanup proof.
- The pinned donor's prelaunch could issue `Page.enable` before its close hook,
  hiding failed cleanup. The installed wrapper now sends the broker an exact
  one-use retirement grant before invoking donor close without its provider.
  Retirement inventories/rebinds only the named session, including when the
  donor daemon is gone. Preserve the production CLI close boundary; a direct
  cleanup-hook invocation does not exercise it. `Browser closed` may appear
  before the command process exits: await exit and judge exact task/ledger
  retirement separately from background window cleanup or broker draining.
- `chrome.debugger.onDetach` and `tabs.onRemoved` can race for the same tab.
  Cleanup must be idempotent for the exact session/tab regardless of which event
  arrives first; the second event must not repeat retirement or affect another
  task surface.
- Every native `Port` reconnect is a new connection epoch even for the same
  enrolled profile. Pending requests, replies, events, and attachment ownership
  must remain bound to their issuing epoch; reconnect must explicitly rebind
  exact retained state rather than silently inheriting prior-epoch authority.
  Use non-secret page identity/state evidence when continuation is required;
  URL equality alone cannot distinguish a retained document from a new page
  created at the same address.

### Chrome Window Automation Without Focus Theft

- Win32 show-state values are behavioral contracts, not cosmetic flags.
  `SW_SHOWMINIMIZED` (`2`) activates the window; for a minimized no-activation
  operation the observed correct primitive was `SW_SHOWMINNOACTIVE` (`7`).
  Verify the current platform contract and exact foreground HWND before/after;
  never accept a visually brief popup as background proof.
- A UI Automation control advertising a pattern does not prove the action will
  succeed. Chrome's toolbar Extensions control advertised `Expand` but returned
  `E_FAIL` at the live boundary. After that exact red, do not repeat UIA Expand.
  A bound MSAA `accDoDefaultAction` may be used only when the exact Chrome window
  and exact control expose the expected role/action and foreground is preserved.
  This is a narrow recovery technique, not a general preference for UI driving.
- An unfocused Chrome window may elide `https://` in its UIA address value and
  expose no UIA `Document`. In the September 6 proof, those observations failed
  helper preconditions without proving navigation or page failure. Bind the
  exact window, helper assumptions, and page URL through an available scoped
  owner; do not infer document absence from an incomplete accessibility tree or
  change browser behavior to satisfy the helper. Scheme elision is not
  permission to accept another origin. A focus-dependent helper may run only
  when that focus is independently authorized.
- Windows rejected a plain `SetForegroundWindow` restoration even for the
  previously foreground window. A September 8 installed journey instead proved
  cooperative Chrome demotion in 65 ms: the extension requested
  `windows.update({focused:false})` only while the next visible HWND still
  matched the saved prior app, and the native owner observed exact identities
  and latched the away/back lifecycle. Preserve that identity and user-choice
  contract, not this mechanism. A separate persistent Windows observer then
  proved tab-selection cancellation: native Chrome foreground stayed fixed while
  UIA selected owned tab B then A; `background` returned `no-handoff` in 37 ms
  without changing the actual Chrome HWND/PID/tab, and both owned tabs and the
  observer were retired. That earlier journey did not establish other-app
  interference or wider lifecycle reliability; a longer delay is not a fix. Do not
  substitute `AttachThreadInput`, topmost toggles, fake input, or another forced
  activation technique without new evidence and authority. Receipt:
  persistent-observer cancellation,
  SHA-256 `4897c99a49d311edc1753f0a41bde666fb63661ecb8b809329f9b838db101f88`.

- The September 8 reloaded-worker journey subsequently closed previous-tab
  B→A→B return and independent owned-window-minimization cancellation, including
  continuous HWND observations, no transient return, and physical tab cleanup:
  conditional-return proof.
  Acquisition refusal (`FOREGROUND_NOT_CONFIRMED` or activation-settle timeout)
  is not an incorrect return: no handoff was armed in those earlier failures.
  Preserve conservative refusal; do not promise Windows always allows activation
  or claim a later green proves the refusal's cause was repaired.
- An offline broker profile still executed old extension code after its next
  open. Native-peer reconnection did not reload the worker source. An explicit,
  authorized extension reload preceded the later proof. Retain separate disk,
  loaded-worker and native-peer bindings; a missing connection is not a reload.

### CLI And Contract Binding

- A command string in an allowlist is not CLI support. Prove parser choice,
  argument binding, dispatch branch, current owner function, output schema, wrapper
  validator, and installed launcher together. The production parser/dispatch
  path—not a direct function call—is the falsifier.
- In the historical controller/CDP lineage, treat receipt schema, claim-envelope
  schema, target kind, anchor/root identity,
  marker syntax, metadata schema, and capability policy as one versioned
  contract across controller, wrapper, broker, and engine. The observed red was
  a wrapper/controller `target-lease.v2` task root reaching an installed engine
  that still accepted only `target-lease.v1`/`agent-workspace`; controller-only
  tests could never prove that handoff.
- In the private-CWS/v0.36 lineage, preserve its `directPage` capability and
  satisfy the donor's liveness probe with a page-scoped check; never widen the
  grant to `Browser.*` or `Target.*`. Consume one-use launch authority before any
  downstream native or broker contact.
- When tracked `dist` is the declared runtime authority, changing engine bytes
  also changes the canonical file hash, manifest hash, graph fingerprint, and
  wrapper pins. Install/rollback that set as one transaction and run an exact
  one-use receipt-claim fixture plus the literal command. A stale manifest or a
  stale engine test fixture is a red, not an excuse to weaken validation.
- A locally patched donor pin is not reproducible merely because its upstream
  release can be downloaded. The acquisition verifier, patch identity, expected
  size/hash, and runtime pin must agree on the selected artifact. An earlier
  September 6 candidate audit found acquisition expecting the official v0.36
  binary while the runtime pin selected a local build. Rebind the current
  acquisition/build path before reproducibility or publication claims; a
  successful installed browser journey does not resolve that packaging
  boundary.
- Transitional durable metadata created by an accepted prior schema must be
  recognized exactly. Do not reject it with a guessed current-only field set,
  and do not widen acceptance to arbitrary shapes.

### Production Proof And Diagnostics

- In the historical controller/CDP lineage, a fake adapter can silently provide
  a hook the production broker deliberately
  does not expose. The observed fake-only green hid an unimplemented active-tab
  primitive. Background proof for this architecture is the exact same-profile
  `tabActive` set plus the Win32 foreground HWND before/after; never add an
  unscoped active-target hook merely to satisfy a test.
- Exercise the production adapter/hook at least once for every changed boundary.
  A fake-only pass cannot prove broker policy, credential scope, Windows/WSL
  transport, native engine claim, or installed launcher binding.
- A nonzero downstream owner may place its canonical bounded failure on stderr.
  Capture that exact line once before changing code. A wrapper's generic relay
  error is classification, not root-cause evidence.
- Do not feed a raw authorization file to `curl --config`; that malformed probe
  is inconclusive. If a local HTTP discriminator is necessary, reproduce the
  exact header syntax/credential scope used by the owner without printing the
  credential.
- Map test dependencies exactly. In one historical harness, `Cannot find package
  ws` from an isolated cwd was a harness-dependency red, not evidence against
  broker behavior. Rediscover current dependencies instead of freezing that
  `node_modules` layout.

### Historical Controller/CDP Broker Capability Lifecycle

- Broker CDP and broker health credentials are intentionally different scopes.
  A task `Bearer` credential sent to `/healthz` must return 401; only the
  controller health credential may probe health. The wrapper relies on the
  controller's fresh authenticated transport attestation and exact task CDP
  authorization instead of cross-using credentials.
- Mint and revoke must use one canonical capability builder, including
  `rootDisposition`, target IDs, context, opener-tree policy, generation, and
  exact root. Hand-built near-duplicates caused release policy divergence.
- Revoking a task capability can make direct `Target.getTargetInfo` on that root
  correctly policy-denied. Before revocation, take one bounded controller
  inventory and validate the exact root/marker/context plus descendant opener
  tree; after revocation, use the scoped cleanup capability and bounded
  controller inventory for absence. Never interpret policy denial itself as
  target absence.
- Apply that same revoked-root cleanup contract to both pending/interrupted task
  release and registered-session close. The observed regression fixed pending
  release while registered close retained the old direct lookup and failed only
  after a real successful session.

### Historical Controller/Engine Task Roots And Recovery

- In the audited controller/engine lineage, a controller-created task root uses a private
  `about:blank#agent-browser-task-<marker>` URL. Its consumer must have an exact
  workspace-task branch bound to the anchor, task lease, creation journal,
  target/tab/window/context, receipt, provenance, broker capability, and marker.
  A generic HTTP(S) allowlist was not equivalent and rejected the valid root.
  A later lineage may use another root contract, but it must preserve equivalent
  ownership/provenance and replay the same rejection boundary.
- In a topology using Chrome target close, treat it as asynchronous. After the
  exact scoped close request,
  perform bounded absence confirmation. If Chrome closed the root but the
  controller was interrupted before retiring state, one later exact-owned
  cleanup must prove absence and retire the same lease/journal idempotently.
- In that audited lineage, a stale browser-generation anchor is recovered only
  through its supported same-marker reprovision action once, with exact
  account/profile/context and focus/inventory preservation. A future owner may
  expose another recovery contract, but it must prove those same observables.
  Do not retry open, adopt a user tab, start another Chrome, or bypass through
  raw/fixed-port CDP.
- A command is not green when native output appears. Wait for wrapper exit and
  verify reconciliation/registration on open, and exact state retirement plus
  anchor/broker preservation on close. This repair exposed policy failure after
  `Browser closed` had already printed.

### Focus And Windows/WSL Observation

- `GetForegroundWindow()` may validly return HWND zero, while WSL/PowerShell
  interop can fail before reaching user32. Do not collapse both into zero. Use a
  distinct failure sentinel, retry the exact read at most once only after an
  observed transient interop failure, and retain exact before/after equality.
- Never turn a transient focus-observation failure into guessed focus or a
  relaxed no-focus rule. Preserve the existing `tabActive` and HWND proof and
  return a compact failure if the second observation is still unproven.
- Do not restart or kill a shared Windows/WSL relay merely because a bounded
  interop checker reports a transient warning when direct current probes remain
  usable. Change the relay only with exact ownership and causal evidence.
- Under `RemoteSigned`, dot-sourcing the reviewed observer from its WSL UNC path
  was rejected because the script was unsigned. Keep policy unchanged: pass the
  reviewed source through the bound runner's stdin when that owner contract
  supports it. Build transformed scripts with callback replacement rather than
  replacement-string `$` semantics, and run a PowerShell parse-only check before
  execution. That parse green proves only delivery syntax. The later persistent
  observer removed per-sample PowerShell launches and closed the exact tab
  away/back cancellation boundary, but it did not establish why the earlier
  production `ACTIVATION_SETTLE_TIMEOUT` was intermittent. Keep that cause
  `UNKNOWN`; improved measurement is not proof that the old helper caused it.

### Scope And Work Economy

- For an affected runtime boundary, the first safe action after binding is its
  installed literal command or the one prerequisite whose red makes it unsafe.
  A guide-only change needs no browser action. Do not spend time on broad
  archaeology, all-session audits, donor comparisons, web research, invented
  harnesses, or full suites while that path is ready. Read only cited history
  that can change the next action.
- After a literal red, preserve its exact identity and do not rerun it until an
  observed/sourced delta changes the predicted result. A new patch, tool,
  worker, or explanation alone is not a delta.

### September 5–6 Session Lessons: Action, Reload, And Scoped Proof

- The exact session contained 78 consecutive blocked/pause replies without a
  tool call between them, followed by another 46-reply interval. Saying "not
  repeating" was itself repetition, not diagnosis. An unavailable causal error
  is not automatically an unavailable external dependency: inspect its actual
  owner stream or add bounded, non-secret instrumentation when authorized.
  If no supported action exists, report the actual prerequisite once and use
  the current continuation controls; do not consume turns narrating a pause.
- A reload was requested while the candidate was still being prepared. The
  user reloaded before installation and therefore loaded old bytes; a second
  reload was then needed. Stage and hash the exact candidate first, have the
  authorized reload scope and literal check ready, and only then ask for the
  user action. Historical helpers also carried closed HWNDs and one-time focus
  authority: prior helper success is not current permission or runnability.
- A ten-second foreground observer expired across a tool/model round trip
  before any browser command ran. Start the observer and literal task in one
  orchestration with bounded readiness, covering the actual command interval.
  This was a local proof-timing defect, not a browser failure. Do not restore
  an old foreground after a later user app switch or count that switch as
  task-caused focus theft.
- Earlier percentage and whole-feature claims outran literal evidence. Normal
  owned-tab success did not prove current-tab claim/minimized interaction or
  final-profile behavior. Those core boundaries later received their own
  proof; preserve it rather than reopening them from this historical audit.
  Report remaining acceptance explicitly. A saved rollback base is not an
  exercised rollback/reapply cycle, and a successful browser flow does not
  prove reproducible acquisition or GitHub publication.
- Broker/native-host reconnect does not prove cleanup after the owning agent
  dies. Unique session names used by cooperative workers also do not establish
  process-bound isolation when two owners supply the same name. Likewise,
  separate current-tab claims do not prove invited sharing of one tab. Bind
  each claimed guarantee to its actual owner/lifetime and literal evidence;
  do not turn a code audit or missing proof into an asserted live failure.

- September 7 owner proof now closes two distinct boundaries: a genuine native
  caller-process exit removed only its exact task while a neighboring Codex
  owner's marker/timeOrigin and physical tab survived; installed parent and
  real Codex child then used the same alias in separate tabs and closed both
  with unchanged user-tab IDs/selections and no foreground events. Launcher,
  wrapper, provider, owner module and broker were bound together; rollback and
  reapply were exercised. Preserve this scoped proof, not a frozen PID/hash.
  Child completion is not native-process death: children share a native owner
  process but have different thread namespaces. Parent-side same-alias close
  cannot clean a child's namespace, and environment PID overrides are not a
  supported transfer mechanism. Require original-worker cleanup or a separately
  proven successor handoff; do not silently broaden ownership.
- September 7 R69 proves ordinary task removal with the reload-bound `b04b076`
  worker and candidate `6612815` engine: A closed in 674 ms and B in 456 ms.
  B's document, timeOrigin, field value, physical tab, and native daemon survived
  A's close; all 14 user tabs and selections survived both closes. The full
  45-second observer recorded no foreground events, and the broker ended with
  zero sessions. Preserve this closed boundary; it does not prove popup
  adoption/removal, invited shared-tab operation, automatic input-focus return,
  screenshots, default-engine cutover, or full release. Evidence:
  R69 receipt,
  SHA-256 `75006f881eb9aec4b9c7854b79396840355e95642b276bea0d3470ec8be70240`.
- Use real physical absence to judge tab cleanup. Extension inventory alone is
  its retained bookkeeping, not independent evidence that Chrome removed the
  tab. A null Get-Process.Path/CIM field also did not mean Chrome had changed;
  limited-query native image lookup resolved the same process. Observe only
  exact Chrome windows and tab IDs/markers, never desktop-wide descendants or
  unrelated tab titles. Check an observer's declared input/time bound before
  dispatch: an out-of-range duration rejected the observer before a browser
  command, so it was a setup failure, not a new browser red.

### Popup Source Identity And Physical Cleanup

- In the September 7 Chrome 153 literal, `tabs.onCreated` reported the active
  tab as a new popup's `openerTabId`, not the owned page that opened it. A tab
  strip opener is not sufficient causal ownership evidence. The repaired
  worker uses `webNavigation.onCreatedNavigationTarget`'s exact source/target
  edge, with retained owner/epoch and post-await validation. Do not replace it
  with matching titles, URLs, timing, or the currently active tab. A successor
  mechanism must establish the same causal edge; this is not a universal API
  preference.
- R78 literally proved a task root and its source-bound popup both physically
  disappeared after ordinary `close` (473 ms), without manual cleanup. The
  task daemon exited and all 14 pre-existing tabs/selections survived. The
  accepted website-popup foreground limitation remains separate from ordinary
  no-focus behavior and never waives descendant cleanup. Receipt:
  R78,
  SHA-256 `388b5e000133c29c6bf8e0b72b2c5855725e3e86b11820ad5a825f7c38ff04d2`.
  This observation does not prove every asynchronous or nested popup variant.

### Foreground Metadata, Reloads, And Proof Preconditions

- Chrome 153 can omit `tabs.Tab.url` without tabs/activeTab/host permission;
  debugger permission alone does not make that field available. Treat missing
  metadata as unavailable, not as a forbidden URL. The R68 repair validates a
  fresh exact-owned `Page.getFrameTree` main-frame URL before activation while
  preserving ownership, deadline, busy-target and user-switch guards. A cached
  attachment check cannot substitute for this fresh navigation check. Do not
  add broader permissions merely to satisfy an optional metadata assumption.
- R82 literally proved `foreground --input-boundary recovery` selected the
  exact owned task and activated its bound Chrome window. Cleanup removed the
  task/daemon and preserved all 14 baseline tabs/selections. Receipt:
  R82,
  SHA-256 `011cb18ebf0c255495339102fcaefd719c1b2a85eb57ffa75badc4bc05ab7e5e`.
  This proves explicit candidate foreground only—not prior-app return, invited
  sharing, or availability through a still-old installed launcher.
- A bound semantic extension Reload succeeded in the background. The earlier
  helper's external `SetForegroundWindow` prerequisite was unnecessary and
  failed before Reload. Reuse exact extension/control identity and actual
  loaded-generation proof, not that rejected helper prerequisite. A later
  shared-tab proof stopped before UI because its selected profile was no longer
  connected. Its window and native host were confirmed absent while the shared
  Chrome process survived; that is not evidence of an existing-window transport
  failure. Also avoid requiring an unrelated profile's availability for a
  single-profile proof. Preconditions must track the actual fixture lifecycle.

### Screenshot Latency: Distinguish Pixels, Transport, And Capture Mode

- In the September 6 installed route, ordinary and full-page screenshots hit
  roughly 15-second deadlines while a 44 KB response on the same route took
  69 ms. That falsified a blanket slow-WSL/native-transfer explanation, not
  every possible transport fault. Do not change IPC without an implicated
  owner boundary.
- Exact Chrome 153 source distinguished surface capture waiting for redraw/
  presentation from the Viz screencast path. PNG `optimizeForSpeed` affects
  encoding after pixels arrive; it cannot repair a pre-encoding wait. A
  same-value device-metrics override did not guarantee redraw. Revalidate
  current-version contracts before choosing a mechanism, and do not add
  restart flags, foreground activation, or broader CDP grants as silent fixes.
- The installed worker's exact ordinary viewport PNG request used one fresh,
  tab-bound screencast frame with acknowledgment and bounded listener/stream
  cleanup. Three default-profile CLI captures took 358/402/376 ms. Visually checked
  changed text/backgrounds, including a second capture after another change
  in the same document, ruled out returning the previous frame. The task
  interval had no foreground transition, both task sessions closed, and the
  final broker ledger was empty. Preserve freshness, exact-tab/epoch binding,
  no-focus and cleanup—not loyalty to screencasting.
- That September 6 proof covered the exact normal PNG path only, not full-page,
  clipped, JPEG, other-profile latest-worker behavior or universal latency.
  The September 7 candidate engine later captured an ordinary viewport PNG in
  201 ms at 2562 × 1287 with a fresh visible marker/background, no foreground
  transition during the task, exact cleanup and neighboring tabs preserved.
  Compare like modes: the full-page timing below is not a viewport regression.
  Neither observation is a general latency bound or reason to repeat a retired
  screenshot boundary merely to increase a test count.
- The September 7 full-page PNG then returned fresh above/below-fold markers
  in 1067 ms, but had excess blank right/bottom extent. The donor preferred
  deprecated device-pixel `contentSize` for a CSS clip; inspect coordinate
  units and DPR at that consumer instead of retrying the capture transport.
  The CSS-metrics repair was then compiled and literally proved with the
  candidate engine: 731 ms, 2535 × 4260 pixels for a 1428 × 2400 CSS document
  at DPR 1.775, including fresh bottom content and the correct document extent.
  The raw receipt's exact RGB assertion remains preserved: it compared encoded
  PNG samples with CSS sRGB without applying the embedded ICC profile. Actual
  image inspection and color-managed samples resolved that proof defect, not
  another capture or a new exact color-calibration guarantee.
- A selector PNG returned in 710 ms with plausible dimensions while its
  requested below-viewport pixels were white. Inspect actual pixels with
  distinct fresh visible/below-fold markers; dimensions and file signatures
  cannot prove image content. The donor enabled `captureBeyondViewport` only
  for full-page mode, not selector clips. Preserve exact selector bounds when
  repairing that contract; a body-element capture is not equivalent to the
  whole document's overflow extent. A separate candidate-engine selector replay
  proved the repair in 579 ms: the 600 × 2300 CSS selector produced 1065 × 4083
  pixels, including its beyond-viewport bottom edge, with no blank/clipped tail.
  Both full-page and selector journeys preserved neighboring physical tabs and
  selections, closed their exact sessions and exited their native daemons.
  Neither journey had foreground events during its actual action interval.
  Keep complete observer coverage and retain later events separately: two
  post-cleanup events made the selector's original whole-observation zero-count
  assertion fail; they do not establish focus theft during the completed task.
- JPEG used another request branch and still timed out at roughly 15 seconds.
  Preserve requested format/quality and validate actual encoded bytes plus
  fresh pixels after the staged worker loads. A PNG green cannot close JPEG,
  and renaming an image cannot change its encoding. A later combined-candidate
  ordinary viewport JPEG at quality 80 was literally accepted in 694 ms:
  actual JPEG bytes, 2562 × 1287 dimensions and fresh visible content, with
  exact task cleanup, neighboring tabs preserved and no foreground events
  during the actions. Its separate diagnostic assertion failure did not erase
  that scoped JPEG proof or prove diagnostics correct.
- A later second-profile ordinary viewport JPEG at quality 80 passed in 589 ms on the
  separately reload-bound `aa003` worker and `6612815` candidate engine. The
  unchanged receipt SHA-256 is
  `8e99eb550ddced956d2cf7abb71ad65dcf4ffbfe65b806d5b63236fb0da48fb2`;
  the receipt
  and parent review
  establish the exact fresh visible marker and actual JPEG bytes.
  The journey preserved neighboring tabs/selections, closed
  its exact task and native daemon, and had no foreground events during the
  measured actions. This supersedes the earlier second-profile `OP_NOT_ALLOWED` capture
  status for that proved path only. It does not cover the subsequently staged
  `b04` worker, shared user-tab commands, popup no-focus behavior, foreground
  handoff/return, final installation, or publication. Preserve this separate
  profile/format proof instead of repeating it from the earlier red.
- These are distinct mode/revision proofs, not one final installed-engine or
  all-profile release proof. The earlier PNG candidate journeys did not bind
  the serving extension generation; the later combined-candidate JPEG journey
  used separately bound reload/runtime evidence. Preserve their scope and raw
  failures. Do not infer loaded code from a disk hash, or infer all screenshot
  modes, final installation or publication from these accepted observations.

### Relative Upload And Permission Reporting

- The September 7 combined-candidate literal attached one harmless 30-byte
  file supplied as a relative filename containing spaces. Upload took 58 ms;
  an actual file-input readback verified its name, size and text. There was no
  form submission, permission change or retry; exact cleanup and no foreground
  transition during the journey were proved. Preserve caller-cwd resolution
  through the Windows-readable path handoff: broker cwd is not caller cwd, and
  a path-conversion string alone is not proof that Windows Chrome can read it.
  This fixture does not establish arbitrary WSL, UNC or Windows-path support.
- Keep confirmed missing file access distinct from an unavailable or failed
  permission lookup. `FILE_ACCESS_REQUIRED` may report confirmed false;
  `FILE_ACCESS_UNVERIFIED` must not claim permission is disabled or ask the user
  to approve it again. Neither may attach a file. The successful literal used
  pre-existing permission; it did not exercise every failure branch. A later
  permission change requires a fresh debugger attachment, not an unchanged
  upload retry through the old attachment.

### Diagnostic Delivery And Console-Clear Isolation

- Real page console buffers need not contain only fixture messages. A captured
  diagnostic run contained the exact generated marker plus DOM-health messages;
  their actual producer was not established. Its `3 != 1` total-count assertion
  was not an ownership verdict. The earlier `6 != 1` run did not retain those
  six entries, so they remain unclassified; do not retroactively assign them
  the later messages' source. Capture bounded raw buffers before assertions,
  require each unique generated marker exactly once, reject cross-owner markers
  and duplicates, and retain unrelated entries rather than filtering product
  output to make a test pass.
- A separate literal proved generated console/error delivery for two owned
  tabs and `console --clear` isolation: clearing A removed A's generated log,
  preserved B's log and preserved both tabs' generated errors. Exact task
  cleanup, neighboring physical tabs/selections and no foreground events during
  the actions were proved; later observer events remain recorded. This closes
  console clear only. A subsequent compiled-candidate literal separately proved
  `errors --clear` in 50 ms: A's error buffer emptied while B's complete error
  buffer and both complete console buffers stayed unchanged. Both exact task
  tabs closed, all 14 pre-existing tabs and selections survived, and no
  foreground transition occurred during the actions. Preserve that distinct
  clear-error boundary rather than rebuilding or rerunning it from this history.
  Neither diagnostic proof establishes invited user-tab sharing, foreground
  handoff/return, final installation, or publication.

### Loaded Pages, Reloads, And Interrupted Invitations

- A requested URL in Chrome's address bar is not evidence of a committed
  document. On September 7, an initial current-tab claim returned
  `TARGET_DENIED_CLAIM_VALIDATE_URL_EMPTY`. Chromium 153's
  [frame serializer](https://raw.githubusercontent.com/chromium/chromium/153.0.8010.27/third_party/blink/renderer/core/inspector/inspector_page_agent.cc)
  deliberately emits an empty URL when its document loader is absent.
  Waiting for the exact nonce fixture's rendered document and tab title changed
  that literal result: the claim returned the correct URL in 163 ms, detach
  preserved the tab, and cleanup/no-focus checks passed without a production
  change. The receipt
  has SHA-256 `ab76781b83c71dce8233b6f1f34286cd796487bdef4baaeff0b7cf547d33e18c`.
  Preserve real document-readiness evidence in setup; do not weaken restricted
  target checks, turn every empty URL into an allowed page, or substitute sleeps.
- Headed Windows Chrome 153 intentionally filters `chrome://extensions` from
  the [command-line launch path](https://raw.githubusercontent.com/chromium/chromium/153.0.8010.27/chrome/browser/ui/startup/url_util.cc).
  More quoting, waiting or startup flags do not fix that contract. For an
  authorized reload of this extension, its own extension page can invoke the
  documented [runtime.reload](https://developer.chrome.com/docs/extensions/reference/api/runtime#method-reload)
  API. A scoped literal verified the exact second profile before invocation,
  peer disconnect/reconnect and native-host replacement, with the default profile unchanged.
  An earlier missing profile badge was not permission to guess the profile;
  retain the bounded observed control evidence before rejecting setup.
- Reload invalidated that helper page: its created browser-tab runtime identity
  survived but its content became New Tab with an empty address. Cleanup tied
  only to the old document URL therefore failed. Preserve the exact created
  browser-tab identity across the authorized lifecycle change; never clean up
  arbitrary blank tabs by title. The exact helper tab and temporary files were
  subsequently removed. This recovery is not ordinary browsing permission to
  reload extensions or touch their stored state.
- A subsequent two-owner invitation stopped before sharing with
  `NO_FOCUSED_USER_TAB`; the foreground trace showed Chrome switched to the
  terminal during the first claim. The actor was not established. Keep that
  interrupted proof separate from the completed single-claim result. Do not
  force focus, relax invitation ownership, diagnose a Chrome defect from the
  interruption, or claim two-owner sharing has been proved.
- The foreground observer used for that invitation recorded the newly focused
  window's PID, not the process that caused activation; it recorded no input
  activity despite its filename. Inspect the observer's fields before assigning
  blame. Its callback UTC is receipt time, while Win32's
  [event timestamp](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nc-winuser-wineventproc)
  describes event generation. A next handoff-only discriminator can compare
  focus and session-local input timing without attempting another claim.
  [GetLastInputInfo](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-getlastinputinfo)
  is session-local and also reflects injected input; a changed timestamp alone
  does not prove the human switched apps. Preserve the initial focused-tab
  requirement rather than weakening it to pass an interrupted setup.
- R109 subsequently proved two genuinely distinct parent/child owner namespaces
  using the same alias to claim one rendered, explicitly invited nonce tab on
  candidate engine `6612815` and worker `82a32`. Overlapping eval requests
  serialized as whole native commands (`A-start`, `A-end`, `B-start`, `B-end`).
  The first detach preserved the other participant's daemon, document timeOrigin
  and input value; the last detach still left the user-tab fixture intact.
  Exact fixture/setup cleanup then removed only the generated tabs, retired all
  three task daemons and their PID/socket files, and preserved baseline physical
  tab IDs/selections. Ordinary-action foreground events were zero. The
  R109 receipt
  has SHA-256 `a85a032e7b37a13d0bf8e32b9265589451b16615f0c3f9009e7de2b735237a73`.
  This closes the separate two-owner sharing boundary; retain its proof rather
  than retrying the earlier interrupted invitation. It neither identifies that
  interruption's actor nor proves automatic prior-app return or full release.
- The later installed CLI proof exercised engine `6612815`, then rollback and
  reapply through the ordinary launcher. The final replay opened in 562 ms,
  read in 60-65 ms and closed in 482 ms, with exact cleanup and existing physical
  tabs protected. Receipts: first installation
  (`10517a05011e499f175a14b016e4bf1776c85e247f148c49bb7175511fe3e447`),
  rollback
  (`617d88c186a717aa3c3d17e74b8122fdb8d071bb36ed0347fd84bb7c031eee49`),
  and final reapply
  (`c97287bd77985e38d36e6405b13c42229dc38d93528c86ddcf89f2c1bfbf6f3a`).
  Busy-cutover refusals when new agents opened tasks were honored: reapply
  waited for natural daemon exit and rechecked admission, killed no owners and
  restarted neither Chrome nor WSL. This closes installed delivery/rollback
  for the exercised route, not automatic prior-app return or full release.

### Engine Shutdown Is Not Task-Preserving Reconnection

- The September 7 source audit traced pinned v0.36 graceful daemon shutdown
  through `close_all_browser_backends`, provider cleanup, the plugin's `close`
  request and the broker's exact `session.close`. The extension then removes
  extension-created task tabs; invited user tabs detach instead. Restarting
  that engine is therefore not evidence that an active task's document, form
  values or timeOrigin will survive. This is a source-established consequence,
  not a newly executed cutover or permission to discard another task.
- Abrupt WebSocket loss is not equivalent: the audited broker clears the
  connection but retains the session. Its owner reaper watches the native
  agent's lifetime, not just the browser daemon's. Killing the daemon cannot
  be assumed to release capacity while that agent remains alive. Choose the
  current supported lifecycle path that matches the authorized preservation
  result; do not substitute an abrupt disconnect or escalate signals.
- The donor suppresses provider-cleanup errors during shutdown. Daemon exit
  alone therefore does not prove task/ledger retirement. Judge the exact
  affected records and physical tabs, with neighboring owners preserved.
  Reuse existing approval when it covers the actual effect; distinguish a
  task-preserving reconnect from ending a task before requesting new authority.

### Primary Command Errors And Physical Tab Cleanup

- A September 13 supported `open` reached the page command, where Windows
  resolved the requested local-preview host to localhost and HTTPS connection
  on that host was refused. The native private-CWS `command.end` then replaced
  that primary navigation error with a bare `TAB_NOT_OWNED`. Preserve the
  command's primary result through ownership reconciliation and cleanup. A site,
  DNS, or local-preview failure belongs to that website or app owner; it is not
  evidence of a browser transport failure. If an action succeeded, never repeat
  it merely to recover output or cleanup evidence. Retain both the primary
  command error and a distinct cleanup error when both affect the verdict.
- The old extension path for a Chrome error-page navigation removed opaque
  ownership state without physically deleting its extension-created tab.
  A later close returned green while that exact owned tab remained. Candidate
  guards distinguish lifecycle by origin: delete extension-created task tabs;
  revoke every invited participant and detach the shared user tab; and on
  failed deletion retain exact retry authority through synchronous detach.
  Logical ledger removal and a green close are incomplete until the exact
  physical tab and neighboring owners match the contract.
- Automate accessible site and ownership checks. Use read-only project evidence
  to diagnose an ordinary website failure, and route an ownership, cleanup,
  wrapper, or transport failure to the builder without expanding into unrelated
  app repair. Do not cycle sessions, repeat mutations, or turn routine checks
  into user chores.
- The full extension ownership test file passed 106 checks. An isolated live
  second-profile replay then opened Example Domain, tagged its exact physical
  tab, navigated to the refused host, and closed. The tab disappeared while all
  baseline selections and the other owner ledger remained unchanged. This
  proves the repaired worker on that profile. The candidate native engine also
  passed fresh and reused-session replays there with exact physical cleanup.
  The repaired engine and default-profile worker were subsequently installed during a
  human-authorized maintenance window. The normal CLI passed fresh and reused
  refused-navigation checks, retained the primary site error, and physically
  closed its own failed tabs while preserving the measured baseline. A fresh
  failure retained a separate command-cleanup warning; it did not hide the site
  error or prevent matching cleanup. Engine rollback and reapply also passed
  real open, snapshot, loaded-process binding and physical cleanup. Receipts:
  installed replay,
  rollback,
  reapply.
- Retained owners veto an extension reload unless the human has authorized
  ending their exact browser tasks for maintenance: Chrome clears extension
  `storage.session` on reload. In that approved window, admission excluded
  active commands, exact graceful daemon retirement released ownership, and
  reload waited for empty ownership. The Codex processes and saved profiles
  stayed intact. Do not describe this as preserving the retired task document,
  make manual user reload a standing step, or encode transient runtime values.
- The exact pre-repair orphan was later removed in that maintenance window.
  Selecting its already-proven native tab made its own Close button visibly
  rendered; one semantic invocation then removed only that tab. Invisible
  Invoke remains rejected. The original remaining tab selection and minimized
  state were restored. Maintenance activation is separate from ordinary
  background browser operation; no forced foreground return follows input
  intervention. Cleanup evidence.

### Bounded JSON Must Preserve What Actually Happened

- The text formatter's output limit did not bound the old engine's JSON path.
  The selected patch bounds serialized data in characters per result, retaining
  action status and continuation identifiers and reporting omitted content.
  It is not a fixed byte ceiling for the complete response. Do not advertise
  either `--json` or the text limit as such a guarantee.
- Omitted data after a successful mutation must not trigger a repeated click,
  upload or submission. Use a smaller read-only observation for missing detail.
  Validate options through the actual CLI parser and installed route; patched
  candidate output does not enable the feature in an older installed engine.

### Native-Messaging Framing And Result Size

- Chrome native messaging frames UTF-8 JSON with a 32-bit native-byte-order
  byte length. A generated host header whose four length bytes were all zero
  broke the actual Windows wire even though higher-level payload logic looked
  valid; the repaired host passed an exact framed capture/cancel check. Preserve
  binary framing and byte-count proof at the real host boundary, including
  Windows binary stdio, rather than inferring it from JSON parsing or source.
- [Chrome's native-messaging contract](https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging#native-messaging-protocol)
  limits messages to 64 MiB extension-to-host and 1 MiB host-to-extension. An
  earlier extension applied the smaller limit in the wrong direction: Chrome
  produced the full AX tree, then the extension rejected that reply before the
  native engine received or selector-filtered it. The current source uses the
  directional limits without a fixed-size allocation. One installed second-profile
  owned-tab journey with more than 1.3 MiB of AX names passed the exact scoped
  snapshot, click, and cleanup path. With explicit human permission for one
  maintenance window, the default-profile extension was subsequently reloaded. Its owned
  replay session opened an authenticated internal app and
  clicked the display-only control. The old exact
  `snapshot -s '#editor'` returned `Selector did not match` because the
  current app no longer had that ID; this did not reproduce the earlier size
  failure. After a bounded DOM check identified `#section`, the exact
  `snapshot -i --compact -s '#section'` succeeded in 254.935 ms with 544
  lines. The task closed with exit 0 and saved no prices or settings. These
  parent-observed tool returns do not yet have a raw receipt. They prove the
  current authenticated scoped-section snapshot on that reloaded worker, not
  the removed editor literal, every profile, or the whole AX path. Engine-side
  `-s` filtering still happens after the full AX fetch, so prefer a narrower CSS
  `get` or `is` observation when it can answer the question; neither wrapper
  truncation nor a raw-CDP fallback repairs this boundary.

### Atomic Windows Delivery Must Pass A True Null Backup Path

- A Windows PowerShell 5.1 delivery passed plain `$null` as
  `File.Replace`'s nullable string backup argument, but overload binding turned
  it into an empty string and the real apply failed with an illegal-path
  `ArgumentException`. The failed call left a partial native-host copy; its
  exact preimage was restored before the fix. A focused host check distinguished
  the values: `[string]::CompareOrdinal($null, '')` returned `0`, while
  comparing `[System.Management.Automation.Language.NullString]::Value` with
  `''` returned `-1`. Microsoft documents
  [NullString](https://learn.microsoft.com/en-us/dotnet/api/system.management.automation.language.nullstring)
  as the way to pass null to a .NET string parameter, and
  [File.Replace](https://learn.microsoft.com/en-us/dotnet/api/system.io.file.replace)
  accepts null when no replacement backup file should be created. Receipt:
  initial red.
- WHY: a transaction-owned preimage and an API's nullable contract do not prove
  that PowerShell supplied a CLR null. Bind the actual shell/runtime overload,
  preserve and restore any partial destination before retry, and verify the
  installer receipt, discovered native manifest, and loaded process bytes as
  one coherent delivery. Rollback must touch only the transaction-owned files.
  Do not prescribe a fixed version directory: discover the canonical installed
  target from its current manifest/receipt contract. The corrected delivery
  then passed a real installed read, loaded-process hash binding, rollback,
  reapply, a second real read, and exact cleanup without restarting Chrome or
  WSL. Receipt:
  nullable delivery.

### UIA Tab Counts Must Exclude Page-Authored Tabs

- A native observer that counts every UIA `ControlType.TabItem` can include
  webpage ARIA tabs alongside Chrome's tab strip. The scoped diagnostic found
  one Chrome window with 11 such nodes: four native nodes had class `Tab` under
  parent class `TabContainerImpl`, while seven unrelated page nodes had a
  webpage-specific class and parent. Filter browser-tab observations by the
  native class and tab-container parent before applying a count limit. This
  explains a concrete overcount mechanism; it does not establish the owner of
  the historical greater-than-128 failure. Receipt:
  TabItem diagnostic.
- WHY: UIA role alone is not browser ownership, and input-idle telemetry is not
  actor attribution. Microsoft documents
  [GetLastInputInfo](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-getlastinputinfo)
  as session-specific last-input timing whose tick value can also reflect
  `SendInput`; it does not prove a human action or a focus transition. Judge a
  focus result from the actual foreground window, physical tab selection, and
  native event timeline. The final focus journey remains pending; neither this
  filter nor unchanged input timing makes it green. Preserve the observation
  boundary if UIA structure changes instead of freezing these class names as
  the only possible architecture.
