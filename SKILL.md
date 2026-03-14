---
name: agent-browser
description: Use when needing to navigate websites, verify deployments, check dashboards (Google Ads, Stripe, Cloudflare), test features as a real user, or do any browser automation. Also use when user says "test" or "verify" a web feature.
---

# Agent Browser

CLI browser automation via `agent-browser` (Rust binary, v0.13.0).

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
- **NEVER run `agent-browser connect` manually** — `start-chrome-debug` handles this.
- If `start-chrome-debug` reports an error, **STOP and tell the user**.

## Environment (Pre-configured)

Environment variables in `.bashrc` — do not modify:

- `AGENT_BROWSER_HEADED=1` — visible Chrome window, user can interject anytime
- `AGENT_BROWSER_AUTO_CONNECT=1` — auto-discovers running Chrome CDP
- `AGENT_BROWSER_SESSION="claude-${PPID}"` — each Claude session gets its own isolated daemon/tab
- `AGENT_BROWSER_ARGS` — anti-bot-detection flags

The persistent Chrome profile has saved cookies. After running `start-chrome-debug`, no login needed.

## Phase 0: Research the UI (MANDATORY — No Exceptions)

Before opening ANY website with `agent-browser open`, you MUST research the current UI first. Your training data is stale. UIs change constantly. Research first, click second.

1. **WebSearch the current UI flow** — search for "[site name] [task] steps [current year]" or "[site name] UI layout [current year]"
   - Example: "Google Ads create conversion action steps 2026"
   - Example: "Stripe connect webhook endpoint setup 2026"
   - Example: "Amazon order flow current layout 2026"
   - Example: "threads.com compose new post UI 2026"
2. **Document the expected navigation path** before opening the browser:
   - Where target buttons/links/forms are in the CURRENT UI
   - What the current navigation path looks like
   - Any recent UI redesigns or layout changes
   - What form fields to fill and with what values
   - What confirmation screens to expect
3. **Then execute** using the Core Workflow below, following the researched path step-by-step

**NO EXCEPTIONS.** Not for "simple" sites. Not for "your own" sites. Not for sites you "already know." Your knowledge is stale. This is a hard gate — skip it and you WILL brute-force through wrong clicks and waste tokens.

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
```bash
# Coordinator creates tasks
ab-tasks create "Check Amazon seller rating for WidgetCo"
ab-tasks create "Message Alibaba supplier about bulk pricing"

# Worker sessions claim and execute
ab-tasks claim                                    # Claims next pending task
# ... do the browser work ...
ab-tasks complete 0 "5 stars, verified seller"    # Mark done with result

# Coordinator checks progress
ab-tasks list                                      # See all tasks + status
```

### Shared State
```bash
ab-tasks share <key> <value>    # Write (scoped to AGENT_BROWSER_SESSION)
ab-tasks shared [key]           # Read across all sessions
```

## agent-browser connects directly to Chrome via CDP. No other browser engines.
