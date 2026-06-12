---
name: agent-browser
description: Use when needing to navigate websites, verify deployments, check dashboards (Google Ads, Stripe, Cloudflare), test features as a real user, inspect rendered pages, capture screenshots, prove visual state, handle login/account/admin-console workflows, or do any browser automation. Also use when the user says "use agent browser", "visual verification", "visual proof", "verify what renders", "check page in browser", "test", or "verify" a web feature.
---

# Agent Browser

CLI browser automation via `agent-browser` (Rust binary, v0.13.0).

## Default Use Policy

Use Agent Browser first when the request involves a rendered webpage, visual proof, screenshots, clicking, filling, login, account setup, OAuth/admin consoles, local web app previews, or any flow where cookies, JavaScript rendering, or browser identity matter.

Use terminal/curl first only for pure API/status/header/DNS checks where rendered browser state is irrelevant. If the task has 3+ independent URLs/pages/sections, switch to browser-swarm or parallel Agent Browser sessions; for 1-2 pages, use named sessions directly.

## Tab and Session Cleanup Rule

Treat every Agent Browser tab and session as temporary. Close finished, failed, duplicate, wrong-account, irrelevant, or no-longer-useful pages immediately instead of leaving them around for later.

Before reporting browser work as done, close every Agent Browser tab/session you opened:

```bash
agent-browser tab close <index>       # Close one finished tab in the current session
agent-browser close                   # Close the default session/tab
agent-browser --session <name> close  # Close a named session/tab
```

Only keep a tab open when it is still needed for active user-visible state, in-progress login/2FA, or a specific follow-up the user asked to inspect. If anything is intentionally left open, say which tab/session remains and why.

## Step 0: Launch Chrome (MANDATORY — Run Before Anything Else)

Before ANY agent-browser command, run:

```bash
start-chrome-debug
```

This detects the platform (WSL or native Linux), launches Chrome with a **persistent profile** (saved cookies — Google, Stripe, etc.), and connects `agent-browser` on port 9222. If Chrome is already running correctly, it reconnects instantly.

- **WSL**: Launches Windows Chrome via PowerShell with the `ChromeCDP` profile
- **Native Linux**: Launches `google-chrome`/`chromium` with `~/.config/agent-browser-chrome` profile

**One-time sign-in**: ChromeCDP is a dedicated automation profile (required by Chrome 136+ security — the default profile cannot use CDP). Sign in to Google/Stripe/etc. **once** in the CDP Chrome window. Cookies persist across all future sessions.

**CRITICAL RULES:**
- **NEVER launch Chrome manually** (`google-chrome`, `chromium`, `chrome.exe`). Always use `start-chrome-debug`.
- **NEVER launch a separate browser instance.** agent-browser manages its own CDP connection.
- For account/admin work, connect each named work lane to the real Chrome CDP port before opening pages:
  ```bash
  start-chrome-debug 9222
  agent-browser --session <name> connect 9222
  agent-browser --session <name> open <url>
  agent-browser --session <name> snapshot -i
  ```
- If `start-chrome-debug` reports an error, run `browser-runtime doctor` and fix the smallest clear runtime issue before falling back.

Clean-profile exception: do not start with `AGENT_BROWSER_CONFIG=/tmp/agent-browser-clean.json` for account work, but switch to it after one real-CDP retry if page loads repeatedly abort, land on extension/offscreen pages, show the wrong browser identity, or fail before login UI appears. State clearly that the clean config will not have the user's cookies, extensions, saved passwords, or logged-in sessions.

## Environment (Pre-configured)

Environment variables in `.bashrc` — do not modify:

- `AGENT_BROWSER_HEADED=1` — visible Chrome window, user can interject anytime
- `AGENT_BROWSER_AUTO_CONNECT=1` — auto-discovers running Chrome CDP
- `AGENT_BROWSER_SESSION="claude-${PPID}"` — each Claude session gets its own isolated daemon/tab
- `AGENT_BROWSER_ARGS` — anti-bot-detection flags

The persistent Chrome profile has saved cookies. After running `start-chrome-debug`, no login needed.

## Phase 0: Inspect the Live UI First

Do not default to external WebSearch before using the browser. Start with the live page unless the flow is high-risk, unfamiliar, or blocked.

Default order:
1. Open the page.
2. Snapshot the real UI.
3. Attempt the direct interaction path.
4. Escalate to external research only if the flow is complex, changed, blocked, or high-risk.

Good reasons to search first: OAuth/login/consent/admin flows, complex SPAs with unclear navigation, high-stakes forms where misclicking is risky, or repeated blockers after observing the live UI.

## Core Workflow

```bash
# Navigate + wait + get element refs
agent-browser open URL && agent-browser wait --load networkidle && agent-browser snapshot -i --compact

# Interact using @refs from snapshot
agent-browser click @e5
agent-browser fill @e3 "text"

# Re-snapshot after DOM changes (refs become stale)
agent-browser snapshot -i --compact
```

Chain commands with `&&` for speed. Use separate calls when you need to parse output before next step.

Diagnostic budget: once a screenshot shows the expected page, stop probing. If browser evidence fails, run only the smallest focused set: `agent-browser get url`, `agent-browser errors`, one HTTP/status or `browser-runtime preflight` check, and one targeted DOM/canvas probe. Do not repeat diagnostics unless a recovery step changed the state.

## Session Isolation (Automatic)

Each Claude Code session gets its own isolated Chrome tab via `AGENT_BROWSER_SESSION="claude-${PPID}"`. Multiple sessions NEVER share tabs — each daemon creates a fresh target on connect. No configuration needed.

## Parallel Verification (Multi-Tab)

Use `tab new` to open multiple pages simultaneously within one session:

```bash
# Open multiple tabs for parallel checks
agent-browser tab new https://site.com/page1 && agent-browser tab new https://site.com/page2

# List all tabs (shows index numbers)
agent-browser tab list

# Switch to tab by index, then screenshot/snapshot
agent-browser tab 0 && agent-browser screenshot page1.png
agent-browser tab 1 && agent-browser screenshot page2.png

# Clean up when done
agent-browser tab close 1 && agent-browser tab close 0
```

Or use `ab-parallel` for bulk checks:
```bash
ab-parallel check https://site.com/page1 https://site.com/page2
```

**When to use tabs vs sequential `open`:**
- **Sequential `open`**: Same tab, navigating through a flow (login → dashboard → settings)
- **`tab new`**: Parallel verification — checking multiple independent pages without losing state

## Testing / Verification Workflow

When user says "test" or "verify" a feature:

1. **Act as a real user** — click, type, fill forms (not programmatic tests)
2. **Trigger the action** — submit form, click button, complete flow
3. **Verify downstream effects:**
   - Check the database (SSH + SQL query)
   - Check other pages where the change should appear
   - Use `ab-parallel` for multi-page checks
4. **Take screenshots** as evidence at each step
5. **Check console** — `agent-browser errors` must be clean

Example: fill checkout email + submit -> verify Purchase row in DB -> verify success page -> verify admin dashboard updated.

## Gate Requirements

The hook system tracks agent-browser calls. Gate clears when ALL met:
- Interacted (click/type/fill — not just navigate)
- Visited 2+ pages
- `agent-browser errors` returned clean
- `agent-browser screenshot` taken

## Key Commands

| Command | Purpose |
|---------|---------|
| `open <url>` | Navigate |
| `snapshot -i --compact` | Accessibility tree with @refs, compact (fewer tokens) |
| `click @e1` | Click element |
| `fill @e1 "text"` | Clear + type |
| `type @e1 "text"` | Append text |
| `screenshot --format jpeg --quality 80` | Capture page (JPEG = 3-5x smaller than PNG) |
| `errors` | Check console errors |
| `get text @e1` | Extract text |
| `get url` | Current URL |
| `eval <js>` | Run JavaScript |
| `wait --load networkidle` | Wait for page load |
| `tab new [url]` | Open new tab (optionally navigate) |
| `tab list` | List all tabs with index numbers |
| `tab <n>` | Switch to tab by index |
| `tab close [n]` | Close tab (current or by index) |

## Multi-Agent Coordination

Use `ab-tasks` for inter-session coordination (no daemon needed — pure file I/O):

### Coordinator + Workers Pattern

**CRITICAL: Each worker MUST use its own session.** Without this, all workers fight over one tab.

```bash
# Coordinator creates tasks
ab-tasks create "Check Amazon seller rating for WidgetCo"
ab-tasks create "Message Alibaba supplier about bulk pricing"
ab-tasks create "Scrape competitor pricing on eBay"
```

Each worker agent must set a unique session before any browser commands:
```bash
# Worker sets unique session (gets its own independent Chrome tab)
export AGENT_BROWSER_SESSION="worker-1"
ab-tasks claim                                    # Claims next pending task
agent-browser open <url-from-task>                # Own tab, no conflicts
agent-browser snapshot -i --compact
# ... do the work ...
ab-tasks complete <id> "result data"              # Mark done with result
ab-tasks share worker1_finding "key insight"       # Share with other workers
agent-browser close                                # Clean up own session
```

Workers run in TRUE parallel — each has its own daemon, its own Chrome tab, zero interference.

If a worker opens a bad page, hits the wrong account, or learns a page is useless, it closes that tab/session immediately before claiming another task. Do not let failed exploratory tabs pile up.

### Fast Execution: `ab-workers`

For mechanical tasks (open URL, get data, report back), use `ab-workers` instead of AI agents — 3x faster, zero AI overhead:

```bash
# 1. Create tasks
ab-tasks create "Get title from https://example.com/page1"
ab-tasks create "Get title from https://example.com/page2"
ab-tasks create "Get title from https://example.com/page3"

# 2. Execute all in parallel (5 workers default)
ab-workers           # Claims all pending tasks, runs in parallel bash workers
ab-workers 10        # Use up to 10 parallel workers
```

`ab-workers` auto-claims tasks, opens each URL in its own session/tab, gets the title, completes the task, and shares results. Use AI agents only when the task needs reasoning (form filling, navigation decisions, data interpretation).

```bash
# Coordinator checks progress and collects results
ab-tasks list                                      # See all tasks + status
ab-tasks shared                                    # Read results from all workers
```

### Shared State
```bash
ab-tasks share <key> <value>    # Write (scoped to AGENT_BROWSER_SESSION)
ab-tasks shared [key]           # Read across all sessions
```

## agent-browser connects directly to Chrome via CDP. No other browser engines.
