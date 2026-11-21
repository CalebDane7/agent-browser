---
name: browser-swarm
description: "Parallel real-browser interaction swarm. Use only when the task requires operating multiple live browser pages/tabs through a real browser, especially visual login/account flows, authenticated UI proof, multi-tab form workflows, or browser-only visual verification. Do NOT use for web search, source lookup, open-ended research, multi-URL reading, competitor research, article/forum reading, or any task where normal search, fetch, curl, or local docs can answer without interacting with a real browser."
allowed-tools: Bash(agent-browser:*), Agent
---

# Browser Swarm

Use multiple agents and owned tabs when independent work in the real browser
can finish sooner in parallel. Each worker must read
[Agent Browser](../agent-browser/SKILL.md) before its first browser action.
That skill owns the current commands, account mappings, transport, capacity,
and recovery rules; this companion adds work assignment and cleanup.

Use this for independent authenticated flows, visible UI checks, browser forms,
or other work whose result depends on the live browser. Public web research,
article reading, source lookup, API checks, and local code review belong with
search, fetch, shell, or ordinary research workers. One short browser flow may
need only one agent.

## Dispatch Useful Work Immediately

Identify independent work across the remaining requested result. Dispatch each
ready lane whose concurrent run materially shortens completion after worker
startup, coordination, proof, and cleanup. Keep useful parent work running too.
On every worker return or dependency change, assign the next eligible lane
immediately; waiting for a whole batch to finish can leave useful capacity idle.

Group short checks that share a page. Splitting every page, section, or check
into its own agent can duplicate browsing and consume RAM without saving time.
Open tabs only for work that is ready to run. Do not prewarm unused tabs, create
placeholder windows, or target a fixed agent/tab count. Respect the current
broker capacity and observed host pressure when admitting more concurrency.

Run independent sessions in the same profile concurrently. Serialize commands
within one owned tab tree and actions that could race shared account state.
For a dependent flow, observe the upstream result before starting its dependent
checks; other independent work can continue meanwhile.

## Give Each Worker One Clear Ownership Boundary

Pass the requested result, allowed actions, dependencies, visible proof needed,
exact account handle, unique session name, and cleanup responsibility. Use a
semantic purpose plus a UUID for session names so unrelated tasks cannot collide.
Each owned tab tree has one writer. Keep the original worker for an ongoing
workflow: another agent using the same alias gets a different owner namespace,
not access to that tab. The installed route has no direct cross-agent transfer
command. Other agents may send requested work to the original worker, but must
not pretend they have acquired its browser ownership.

The runtime's configured default account applies unless the task specifies
another account. Resolve other accounts through the everyday skill's local
operator mapping and repeat the same explicit `--account`
on every command, including `close`. A session name does not select an account.
Verify the visible identity before account-sensitive actions.

Each worker opens its own task session through `agent-browser`; no bulk setup
helper is required. For example, one worker's sequence is:

```bash
IFS= read -r browser_uuid </proc/sys/kernel/random/uuid
: "${browser_account:?Set the requested alias from the local operator mapping}"
browser_session="account-check-${browser_uuid//-/}"
agent-browser --account "$browser_account" --session "$browser_session" open URL
agent-browser --account "$browser_account" --session "$browser_session" snapshot -i --compact
# Perform the assigned actions with fresh refs and verify the visible result.
agent-browser --account "$browser_account" --session "$browser_session" close
```

Keep browser work backgrounded. Never activate Chrome to inspect a page or
automatically claim a user tab for convenience. An explicit user invitation to
their current tab follows the everyday skill's exact claim and detach rules;
it does not allow several workers to control that tab concurrently.

## Keep Evidence Focused

Follow the real visible workflow within the assigned actions. Re-snapshot after
navigation or a material DOM change before using stale refs. Refs belong to
their session and page state; do not copy them between workers. Scope reads to
the relevant controls and use screenshots only when they change the verdict.
A successful command exit alone does not establish the requested visible result.

Never print or pass credentials, cookies, tokens, verification codes, wallet
recovery data, private account bodies, or payment data between workers or into
reports. A worker reports the observation needed for its assigned result and
the smallest safe supporting evidence.

## Close Each Owned Session and Return Its Status

After capturing the result, each worker runs the matching `close` promptly,
including after failure or cancellation, unless that exact tab is still in use
with the user or awaiting genuine input. Never close a user's pre-existing tab.
Wait for command completion and inspect the
cleanup result before reporting success. Close only that worker's exact named
session with its original account and any required selectors. Do not use broad
cleanup, close another worker's tabs, or rely on idle cleanup.

At a proven password, 2FA, CAPTCHA, hardware, or other human-input boundary,
preserve the exact session for that input. Likewise preserve a tab while the
user and agent are still working in it together. Return its account/session
identity, retention reason, and who retains ownership. Resume the same session
and close task-owned tabs when the shared work is finished; do not retain idle
or blank tabs merely for possible later work.

If a worker returns without cleanup, resume that same worker for the matching
close. Child-thread completion alone is not native owner-process death. The
installed broker cleans up after confirmed native owner death; a parent cannot
close a child's tab merely by copying its alias. If the original worker cannot
be resumed, report the exact unresolved owner/cleanup boundary to the runtime
maintainer;
do not forge owner fields, broadly close tabs, or silently report cleanup.
Preserve the compact failure: a replacement worker or an unchanged retry is
not evidence that the failed boundary changed.

Return the result or exact blocker, observed evidence, account/session identity,
and cleanup status: closed, retained for collaboration/input, or cleanup failed.
Integrate each result when it arrives and refill useful capacity. Do not retain
finished tabs or workers merely to wait for siblings.
