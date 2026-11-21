# agent-browser — AI browser automation for your real Chrome

## Breaking. Browser automation just got completely replaced.

**Your real Chrome as you. Real cookies. Parallel AI agents. Open source.**

**Your agents get more control. You don't lose yours.**

One agent researches suppliers. Another tests your checkout. You keep working
in your own tab. No fighting over the page. No closing your work when theirs
is done.

Browser automation CLI + skills for **Codex, Claude Code, and other
command-capable LLM agents**. Built by [Caleb Dane](https://github.com/CalebDane7)
on [Vercel Agent Browser](https://github.com/vercel-labs/agent-browser).

> “Find 5-star Amazon sellers and order from the best.”
>
> “Message 20 Alibaba suppliers.”

Real accounts. Real browser work. Purchases and messages still need your
authorization.

[Get the skill and setup guide →](skills/agent-browser/references/setup.md)

## Less context. Faster eyes. More hands.

- **Up to 93% less context than Playwright MCP** — the upstream Agent Browser
  launch claim.[¹](#numbers-and-scope) Read compact page structure and act on
  element references instead of sending an image for every click.
- **201 ms viewport screenshot. 731 ms full-page screenshot.** Local,
  end-to-end CLI observations with fresh pixels and no focus changes during
  capture.[²](#numbers-and-scope) See the page without waiting seconds for every look.
- **Up to 16 live task sessions in one shared Chrome installation.** Separate
  task tabs, not a new browser for every agent. The included skill tells agents
  to split independent work immediately—and close finished tabs to free memory.

This fork keeps Vercel's compact action engine, connects it to your existing
Windows Chrome profiles, and adds enforced tab ownership and a coworking skill.
**The point of combining them: more work finished without more browser babysitting.**

## Everything you want from an agent browser. In one setup.

**Read pages without bloating the AI's context. Get screenshots fast. Use your
existing logins. Run several agents at once. Stay in control.**

You get all of that here—not just faster clicks or tidier tabs.

| What you need | What you get here |
| --- | --- |
| **Read and act without sending huge page dumps** | Compact page text and numbered controls the agent can click. |
| **See the page quickly when pictures matter** | Fresh screenshots: **201 ms viewport, 731 ms full page** in local checks. |
| **Use the accounts you're already signed into** | Your actual Chrome profiles—not a copied browser you have to set up again. |
| **Get independent jobs done at the same time** | Several agents work in their own tabs while you keep using yours. |
| **Control what each agent can touch** | Agents use their assigned tabs. They help in your tab only when invited, and cleanup leaves your work intact. |
| **Have agents use it well from the start** | A skill for Codex, Claude Code and other tool-capable agents: work in parallel, read efficiently, verify, then close finished tabs. |

**Here's how those pieces work together:** ask your AI to compare five suppliers.
Agents research them in separate tabs using your existing login. They read compact
page text, take screenshots when needed, and close their task tabs when finished.
You keep browsing throughout.

Vercel's action engine is the foundation. This fork adds the real-Chrome
connection, fast background captures, tab-control rules and the operating skill
around it. **One tool for the whole browser job—not just one step of it.**

[Compare the alternatives and see the evidence ↓](#best-agentic-browser-compare-the-whole-job)

## A browser engine—and the skill to use it well

Open websites. Read controls. Click, type and fill forms. Upload files. Run
page JavaScript. Inspect console output and errors. Capture a viewport, full
page or selected section. See
[command availability and limits](skills/agent-browser/references/commands.md).

The [operator skill](skills/agent-browser/SKILL.md) teaches agents to choose
the shortest useful path:

**Split independent work → read compactly → act → verify → close.**

Use screenshots when appearance matters, not as an expensive substitute for
every text read. Keep separate tasks moving while another needs input. Stop
repeating a failed action without new evidence. Keep a coworking tab open while
you're using it.

These are reusable instructions plus a CLI—not a Claude-only plugin. Codex,
Claude Code and other tool-capable agents can use the same skill; installation
and caller-identity integration depend on the agent host.

## Get started

**Currently built for Windows Stable Chrome + WSL.** First-time setup is
agent-assisted, with a transport extension and user-approved enrollment in each
chosen profile. This is not a one-command npm installation; installing upstream
Agent Browser or copying the skill alone does not install this integration.

Give your agent the [setup and reuse guide](skills/agent-browser/references/setup.md).
An already configured installation goes straight to work:

```bash
agent-browser --account ACCOUNT --session TASK open https://example.com/
agent-browser --account ACCOUNT --session TASK snapshot -i --compact
agent-browser --account ACCOUNT --session TASK click @e1
agent-browser --account ACCOUNT --session TASK close
```

Use your enrolled account handle, a unique task name and a fresh element
reference from the actual snapshot. Keep the same agent, account and session
through cleanup.

**[Operator skill](skills/agent-browser/SKILL.md) ·
[Commands](skills/agent-browser/references/commands.md) ·
[Setup](skills/agent-browser/references/setup.md) ·
[Recovery](skills/agent-browser/references/browser-state-recovery.md)**

## Vercel: here's the work you can bring upstream

**Vercel built the engine. Caleb built the real-Chrome coworking integration
around it—and focused engine fixes worth reusing independently.**

- **Screenshots:** corrected full-page scaling and below-viewport section
  capture. The local background path also addresses minimized-Chrome stalls.
- **Context control:** bounded JSON output keeps results valid and preserves
  action status, so truncated output does not tell an agent to repeat a
  successful action.
- **Scoped control:** page-level liveness, exact-input uploads, per-task
  diagnostics and error clearing, plus shared-tab commands that retain ownership
  until the native action finishes.

[Inspect the eight patches and build recipe →](scripts/agent-browser-engine-build.md)

[Read the detailed improvement history →](https://github.com/CalebDane7/agent-browser/blob/2f686961fc9f3a6bb83718259d9f4393bf725c5f/README.md#the-full-improvement-history)

[Join the upstream contribution discussion →](https://github.com/vercel-labs/agent-browser/issues/1823)

The recipe pins Vercel v0.36.0 and the ordered changes. This is Caleb's
independent open-source fork, not a Vercel-endorsed release. Preserve Apache-2.0,
axe-core and the bundled third-party notices with their corresponding artifacts.

## Best agentic browser? Compare the whole job.

<details>
<summary>Agent Browser vs Playwright, PinchTab and Browser Use: technical comparison</summary>

The everyday capabilities above are combined in this installation. It does not
include every feature or codebase from every competing product.

- **Vercel Agent Browser:** supplies the compact CLI, snapshots and action
  engine. Upstream already has [sessions and tab pinning](https://github.com/vercel-labs/agent-browser/releases/tag/v0.34.0).
  This fork adds per-agent tab permissions, enrolled Windows Chrome profiles,
  background capture, conditional focus return and cleanup tied to the task owner.
- **Playwright MCP / Playwright CLI:** already offer
  [existing-browser access and multiple clients](https://github.com/microsoft/playwright/tree/main/packages/extension#readme);
  [CLI + skills](https://playwright.dev/agent-cli/introduction) also targets low
  context use. This fork packages its real-Chrome control rules and operator
  skill around Vercel's engine. Playwright remains the broader choice for
  Chromium, Firefox and WebKit test suites—not something this fork replaces.
- **PinchTab:** can [attach to an already-running Chrome](https://pinchtab.com/docs/attach-chrome/)
  through a browser-level CDP endpoint and leave Chrome running when its bridge
  stops. This fork uses a per-profile extension connection and grants its action
  engine a task page instead of browser-wide target control.
- **Browser Use:** supports [local Chrome and named sessions](https://github.com/browser-use/browser-use/blob/main/browser_use/skill_cli/README.md),
  as well as [hosted cloud tasks](https://github.com/browser-use/browser-use/blob/main/CLOUD.md).
  This fork focuses on several agents working beside you in your live local
  Chrome, with explicit tab ownership, human handoffs and cleanup.

**The difference is the combination—not a claim that nobody else can use real
Chrome, take screenshots or run parallel sessions.** No matched comparison
establishes a universal speed, context or control multiplier.

### How tab control works

A tidy tab group tells you where an agent is working. This runtime also decides
**what that agent is allowed to touch**.

- **The right profile.** Use the enrolled profile you request, with its existing
  sign-ins. No copied login store or rebuilt wallet profile.
- **Its tabs—not everybody's.** Tasks are bound to the actual caller and thread.
  Two agents choosing the same task name do not gain control of each other's pages.
- **Your screen stays yours.** Ordinary commands work in background tabs,
  including while Chrome is minimized. An explicit user-input handoff can show
  the task; returning to your previous app or tab respects intervening focus changes.
- **Your tab, by invitation.** Ask an agent to help on the page you're using.
  Invite several and their commands take turns. Detaching leaves your page intact.
- **A stuck task doesn't hold the whole profile hostage.** Independent task
  commands use separate queues; cleanup has its own path.
- **Done means closed.** The skill requires prompt task cleanup. The runtime
  restricts it to owned tabs, preserves invited user tabs, and supports cleanup
  after confirmed owner-process death.

Same login does not mean unlimited control. Independent pages can run in
parallel; changes to the same account state still need coordination.

</details>

## Numbers and scope

<details>
<summary>Where the numbers come from—and the limits that matter</summary>

### Is this the lowest-context agentic browser?

**¹ Context:** Chris Tate's [Agent Browser launch post](https://x.com/ctatedev/status/2010400005887082907)
reported “Up to 93% less context than Playwright MCP.” This is an attributed
upstream claim, not a benchmark measured on this fork. A reproducible methodology
was not located. It does not mean 93% lower total cost, or establish the same
saving against today's Playwright CLI.

### Is this the fastest agentic browser?

**² Speed:** local candidate checks measured the complete CLI call: viewport PNG
201 ms, full-page PNG 731 ms, tall-section PNG 579 ms, and quality-80 JPEG 694 ms.
Those journeys checked fresh content and no foreground transitions. They are
individual observations, not averages, p95 figures, guarantees, or matched
competitor benchmarks. The earlier minimized capture path hit a roughly
15-second deadline; that was a failure to repair, not a fair competitor baseline.

**Concurrency:** 16 is the current live-session ceiling, not a 16-agent
throughput benchmark. Same-profile parallel work, caller isolation, shared-tab
command ordering and exact cleanup have scoped live-browser checks. More agents
still use memory and model tokens.

**Control:** ordinary commands stay in the background; website-triggered popups
can still take focus. Windows can refuse an explicit foreground request, and a
conditional return is cancelled when its focus history changes. These rules
govern the supported tool route, not arbitrary software with access to your PC.

**Trust and setup:** enrollment is per profile and requires your consent.
Do not copy profiles, export credentials, reset MetaMask or alter another
extension's private state as a setup shortcut. Real Chrome is not undetectable:
sites can require login, 2FA or CAPTCHAs. Programmatic popup switching and every
upstream browser-wide command are not exposed by the private page route.
Clean-room byte-identical rebuilding and portable one-command setup are not
claimed.

The [recorded live checks](https://github.com/CalebDane7/agent-browser/blob/2f686961fc9f3a6bb83718259d9f4393bf725c5f/README.md#current-limits)
preserve the individual proof scopes; the operator skill documents current use.

</details>
