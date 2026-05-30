---
name: agent-browser
description: Browser automation CLI for AI agents. Use when the user needs to interact with websites, including navigating pages, filling forms, clicking buttons, taking screenshots, extracting data, testing web apps, checking rendered pages, proving visual state, logging into sites, using the real Chrome profile, or automating any browser task. Triggers include requests to "use agent browser", "open a website", "fill out a form", "click a button", "take a screenshot", "browser screenshot", "visual verification", "visual proof", "verify what renders", "check page in browser", "scrape data from a page", "test this web app", "login to a site", "automate browser actions", or any task requiring programmatic web interaction.
ai_controller_enforcement: hard_gate
ai_controller_requires_phrases_any:
  - browser automation
  - take a screenshot
  - fill out a form
  - click a button
  - test this web app
  - scrape data from a page
  - login to a site
  - automate browser actions
  - open a website
  - capture a screenshot
  - interact with website
  - use agent browser
  - agent-browser
  - visual verification
  - visual proof
  - verify what renders
  - check page in browser
  - browser screenshot
ai_controller_forbids_phrases_any:
  - browser swarm gate
  - skill router
  - hook code
  - ai-controller
  - infrastructure
  - fix the gate
ai_controller_forbids_paths_any:
  - ".ai-controller/**"
  - "**/hooks/**"
ai_controller_scoring_minimum_score: 15
ai_controller_scoring_margin_over_runner_up: 10
allowed-tools: Bash(npx agent-browser:*), Bash(agent-browser:*), Bash(start-chrome-debug:*), Bash(browser-runtime doctor:*), Bash(browser-runtime preflight:*)
---

# Browser Automation with agent-browser

## Default Use Policy

Use Agent Browser first when the request involves a rendered webpage, visual proof, screenshots, clicking, filling, login, account setup, OAuth/admin consoles, local web app previews, or any flow where cookies, JavaScript rendering, or browser identity matter.

Use terminal/curl first only for pure API/status/header/DNS checks where rendered browser state is irrelevant. If the task has 3+ independent URLs/pages/sections, switch to `browser-swarm`; for 1-2 pages, use named Agent Browser sessions directly.

## Real Chrome Profile First

For account/login work, payment dashboards, registrar/admin consoles, or any task where the user expects existing cookies, saved passwords, extensions, or their visible desktop Chrome session, use the controller-owned real Chrome CDP profile first. Do not use `AGENT_BROWSER_CONFIG=/tmp/agent-browser-clean.json`, `--profile`, `--state`, or `--executable-path` for these tasks unless the user explicitly asks for a disposable browser.

Required startup path for real-browser work:

```bash
start-chrome-debug 9222
agent-browser --session <name> connect 9222
agent-browser --session <name> open <url>
agent-browser --session <name> snapshot -i
```

For parallel real-Chrome work, every named session must connect to CDP before opening pages.

If Agent Browser reports `Failed to connect via CDP` or `localhost:9222` readiness problems, run `start-chrome-debug 9222` again and verify with `browser-runtime doctor`. Only after the real Chrome CDP path is confirmed unavailable should you use a clean temporary config, and when you do, clearly tell the user that it will not have their existing logged-in sessions.

Clean-profile exception: do not start with `AGENT_BROWSER_CONFIG=/tmp/agent-browser-clean.json` for account work, but switch to it after one real-CDP retry if page loads repeatedly abort, land on extension/offscreen pages, show the wrong browser identity, or fail before login UI appears. State clearly that the clean config will not have the user's cookies, extensions, saved passwords, or logged-in sessions.

## Core Workflow

If the task spans **3+ URLs, pages, or independently reviewable sections**, do NOT stay in this skill alone. Switch to `browser-swarm` so setup and review happen in parallel instead of sequentially.

Every browser automation follows this pattern:

1. **Navigate**: `agent-browser open <url>`
2. **Snapshot**: `agent-browser snapshot -i` (get element refs like `@e1`, `@e2`)
3. **Interact**: Use refs to click, fill, select
4. **Re-snapshot**: After navigation or DOM changes, get fresh refs

```bash
agent-browser open https://example.com/form
agent-browser snapshot -i
# Output: @e1 [input type="email"], @e2 [input type="password"], @e3 [button] "Submit"

agent-browser fill @e1 "user@example.com"
agent-browser fill @e2 "password123"
agent-browser click @e3
agent-browser wait --load networkidle
agent-browser snapshot -i  # Check result
```

## Visual Verification Fast Path

When the user asks to visually inspect, open, show, screenshot, verify what renders, check a page in the browser, or "let me see it", the first browser action must be Agent Browser against the live target page. Do not start with curl probes, DOM classifiers, canvas classifiers, route inventories, package/version checks, or repeated JavaScript probes.

Use this order:

1. Open the target in the real Agent Browser session:
   ```bash
   agent-browser --session <name> open <url>
   ```
2. Wait briefly for first render:
   ```bash
   agent-browser --session <name> wait 2000
   ```
3. Capture visible evidence immediately:
   ```bash
   agent-browser --session <name> screenshot /tmp/<name>.png
   ```
4. Read/inspect the screenshot and describe what is visible.
5. Only after the screenshot/open path fails, or the screenshot shows a blank/error/frozen page, run focused diagnostics such as `agent-browser errors`, `agent-browser get url`, a route HTTP status check, or a small DOM/canvas probe.

WHY: The old visual behavior the user expects is "open it in my real browser and show me what it looks like." Diagnostics are useful after evidence fails, but running them first wastes tokens and can hide the actual visual state behind probe noise. The canonical browser runtime still owns CDP readiness, session identity, and URL translation; this fast path only fixes the action order.

WSL ChromeCDP recovery rule: if Agent Browser reports ChromeCDP/bridge/localhost readiness problems, use the controller-owned runtime path (`start-chrome-debug`, `browser-runtime doctor`, and the resolved Windows-reachable URL). Do not enable WSL `networkingMode=mirrored`; it was removed on this machine after repeated `Wsl/Service/CreateInstance/E_FAIL` startup failures. For WSL app previews, wait for the dev server to finish compiling, try Windows `localhost:<port>` first, then use the runtime-resolved WSL IP URL or a narrow app-port portproxy if needed.

Diagnostic budget: once a screenshot shows the expected page, stop probing. If the browser evidence fails, run only the smallest focused set: `agent-browser get url`, `agent-browser errors`, one HTTP/status or `browser-runtime preflight` check, and one targeted DOM/canvas probe. Do not repeat diagnostics unless a recovery step changed the state.

## Website Automation Protocol (MANDATORY only for complex sites)

Use this protocol for multi-step, high-risk, unfamiliar, or repeatedly failing flows. For simple screenshots, obvious clicks, page checks, or straightforward forms, use the Core Workflow fast path: open, snapshot, interact, re-snapshot.

### Cheap-First Rule

Do NOT default to external WebSearch before using the browser. Start with the live page first.

Default order:
1. Open the page.
2. Snapshot the real UI.
3. Attempt the direct interaction path.
4. Escalate to external research only if the flow is complex, changed, blocked, or high-risk.

Good reasons to search first:
- OAuth/login/consent/admin flows
- complex SPAs with unclear navigation
- high-stakes forms where misclicking is risky
- repeated blockers after observing the live UI

Simple screenshots, page checks, obvious buttons, and straightforward forms should usually skip external research.

### Step 1: Research the Website's GUI

**Before touching a single element**, understand the site:

1. **Check for a cached playbook first:** Look in `references/<site>.md` (e.g., `references/linkedin.md`). If one exists, skip to Step 3 — the research is already done.
2. **Use the live page first:** snapshot key pages to understand navigation structure:
   ```bash
   agent-browser open <url> && agent-browser snapshot -i
   ```
3. **If live inspection is still unclear, then use WebSearch** for current UI guidance.
4. **Identify all form field types** — snapshot the form and classify each field:
   - `[textbox]` / `[input]` → use `fill`
   - `[combobox]` → use `select` or type partial + wait for dropdown + click option
   - `[contenteditable]` → use `eval` with innerHTML + InputEvent
   - `[checkbox]` → use `check`/`uncheck`
   - `[select]` (native HTML) → use `select`
5. **Identify navigation patterns** — How do you add new entries? Is there an "Add" button, a dropdown menu, a sidebar link? Where do modals appear?
6. **Identify potential blockers** — banners, cookie consent, terms updates, overlays that intercept clicks
7. **Identify the SPA framework** — React, Angular, Vue? This determines whether `fill` triggers state updates or if you need `eval` with event dispatch

### Step 2: Plan the Execution

1. **Map every field to its exact command** before starting:
   ```
   Title field: [textbox] → fill @eN "value"
   Company field: [combobox] → fill @eN "partial" → wait → click option
   Description: [contenteditable] → eval with innerHTML
   ```
2. **Identify independent tasks** that can run in parallel:
   - Different profile sections (Experience vs Skills vs Featured)
   - Different pages that don't share state
   - Different accounts or data sources
3. **Assign parallel agents** with isolated sessions:
   ```bash
   # Each agent gets its own session for tab isolation
   agent-browser --session task-a open <url>  # Agent 1
   agent-browser --session task-b open <url>  # Agent 2
   agent-browser --session task-c open <url>  # Agent 3
   ```
4. **Identify sequential dependencies** — tasks that MUST happen in order:
   - Within a single form: fill fields → save → dismiss post-save dialog → next entry
   - Cross-section: if section B depends on section A being saved first

### Step 3: Execute

- Follow the field-to-command mapping from Step 2 exactly
- Spawn parallel agents for independent tasks (use `--session` flags)
- Re-snapshot after every DOM change
- If a cached playbook exists in `references/`, follow it step-by-step

### Worked Example: LinkedIn Profile Automation

Here's the protocol applied to LinkedIn (full playbook: [references/linkedin.md](references/linkedin.md)):

**Step 1 result — Research findings:**
- Navigation: second "Add profile section" link (first collides with navbar) → dropdown → "Add position"
- Field types: Title=`[textbox]`, Company=`[combobox]`, Employment type=`[combobox]`, Dates=`[combobox]`, Location=`[combobox]`, Description=`[contenteditable]`, Currently working=`[checkbox]`
- Blockers: "Update to our terms" banner intercepts clicks — dismiss first
- Framework: React SPA — `fill` works on textbox/combobox, but `contenteditable` requires `eval` with innerHTML + InputEvent
- Quirks: Escape triggers "Discard changes?" dialog; Featured link auto-populated title/description breaks if modified via `fill`

**Step 2 result — Execution plan:**
- 3 independent tasks → 3 parallel agents:
  - `--session linkedin-exp`: 4 Experience entries (sequential within)
  - `--session linkedin-skills`: 16 Skills (sequential within)
  - `--session linkedin-feat`: 3 Featured links (sequential within)
- Field-to-command mapping per form (see [references/linkedin.md](references/linkedin.md))

**Step 3 result:** Each agent follows its playbook. ~15min parallel vs ~45min sequential.

### After Completion: Cache the Playbook

If this is the first time automating a site, save what you learned as `references/<site>.md` so future sessions skip Steps 1-2. Include:
- Field type mappings for every form
- Navigation paths to key pages
- Known quirks and anti-patterns
- Parallelization strategy (which tasks are independent)

## Command Chaining

Commands can be chained with `&&` in a single shell invocation. The browser persists between commands via a background daemon, so chaining is safe and more efficient than separate calls.

```bash
# Chain open + wait + snapshot in one call
agent-browser open https://example.com && agent-browser wait --load networkidle && agent-browser snapshot -i

# Chain multiple interactions
agent-browser fill @e1 "user@example.com" && agent-browser fill @e2 "password123" && agent-browser click @e3

# Navigate and capture
agent-browser open https://example.com && agent-browser wait --load networkidle && agent-browser screenshot page.png
```

**When to chain:** Use `&&` only when you do not need the intermediate output. If a later step depends on snapshot refs or changed DOM state, keep the commands separate.

## Essential Commands

```bash
# Navigation
agent-browser open <url>              # Navigate (aliases: goto, navigate)
agent-browser close                   # Close browser

# Snapshot
agent-browser snapshot -i             # Interactive elements with refs (recommended)
agent-browser snapshot -i -C          # Include cursor-interactive elements (divs with onclick, cursor:pointer)
agent-browser snapshot -s "#selector" # Scope to CSS selector

# Interaction (use @refs from snapshot)
agent-browser click @e1               # Click element
agent-browser click @e1 --new-tab     # Click and open in new tab
agent-browser fill @e2 "text"         # Clear and type text
agent-browser type @e2 "text"         # Type without clearing
agent-browser select @e1 "option"     # Select dropdown option
agent-browser check @e1               # Check checkbox
agent-browser press Enter             # Press key
agent-browser scroll down 500         # Scroll page

# Get information
agent-browser get text @e1            # Get element text
agent-browser get url                 # Get current URL
agent-browser get title               # Get page title

# Wait
agent-browser wait @e1                # Wait for element
agent-browser wait --load networkidle # Wait for network idle
agent-browser wait --url "**/page"    # Wait for URL pattern
agent-browser wait 2000               # Wait milliseconds

# Capture
agent-browser screenshot              # Screenshot to temp dir
agent-browser screenshot --full       # Full page screenshot
agent-browser screenshot --annotate   # Annotated screenshot with numbered element labels
agent-browser pdf output.pdf          # Save as PDF

# Diff (compare page states)
agent-browser diff snapshot                          # Compare current vs last snapshot
agent-browser diff snapshot --baseline before.txt    # Compare current vs saved file
agent-browser diff screenshot --baseline before.png  # Visual pixel diff
agent-browser diff url <url1> <url2>                 # Compare two pages
agent-browser diff url <url1> <url2> --wait-until networkidle  # Custom wait strategy
agent-browser diff url <url1> <url2> --selector "#main"  # Scope to element
```

## Complex Web App Forms (React, SPAs, LinkedIn, etc.)

Modern web apps use React/Angular/Vue with custom form controls. Standard `fill` doesn't always work. **Read the snapshot output to identify the field type, then use the right command.**

### Decision Tree: Which Command for Which Field?

| Snapshot shows | Use | Example |
|---|---|---|
| `[textbox]` or `[input type="text"]` | `fill @ref "text"` | `agent-browser fill @e3 "John"` |
| `[combobox]` (dropdown/autocomplete) | `select @ref "option text"` | `agent-browser select @e5 "Full-time"` |
| `[checkbox]` | `check @ref` or `uncheck @ref` | `agent-browser check @e7` |
| `[contenteditable]` or rich text editor | `eval` with innerHTML + InputEvent | See below |
| `[select]` (native HTML select) | `select @ref "option text"` | `agent-browser select @e2 "March"` |

### Contenteditable Fields (Rich Text Editors)

Some apps use `contenteditable` divs (LinkedIn About/Description, Notion, CMS editors). These IGNORE `fill` and `type`. Use JavaScript:

```bash
# For contenteditable fields — replace SELECTOR with the actual CSS selector
agent-browser eval --stdin <<'EVALEOF'
const el = document.querySelector('[contenteditable="true"]');
el.innerHTML = 'Your text here';
el.dispatchEvent(new InputEvent('input', { bubbles: true }));
EVALEOF
```

If multiple contenteditable fields exist, use a more specific selector (inspect the snapshot for parent containers).

### Combobox / Autocomplete Fields

Combobox fields show a dropdown when you type. **Do NOT click dropdown option elements directly** — they often fail with "Could not compute box model."

```bash
# CORRECT: Use select command (handles dropdown internally)
agent-browser select @e5 "Self-employed"

# If select doesn't work: type partial text → wait → snapshot → click
agent-browser fill @e5 "Self-emp"
agent-browser wait 1000
agent-browser snapshot -i      # See dropdown options appear
agent-browser click @e12       # Click the matching option
```

### Anti-Patterns (Things That WASTE Tokens)

1. **NEVER press Escape on form pages** — SPAs interpret Escape as "Discard changes?" which opens a confirmation dialog. To dismiss dropdowns, click elsewhere or move to the next field.

2. **NEVER click `<option>` or combobox list items directly** — Use `select @ref "option"`. Direct clicks on dropdown items fail with "Could not compute box model."

3. **NEVER use `type` when you mean `fill`** — `type` APPENDS text. `fill` CLEARS then types. On a pre-filled field, `type` creates "Existing TextNew Text". Always use `fill` unless you're intentionally appending.

4. **NEVER interact without a fresh snapshot** — After ANY click, navigation, dropdown, modal, or form submission, your refs are STALE. You MUST `snapshot -i` before the next interaction.

5. **NEVER guess refs from memory** — If the DOM changed in any way, old refs point to wrong elements. Always re-snapshot.

6. **NEVER modify auto-populated metadata fields when adding links/embeds** — Some React apps (LinkedIn Featured section, CMS embeds) auto-populate Title/Description from URL metadata. Using `fill` on these fields breaks React's internal state, causing "Save failed". Save with the auto-populated values, then edit afterward if needed.

7. **NEVER chain commands that depend on intermediate snapshot results** — If command B needs a ref from command A's output, run them separately: run A, read the output, get the ref, then run B. Only chain commands where you DON'T need intermediate results (e.g., `open && wait && screenshot`).

8. **Dismiss banners/overlays FIRST** — Cookie consent bars, terms update banners, and notification overlays intercept clicks on elements below them. Before interacting with any page element, snapshot to check for dismissible banners (look for unlabeled close buttons or "Close"/"Dismiss"/"Accept" buttons at the top of the snapshot), and click them first.

9. **When duplicate labels exist (e.g., two "Add section" links), use `scrollintoview` on the correct one before clicking** — Clicking without scrolling may hit a nearby element (like a navbar button) instead. Always `scrollintoview @ref` first, then `click @ref`.

10. **Do not use `open` to bounce around inside an already-observed multi-step flow unless it is needed** — For in-app navigation after the target page is already open and snapshotted, prefer `back`, clicking visible links, or a scoped navigation command so refs and flow state stay coherent. This does **not** apply to visual verification, screenshots, or "open/show this page" requests: those must start with `agent-browser open <url>` on the target page.

### Multi-Step Form Workflow (Adding Multiple Records)

For complex forms where you add multiple entries (job positions, education, projects):

```bash
# Step 1: Open form and orient
agent-browser snapshot -i

# Step 2: Fill simple text fields (no snapshot needed between these)
agent-browser fill @e1 "Value 1"
agent-browser fill @e2 "Value 2"

# Step 3: Handle dropdowns with select (re-snapshot if dropdown changes DOM)
agent-browser select @e3 "Option"

# Step 4: Handle contenteditable with eval (see above)

# Step 5: Save
agent-browser click @e10             # Save/Submit button
agent-browser wait --load networkidle
agent-browser snapshot -i            # MUST re-snapshot after save

# Step 6: Dismiss post-save dialogs
# Many apps show follow-up prompts after save ("Add skills?", "Suggestions")
# Look for "Skip", "Close", "Not now", "No thanks" buttons and click them
agent-browser click @e2              # Dismiss dialog

# Step 7: Navigate to add next entry (re-snapshot, find "Add" button, repeat)
agent-browser snapshot -i
```

### When `fill` Doesn't Work

If `fill` produces no visible change:
1. The field might be `contenteditable` → use `eval` with innerHTML
2. The field might be read-only or disabled → check `agent-browser is enabled @ref`
3. React may not see the change → add InputEvent dispatch via eval
4. The field might need a click first → `agent-browser click @ref` then `agent-browser fill @ref "text"`

## Common Patterns

### Form Submission

```bash
agent-browser open https://example.com/signup
agent-browser snapshot -i
agent-browser fill @e1 "Jane Doe"
agent-browser fill @e2 "jane@example.com"
agent-browser select @e3 "California"
agent-browser check @e4
agent-browser click @e5
agent-browser wait --load networkidle
```

### Authentication with State Persistence

For user-owned accounts, prefer real Chrome CDP over saved state files. Use `state save/load` for test accounts, CI-style reuse, or when the user explicitly wants portable Agent Browser auth state.

```bash
# Login once and save state
agent-browser open https://app.example.com/login
agent-browser snapshot -i
agent-browser fill @e1 "$USERNAME"
agent-browser fill @e2 "$PASSWORD"
agent-browser click @e3
agent-browser wait --url "**/dashboard"
agent-browser state save auth.json

# Reuse in future sessions
agent-browser state load auth.json
agent-browser open https://app.example.com/dashboard
```

### Session Persistence

```bash
# Auto-save/restore cookies and localStorage across browser restarts
agent-browser --session-name myapp open https://app.example.com/login
# ... login flow ...
agent-browser close  # State auto-saved to ~/.agent-browser/sessions/

# Next time, state is auto-loaded
agent-browser --session-name myapp open https://app.example.com/dashboard

# Encrypt state at rest
export AGENT_BROWSER_ENCRYPTION_KEY=$(openssl rand -hex 32)
agent-browser --session-name secure open https://app.example.com

# Manage saved states
agent-browser state list
agent-browser state show myapp-default.json
agent-browser state clear myapp
agent-browser state clean --older-than 7
```

### Data Extraction

```bash
agent-browser open https://example.com/products
agent-browser snapshot -i
agent-browser get text @e5           # Get specific element text
agent-browser get text body > page.txt  # Get all page text

# JSON output for parsing
agent-browser snapshot -i --json
agent-browser get text @e1 --json
```

### Parallel Sessions and Browser Identity

```bash
start-chrome-debug 9222
agent-browser --session site1 connect 9222
agent-browser --session site2 connect 9222

agent-browser --session site1 open https://site-a.com
agent-browser --session site2 open https://site-b.com

agent-browser --session site1 snapshot -i
agent-browser --session site2 snapshot -i

agent-browser session list
```

`--session` isolates a work lane, refs, tabs, and daemon state. It is not the same as browser identity. Use `--session-name` for Agent Browser storage-state persistence. Use a clean config or separate `--profile` only when you intentionally want a disposable or separate browser identity.

### Connect to Existing Chrome

```bash
# Auto-discover running Chrome with remote debugging enabled
agent-browser --auto-connect open https://example.com
agent-browser --auto-connect snapshot

# Or with explicit CDP port
agent-browser --cdp 9222 snapshot
```

### Visual Browser (Debugging)

```bash
agent-browser --headed open https://example.com
agent-browser highlight @e1          # Highlight element
agent-browser record start demo.webm # Record session
agent-browser profiler start         # Start Chrome DevTools profiling
agent-browser profiler stop trace.json # Stop and save profile (path optional)
```

### Local Files (PDFs, HTML)

```bash
# Open local files with file:// URLs
agent-browser --allow-file-access open file:///path/to/document.pdf
agent-browser --allow-file-access open file:///path/to/page.html
agent-browser screenshot output.png
```

### iOS Simulator (Mobile Safari)

```bash
# List available iOS simulators
agent-browser device list

# Launch Safari on a specific device
agent-browser -p ios --device "iPhone 16 Pro" open https://example.com

# Same workflow as desktop - snapshot, interact, re-snapshot
agent-browser -p ios snapshot -i
agent-browser -p ios tap @e1          # Tap (alias for click)
agent-browser -p ios fill @e2 "text"
agent-browser -p ios swipe up         # Mobile-specific gesture

# Take screenshot
agent-browser -p ios screenshot mobile.png

# Close session (shuts down simulator)
agent-browser -p ios close
```

**Requirements:** macOS with Xcode, Appium (`npm install -g appium && appium driver install xcuitest`)

**Real devices:** Works with physical iOS devices if pre-configured. Use `--device "<UDID>"` where UDID is from `xcrun xctrace list devices`.

## Diffing (Verifying Changes)

Use `diff snapshot` after performing an action to verify it had the intended effect. This compares the current accessibility tree against the last snapshot taken in the session.

```bash
# Typical workflow: snapshot -> action -> diff
agent-browser snapshot -i          # Take baseline snapshot
agent-browser click @e2            # Perform action
agent-browser diff snapshot        # See what changed (auto-compares to last snapshot)
```

For visual regression testing or monitoring:

```bash
# Save a baseline screenshot, then compare later
agent-browser screenshot baseline.png
# ... time passes or changes are made ...
agent-browser diff screenshot --baseline baseline.png

# Compare staging vs production
agent-browser diff url https://staging.example.com https://prod.example.com --screenshot
```

`diff snapshot` output uses `+` for additions and `-` for removals, similar to git diff. `diff screenshot` produces a diff image with changed pixels highlighted in red, plus a mismatch percentage.

## Timeouts and Slow Pages

The default Playwright timeout is 60 seconds for local browsers. For slow websites or large pages, use explicit waits instead of relying on the default timeout:

```bash
# Wait for network activity to settle (best for slow pages)
agent-browser wait --load networkidle

# Wait for a specific element to appear
agent-browser wait "#content"
agent-browser wait @e1

# Wait for a specific URL pattern (useful after redirects)
agent-browser wait --url "**/dashboard"

# Wait for a JavaScript condition
agent-browser wait --fn "document.readyState === 'complete'"

# Wait a fixed duration (milliseconds) as a last resort
agent-browser wait 5000
```

When dealing with consistently slow websites, use `wait --load networkidle` after `open` to ensure the page is fully loaded before taking a snapshot. If a specific element is slow to render, wait for it directly with `wait <selector>` or `wait @ref`.

## Session Management and Cleanup

When running multiple agents or automations concurrently, always use named sessions to avoid conflicts:

```bash
# Each agent gets its own isolated session
agent-browser --session agent1 open site-a.com
agent-browser --session agent2 open site-b.com

# Check active sessions
agent-browser session list
```

Always close your browser session when done to avoid leaked processes:

```bash
agent-browser close                    # Close default session
agent-browser --session agent1 close   # Close specific session
```

If a previous session was not closed properly, the daemon may still be running. Use `agent-browser close` to clean it up before starting new work.

## Ref Lifecycle (Important)

Refs (`@e1`, `@e2`, etc.) are invalidated when the page changes. Always re-snapshot after:

- Clicking links or buttons that navigate
- Form submissions
- Dynamic content loading (dropdowns, modals)

```bash
agent-browser click @e5              # Navigates to new page
agent-browser snapshot -i            # MUST re-snapshot
agent-browser click @e1              # Use new refs
```

## Annotated Screenshots (Vision Mode)

Use `--annotate` to take a screenshot with numbered labels overlaid on interactive elements. Each label `[N]` maps to ref `@eN`. This also caches refs, so you can interact with elements immediately without a separate snapshot.

```bash
agent-browser screenshot --annotate
# Output includes the image path and a legend:
#   [1] @e1 button "Submit"
#   [2] @e2 link "Home"
#   [3] @e3 textbox "Email"
agent-browser click @e2              # Click using ref from annotated screenshot
```

Use annotated screenshots when:
- The page has unlabeled icon buttons or visual-only elements
- You need to verify visual layout or styling
- Canvas or chart elements are present (invisible to text snapshots)
- You need spatial reasoning about element positions

## Semantic Locators (Alternative to Refs)

When refs are unavailable or unreliable, use semantic locators:

```bash
agent-browser find text "Sign In" click
agent-browser find label "Email" fill "user@test.com"
agent-browser find role button click --name "Submit"
agent-browser find placeholder "Search" type "query"
agent-browser find testid "submit-btn" click
```

## JavaScript Evaluation (eval)

Use `eval` to run JavaScript in the browser context. **Shell quoting can corrupt complex expressions** -- use `--stdin` or `-b` to avoid issues.

```bash
# Simple expressions work with regular quoting
agent-browser eval 'document.title'
agent-browser eval 'document.querySelectorAll("img").length'

# Complex JS: use --stdin with heredoc (RECOMMENDED)
agent-browser eval --stdin <<'EVALEOF'
JSON.stringify(
  Array.from(document.querySelectorAll("img"))
    .filter(i => !i.alt)
    .map(i => ({ src: i.src.split("/").pop(), width: i.width }))
)
EVALEOF

# Alternative: base64 encoding (avoids all shell escaping issues)
agent-browser eval -b "$(echo -n 'Array.from(document.querySelectorAll("a")).map(a => a.href)' | base64)"
```

**Why this matters:** When the shell processes your command, inner double quotes, `!` characters (history expansion), backticks, and `$()` can all corrupt the JavaScript before it reaches agent-browser. The `--stdin` and `-b` flags bypass shell interpretation entirely.

**Rules of thumb:**
- Single-line, no nested quotes -> regular `eval 'expression'` with single quotes is fine
- Nested quotes, arrow functions, template literals, or multiline -> use `eval --stdin <<'EVALEOF'`
- Programmatic/generated scripts -> use `eval -b` with base64

## Configuration File

Create `agent-browser.json` in the project root for persistent settings:

```json
{
  "headed": true,
  "proxy": "http://localhost:8080",
  "profile": "./browser-data"
}
```

Priority (lowest to highest): `~/.agent-browser/config.json` < `./agent-browser.json` < env vars < CLI flags. Use `--config <path>` or `AGENT_BROWSER_CONFIG` env var for a custom config file (exits with error if missing/invalid). All CLI options map to camelCase keys (e.g., `--executable-path` -> `"executablePath"`). Boolean flags accept `true`/`false` values (e.g., `--headed false` overrides config). Extensions from user and project configs are merged, not replaced.

## Deep-Dive Documentation

| Reference | When to Use |
|-----------|-------------|
| [references/commands.md](references/commands.md) | Full command reference with all options |
| [references/snapshot-refs.md](references/snapshot-refs.md) | Ref lifecycle, invalidation rules, troubleshooting |
| [references/session-management.md](references/session-management.md) | Parallel sessions, state persistence, concurrent scraping |
| [references/authentication.md](references/authentication.md) | Login flows, OAuth, 2FA handling, state reuse |
| [references/video-recording.md](references/video-recording.md) | Recording workflows for debugging and documentation |
| [references/profiling.md](references/profiling.md) | Chrome DevTools profiling for performance analysis |
| [references/proxy-support.md](references/proxy-support.md) | Proxy configuration, geo-testing, rotating proxies |
| [references/linkedin.md](references/linkedin.md) | LinkedIn profile automation — field mappings, navigation, parallelization |

## Ready-to-Use Templates

| Template | Description |
|----------|-------------|
| [templates/form-automation.sh](templates/form-automation.sh) | Form filling with validation |
| [templates/authenticated-session.sh](templates/authenticated-session.sh) | Login once, reuse state |
| [templates/capture-workflow.sh](templates/capture-workflow.sh) | Content extraction with screenshots |

```bash
./templates/form-automation.sh https://example.com/form
./templates/authenticated-session.sh https://app.example.com/login
./templates/capture-workflow.sh https://example.com ./output
```
