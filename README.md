# agent-browser

Headless browser automation CLI for AI agents. Talks directly to Chrome via raw CDP (Chrome DevTools Protocol) over WebSocket. No Playwright, no Puppeteer, no browser automation library. Just a WebSocket and Chrome.

Built as a [Claude Code](https://claude.ai/claude-code) skill — drop the `SKILL.md` into `~/.claude/skills/agent-browser/` and Claude knows how to drive a browser.

## What it does

- **Accessibility snapshots** with element refs (`@e1`, `@e2`, ...) that Claude reads to understand the page
- **Click, fill, hover, type** by ref — no CSS selectors, no XPath, just `click @e1`
- **Screenshots** for visual verification
- **JavaScript eval** for anything the CLI doesn't cover
- **Console error tracking** to catch broken pages
- **Tab management** — open, switch, close tabs
- **Request interception** — mock API responses, block resources
- **Screencast** — stream viewport frames via CDP

All through a single CLI: `agent-browser <command>`.

## Architecture

```
Claude Code  -->  agent-browser CLI (Rust)  -->  daemon (Node.js)  -->  Chrome CDP (WebSocket)
                                                     |
                                                   cdp.js     Raw WebSocket JSON-RPC
                                                   browser.js  Page/Locator/Context API
                                                   snapshot.js Accessibility tree + refs
                                                   actions.js  Command handlers
```

**cdp.js** is the core — ~950 lines of raw WebSocket CDP transport. No npm CDP libraries. Connects to `ws://localhost:9222`, sends JSON-RPC, handles sessions, lifecycle events, dialogs, network idle detection.

**browser.js** wraps cdp.js into Page/Locator/Context objects that actions.js can use without caring about raw CDP details.

**snapshot.js** calls `Accessibility.getFullAXTree()` via CDP, formats it into the text tree format with element refs that Claude reads.

## Install

```bash
npm install -g agent-browser
```

## Usage as Claude Code Skill

Copy `SKILL.md` to your Claude Code skills directory:

```bash
mkdir -p ~/.claude/skills/agent-browser
cp SKILL.md ~/.claude/skills/agent-browser/SKILL.md
```

Then Claude Code automatically knows how to use agent-browser when you ask it to test a website, verify a deployment, or automate a browser flow.

## Quick start

```bash
# Launch Chrome with debugging enabled
google-chrome --remote-debugging-port=9222 &

# Navigate and snapshot
agent-browser open https://example.com
agent-browser snapshot -i --compact
# Output: - link "Learn more" [ref=e1]

# Click the link
agent-browser click @e1

# Screenshot
agent-browser screenshot
```

## Commands

| Command | What it does |
|---------|-------------|
| `open <url>` | Navigate to URL |
| `snapshot -i --compact` | Accessibility tree with refs (interactive elements only) |
| `snapshot` | Full accessibility tree |
| `click @e1` | Click element by ref |
| `fill @e1 "text"` | Clear field and type text |
| `type @e1 "text"` | Append text to field |
| `hover @e1` | Hover over element |
| `press Enter` | Press a key |
| `screenshot` | Capture viewport as PNG |
| `eval "document.title"` | Run JavaScript |
| `errors` | Show console errors |
| `back` / `forward` | Navigate history |
| `wait --load networkidle` | Wait for page to finish loading |
| `close` | Close browser connection |

## Why raw CDP

Browser automation libraries add a Node.js WebSocket relay between you and Chrome. Every CDP call goes: your code -> library -> WebSocket -> Chrome -> WebSocket -> library -> your code. That's an extra network hop on every operation.

agent-browser talks directly to Chrome: your code -> WebSocket -> Chrome -> WebSocket -> your code. One less hop. Faster. Simpler. Fewer dependencies.

The accessibility tree snapshot format (~200-400 tokens per page) is the same format used across the industry for LLM browser agents. Claude reads it, understands the page structure, and acts on element refs.

## License

Apache-2.0

## Author

Caleb Dane ([@CalebDane7](https://github.com/CalebDane7))

Originally forked from [vercel-labs/agent-browser](https://github.com/vercel-labs/agent-browser). CDP transport layer (`cdp.js`, `browser.js`) rewritten from scratch.
