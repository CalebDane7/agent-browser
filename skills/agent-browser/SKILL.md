---
name: agent-browser
description: "Use the user's real authenticated Windows Google Chrome whenever a request says to open, use, inspect, look at, check, test, verify, screenshot, click, fill, sign in to, upload/download from, or troubleshoot a website/web app/dashboard—or whenever cookies, saved logins, profile identity, rendered JavaScript/UI, or existing account state can change the result. Also route browser-extension, MetaMask, or wallet requests here so the skill protects their state, but the ordinary private page route does not itself repair or control extension UI. Trigger for natural requests such as 'does this work,' 'what do you see,' 'use my Chrome,' or 'go to my dashboard,' even when 'agent browser' is not named. Uses the actual Windows Stable Chrome user data, not a copied automation profile. Do not use for information-only public web research or pure API/source/header checks."
---

# Agent Browser

## Parallelize First: Multiple Agents, Multiple Owned Tabs

Before the first browser action, aggressively split independent pages, searches,
checks, or account lanes across multiple agents and multiple owned tabs whenever
that materially shortens time to the finished result. Dispatch those lanes
immediately; serial browser work is the exception, not the default. Give every
lane a globally unique semantic `--session`, keep one writer per owned tab tree,
and let same-profile lanes run concurrently. Serialize only actions that depend
on the same tab/state or could race the same account-sensitive mutation. Close
every lane as soon as its result is integrated.

Keep a co-working tab open while the user is still using it or genuine user
input is pending. Otherwise close promptly in the original worker and wait for
command exit. The installed wrapper binds an alias to its real owner namespace;
different agents using the same name get separate tabs. A parent cannot close
or take over a child's tab by repeating its name. Resume the original worker for
cleanup when possible, or report the exact failure to the runtime maintainer.
Never forge owner metadata. Native process-death cleanup is not child-thread completion.

## Use The Real Browser When It Matters

Choose the smallest surface that can prove the result:

- Use web search for information-only public research that does not depend on a
  browser session.
- Use terminal tools for pure API, status, header, DNS, or source checks when
  rendered browser state cannot change the answer.
- Use `agent-browser` whenever JavaScript rendering, visible UI, cookies, login,
  an existing account, saved browser state, clicking, typing, forms, downloads,
  screenshots, or a literal user flow can affect the result.

When the third case applies, do not substitute a clean, local, disposable,
headless, Lightpanda, or text-only browser. Operate the real persistent Windows
Google Chrome profile and judge the rendered result yourself.

## Account And Transport Authority

For a missing installation or a newly requested profile, read
[fast setup and reuse](references/setup.md) once. Already configured? Start the
task directly; no reinstall, prewarm, or new enrollment is needed per task.

The installed `agent-browser` launcher, private wrapper/broker, and profile-local
extension jointly own attachment to the user's real Windows Stable Chrome,
profile selection, exact tab capabilities, and transport. Start with `open`.

- Never launch Chrome directly or use `Start-Process chrome`,
  `start-chrome-debug`, fixed port `9222`, `connect`, `--cdp`, `--headed`, an
  alternate `--user-data-dir`, or a custom browser/config/profile/state.
- Never revive a historical copied profile as the live profile. A copy can show
  extension icons while silently losing cookies, settings, and MetaMask wallet state.

With no stronger account direction, omit `--account` to use the runtime's
configured default. For a requested account, use `--account HANDLE` with its
exact enrolled alias from the local installed operator mapping. Display names,
emails, and profile directories are not automatically valid CLI aliases.

If the requested account has no known local mapping, do not invent a handle or
silently use the default. Follow the [setup guide](references/setup.md) for a
new mapping or enrollment; keep that machine-specific map private.

- A named session owns task tabs and refs; it does not choose the Google account.
  Verify the visible identity before any account-sensitive action.
- Try the requested/default saved profile, its visible account chooser, and its
  existing signed-in state before declaring login blocked. Never ask the user to
  sign in as a first step, and never silently act under the wrong account.

### Background By Default; Current Tab Only By Invitation

Normal `open` creates an inactive task tab in the selected profile. If that
profile has no window, the wrapper starts the exact Stable profile without a
startup window and the extension creates one minimized task window on demand.
Closing the last task retires that extension-owned window. Do not pre-open one
window per profile or activate Chrome merely to inspect it.

Website-triggered popups can bring Chrome forward; ordinary task tabs must
still stay inactive. This accepted limitation does not authorize agent-driven
activation or waive cleanup of exact task-owned popup descendants. A finished
task's owned popup left after `close` is a cleanup failure; report the exact
error to the runtime maintainer without closing guessed or user-owned tabs.

Only when the user explicitly asks for help in the tab they are currently using,
claim that exact focused tab at cold session bootstrap:

```bash
IFS= read -r task_uuid </proc/sys/kernel/random/uuid
browser_session="current-help-${task_uuid//-/}"
agent-browser --session "$browser_session" --current-tab get url
```

The one-shot claim rechecks the focused profile/window/tab and fails closed if it
changed or belongs to another agent's task. Repeat the same `--account`, `--session`, and
`--current-tab` selectors on every later command in that claimed session.
`close` detaches from a user-claimed tab; it does not close that tab. Never use
`--current-tab` merely because a tab is
convenient, and never select by title, index, visual proximity, keyboard, or
mouse guess.

Verify the returned URL before acting. A newly selected address is not proof
that its document has rendered; initial claim needs the intended page loaded
and still focused. After attachment, Chrome may be minimized without disrupting
the retained session. Multiple explicitly invited agents may share one user tab;
the runtime serializes complete commands on that tab. Each agent keeps its own
session and detaches separately. Prefer independent owned tabs for independent
work: sharing one tab does not make its actions run in parallel.

For unavoidable user-only input, keep the exact named session. With the user's
permission, use the narrowly scoped `foreground --input-boundary TYPE` command
described in [commands](references/commands.md); otherwise identify the tab for
the user to select. After input, `background` must repeat the exact account,
session, and `--current-tab` prefix when applicable. It conditionally returns
only while the saved handoff is still valid. Cancellation, denial, an
unconfirmed result, or no handoff does not promise focus; do not retry or force
focus. Resume the same session after input and close it when the shared work is
finished. Never request secrets in chat or shell commands.

## Fast Token-Cheap Loop

Choose the smallest useful command: compact/scoped `snapshot` for controls,
`get` or `is` for a specific value/state, `find` for a semantic control,
`screenshot` for pixels, and `console` / `errors` for page diagnostics.
See [commands](references/commands.md) for syntax and availability. New
full-page/selector/JPEG capture, relative uploads, error-buffer clearing,
and bounded JSON improvements are available in the verified installed revision.
Use the ordinary command; do not switch binaries to access them.

```bash
IFS= read -r task_uuid </proc/sys/kernel/random/uuid
browser_session="browser-task-${task_uuid//-/}"
agent-browser --session "$browser_session" open URL
agent-browser --session "$browser_session" snapshot -i --compact
# act with fresh refs and verify the relevant visible result
agent-browser --session "$browser_session" close
```

For an explicitly selected enrolled account:

```bash
IFS= read -r task_uuid </proc/sys/kernel/random/uuid
: "${browser_account:?Set the requested alias from the local operator mapping}"
browser_session="account-task-${task_uuid//-/}"
agent-browser --account "$browser_account" --session "$browser_session" open URL
agent-browser --account "$browser_account" --session "$browser_session" snapshot -i --compact
agent-browser --account "$browser_account" --session "$browser_session" close
```

Repeat the same explicit `--account` on every command in a non-default profile
session. Omitting it selects the runtime default for that invocation and can
misroute or fail the workflow; do not rely on a later conflict to catch the mistake.
Retain the exact account/session values across tool calls; shell variables may
not survive a new call. Put engine output flags after the command, for example
`snapshot -i --compact --json`, after the usual account/session prefix.
JSON is a format, not a guarantee of small output; scope the observation first.

- Reuse one named session for one workflow. The writer boundary is its owned
  tab tree, not the whole account/profile.
- Session names must be unique across concurrent agents. When browser lanes are
  independent and parallel work materially shortens wall time, run them
  concurrently in separate owned sessions/tabs—even in the same profile. Keep
  dependent actions on one tab serialized. The current broker supports up to 16
  total live sessions; open only the few actually needed and close each promptly.
- Snapshot before interaction. Re-snapshot only after navigation, reload, save,
  dialog, or a material DOM change because old refs then become stale.
- Prefer fresh refs or semantic controls. Scope `get`/`snapshot` output to the
  relevant selector; never dump `get text body` by default.
- Wait for an observable selector, URL, load state, or visible result. Do not use
  arbitrary long sleeps.
- Capture a screenshot only when visual evidence adds value.
- Do not load reference files for a simple one-page flow.

Run the matching `close` promptly when finished, including after failure or
cancellation, unless the exact tab is still in active collaboration with the
user or awaits genuine user-only input. It closes only task-owned targets while
preserving the user's real Chrome, unrelated tabs, authentication, extensions,
and settings. Retain the original account/session during collaboration or input;
do not leave finished or blank task targets for later cleanup.

## Proof And Recovery

Perform the same actions a real user performs and verify the final visible state.
A successful CLI exit proves transport only. For saved settings or submitted
forms, reload or reopen when persistence is part of acceptance.

The wrapper starts an offline enrolled profile once and waits for its extension
to reconnect automatically. If the command still fails, do not repeat the same
`open`; preserve its compact error for diagnosis against the installed wrapper,
broker and extension. Never fall through to another browser or profile, and
do not use the retired controller's `browser-runtime doctor` as a current-path
ritual.

Pairing is profile-local and requires one explicit user gesture for that exact
profile. Previously enrolled profiles should reconnect during ordinary
broker/profile turnover without another approval. A fresh pairing/approval
request during intended reuse is a red—do not click it automatically or claim
that an enabled extension is enrolled.

Only request user input after the correct saved profile and visible sign-in path
are exhausted and the live page proves a genuine user-only boundary. Keep the
exact tab/session, finish the flow afterward, and close the task session. Never
print, export, copy, or persist
credentials, cookies, tokens, one-time codes, wallet vaults/recovery data,
private bodies, or payment data.

## Conditional References

- `references/commands.md`: less-common CLI commands.
- `references/snapshot-refs.md`: ref lifecycle and selector troubleshooting.
- `references/authentication.md`: login, OAuth, and genuine human-input bounds.
- `references/session-management.md`: reuse, account lanes, and cleanup.
- `references/browser-state-recovery.md`: stop-and-route boundary when Chrome,
  profile, extension, wallet, or transport state appears damaged. It grants no
  ordinary recovery or mutation authority.
- Other legacy donor references in this directory are not authority for the
  private authenticated route. Do not use their commands until their parser and
  permissions are verified against the installed wrapper and page capability.
