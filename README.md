# agent-browser

### Your AI and you, sharing the same browser. Like a remote control for Chrome.

- **Real Chrome, real cookies** — log in once, stay logged in. Your AI uses your actual browser session with persistent cookies
- **Invisible to bot detection** — no `navigator.webdriver` flag, no fingerprint mismatches. Sites see a real human, not a bot
- **93% fewer tokens** than Playwright MCP — ~200 tokens per page vs ~13,700. Your AI does more with less
- **5x faster** — direct WebSocket to Chrome, no middleware relay. Every call saves seconds
- **Independent sessions** — run multiple AI agents simultaneously on the same machine. Zero conflicts, zero shared state
- **Headed, not headless** — you see everything the AI does in real time. Watch it work, jump in anytime, take over when you want
- **Claude Code skill included** — drop one file and Claude knows how to drive your browser. No setup, no configuration

---

**agent-browser** is a CLI that gives AI agents direct control of your real, visible Chrome browser — without Playwright, without Puppeteer, without downloading bundled browser binaries, and without burning through your token budget.

It speaks raw [Chrome DevTools Protocol (CDP)](https://chromedevtools.github.io/devtools-protocol/) over a single WebSocket. That's it. No middleware. No relay servers. No 50MB dependency you never asked for.

Built by [Caleb Dane](https://github.com/CalebDane7). Originally forked from [vercel-labs/agent-browser](https://github.com/vercel-labs/agent-browser) — CDP transport layer rewritten from scratch.

---

## The Problem with Playwright and Puppeteer

If you're using Playwright or Puppeteer for AI browser automation, here's what's actually happening under the hood:

```
Your AI  →  Playwright/Puppeteer  →  Node.js WebSocket relay  →  Chrome  →  back through all of that
```

That middle layer — the Node.js relay — adds **an extra network hop on every single browser call**. Click a button? Extra hop. Take a screenshot? Extra hop. Read the page? Extra hop. Multiply that by hundreds of operations per session and you get real, measurable slowdowns.

And then there's the size. Playwright alone adds **~50MB** to your `node_modules`. It downloads its own browser binaries. It bundles Firefox and WebKit engines you'll never use for AI automation.

**The industry is moving away from this.** [browser-use reported 5x faster element extraction](https://browser-use.com/posts/playwright-to-cdp) after dropping Playwright for raw CDP. Stagehand (Browserbase) is making the same move. Even Microsoft built [Playwright CLI](https://testcollab.com/blog/playwright-cli) to work around their own tool's token bloat.

---

## How agent-browser Is Different

```
Your AI  →  agent-browser  →  Chrome
```

That's the whole stack. One WebSocket connection. Zero relay layers. Your commands go straight to Chrome and the response comes straight back.

### By the numbers

| | agent-browser | Playwright MCP | Playwright CLI |
|---|---|---|---|
| **Tokens per page** | ~200-400 | ~13,700 per step | ~2,700 per step |
| **10-step workflow** | ~7,000 tokens | ~114,000 tokens | ~27,000 tokens |
| **Install size** | Lightweight (uses your Chrome) | ~50MB + browser binaries | ~50MB + browser binaries |
| **Network hops per call** | 1 (direct to Chrome) | 2 (relay + Chrome) | 2 (relay + Chrome) |
| **Extra browser download?** | No — uses your existing Chrome | Yes — downloads Chromium | Yes — downloads Chromium |

Under the same token budget, agent-browser runs **5.7x more automation cycles** than Playwright MCP. That's not a minor optimization — it's the difference between your AI agent finishing the job or running out of context halfway through.

---

## You and Your AI Share the Same Browser

This isn't headless automation running invisibly in the background. **agent-browser is headed** — it controls your real, visible Chrome window. You can watch everything the AI does in real time.

Think of it like handing someone a remote control to your computer:

- **Watch the AI work** — see it click buttons, fill forms, navigate pages, all on your actual screen
- **Jump in anytime** — navigate to a page manually, then tell the AI "now fill out this form" or "click that button"
- **Hand control back and forth** — you browse to the right page, the AI handles the tedious parts, you verify the result
- **Pair browse** — stream the viewport via WebSocket so you can watch from another machine or share with a teammate
- **Debug in real time** — when something goes wrong, you see exactly what the AI sees. No guessing what happened in a headless void

Other automation tools run in a hidden browser you can't see or interact with. agent-browser runs in **your** browser — the one you're already looking at.

---

## What It Actually Does (Plain English)

If you're new to browser automation, here's the simple version:

**agent-browser lets an AI control your Chrome browser the same way you do** — it can open websites, click buttons, fill out forms, read what's on the page, and take screenshots. You see everything it does because it's working in your real, visible browser — not some hidden process running in the background.

Here's everything it automates:

- **Open any website** — navigate to URLs, go back, go forward, refresh
- **Read the page** — get a structured snapshot of everything on the page (buttons, links, text fields, headings) that an AI can understand in ~200 tokens instead of thousands
- **Click things** — buttons, links, checkboxes, dropdowns — by simple reference like `@e1` instead of fragile CSS selectors
- **Fill out forms** — type into text fields, select options, check boxes
- **Take screenshots** — capture what the page looks like for visual verification
- **Run JavaScript** — execute any code in the browser for advanced automation
- **Track errors** — catch console errors and broken pages automatically
- **Manage tabs** — open new tabs, switch between them, close them
- **Intercept network requests** — mock API responses, block tracking scripts, test error states
- **Stream the viewport** — watch what the browser is doing in real time via screencast

All of this through one simple CLI: `agent-browser <command>`.

---

## Sessions That Don't Step on Each Other

This is a big deal if you're running multiple AI agents at the same time.

**Every session is completely independent.** Each AI session (like each Claude Code window) gets its own daemon process through an environment variable:

```bash
AGENT_BROWSER_SESSION="claude-$$"  # Each session gets a unique ID
```

What this means in practice:

- **Session A** can be testing your login page while **Session B** tests the checkout flow — simultaneously, on the same machine
- No shared state between sessions — different cookies, different tabs, different browsing history
- No race conditions — one agent clicking a button won't interfere with another agent reading a page
- Sessions clean up after themselves — close one and the others keep running

If you've ever had two Playwright scripts fight over the same browser instance, you know why this matters.

---

## Real Chrome. Real Cookies. Invisible to Bot Detection.

This is the part most automation tools get wrong.

Playwright and Puppeteer download their own Chromium binary — a stripped-down, identifiable browser that websites can detect instantly. They set `navigator.webdriver = true`. They leave fingerprint mismatches in canvas rendering, WebGL, and device memory. Even with "stealth" plugins, [they fail advanced detection systems](https://blog.castle.io/how-to-detect-headless-chrome-bots-instrumented-with-playwright/) like Cloudflare and Pixelscan.

**agent-browser doesn't have this problem.** It connects to your real Chrome — the same browser you use every day, with your real cookies, your real extensions, your real fingerprint. Websites can't tell the difference between you and your AI agent because there is no difference. It's the same browser.

### What this means in practice

**Log in once, stay logged in forever.** Sign into Amazon, Gmail, your bank — whatever. Those cookies persist in your Chrome profile. Next time your AI agent opens that site, it's already authenticated. No re-entering passwords. No 2FA loops. No expired sessions.

**Shop on Amazon.** Your AI can browse products, compare prices, add items to your cart, and go through checkout — on your real account, with your saved payment methods, at your saved addresses. The same workflow that gets blocked instantly with Playwright just works here because Amazon sees a real Chrome browser with a real browsing history.

**Manage any authenticated account.** Banking dashboards, social media, email, admin panels, SaaS tools — if you can access it in Chrome, your AI agent can too. Same cookies. Same session. No bot flags.

**Get past Cloudflare, CAPTCHAs, and bot walls.** Sites that block automated browsers don't block yours — because yours isn't automated in the way they're detecting. There's no `navigator.webdriver` flag. No stripped-down Chromium binary. No fingerprint inconsistencies. It's your real Chrome, headed and visible.

### Why this works

| | agent-browser | Playwright / Puppeteer |
|---|---|---|
| Browser used | Your real Chrome | Downloaded Chromium binary |
| `navigator.webdriver` | `false` (real browser) | `true` (automation flag) |
| Cookies | Your real cookies, persistent | Fresh/empty every session |
| Browser fingerprint | Genuine (canvas, WebGL, etc.) | Detectable mismatches |
| Bot detection result | Passes as human | Detected and blocked |

---

## Quick Start

### Install

```bash
npm install -g agent-browser
```

### Use it right now

```bash
# Start Chrome with debugging enabled
google-chrome --remote-debugging-port=9222 &

# Open a website
agent-browser open https://example.com

# See what's on the page (AI-readable snapshot)
agent-browser snapshot -i --compact
# Output:
# - heading "Example Domain" [level=1]
# - paragraph "This domain is for use in illustrative examples..."
# - link "More information..." [ref=e1]

# Click the link
agent-browser click @e1

# Take a screenshot
agent-browser screenshot
```

That `@e1` is an element reference. Instead of writing brittle CSS selectors like `#main > div:nth-child(3) > a.link-class`, you just say "click element 1." The AI reads the snapshot, picks the right ref, and acts on it.

---

## Use It as a Claude Code Skill

Drop one file and Claude Code knows how to drive a browser:

```bash
mkdir -p ~/.claude/skills/agent-browser
cp SKILL.md ~/.claude/skills/agent-browser/SKILL.md
```

Now you can tell Claude things like:
- *"Test the login page and make sure it works"*
- *"Check if the homepage has any console errors"*
- *"Fill out the contact form and submit it"*
- *"Take a screenshot of the dashboard"*

Claude will use agent-browser automatically — opening the browser, navigating, clicking, filling forms, taking screenshots, and reporting back what it found.

---

## Every Command

| Command | What it does |
|---------|-------------|
| `open <url>` | Navigate to a URL |
| `snapshot -i --compact` | AI-readable page snapshot (interactive elements only) |
| `snapshot` | Full page structure |
| `click @e1` | Click an element by ref |
| `fill @e1 "text"` | Clear a field and type text |
| `type @e1 "text"` | Append text to a field |
| `hover @e1` | Hover over an element |
| `press Enter` | Press a keyboard key |
| `screenshot` | Capture the viewport as PNG |
| `eval "document.title"` | Run JavaScript in the browser |
| `errors` | Show console errors |
| `back` / `forward` | Navigate browser history |
| `wait --load networkidle` | Wait for the page to finish loading |
| `close` | Close the browser connection |

---

## How It Works Under the Hood

```
Claude Code  →  agent-browser CLI (Rust)  →  daemon (Node.js)  →  Chrome CDP (WebSocket)
                                                   |
                                                 cdp.js      Raw WebSocket JSON-RPC
                                                 browser.js   Page/Locator/Context API
                                                 snapshot.js  Accessibility tree + refs
                                                 actions.js   Command handlers
```

**cdp.js** — The engine. ~950 lines of raw WebSocket CDP transport. Connects to `ws://localhost:9222`, sends JSON-RPC commands, handles sessions, lifecycle events, dialogs, and network idle detection. No npm CDP libraries.

**browser.js** — Wraps the raw CDP calls into a clean Page/Locator/Context API so the rest of the code doesn't need to think about WebSocket frames.

**snapshot.js** — Calls Chrome's `Accessibility.getFullAXTree()` and formats it into the compact text tree with element refs (`@e1`, `@e2`, ...) that AI agents read.

**actions.js** — Maps CLI commands to browser actions. `click @e1` resolves the ref, scrolls the element into view, gets its coordinates, and dispatches a click event through CDP.

---

## Who This Is For

- **AI developers** building agents that need to interact with real websites
- **Claude Code users** who want their AI to test, verify, and automate browser tasks
- **Teams running parallel AI agents** that need session isolation
- **Anyone frustrated with Playwright/Puppeteer bloat** who just wants to talk to Chrome
- **People who want AI to handle real-world tasks** — shopping on Amazon, managing accounts, interacting with sites that block bots
- **New developers** who want a simple CLI instead of learning a complex automation framework

---

## Compared to the Alternatives

| Feature | agent-browser | Playwright | Puppeteer | Playwright MCP | Selenium |
|---------|--------------|------------|-----------|---------------|----------|
| Direct CDP (no relay) | Yes | No | No | No | No |
| Token-efficient snapshots | ~200-400/page | N/A | N/A | ~13,700/step | N/A |
| Session isolation | Built-in | Manual | Manual | Manual | Manual |
| Install size | Lightweight | ~50MB | ~30MB | ~50MB | ~100MB+ |
| Downloads browsers | No | Yes | Yes | Yes | Yes |
| AI-native refs (`@e1`) | Yes | No | No | Yes | No |
| CLI-first design | Yes | No | No | Partial | No |
| Persistent cookies | Yes (real Chrome profile) | No (fresh each run) | No (fresh each run) | No (fresh each run) | No (fresh each run) |
| Invisible to bot detection | Yes (real browser) | No (`webdriver=true`) | No (`webdriver=true`) | No (`webdriver=true`) | No (`webdriver=true`) |
| Visible browser (headed) | Yes — you watch it work | No (headless default) | No (headless default) | No (headless default) | No (headless default) |
| Cross-browser | Chrome only | Chrome, Firefox, WebKit | Chrome only | Chrome only | All |

**The trade-off is intentional**: agent-browser only supports Chrome because that's what AI agents need. Dropping Firefox and WebKit means zero bundled browsers, zero extra downloads, and a much simpler codebase.

---

## License

Apache-2.0

## Author

**Caleb Dane** ([@CalebDane7](https://github.com/CalebDane7))

Originally forked from [vercel-labs/agent-browser](https://github.com/vercel-labs/agent-browser). CDP transport layer (`cdp.js`, `browser.js`) rewritten from scratch — zero Playwright code, zero Puppeteer code, zero browser automation library dependencies.

---

## Research & References

The claims in this README are backed by real benchmarks, migration reports, and industry analysis:

### Performance & Token Efficiency
- [Closer to the Metal: Leaving Playwright for CDP](https://browser-use.com/posts/playwright-to-cdp) — browser-use's migration report documenting 5x faster element extraction after dropping Playwright
- [Why Vercel's agent-browser Is Winning the Token Efficiency War](https://dev.to/chen_zhang_bac430bc7f6b95/why-vercels-agent-browser-is-winning-the-token-efficiency-war-for-ai-browser-automation-4p87) — 5.7x more test cycles under the same token budget
- [Agent-Browser: AI-First Browser Automation That Saves 93% of Your Context Window](https://medium.com/@richardhightower/agent-browser-ai-first-browser-automation-that-saves-93-of-your-context-window-7a2c52562f8c) — Deep dive on token savings
- [Playwright CLI: The Token-Efficient Alternative to Playwright MCP](https://testcollab.com/blog/playwright-cli) — Microsoft's own acknowledgment of the MCP token problem (~114K tokens vs ~27K with CLI)
- [MCP vs Playwright CLI: Best Browser Control for Agents](https://supatest.ai/blog/playwright-mcp-vs-cli-ai-browser-automation) — Head-to-head comparison

### CDP vs Playwright vs Puppeteer
- [CDP vs Playwright vs Puppeteer: Is This the Wrong Question?](https://lightpanda.io/blog/posts/cdp-vs-playwright-vs-puppeteer-is-this-the-wrong-question) — Architectural analysis of the relay layer overhead
- [Playwright vs Puppeteer: Which to Choose in 2026?](https://www.firecrawl.dev/blog/playwright-vs-puppeteer) — Puppeteer runs 15-20% faster than Playwright on identical Chromium tasks
- [Stagehand vs Browser Use vs Playwright: AI Browser Automation Compared](https://www.nxcode.io/resources/news/stagehand-vs-browser-use-vs-playwright-ai-browser-automation-2026) — Industry comparison of AI browser approaches
- [Top Playwright Alternatives in 2026](https://www.browserstack.com/guide/playwright-alternative) — BrowserStack's overview of the alternative landscape

### Bot Detection & Real Chrome
- [How to Detect Headless Chrome Bots Instrumented with Playwright](https://blog.castle.io/how-to-detect-headless-chrome-bots-instrumented-with-playwright/) — Why Playwright's `navigator.webdriver=true` is an instant detection signal
- [From Puppeteer Stealth to Nodriver: How Anti-Detect Frameworks Evolved](https://securityboulevard.com/2025/06/from-puppeteer-stealth-to-nodriver-how-anti-detect-frameworks-evolved-to-evade-bot-detection/) — The industry shift toward CDP-minimal frameworks
- [Stealth AI Browser Agents: Ultimate 2026 Guide](https://o-mega.ai/articles/stealth-for-ai-browser-agents-the-ultimate-2026-guide) — Comprehensive guide on browser fingerprinting and detection evasion
- [The Best Headless Chrome Browser for Bypassing Anti-Bot Systems](https://kameleo.io/blog/the-best-headless-chrome-browser-for-bypassing-anti-bot-systems) — Testing results showing Playwright/Puppeteer fail advanced detection

### AI Browser Agents Landscape
- [11 Best AI Browser Agents in 2026](https://www.firecrawl.dev/blog/best-browser-agents) — Firecrawl's comprehensive review
- [Top 10 Browser AI Agents 2026: Complete Review & Guide](https://o-mega.ai/articles/top-10-browser-use-agents-full-review-2026) — o-mega's agent comparison
- [The Agentic Browser Landscape in 2026](https://www.nohackspod.com/blog/agentic-browser-landscape-2026) — Full landscape analysis
- [Browser Agent Security Risks: CDP Automation Leaking Cookies](https://debugg.ai/resources/browser-agent-security-risks-cdp-automation-leaking-cookies-oauth-internal-data) — Security considerations for CDP-based agents
