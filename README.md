# agent-browser — AI browser automation for your real Chrome

## Breaking. Browser automation just got completely replaced.

**Your real Chrome as you. Real cookies. Parallel AI agents. Open source.**

Reads page structure. No screenshot needed for every click.
Need pixels? **201 ms viewport capture. 731 ms full-page capture** in local tests.

One agent researches. Another tests your site. You keep working in your own tab.
When they finish, they close their tabs—not yours.

**Browser automation CLI + skills for Codex, Claude Code, and other LLM-powered agents.**
The skills teach agents to research the UI, plan the smartest path, split independent
work across tabs, and verify the result. Not just click and hope.

> “Find 5-star Amazon sellers and order from the best.”
>
> “Message 20 Alibaba suppliers.”

That's the kind of work this is built for: real websites, real accounts, real tasks.
Those are example requests, not claims of completed Amazon or Alibaba tests;
purchases and messages still need your authorization.

Built by [Caleb Dane](https://github.com/CalebDane7), on
[Vercel Agent Browser](https://github.com/vercel-labs/agent-browser).

> **Development status:** the improved engine is installed locally, with real-Chrome
> installation, rollback and reapply checks passed. Portable setup and automatic
> app return still have limits. [Current limits →](#current-limits)

## How agent-browser Is Different

**The best all-around agent browser should finish your work—not give you
another browser to babysit. That's the case for this fork.**

The original plan was bigger than faster clicks: keep Vercel's action engine,
give agents the Chrome you're already signed into, and let several of them work
beside you without fighting over tabs, dragging windows forward, or leaving a
pile of finished pages in RAM. Pair the runtime with skills that teach agents
to use that freedom well. Judge the combination, not one isolated feature.

- **Real Chrome, real cookies** — your actual browser session, with the sign-ins
  already in your enrolled profile. No copied login store.
- **Token-efficient browser automation** — compact page structure and element
  references instead of an image or a giant page dump at every step.
- **Fast screenshots** — inspect fresh pixels without dragging Chrome in front
  of the work you're doing. [See the measured capture times.](#screenshots-in-under-a-second)
- **Independent sessions** — run multiple AI agents simultaneously on the same
  machine. Each owns its task tabs; closing one task leaves the others running.
- **Headed, not a separate hidden browser** — watch the AI work when you choose.
  Keep Chrome minimized when you don't. Ordinary commands don't demand the foreground.
- **Agent skills included** — instructions for Codex, Claude Code, and compatible
  LLM agents: plan, act, verify, clean up. A skill alone does not install the runtime.

## You and Your AI Share the Same Browser

**agent-browser is a CLI that gives AI agents control of your real Chrome browser.**
The one with your profiles, your extensions, and the websites you're already using.

- **Watch the AI work** — inspect its tabs whenever you want.
- **Jump in anytime** — navigate to a page, then ask “now fill out this form” or
  “click that button.” An explicitly invited agent can help in that selected tab.
- **Keep working** — independent agents use their own background tabs, not the
  one you're typing in. Minimize Chrome and carry on.
- **Finish without the mess** — agents close completed task tabs to free memory.
  Your own tabs and active co-working tabs stay open.

Same profile means shared website login—not permission to hijack another agent's
tab. You can explicitly invite several agents into your own tab; complete
commands take turns there, and detaching leaves your page intact.

## What It Actually Does (Plain English)

- **Open websites** — navigate, go back, and go forward.
- **Read the page** — get buttons, links, text fields and headings as a compact
  accessibility snapshot the agent can act on.
- **Click things** — use fresh element references such as `@e1`.
- **Fill out forms** — type text, select options, check boxes and press Enter.
- **Take screenshots** — capture the viewport, a full page or a selected section.
- **Run JavaScript** — inspect or interact with the task's page.
- **Track errors** — read the task's console and error output.
- **Manage task tabs** — open independent work and close it when finished.

All through one command-line tool: `agent-browser`. The configured private route
limits commands to the agent's granted page; it does not expose every upstream
browser-wide feature. [Usage and setup](#usage-and-setup) covers the supported route.

## Use It as a Codex Skill, Claude Code Skill, or LLM Browser Tool

**Agent Browser** opens pages, reads controls, fills forms and takes screenshots.
Its ownership rules decide which agent may use or close each task tab.

**The operator skill** teaches the everyday loop: split independent work, open
owned tabs, read compact snapshots, act, verify, and close. It keeps agents from
wasting time on unnecessary screenshots, oversized page dumps or repeated failures.

These are instructions paired with a command-line tool—not a Claude-only plugin.
Use them with **Codex, Claude Code, or another agent that can read instructions
and run local commands**. A model without tool access needs that connection first;
skill discovery and caller-identity integration depend on the agent host.

## Screenshots in under a second

Measured local candidate captures, including the complete CLI call:

| Capture | Time |
| --- | ---: |
| Viewport PNG | **201 ms** |
| Full-page PNG | **731 ms** |
| Tall page section | **579 ms** |
| JPEG, quality 80 | **694 ms** |

These checks verified fresh pixels and no focus changes during capture.
They are scoped observations on this machine—not a universal latency promise
or a matched “10× faster than stock” benchmark.

For reading and clicking, compact snapshots avoid sending an image every step.
Bounded output keeps huge pages from flooding the agent's context. That is how
the design limits unnecessary model input; there is no fixed cost-saving
percentage to promise.

## Sessions That Don't Step on Each Other

**Session A can test your login page while Session B tests the checkout flow.**
Simultaneously, on the same machine. An agent doing independent work should not
wait behind another agent's entire task.

- Give each independent agent its own task session and tabs.
- Use a few at a time; the current ceiling is **16 live sessions**, not hundreds.
- Open tabs only when needed. Nothing reserves 16 browsers or prewarms idle tabs.
- Close finished tasks promptly; keep tabs still being used with the user.
- Serialize changes to the same account state. Shared login does not mean shared tab ownership.

More agents still consume more memory and model tokens. Parallelize when it
finishes the job sooner—not to keep every slot busy.

## Vercel Agent Browser, Improved for Parallel Work in Your Chrome

Vercel supplies the native action engine, compact snapshots, element references,
named sessions and tab pinning. This fork adds the Windows Chrome integration
around it: real caller ownership, background task tabs, shared profile
connections and exact cleanup across owner lifecycles.

Focused engine patches also address screenshot geometry, below-viewport
capture, bounded JSON and direct-page integration. The [full history](#the-full-improvement-history)
separates upstream work from this fork's changes.

**The payoff: your AI spends its time on the job—not fighting another agent for
a tab, waiting on a screenshot, or making you log into a copied browser.**

This comparison uses pinned [Vercel Agent Browser v0.36.0](https://github.com/vercel-labs/agent-browser/tree/eb05921bad874cd2a1b4fa5d1149f1ed26576cae).
Standard Agent Browser already supports sessions sharing Chrome; we do not
claim to have invented that, or to beat every newer release at every task.

## agent-browser vs Playwright, Playwright MCP, and PinchTab

Looking for a **Playwright alternative**, a **PinchTab alternative**, or
**browser control for AI agents**? The important question isn't just “can it
click?” It's what happens when several agents work in the browser you're using.

| Tool | What to compare |
| --- | --- |
| [Vercel Agent Browser](https://github.com/vercel-labs/agent-browser) | The upstream CLI, compact snapshots, sessions and tab pinning this work builds on. |
| [Playwright MCP](https://github.com/microsoft/playwright/tree/main/packages/extension#multiple-clients) | Structured snapshots and existing logged-in Chrome; its extension also supports simultaneous clients with separate tab groups and one-client-per-tab access. |
| [Playwright CLI](https://github.com/microsoft/playwright-cli) | A CLI-and-skills route with snapshots, named sessions and existing-browser connections. |
| [PinchTab](https://pinchtab.com/docs/attach-chrome/) | A bridge for externally owned Chrome using a browser-level CDP endpoint; it rejects page-level attach endpoints and preserves external Chrome when the bridge stops. |
| **This fork** | Vercel's engine paired with caller-bound tab ownership, shared profile connections, background operation, exact cleanup and the Agent Browser skill. |

**Real Chrome and multiple sessions are the starting point. The whole working
experience is the reason for this fork:** caller-bound tab authority, background
work, exact cleanup, fast fresh captures, compact output and practical agent
skills together. Other tools also organize concurrent clients; this project's
case rests on its demonstrated integration, not on pretending they cannot.
The [improvement history](#the-full-improvement-history)
shows exactly what Caleb added, and the [release limits](#current-limits) show
what still needs finishing.

## Real Chrome. Real Cookies. Your Actual Browser Session.

Use the sign-ins in your normal Chrome profile instead of rebuilding a login
inside a disposable browser. Work with authenticated dashboards, admin panels,
SaaS tools and the other websites you already use.

The transport must not copy profiles, change wallet settings or tamper with
other extensions' private data. It keeps its own ownership records separately.

Real Chrome is not a promise of invisibility. Websites can still detect
automation, expire sessions, require 2FA or show CAPTCHAs. Saved authentication
removes needless setup; it does not remove a site's security checks.

## Who This Is For

- **AI developers** building agents that need to interact with real websites.
- **Codex and Claude Code users** who want their AI to test, verify and automate
  browser tasks in the Chrome they already use.
- **Teams running parallel AI agents** that need explicit tab ownership and cleanup.
- **People comparing Playwright or PinchTab alternatives** for authenticated
  Chrome automation, compact snapshots and multi-agent work.
- **Anyone who wants AI to handle real-world browser tasks** without making
  browser babysitting another job.

## The full improvement history

Every change below serves the same purpose: less waiting, less interruption,
and less risk of an agent touching the wrong thing. The details also separate
what came from upstream, what we added, and what still needs finishing.

<details>
<summary>From the original custom browser to the current integration: what changed and why</summary>

### 1. Reuse the engine. Put our work into making it a better coworker.

The earlier fork rebuilt the raw CDP transport and page/action layer around a
Rust CLI and Node daemon. That gave us direct control, but also made this
project responsible for low-level browser behavior that upstream continued to
develop.

The modernization separates the jobs. Vercel's pinned native engine handles
actions and snapshots. Our wrapper, broker and extension handle who may use
which profile and tab. We keep the part that makes this a coworking browser
without maintaining a second implementation of every click.

### 2. Use the real profile, not an imitation of it.

A copied browser profile can look familiar without preserving the user's
working state. Earlier recovery work made that distinction painful. The rule
now is explicit: Agent Browser transport work must not copy profiles or touch
wallets, credentials, other extensions' private state, or hardware-wallet
settings. The transport keeps its own tab-ownership records separately.

We moved the transport into an extension in each enrolled Chrome profile,
connected through a local native bridge. The broker shares those native
connections among agents; enrollment is per profile. The extension still
attaches Chrome's debugger separately to each owned tab. Reusing the transport
does not mean one debugger attachment covers the whole browser. Chrome's own
consent and security boundaries still apply. This is not an auto-clicker for approval
dialogs, nor a promise that permission can never be revoked.

### 3. Know who owns a tab—not just what they named the task.

Two agents can choose the same name. Names alone therefore cannot decide who
owns a tab or who may close it. The wrapper binds a task to its actual caller
and thread; the broker gives the engine authority over that task's page, not
the whole browser.

That narrower authority also required a focused upstream patch: the engine's
direct-page liveness check must use a page-level operation. Giving it
browser-wide target discovery merely to pass a health check would defeat the
ownership boundary.

### 4. Let one agent keep working when another gets stuck.

One blocked page must not freeze every agent using the same profile. An earlier
profile-wide queue did exactly that. Page work now runs in session-specific
queues, with a separate teardown lane so a stalled command cannot make cleanup
unreachable.

Cleanup has its own order. Removing the last task window could disconnect
native messaging before the close acknowledgment reached the broker. The
repair retires task state before final window cleanup. A user tab in that
window prevents whole-window removal. An invited user tab is detached, never
treated as disposable agent property.

Late replies and reconnects must obey the same ownership rules. A delayed
response is not permission to resurrect an old task, and a fresh connection
does not inherit stale command authority. These changes belong to our
integration; they are not claims that every upstream browser has these bugs.

### 5. Get a fresh screenshot without dragging Chrome in front of you.

In minimized Chrome, surface screenshots reached a roughly 15-second deadline
while a comparable payload crossed the transport in 69 ms. That evidence
pointed away from a blanket “WSL is slow” explanation. The transport gained a
scoped internal capture path that obtains a fresh frame without activating
Chrome, then acknowledges and stops that capture.

Two separate image defects needed separate engine changes. Full-page capture
mixed device-pixel dimensions with a CSS clip, producing excess blank space on
scaled displays. Selector capture could produce the right dimensions but white
pixels below the viewport. The fixes use CSS metrics and enable capture beyond
the viewport for the requested selector. Image dimensions alone were never
enough: the checks inspect fresh content through the bottom edge.

Local candidate observations now include 201 ms for a viewport PNG, 731 ms for
a full page, 579 ms for a tall selector, and 694 ms for a quality-80 JPEG. These
are end-to-end CLI observations on this machine, not a stock-versus-fork
benchmark or a universal speed guarantee.

### 6. Give the AI the right information without burying it.

Compact snapshots and references come from upstream. The local JSON patch
closes a different gap: a text-output cap did not necessarily bound JSON
responses. The candidate keeps structured results valid, explicitly reports
omitted content, and preserves action status and required continuation fields.
Truncating a response must not turn a successful mutation into a false failure
that encourages the agent to repeat it.

Diagnostics and uploads also needed direct-page integration. Console/error
events must reach the correct owner through bounded forwarding. Upload must
identify the exact file input and translate a relative path from the invoking
CLI's working directory—not the broker's. A real relative-file upload now has
content-readback and cleanup proof. Separate diagnostics checks delivered each
generated log and error once to its intended task. Clearing one task's console
left the neighboring task's log and both error buffers intact.

One lesson belongs in the test, not the browser: a real page can emit additional
logs. An earlier check wrongly expected the fixture's log to be the only one.
The corrected check tracks unique test messages, rejects duplicates and
cross-task delivery, and leaves ordinary page logging alone. It does not hide
unexpected output to manufacture a pass.

### 7. Let agents help in your tab without taking ownership of it.

Two real agents claimed the same invited tab and sent overlapping commands.
The commands ran in order, not over each other. Detaching the first agent left
the second working; detaching the second left the page and its input intact.
The ordinary command interval had no foreground changes, and test cleanup
preserved existing tabs.

An explicitly permitted user-input request can also bring the exact task tab
forward. After input, the same owner can request a conditional return to the
saved prior app. One scoped Windows return and a separate tab-selection
cancellation journey passed; other-app interference and wider lifecycle
reliability remain separate limits.

### The focused changes to the pinned engine

The installed engine's pin records the exact donor and ordered patch hashes.
Its focused changes include:

| Patch | Reason |
| --- | --- |
| Direct-page liveness | Check the granted page without requesting whole-browser authority |
| Full-page CSS metrics and selector capture | Correct scaled-display geometry and below-viewport pixels |
| Direct-page diagnostic events | Match incoming events to the direct-page connection |
| Bounded JSON output | Limit content without corrupting the result or hiding action status |
| Object-ID upload | Address the exact file input through the scoped page connection |
| Private upload paths | Resolve caller-relative files for the Windows browser host |
| Private shared commands | Keep shared-tab command ownership through actual native completion |
| Error-buffer cleanup | Clear one task's errors without clearing its console or another task's diagnostics |

The compiled candidate also passed a real two-task `errors --clear` check in
50 ms: the selected error buffer emptied, both console buffers and the other
task's errors stayed unchanged, and both task tabs closed without taking focus.
Those measurements came from the scoped candidate checks. The selected engine
subsequently passed the ordinary installed CLI, rollback and reapply journeys.
The source and build recipe are included; byte-identical clean-room rebuilding
has not been verified.

### How the pieces connect

```text
LLM or agent → CLI / pinned native engine → local ownership broker
            → WSL–Windows native bridge → profile extension → owned Chrome tab
```

There are relays in this path. The goal is low end-to-end latency and correct
ownership, not a diagram that hides the transport.

</details>

## What we deliberately did not add

<details>
<summary>Scope, tradeoffs and what this integration does not replace</summary>

No browser per agent. No idle window for every saved profile. No copied wallet
or login store. No broad browser-control fallback when ownership fails. No
separate Google DevTools agent runtime is merged into this installation, and
WebMCP is deferred. We use Chrome's browser APIs; we do not claim to have
combined every Google agent product into this fork.

If you need a portable general-purpose browser CLI, standard Agent Browser may
be the simpler choice. Choose this integration when agents need to work beside
you in your existing Windows Chrome profiles, with explicit control over whose
tabs they may use and close.

</details>

## Usage and setup

<details>
<summary>Commands, parallel sessions, user-tab help and installation requirements</summary>

## Work in parallel, without opening a browser per agent

Independent agents use separate named task sessions. Several sessions can work
in the same profile at once. They share that profile's normal website login and
cookies; they do **not** share ownership of task tabs or element references.

The wrapper also binds the session name to the real agent's identity. Two
agents choosing the same name receive different tabs. Keep an ongoing task in
its original agent; copying its name to another agent is not a handoff.

The current limit is 16 live sessions, not 16 preallocated browsers. Open only
what is needed. A closed enrolled profile starts on demand without a startup
window; its task window is created minimized and retired when its last owned
task closes, provided no user tabs would be lost.

Parallelize independent pages. Serialize work on shared account state when
simultaneous changes could interfere with each other.

## The ordinary workflow

On an already configured installation, choose an enrolled account handle and
keep the same account, session and agent for the whole task:

```bash
agent-browser --account ACCOUNT --session TASK open https://example.com/
agent-browser --account ACCOUNT --session TASK snapshot -i --compact
agent-browser --account ACCOUNT --session TASK click @e1
agent-browser --account ACCOUNT --session TASK close
```

`ACCOUNT` and `TASK` are placeholders. Use a fresh reference from the actual
snapshot, not the example's `@e1`. Put command-specific options after the command:
for example, `snapshot -i --compact --json`.

Use compact snapshots for page structure and available controls. Use screenshots
when pixels matter. Refresh references after navigation or a material page
change. Wait for command exit and check the requested result—not just an early
success line.

Close a finished task on success, failure or cancellation. Keep a tab only while
the user is collaborating in it or genuine user-only input is pending. Closing
a task removes its owned tabs; it must not close a user's pre-existing tab or a
neighboring agent's work.

Confirmed native owner-process death also permits exact cleanup. A child agent
can finish while its shared native process stays alive, so each child must
still close its own task. A parent cannot clean up a child's tab merely by
repeating its session name.

## Help in the user's tab

An explicit request to help in the currently selected tab uses `--current-tab`
with a fresh session. The initial claim checks the exact focused profile and
tab. Once claimed, interaction continues even if the user minimizes Chrome.
Matching `close` detaches and preserves the user-owned tab.

Several explicitly invited agents can claim that user tab using separate
sessions. The runtime serializes complete commands and each agent detaches
separately. Independent research still belongs in separate owned tabs.

At genuine user-only input, `foreground --input-boundary ...` can show the exact
task tab with permission. After input, `background` must use the exact same
account, session, and `--current-tab` prefix when applicable. It returns to the
saved prior app or tab only while the handoff's focus history is unchanged.
Cancellation, denial, an unconfirmed result, or no handoff is not a promise about focus. Do
not retry or force focus. Keep the session while the user supplies input; never
activate Chrome merely to inspect it.

## Setup and trust

Agents: start with the [fast setup and reuse guide](skills/agent-browser/references/setup.md).
An existing installation goes straight to the task. First-time setup separates
the files an agent prepares from the per-profile consent only the user can give.

This is currently a Windows Chrome plus WSL integration, not a portable
one-command npm install. It needs the pinned engine, wrapper and broker, WSL
relay, Windows native host, and a transport extension enrolled separately in
each chosen Chrome profile. Machine-local enrollment data is not a public
installation template.

During unpacked-extension development, changing the connection code requires
an extension reload in each affected profile. Reconnecting is not the same as
loading the update. This is a development-update step, not a new approval for
every task. See [Chrome's reload requirements](https://developer.chrome.com/docs/extensions/get-started/tutorial/hello-world#when-to-reload-the-extension).

The extension's debugging permission is powerful. Enrollment requires the
user's consent; ordinary reuse should not repeatedly request it. A fresh prompt
is a connection problem to diagnose, not permission to auto-click it or weaken
Chrome's protections.

The control path must not copy profiles, export credentials or cookies, alter
wallet storage, reset extensions, or change hardware-wallet/USB settings.
Working in a signed-in browser does not authorize a payment, signature or other
account action beyond the user's request. Sites can still expire logins,
require two-factor authentication, detect automation or display CAPTCHAs.

</details>

## Current limits

The local engine and operator skill are updated. Live Windows checks verified
return to the previous app and Chrome tab after an explicit input handoff.
Switching tabs or independently minimizing the task window cancelled the return,
without pulling focus back. Windows can still refuse foreground activation;
the browser reports failure instead of forcing it. First-time Windows/WSL setup
still requires agent-assisted installation and per-profile enrollment, not a
one-command npm install. The supplied build is pinned and its source recipe is
documented; byte-identical clean-room reproduction is not claimed.

<details>
<summary>What the live checks establish—and their limits</summary>

- Normal owned-tab interaction, parallel same-profile work, exact native-owner
  cleanup, and installed parent/child name isolation have scoped browser proof.
  These do not establish every command, screenshot mode or lifecycle case.
- Local checks measured ordinary viewport PNG capture at 201 ms, full-page
  PNG at 731 ms, a below-viewport selector PNG at 579 ms, and JPEG at 694 ms. The
  candidate engine returned fresh pixels at the correct extent without foreground
  transitions during those tasks, and closed its tabs. These observations do
  not prove universal latency. The JPEG used the newly combined transport;
  earlier PNG proofs remain scoped to their tested revisions. An initial
  enrolled-profile attempt rejected the capture command (`OP_NOT_ALLOWED`).
  After separate reload/runtime binding, quality-80 JPEG passed in 589 ms with fresh
  pixels, exact task cleanup and no foreground events during the journey. That
  closes the tested candidate path; it does not prove the subsequently staged
  worker, shared user-tab behavior, popup no-focus behavior or the full release.
- Two invited agents sharing one user tab passed overlapping-command,
  detach/survival and exact-cleanup checks. Explicit user-input foregrounding
  also passed its separate check. One scoped Windows handoff returned to the
  exact prior app in 65 ms; a separate tab away/back journey correctly cancelled
  the handoff without changing foreground. On the reloaded Erebora extension,
  restoring the previous tab took 61 ms. Independently minimizing its isolated
  task window cancelled return in 44 ms, with no transient focus return. Both
  task tabs were confirmed closed. These checks do not guarantee activation
  under every Windows condition or cover every installed profile/generation.
  Programmatic popup switching is not available.
- Relative-path upload passed actual file-content readback in 58 ms on the
  candidate, with exact cleanup and no foreground transition. It depends on
  Chrome's local-file-access permission; it is not general filesystem authority.
- Generated console/error delivery and console-clear isolation passed separate
  two-task checks. These do not prove every diagnostic shape or event volume.
  A separate compiled-candidate check also proved `errors --clear` isolation:
  clearing one task's errors preserved both consoles and the other task's errors.
- The candidate engine returned valid bounded JSON for an oversized text
  result and preserved a short result. That closes the tested output case,
  not every command's output behavior. There is no fixed percentage of token
  savings to promise.
- The selected engine passed the normal installed command after installation,
  rollback and reapply. The final reapply opened its task in 562 ms, read the
  page in 60–65 ms, and closed in 482 ms, preserving existing tabs. These are
  local observations, not universal timing guarantees. WebMCP is deferred;
  a separate Google DevTools agent runtime is not part of this installation.

Use the Agent Browser skill for everyday browsing. Keep the code's failure
guards and explanations of why they exist; they protect behavior, not a
permanently frozen architecture.

</details>

## Upstream credit

### Vercel maintainers: here's the work you can inspect and reuse

**Caleb Dane built this on your engine—not to bury your contribution, but to
take it further in the browser people already use.**

Start with the focused patches: [full-page and selector screenshot geometry](scripts/patches/agent-browser-v0.36.0-full-page-css-metrics.patch),
[bounded JSON without losing action status](scripts/patches/agent-browser-v0.36.0-bounded-json-output.patch),
and [isolated error-buffer cleanup](scripts/patches/agent-browser-v0.36.0-errors-clear.patch).
The [source and build notes](scripts/agent-browser-engine-build.md) identify the
pinned donor, ordered patches and scoped checks. The Windows profile connection,
caller ownership and cleanup layer is separate from those engine changes, so
reviewers can see which part belongs where.

This is Caleb's independent fork, not a Vercel-endorsed release. The purpose of
publishing the work is to make the improvements inspectable, reusable and worth
bringing upstream—with clear credit for both sides.

Built on [Vercel Agent Browser](https://github.com/vercel-labs/agent-browser),
with Chrome's [Debugger API](https://developer.chrome.com/docs/extensions/reference/api/debugger)
and [native messaging](https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging).
This fork adds local integration and ownership policy. Preserve the upstream
license and notices alongside the corresponding source and artifacts.

Created by [Caleb Dane](https://github.com/CalebDane7). The earlier fork's custom
CDP work and the modernization's ownership integration are part of that lineage;
the reused native action engine remains Vercel's work. Keep Apache-2.0 and the
bundled axe-core and third-party notices with their corresponding artifacts.
