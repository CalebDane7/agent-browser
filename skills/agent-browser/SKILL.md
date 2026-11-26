---
name: agent-browser
description: "Use real Chrome for app/UI testing, sign-in/login, dashboard verification and browser tasks, even if unnamed. Excludes information-only research."
---

# Agent Browser

Use the installed `agent-browser` command in the user's existing Windows Stable Chrome.
Default to the runtime's configured default account; select another enrolled
profile only when requested. Work in your own background tabs, alongside the
user and other agents.

Every task that needs real browser interaction or browser-visible proof uses
this skill, including browser work inside a project whose main artifact is not
a website. Perform every accessible browser action yourself. Do not delegate
clicks, navigation, inspection, screenshots, setup, or verification to the
user, and do not request manual confirmation for actions the user has already
authorized. Ask for user input only at a proven user-only boundary, while
retaining the exact tab and session as instructed below.

App testing includes signing in. On a login page, read
[authentication](references/authentication.md) before deciding access is blocked.
Use the saved sign-in or, for an app the user owns, retrieve the existing app
login from its authorized deployment. If that deployment has the password,
use it privately and sign in yourself; do not ask the user for it. A password
field alone is not a user-only boundary. This skill also covers browser-visible
proof inside non-web projects, forms, downloads, screenshots and existing-tab
help; API/source-only checks do not need a browser. Wallet/extension requests
retain the state protections below and do not gain extension-UI access.

## The Exact Recipe (read this first)

For an ordinary task (open, read, click, fill, check, screenshot) this recipe
is all you need. The rest of this file covers special cases: co-working in the
user's tab, lost connections, wallets, and proof capture for public pages.

1. **Make a session file once per task, in your first browser call.**
   ```bash
   SCRATCH=/path/to/a/folder/you/own   # e.g. your agent's scratch folder
   mkdir -p "$SCRATCH"
   IFS= read -r u </proc/sys/kernel/random/uuid
   echo "browser-task-${u//-/}" > "$SCRATCH/ab-session"
   ```
   Shell variables vanish between tool calls; the file doesn't. Start every
   later call with `SCRATCH=<same folder>; S=$(cat "$SCRATCH/ab-session")`.
2. **Every command, including `close`, uses the same two flags:**
   `agent-browser --account <handle> --session "$S" <command>`.
   `<handle>` is an enrolled handle from "Choose The Account" below. To use the
   configured default account, leave `--account` off every command.
   There's no setup, `connect` or debugging-port step. The tool refuses
   `connect`, and Chrome is already wired up.
3. **Open the page:** `open URL` prints the page title and URL. In your next
   tool call, `get url` must print that same URL. If it prints `about:blank`,
   follow "If the next command sees about:blank" under Failure And State
   Protection.
4. **Read before acting:** `snapshot -i --compact`, then act on a fresh `@eN` ref.
   Re-snapshot after anything changes the page.
   On a big page, narrow it: `snapshot -i --compact -s 'nav'`, or pipe it
   through `grep -i book`. Refs from that output are valid until the next snapshot.
5. **Run JavaScript with `eval`:** one line works directly, e.g.
   `eval 'document.title'`. For multi-line code use `eval --stdin < file.js`.
   Results come back as JSON, so text arrives in quotes.
6. **Google Ads, GA4, Tag Manager and similar Material/Angular consoles:**
   `snapshot -i` often shows nothing. Use `eval` to find exactly one visible
   matching element and call `.click()` on it inside the eval. Do the same if
   a `click` command doesn't change the page.
7. **Prove the result:** reload or reopen, read the value, and look at any
   screenshot you take.
8. **Close when the task is done, or after it fails:** `close`, with both flags.
   Leave the tab open only while you and the user are still working in it.

## Start Here

This section adds detail to the recipe above. If the two seem to differ, the
recipe wins.

**Parallelize immediately when independent work can finish sooner.** Give each
worker a unique session and its own tab tree, even within the same profile.
Serialize only dependent actions, writers to the same tab, or changes that could
race shared account state. Open only tabs needed now—not idle placeholders.

Make the session file once (recipe step 1), then in every tool call:

```bash
SCRATCH=<same folder>; S=$(cat "$SCRATCH/ab-session")
# Use an exact enrolled handle (see "Choose The Account"). To use the configured
# default instead, omit --account consistently on every command.
agent-browser --account <handle> --session "$S" open URL
agent-browser --account <handle> --session "$S" snapshot -i --compact
# Act on the intended control's fresh ref; verify the requested visible result.
# When finished, close—unless this tab is still being used with the user.
agent-browser --account <handle> --session "$S" close
```

Ordinary browsing needs no installation audit, connection setup, Chrome launch,
prewarm, or reference-file reading. `open` reuses the approved private transport.
For a missing installation or a newly requested profile, read
[fast setup and reuse](references/setup.md) once. Do not reinstall to retry a
failed task; setup and ordinary connection recovery are different paths.

## Close Finished Tabs; Preserve Co-Working Tabs

- On success, failure, or cancellation, run the matching `close` promptly and
  wait for its process to exit. Do not leave blank or finished tabs consuming
  memory, and do not wait for other workers before cleaning up your own lane.
- **Keep a tab open while the user and agent are still working in it together**
  or it awaits genuine user-only input. Retain the exact account/session and
  report why it stays open; resume there, not in a replacement tab. A finished
  task with no active collaboration is not a reason to retain it.
- Close only your session's task-owned tabs and owned popup descendants. Never
  close a user's pre-existing tab, another worker's tab, or an entire browser
  as task cleanup. The scoped connection-recovery exception below is separate.
  End an invited user-tab attachment by detaching, not by closing the user tab.
- Each worker reports `closed`, `retained for collaboration/input` with its
  owner, or `cleanup failed` with the compact error. Run cleanup in the original
  worker: the installed wrapper binds the alias to its real owner namespace.
  Reusing a child's alias from the parent does not access or close the child's
  tab. Resume that worker for cleanup when possible; otherwise report the exact
  failure to the runtime maintainer. Never forge owner metadata or use broad
  cleanup.

## Small Parallel Worker Packet

```text
Read the agent-browser skill. Account: <handle>. Session: <unique purpose + UUID>.
Task/URL: <independent workflow>. Allowed actions: <read-only or exact writes>.
Result: <observable outcome>. Own only this session's tab tree.
Open → compact snapshot → act → verify → close, including after failure.
Preserve a tab still being used with the user or awaiting genuine user input.
Return the result, minimal evidence/error, and exact cleanup/retention status.
```

Workers open their own tabs when ready. Refill useful independent lanes as they
finish. Never share element refs across sessions or have two writers operate
the same tab. The current cap is 16 live sessions total, not a target: normally
use only a few and release each as soon as its work ends.

The installed wrapper separates real agent owners even if their aliases match.
Keep the same worker for an ongoing workflow; a new worker with the same name
gets its own tab. Confirmed native owner-process death triggers exact cleanup;
child-thread completion alone does not prove process death or cleanup.

## Choose The Account

Account handles are local to each installation; none are built in.

- `~/.config/agent-browser/extension-profiles.json` lists the enrolled
  `account` handles and the Chrome profile directory each one maps to.
- `~/.config/agent-browser/default-account` holds the default handle.
- Map the user's wording (a name, an email, a profile label) to an exact
  enrolled handle from that local mapping. Display names, emails, and profile
  directories are not automatically valid handles.

List the handles without printing the file's private profile keys:

```bash
node -e 'const c=require(process.env.HOME+"/.config/agent-browser/extension-profiles.json");for(const p of c.profiles)console.log(p.account+" -> "+p.profileDirectory)'
```

Keep this machine-specific mapping private; never publish it or copy it into
shared instructions.

A session name does **not** select an account. Omission of `--account` selects
the configured default for that command. Do not invent email aliases or
silently substitute a different profile. For a new mapping/enrollment, follow
[fast setup and reuse](references/setup.md).
Verify the page's visible identity before account-sensitive actions. Use the
correct profile's saved sign-in/account chooser before asking for login input.

## Background And User-Tab Collaboration

Normal `open` creates an inactive task tab. An offline enrolled profile starts
without a startup window; its extension creates a minimized task window only
when needed and retires that owned window after its last task closes. Do not
pre-open one window per profile or activate Chrome merely to inspect a page.

Website-triggered popups can bring Chrome forward; ordinary task tabs must
still stay inactive. This accepted limitation does not authorize agent-driven
activation or waive cleanup of exact task-owned popup descendants. A finished
task's owned popup left after `close` is a cleanup failure; report the exact
error to the runtime maintainer without closing guessed or user-owned tabs.

For explicit help in the user's selected tab, use `--current-tab` with the
requested account and a fresh session. The first command claims that profile's
currently focused tab; verify its URL before acting. Keep the flag and the exact
account/session on subsequent commands. Once attached, the user can minimize
Chrome and work elsewhere; commands continue without bringing it forward.
Matching `close` detaches and leaves the user's tab open. Claim, minimized
interaction, and detach/survival passed the maintainer's real-Chrome check on
September 6, 2026. Details:
[session management](references/session-management.md).

Multiple explicitly invited agents may share one user tab. Complete commands
are serialized there, each agent retains its own session, and each `close`
detaches only that agent. Use separate owned tabs for independent work.

At unavoidable user input, retain the task session. With the user's permission,
use `foreground --input-boundary TYPE` as documented in
[commands](references/commands.md); otherwise identify the tab for the user to
select. After input, `background` must repeat the exact account, session, and
`--current-tab` prefix when applicable. It conditionally returns only while the
saved handoff is still valid. Cancellation, denial, an unconfirmed result, or
no handoff does not promise focus; do not retry or force focus. Resume in the
same tab and preserve it while working together.

## Fast Interaction Loop

- Choose the smallest useful command: compact/scoped `snapshot` for controls,
  `get` or `is` for a specific value/state, `find` for a semantic control,
  `screenshot` for pixels, and `console` / `errors` for page diagnostics.
  See [commands](references/commands.md) for syntax and availability. New
  full-page/selector/JPEG capture, relative uploads, error-buffer clearing,
  and bounded JSON improvements are now installed and documented there. Use the
  ordinary command; do not switch binaries to access them.
- Start with `snapshot -i --compact`; use the intended control's fresh ref for
  `click`, `fill`, or `get`. Ref labels alone do not identify the right control.
- Refresh refs after navigation, reload, a dialog, or a material DOM change.
  Each new snapshot replaces the ref map, including scoped snapshots. Use refs
  only from the latest successful snapshot. Scope with CSS, not an `@ref`; do
  not dump `get text body` by default.
- Put engine output flags after the command, for example
  `snapshot -i --compact --json`, after the usual account/session prefix.
  JSON is a format, not a guarantee of small output; scope the observation first.
- Wait for a visible result, selector, URL, or load state—not arbitrary sleeps.
  Always wait for command exit, even if output arrives early; another session
  may continue meanwhile. Take screenshots when visual evidence adds value.
- Judge the requested visible result, not merely a successful command exit.
  Reload/reopen to verify persistence when the task requires a saved change.
- Use web search for information-only public research and terminal/API tools
  for source/header/status checks; do not start browser tabs for those alone.

## Failure And State Protection

**If the next command sees about:blank, fix it now. Don't stop to report it.**
It means the tool didn't recognize your agent process, so each shell got its own tab.
1. Run `cat /proc/$PPID/comm; readlink /proc/$PPID/exe` to see how your agent appears.
2. Edit `resolveInvokingOwner` in this repository's `scripts/agent-browser-owner.js`
   so it recognizes that (it already accepts a `.../<agent>/versions/<ver>` path,
   the binary name, or the process name).
3. Add the case to `tests/agent-browser-owner-deleted-exe.test.mjs` and run
   `npx vitest run tests/agent-browser-owner-deleted-exe.test.mjs`.
4. Re-check with recipe step 3, then carry on with the task.

For a previously working browser connection that is now lost, use the normal
close/reopen recovery below first—not toolbar pinning, pairing or a setup audit.

The wrapper already attempts bounded recovery, including starting an offline
enrolled profile once. Preserve the primary browser or website error separately
from any later ownership or cleanup diagnostic. For an ordinary navigation or
site failure, diagnose the website, DNS, or local-preview owner with read-only
tools and current project authority; do not treat the website failure itself as
an Agent Browser runtime fault or ask the user to perform routine checks. Report
transport, ownership, wrapper, or browser-runtime failures, with the exact
error, to the runtime maintainer through the
[repository issues](https://github.com/CalebDane7/agent-browser/issues);
installation, new-profile enrollment, and extension/pairing problems belong to
[fast setup and reuse](references/setup.md). If
the requested action succeeded but cleanup failed, preserve the cleanup error
without replaying the action. When a command error and cleanup diagnostic both
matter, retain both. Do not repeat an unchanged failed action, cycle new
sessions, replace an authenticated tab, or repeat a mutation. Keep unrelated
independent work moving; report a failure once with the next evidence-changing
action, not repeated status messages.

- Never bypass the wrapper with raw CDP, `connect`, `--cdp`, `--headed`, port
  `9222`, unscoped direct Chrome launch, `browser-runtime doctor`, a different browser,
  copied profile, custom state, or alternate `--user-data-dir`.
- Never revive a historical copied profile as the live profile. Copied profiles
  previously showed extension icons while losing the user's working
  authentication/wallet state.
- Do not loop Chrome restarts, restart WSL, or reinstall/reset extensions to retry.
  One normal, scoped Chrome close/reopen is the first lost-connection recovery below. An enabled
  extension or browser-wide debugging banner is not proof of profile enrollment.
  Pairing is per profile; ordinary reuse should not ask again. For a missing
  installation or a newly requested profile, follow
  [fast setup and reuse](references/setup.md) and perform its steps yourself,
  including loading the extension and the pairing click. A fresh pairing or
  approval prompt during ordinary reuse needs diagnosis; do not re-pair,
  reinstall, or click through it to retry a failed task.
- Never inspect, export, copy or modify browser-stored cookies, credentials or tokens, wallet
  vaults/recovery data, MetaMask settings, or hardware-wallet/USB configuration.
  Existing app credentials from the authorized deployment may be retrieved and
  used only for its sign-in through the authentication guidance above.
  The ordinary route controls page tabs, not extension UI/storage. A site
  connection does not authorize a wallet signature or transaction.
- Ask for input only at a proven user-only boundary; never ask for secrets in
  chat or shell. Keep that tab/session for the user, as described above.

## Recovery After Restart Or Account/Token Changes

A previous offline error is not current connection state. Check the installed
broker's current health once through its supported control contract; compare
any failure receipt's time and broker generation. If the requested profile is
now connected, resume the same account/session and verify its URL and visible
page. An old `profile-unbound` receipt can coexist with a healthy enrolled
profile.

When recovery is authorized, perform accessible setup yourself. Do not ask the
user to open Chrome merely because no window is visible. If a previously working
profile is currently offline, **first normally close and reopen that same Chrome
profile once**, using the supported exact-profile/native recovery route. The
wrapper's windowless bootstrap is not proof that this normal restart was tried.
Bind the actual mapped profile directory and affected windows/sessions; preserve
saved tabs, cookies and login state, and do not dismiss an unsaved-work prompt.
Resolve any real conflict with another active owner before closing its window.
Keep background operation where supported; never force focus restoration.

Then resume the same account/session and check the intended page through ordinary
Agent Browser. If recovered, stop troubleshooting. Only if this attempt fails (or
cannot safely run) inspect the specific remaining failure before proposing pinning,
pairing, re-enrollment, extension changes or a deeper transport repair. A profile
label, enabled icon or old unbound receipt does not prove the mapped profile lost
its enrollment. Do not repeat the restart without new evidence, kill all Chrome
or WSL, clear saved state, or replace the profile. A website/login error is not a
lost browser connection; an account/token change alone does not prove one.

## Read More Only When Needed

- [Commands](references/commands.md): less-common supported CLI syntax.
- [Snapshot refs](references/snapshot-refs.md): stale refs and selectors.
- [Authentication](references/authentication.md): saved sign-in, OAuth, input.
- [Session management](references/session-management.md): reuse and cleanup.
- [Protected state](references/browser-state-recovery.md): missing profile,
  extension, wallet, or transport state; no ordinary recovery authority.
- [Fast setup and reuse](references/setup.md): first-time installation or a
  newly requested profile only.

Other legacy donor references are not instructions for the installed private
route until their commands and capabilities are verified against the installed
wrapper and page capability.

## Proof capture for public pages

Bind proof to the actual URL, viewport, scroll position, loaded assets and relevant
state or moment. Earlier captures sometimes reset scroll or returned the prior
frame. Inspect the captured position and content; use a warm-up or second settled
capture when that defect is observed, not as a ritual on every browser action.

Background or hidden documents may pause or throttle animation. Inspect actual
visibility and frame progression. Forced screenshot frames can help inspect poses;
they do not establish natural cadence, input response, continuous motion or device
performance. Obtain temporal proof under supported, authorized rendering conditions.
If those conditions are unavailable, retain that exact proof gap. This does not
authorize foreground activation, transport bypass or changing browser settings.
See [requestAnimationFrame](https://developer.mozilla.org/en-US/docs/Web/API/Window/requestAnimationFrame)
and [document visibility](https://developer.mozilla.org/en-US/docs/Web/API/Document/visibilityState).

A narrow same-engine reflow can test layout when its styles, assets and content
are faithful. A cloned `srcdoc` view may lose live state, listeners and canvas
content; it is not proof of the original app's behavior, phone gestures, browser
chrome or physical-device performance. Prefer the actual supported responsive
surface when available, and label clone evidence as reflow only. See
[DOM cloning limits](https://developer.mozilla.org/en-US/docs/Web/API/Node/cloneNode).

Verify the served asset identity: HTML may be dynamic while CSS/media remains
cached. Fetch the exact versioned URLs referenced by the live page, inspect cache
status and compare delivered bytes with the intended export. Preserve the project's
cache/versioning contract; a correct local render cannot establish the live result.
Open and inspect every capture used as evidence; an unread screenshot proves nothing.

Observe the browser's actual `prefers-reduced-motion` value. A requested static
branch is not by itself a missing-animation bug. Respect the user's accessibility
setting; do not change the OS preference just to make a test animate. Where a
supported and authorized scoped test override exists, keep it local, restore it
and verify both relevant branches separately. The normal frame and reduced-motion
paths have different expected behavior. [Preference meaning](https://developer.mozilla.org/en-US/docs/Web/CSS/Reference/At-rules/@media/prefers-reduced-motion).
