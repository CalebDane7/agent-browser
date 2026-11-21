---
name: agent-browser-builder
description: "Build, repair, validate, install, or publish Agent Browser, including an offline Chrome-profile extension or native-host connection. Use the separate agent-browser skill for ordinary website or authenticated Chrome operation."
---

# Agent Browser Builder

This is the maintainer's guide for people who build, repair, or fork Agent
Browser. It ships with the repository so a fork inherits the failure history
and release discipline behind the runtime. Installing or using the browser does
not need it: the operator skill and its
[setup guide](../agent-browser/references/setup.md) cover that, and there the
installing agent performs the extension load and pairing click itself. The
stricter user-gesture wording below applies to repairing an existing
installation. Local evidence such as receipts, logs and profile data stays on
the maintainer's machine; this copy keeps the lessons, not that data.

## Route The Request

Use this skill for implementation, repair, installation, release validation, or
publication of Agent Browser itself. For ordinary browsing, screenshots, forms,
website troubleshooting, or authenticated Chrome work, use `$agent-browser`.
Do not change that everyday skill unless the human explicitly includes it.

This skill does not grant permission to mutate the live browser, install a
candidate, publish a package, or push a repository. Derive each action from the
current human-authorized result and applicable workflow authority; a goal is
only a fallible projection of that authority. A goal-tool limitation is not a
prerequisite for independent, already-authorized repair work.

## Shorten Wall Time With Real Concurrency

Before implementation and whenever evidence or dependencies change, dispatch
every authorized, dependency-ready, ownership-closed lane that can materially
shorten time to the finished result—source/contract audit, decision-changing
external research, isolated candidate work, focused fixtures, documentation,
and release review. Use separate physical candidates for overlapping logical
code and separate uniquely named browser sessions/tabs for independent,
authorized live observations. Keep one writer per physical candidate and one
owner per live runtime/session/proof surface; serialize only real dependencies
or shared mutations. Refill useful lanes as they finish, but never prewarm
browser tabs or duplicate an unchanged falsifier merely to create parallel
activity.

In the September 6, 2026 installed private route, one profile-local extension
debugs multiple tabs. Its worker now separates session page work, exact session
teardown, and shared control work; independent tasks in the same profile have
completed literal proof. Sharing a profile alone does not justify serial
page work. Rebind this topology when changing it; the old profile-global queue
is a preserved failure boundary, not an unimplemented repair. The scoped proof
and distinct current-tab claim contract are recorded in
[references/failure-boundaries.md](references/failure-boundaries.md).

## Treat The Skill As A Guide, Not A Frozen Design

This skill preserves observed failure boundaries and decision shortcuts. It is
not evidence that the current wrapper, extension, broker, donor engine, helper,
or profile topology remains the best architecture. Bind only the source, loaded
bytes, processes, Chrome version, and owner contracts relevant to the change;
a guide-only edit does not require a new live browser audit. Reuse accepted
proof unless its exact boundary is invalidated. If evidence supports a stronger
complete solution, reselect it while preserving the protections below.

Keep durable invariants separate from changeable implementation facts. Exact
tab ownership, no unintended focus, bounded cleanup, saved-profile integrity,
and secret-state protection are invariants. PIDs, extension IDs, versions,
profile directories, window handles, helper APIs, process layouts, and the
present repair mechanism are current facts that must be rediscovered. A prior
red vetoes only a causally equivalent failed premise; it does not make every
current implementation detail permanent.

## Bind Before Mutation

1. Reread the current applicable `AGENTS.md` chain and follow its current
   project-resolution and continuity contract. Do not freeze a historical
   resolver, Board, manifest, or goal mechanism into this skill. A leaf packet
   never grants project-wide integration authority.
2. Recover only the smallest cited history that bears on the proposed change:
   accepted behavior, prior reds, protected consumers, dependencies, and WHY.
   Runtime receipts and logs establish current facts; history does not.
3. Inspect intended files, dirty changes, and physical candidate ownership before editing.
   When the change affects a runtime or its proof, also bind its locks, installed
   paths, process ownership, and exact live proof surface before mutation.

Do not promote a remembered PID, port, target handle, session ID, generation, or
hash into a standing rule. Resolve current values from the installed entrypoint,
its actual current owners, and current cited evidence.

## Keep Development Isolated

- Preserve exact preimages and hashes for every file a change may mutate, plus
  unrelated dirty bytes. Put backups outside skill and test discovery roots:
  a copied `SKILL.md` became a stale selectable skill, and copied tests ran as
  extra suites. Use one writer per physical candidate and one for the live runtime.
- Develop and run mechanical checks in an isolated candidate. A candidate must
  not attach directly to the user's Chrome or current live owner unless the
  current proof contract establishes an authorized, safely reversible isolated
  route. Proof-ready means runnable with exact verdict inputs and reversal,
  not already literal-green; requiring the latter would prevent the proof itself.
- Revalidate current role boundaries before acting. In the September 6 private
  route, the installed CLI wrapper validates CLI arguments and capability
  envelopes, the supervisor/broker multiplexes sessions, each profile-local MV3
  extension owns Chrome tabs, and the pinned engine consumes one page-scoped
  capability. None of those roles is a permanent architecture requirement.
- For broker, Chrome/profile, tab ownership, focus, approval-dialog,
  extension/MetaMask, install, or publication work, first read
  [references/failure-boundaries.md](references/failure-boundaries.md).

## Diagnose From The Literal Path

Trace the reported behavior across the owners that current evidence shows can
change the result. In the present private route these commonly include launcher
resolution, wrapper/grant validation, supervisor/broker authority, native-host
and extension identity, Stable Chrome/profile identity, extension-owned target,
page-scoped engine delivery, lifecycle, and the final visible surface. A later
topology may have different owners. Probe the earliest divergence. Preserve a
real-path red; do not patch a downstream symptom while an upstream owner remains
unsupported.

For a previously working connection that is now offline, apply the operator
skill's normal, scoped Chrome close/reopen first, before internal setup, pinning,
pairing or a deeper repair. Check current readiness and protect affected owners;
do not restart an already connected profile. A windowless bootstrap is not the
same attempt. If normal reopening works, resume the task and stop diagnosis.

A failed `open` is not retried without a causal evidence delta. Use only the
bounded recovery exposed by the currently bound owner. The September 6 private
wrapper already validates/restarts its broker and starts an offline enrolled
profile once; `browser-runtime doctor` belongs to the retired controller path
and is not its recovery command. Never fall through to another browser, profile,
direct CDP client, or fixed port. In particular, `extension is not online`
means the broker has no ready peer for that account after bootstrap; it does
not distinguish absent, disabled, unpaired, or failed native-host startup.
If the one normal close/reopen failed or cannot safely run, check the current
account/profile mapping, broker health, native-host identity, and fresh failure
receipts once, then inspect the extension in that exact
Chrome profile before proposing a code fix or another connection attempt.

The ordinary wrapper cannot inspect `chrome://extensions` while its profile
peer is absent, and its page capability does not control extension UI. For this
browser-internal setup boundary only, a supported native UIA observation may
inspect a user-opened, exact-bound Stable Chrome window without changing its
focus; bind the process, profile, window, document, and intended control first.
Never use UIA as a fallback for ordinary websites. Search the extension name
or current registered ID, judge the actual result in that profile, and restore
the search. A missing row points to installation; an enabled row proves only
installation. If that exact UI is inaccessible, report the unresolved state
instead of requesting a blind pairing or reload click.

Treat every command as incomplete until the wrapper process exits. Early native
stdout such as a successful URL or `Browser closed` does not prove wrapper
reconciliation, ownership publication, or cleanup. When a nonzero downstream
owner hides its reason behind a wrapper classification, capture its single
bounded structured failure from the stream where it was actually written; do
not repeat the browser action to rediscover it.

Stopping an unchanged retry is not stopping diagnosis. A generic native-host
exit or missing provider error calls for the smallest supported observation or
bounded error instrumentation, not another "still blocked" reply. Continue
independent useful work. If only an unavailable external prerequisite remains,
report it once and use the available goal/wait controls correctly; never spend
automatic continuations repeating the same status. See the session-backed
lessons in [references/failure-boundaries.md](references/failure-boundaries.md).

After every literal red, identify the first changed owner and admit only the
smallest discriminator or repair that can change the next literal result. Do not
replace that action with a broad session audit, web survey, donor search, fake
adapter suite, or repeated open/close. The exact known-red mechanisms and their
required discriminators are in
[references/failure-boundaries.md](references/failure-boundaries.md).

## Recovery After A Restart Or Account Switch

Check current supported broker health before acting on a retained failure. Match
receipt timestamps and generations. A ready requested profile takes the ordinary
same-session URL/snapshot path; do not restart it to reproduce an old red. See
[the connection recovery decision path](references/connection-recovery.md).

Explicitly authorized recovery includes preparing the exact mapped Chrome
profile's internal setup surface when accessible; “user-opened” above is not a
requirement to hand routine setup back to the user. Bind its profile/process and
window, preserve foreground choice, and use the supported native setup owner.
Do not substitute direct page automation, another profile, or a credential reset.
A scope-safe restart needs current owner/session evidence; no blanket process kill.

## Restore An Offline Profile Extension

If the extension is absent, inspect any existing installed unpacked bundle
before rebuilding or staging one: verify its manifest name/version, worker,
referenced icons, relevant hashes, and extension ID against the registered
native-host origin. Load the verified directory itself in the exact profile;
do not promote its machine-specific path or ID into this guide. Prepare and
verify the file chooser's exact folder path and selected directory before
asking for help with a genuine user-only chooser action. A malformed path,
including whitespace after the drive prefix, is an input error to correct,
not evidence that the bundle is missing. Bind the loaded row's actual ID and
enabled state before proceeding.

If the action icon is hard to find, use the extension's Details page, turn on
**Pin to toolbar**, and identify the visible action icon. Prepare and inspect
everything accessible, but leave the one-time action click to the user and
enroll only the requested profile.

An installed extension with no ready peer still needs cause separation. Read
the current broker's enrollment contract and fresh secret-free stage/action
receipts. In the September 6 route, a previously mapped account/profile uses
`enroll.replace.begin`; `enroll.begin` rejects an existing mapping. Prepare the
exact profile, visible toolbar control, and user handoff before starting the
short-lived challenge. Then start the correct challenge on the current broker
*immediately before* the one user-owned gesture. Do not spend its lifetime on
navigation, pinning, or prompt preparation. If it expires without a fresh
action receipt, record an unobserved gesture and restage only when the user is
ready; expiry does not prove a failed click or missing extension. Do not ask
for repeated clicks or infer success from the extension row, toolbar icon,
or lack of a popup. Confirm a matching action receipt and ready peer first.
Then prove the mapped profile through an ordinary `agent-browser --account ...
--session ... open`, compact snapshot, visible account check, and exact close.

For a recurrence after prior pairing, `profile-unbound` proves a valid-origin
hello with an unmapped key; it does not identify which Chrome profile sent it
or why the key differs. Inspect the original binding path and compare the exact
intended profile's stored key with current and prior mappings by secret-free
equality through a supported profile-owned observation. If access is denied,
retain the cause as unknown. In the current MV3 route, do not publish a newly
generated key to the broker until `storage.local` write and read-back succeed:
an in-memory key after a failed write can pair once and vanish on worker
restart. A ready peer is warm recovery, not durability proof. Check cold-worker
continuity and the ordinary browser path when exact live ownership permits.
Other owners' live sessions veto an uncoordinated shared extension reload.

## Prove The Candidate As One Whole

Before replacing installed bytes, review the staged diff and dependency changes,
exclude secrets and transient runtime values, and run the smallest candidate
checks that can reject the mechanism. Keep the current approved live chain
intact until the replacement and rollback path are proof-ready.

Before asking the user to reload an extension, stage the exact authorized
candidate, verify its installed hash and safe reload scope, and prepare the
literal check. Then give one ready signal. An earlier reload loads old code;
an enabled extension or a disk hash does not prove the running worker changed.

Do not bind a running process to newly written bytes merely because a health
response hashes its source path. First inspect how that hash is produced: a
process that rereads the file can report the new disk hash while still executing
old in-memory code. If current evidence shows code is loaded only at process
start, bind the pre-cutover identity and the exact replacement process. A future
generation-bound hot-reload mechanism is equally valid when independent evidence
proves the running generation loaded the expected bytes. In every topology,
bind loaded behavior rather than assuming disk equality proves it.

Contract changes must be traced as one connected whole across every affected
current producer and consumer, including the installed launcher and running
owner when applicable. A green test for one producer cannot release a
schema/kind/envelope change that another installed consumer has not consumed.
Exercise the production adapter/hook or an exact fixture for it; fake-only green
is not production proof.

For an authorized install or cutover, bind source bytes to installed bytes and
installed bytes to the actual process. Then run the smallest exact literal
journeys and dependent checks whose red can veto the affected behavior. Exercise
rollback and reapply when installation or runtime ownership changed. A source
test, clean exit, hash, or process presence alone is partial evidence; if the
literal surface is unavailable, report `NEEDS_PROOF` and do not publish.

Before calling a cutover a reconnect, trace its shutdown hook. The audited
v0.36 native daemon invokes provider cleanup on graceful shutdown; that closes
extension-created task tabs rather than preserving their documents. A socket
disconnect has different cleanup semantics. See the cutover distinction in
[failure boundaries](references/failure-boundaries.md#engine-shutdown-is-not-task-preserving-reconnection).

Report exactly which user-visible behaviors are proven and which remain—not
"90%", "one last test", or "everything works" from a narrower green. Give an
estimate only when requested and distinguish it from evidence. Current-tab,
other-profile, screenshot-mode, lifecycle, and publication claims each need
their relevant proof or established causal equivalence. Retire proven work;
generic "continue/finish" does not authorize running it all again.

## Publish Only The Proven Whole

An ordinary authorized GitHub push comes only after the staged diff, affected
dependencies, mapped release-veto proofs, and secret exclusion are green. Live
source-installed-process and rollback/reapply proof applies when the published
change affects installation or runtime behavior, not to an isolated docs-only
change. Never run `npm publish`, create a release or tag, rewrite history,
force-push, or broaden public scope without exact authority. Preserve the
focused old-red guard and code-owner WHY before publication.
