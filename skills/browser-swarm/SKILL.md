---
name: browser-swarm
description: Self-orchestrating parallel browser agent swarm. Use for ANY task involving 3+ URLs or web pages. Triggers: multi-URL research, open-ended web research ("find examples of...", "compare sites", "analyze trends"), competitive analysis, design inspiration gathering, forum/discussion reading, parallel auditing, 3+ visual verifications, monitoring. If the task says "research"/"find"/"compare"/"analyze" + websites/pages/examples, use this skill.
allowed-tools: Bash(agent-browser:*), Bash(ab-swarm-setup:*), Bash(ab-parallel:*), Agent, WebSearch, WebFetch
---

# Browser Swarm — Self-Orchestrating Parallel Agents

Automatically decompose tasks into micro-agents, bulk-open all tabs, dispatch reasoning agents in parallel — all in seconds.

## When to Use

- **Open-ended research** — "find beautiful landing pages", "research competitors", "analyze design trends"
- **3+ visual files edited** — gate BLOCKS sequential single-session verification
- **Research N items** — products, sellers, competitors, URLs
- **Multi-section verification** — header, nav, content, footer each get an agent
- **Data flow** — one agent writes, another reads, simultaneously

## Architecture

```
Coordinator (you)
│
├── PHASE 0: DISCOVER (for open-ended research — WebSearch for URLs)
│   └── 3-5 parallel WebSearch calls → collect 20-50 URLs → deduplicate
│
├── PHASE A: ab-swarm-setup (1 Bash call opens ALL tabs simultaneously)
│   └── s1=URL1, s2=URL2, ..., sN=URLN → N warm tabs in Chrome
│
└── PHASE B: Agent tools (ALL in ONE message, all run_in_background: true)
    ├── Agent 1 → operates on warm tab s1 (no open needed)
    ├── Agent 2 → operates on warm tab s2
    └── Agent N → operates on warm tab sN
```

All sessions share ONE Chrome via CDP port 9222. Each session = one tab. 50 agents = 50 tabs. No separate browser processes.

---

## Scaling Guidance

Each browser session = one Chrome tab via CDP. Resource cost is minimal:
- **10-20 agents:** Normal research task. ~200MB total Chrome memory.
- **20-50 agents:** Heavy research. ~500MB. Fine on any modern machine.
- **50+ agents:** Extreme. Batch in waves of 25-30 if needed.

The bottleneck is NOT tabs — it is agent context windows. Each Agent tool call uses one Claude API call. For cost efficiency:

### Two-Tier Research Pattern (recommended for 20+ URLs)
1. **Tier 1 — Fast scan (all URLs):** eval-only agents extract text and score 1-10. No screenshots. Cheap.
2. **Tier 2 — Deep dive (top 10):** screenshot + interaction agents on highest-scored pages. Expensive but targeted.

This halves the number of expensive screenshot agents while still covering all URLs.

---

## Step 1: DECOMPOSE — Apply Rules Automatically

Read the task and apply the FIRST matching rule:

### Rule 0: DISCOVERY-PARALLEL (open-ended research)
**Trigger:** Task does NOT provide specific URLs. Uses phrases like "find", "research", "look for", "discover", "get examples of", "compare the best", "what makes X good", "analyze trends"
**Result:** 3-phase workflow: DISCOVER → SETUP → ANALYZE

**Phase 1 — DISCOVER (coordinator does this, not agents):**
Use WebSearch to find URLs. Run 3-5 parallel WebSearch calls with varied queries:
  - Direct query: "best examples of {topic} 2025"
  - Curated lists: "top {topic} curated list"
  - Community: "{topic} reddit recommendations"
  - Awards: "{topic} awards showcase"
  - Expert: "{topic} expert analysis review"

Collect 20-50 URLs from results. Deduplicate. Group by source type.

**Phase 2 — SETUP:**
```bash
ab-swarm-setup r-1=URL1 r-2=URL2 ... r-N=URLN
```

**Phase 3 — ANALYZE:**
Dispatch N agents, each analyzing their page with the appropriate research template.
Each agent reports structured findings. Coordinator aggregates into comparison.

### Rule 1: ITEM-PARALLEL
**Trigger:** Task mentions N specific items (products, sellers, URLs, pages)
**Result:** N agents, one per item
```
"Research 8 laptop sellers" → 8 agents
"Check these 5 URLs" → 5 agents
```

### Rule 2: ASPECT-PARALLEL
**Trigger:** Each item needs M independent checks (specs AND reviews AND seller)
**Result:** N items × M aspects = N×M agents
```
"Research 8 sellers, compare prices, ratings, AND negative reviews"
→ 8 sellers × 3 aspects = 24 agents
  - 8 specs agents (extract price/rating/specs)
  - 8 review agents (read negative reviews)
  - 8 seller agents (check seller profile/rating)
```

### Rule 3: SECTION-PARALLEL
**Trigger:** Verify a page with N distinct sections
**Result:** N agents, one per section
```
"Verify the homepage after editing header, nav, hero, footer"
→ 4 agents, one per section
```

### Rule 4: DATA-FLOW
**Trigger:** Write-then-read dependency
**Result:** Wave 1 (writes, foreground wait) → Wave 2 (reads, parallel)
```
"Submit form, then check admin shows it and email was sent"
→ Wave 1: 1 submit agent (wait)
→ Wave 2: 2 check agents (parallel)
```

---

## Step 2: SETUP — Bulk Open All Tabs (1 Bash Call)

Generate session names and run ab-swarm-setup:

```bash
ab-swarm-setup s1=URL1 s2=URL2 s3=URL3 ... sN=URLN
```

This opens ALL tabs simultaneously in the background (no focus stealing). Wait for "Ready: N sessions" output. All tabs are now warm — agents skip the open step.

**Session naming conventions:**
- Research: `r-1`, `r-2`, ... or `r-seller1`, `r-seller2`
- Verification: `v-header`, `v-nav`, `v-hero`, `v-footer`
- Aspects: `specs-1`, `rev-1`, `seller-1` (prefix = aspect)
- Data flow: `write-form`, `read-admin`, `read-email`

---

## Step 3: DISPATCH — All Agents in ONE Message

Dispatch ALL Agent tool calls in a SINGLE message with `run_in_background: true`. This is critical — one message = truly parallel dispatch. Subagents cannot spawn other subagents, so the coordinator MUST dispatch all of them.

### Agent Prompt Template

Fill in the blanks and dispatch. Agents start with `snapshot -i` (tabs are already warm):

```
Browser agent. Session: --session {SESSION}.
Task: {ONE_SENTENCE_TASK}
Success: {WHAT_PASS_LOOKS_LIKE}

Commands (session is already open — do NOT call open):
  agent-browser --session {SESSION} snapshot -i
  agent-browser --session {SESSION} eval "..."
  agent-browser --session {SESSION} click @eN
  agent-browser --session {SESSION} screenshot /tmp/{SESSION}.png

Rules:
- ALWAYS snapshot -i before ANY click
- ALWAYS use @eN refs from snapshot, NEVER CSS selectors
- ALWAYS re-snapshot after page/DOM changes
- Use eval for fast data extraction (no clicking needed)

Report format:
RESULT: PASS|FAIL
DATA: {extracted data if research task}
EVIDENCE: {1-2 sentence description}
```

### Research Templates

**Design/Visual Analysis (eval + screenshot):**
```
Browser agent. Session: --session {SESSION}.
Task: Analyze this page's visual design quality and techniques.
Success: Design techniques, colors, typography, animations, uniformity, symmetry identified.

Steps:
1. agent-browser --session {SESSION} eval "document.body.innerText.substring(0,5000)"
2. agent-browser --session {SESSION} screenshot /tmp/{SESSION}.png
3. Analyze: color palette, typography (font families, sizes), layout patterns, animations,
   uniformity (consistent spacing/sizing/alignment across elements),
   symmetry (balanced visual weight, grid alignment, mirrored patterns),
   whitespace usage, visual hierarchy, unique techniques

Report:
SITE: {url}
DESIGN_SCORE: 1-10
TECHNIQUES: [notable design techniques]
COLORS: [primary palette]
TYPOGRAPHY: [font families and usage]
UNIFORMITY: [consistent/inconsistent — evidence]
SYMMETRY: [balanced/asymmetric — evidence]
LAYOUT: [grid/structure]
STANDOUT: [single most impressive element]
```

**Design Fast-Scan (eval only, no screenshot — for Tier 1):**
```
Browser agent. Session: --session {SESSION}.
Task: Quick-score this page's design quality.
Success: Design score and top technique identified.

Steps:
1. agent-browser --session {SESSION} eval "document.body.innerText.substring(0,3000)"
2. Score 1-10 based on text content quality, structure, professionalism

Report:
SITE: {url}
DESIGN_SCORE: 1-10
STANDOUT: [one notable element]
```

**UX/Usability Analysis:**
```
Browser agent. Session: --session {SESSION}.
Task: Evaluate user experience quality of this page.
Success: Navigation clarity, interaction patterns, friction points identified.

Steps:
1. agent-browser --session {SESSION} snapshot -i
2. agent-browser --session {SESSION} screenshot /tmp/{SESSION}.png
3. agent-browser --session {SESSION} eval "JSON.stringify({title: document.title, links: document.querySelectorAll('a').length, buttons: document.querySelectorAll('button').length, forms: document.querySelectorAll('form').length})"
4. Analyze: navigation patterns, CTA placement, information hierarchy, mobile indicators

Report:
SITE: {url}
UX_SCORE: 1-10
NAVIGATION: [clear/confusing, why]
CTAS: [placement, clarity, count]
FRICTION: [any friction points]
```

**Content/Article Research:**
```
Browser agent. Session: --session {SESSION}.
Task: Extract key insights and arguments from this page.
Success: Main thesis, supporting points, notable data identified.

Steps:
1. agent-browser --session {SESSION} eval "document.body.innerText.substring(0,8000)"
2. Parse: main thesis, key arguments, statistics cited, author credentials

Report:
SITE: {url}
TOPIC: {main topic}
THESIS: {one-sentence main argument}
KEY_POINTS: [3-5 bullet points]
DATA: [statistics or evidence cited]
CREDIBILITY: HIGH|MEDIUM|LOW
```

**Forum/Discussion Research:**
```
Browser agent. Session: --session {SESSION}.
Task: Extract community opinions and consensus from this discussion.
Success: Main viewpoints, consensus themes, contrarian opinions identified.

Steps:
1. agent-browser --session {SESSION} eval "document.body.innerText.substring(0,10000)"
2. Identify: top-voted opinions, recurring themes, contrarian views, expert responses

Report:
SITE: {url}
THREAD_TOPIC: {topic}
CONSENSUS: [what most agree on]
CONTRARIAN: [dissenting views]
EXPERT_TAKES: [responses from verified experts]
ACTIONABLE: [practical advice]
```

**Competitive Analysis:**
```
Browser agent. Session: --session {SESSION}.
Task: Analyze this competitor's product positioning.
Success: Value prop, pricing, features, differentiators extracted.

Steps:
1. agent-browser --session {SESSION} snapshot -i
2. agent-browser --session {SESSION} eval "document.body.innerText.substring(0,5000)"
3. agent-browser --session {SESSION} screenshot /tmp/{SESSION}.png
4. Extract: value proposition, pricing tiers, feature list, social proof, CTA strategy

Report:
SITE: {url}
COMPANY: {name}
VALUE_PROP: {one-sentence positioning}
PRICING: {model and tiers}
KEY_FEATURES: [top 5]
DIFFERENTIATOR: {what sets them apart}
WEAKNESS: {apparent gap}
```

### Aspect-Specific Templates

**Specs extraction (fast — eval only, no clicking):**
```
Browser agent. Session: --session {SESSION}.
Task: Extract product specs from already-open page.
Success: Price, rating, review count, seller name extracted.

Steps:
1. agent-browser --session {SESSION} eval "document.body.innerText.substring(0,3000)"
2. Parse the output for: price, rating, reviews, seller, specs
3. agent-browser --session {SESSION} screenshot /tmp/{SESSION}.png

Report: DATA with all extracted fields.
```

**Negative review reader (needs clicking):**
```
Browser agent. Session: --session {SESSION}.
Task: Find and read negative reviews (1-2 stars).
Success: Top 3 complaint themes identified.

Steps:
1. agent-browser --session {SESSION} snapshot -i
2. Find reviews section, click filter for 1-2 stars
3. agent-browser --session {SESSION} eval to extract review text
4. agent-browser --session {SESSION} screenshot /tmp/{SESSION}.png

Report: Top 3 complaint themes with quoted evidence.
```

**Seller profile checker (fast — eval only):**
```
Browser agent. Session: --session {SESSION}.
Task: Check seller reputation on their shop page.
Success: Seller rating, followers, response rate, join date extracted.

Steps:
1. agent-browser --session {SESSION} eval "document.body.innerText.substring(0,3000)"
2. Extract: shop name, rating, followers, response rate, badges
3. agent-browser --session {SESSION} screenshot /tmp/{SESSION}.png

Report: TRUSTED|DECENT|RISKY with evidence.
```

---

## Step 4: AGGREGATE — Collect and Compare

After all agents complete:

### For Verification:
1. Collect PASS/FAIL results → summary table
2. For failures: Read screenshot at `/tmp/{SESSION}.png`
3. Present final pass/fail summary

### For Research:
1. Collect all DATA results into a structured dataset
2. **Rank:** Sort by score/rating
3. **Cluster:** Group findings by theme/pattern
4. **Synthesize:** What patterns emerge across all results?
5. **Contrast:** What do the best examples do that the worst don't?
6. **Recommend:** Actionable takeaways from the research
7. Present as: ranking table + pattern analysis + recommendations

### For Discovery Research (DISCOVERY-PARALLEL):
1. After Tier 1 fast scan: rank all URLs by score
2. Identify top 10-20% for deep dive (Tier 2)
3. After Tier 2 deep dive: synthesize into insights
4. Final output: "Here are the N sites I analyzed. The top 10 are... The common patterns are... My recommendations are..."

---

## Step 5: CLEANUP

```bash
for s in s1 s2 s3 sN; do agent-browser --session $s close & done; wait
```

Or let idle tabs auto-close.

---

## Worked Examples

### Example 1: Open-Ended Research Swarm (discovery → analysis)

```
User: "Find the most beautiful landing pages. Look at 50 examples, figure out what makes them beautiful."

DECOMPOSE: DISCOVERY-PARALLEL → unknown URLs → need discovery first

PHASE 0 — DISCOVER (coordinator, not agents):
  WebSearch("most beautiful landing pages 2025")
  WebSearch("awwwards site of the year winners")
  WebSearch("best landing page design examples curated list")
  WebSearch("beautiful website design reddit recommendations")
  WebSearch("landing page design inspiration dribbble behance")

  → Collect 50 unique URLs from search results

PHASE A — SETUP:
  ab-swarm-setup r-1=URL1 r-2=URL2 ... r-50=URL50

PHASE B1 — FAST SCAN (50 agents, eval-only, ALL in ONE message):
  50 agents using "Design Fast-Scan" template
  Each reports: SITE, DESIGN_SCORE, STANDOUT

PHASE B2 — DEEP DIVE (top 10, screenshot agents):
  Sort 50 results by DESIGN_SCORE
  ab-swarm-setup deep-1=TOP1 ... deep-10=TOP10
  10 agents using full "Design/Visual Analysis" template (with screenshot)

AGGREGATE:
  Ranking table: Site | Score | Top Technique | Standout Element
  Pattern analysis: "The top 10 sites share these patterns: ..."
  Uniformity analysis: "Sites scoring 9+ all have consistent spacing and grid alignment"
  Symmetry analysis: "8/10 top sites use balanced visual weight with intentional asymmetric accents"
  Actionable: "To create a beautiful landing page, prioritize: ..."
```

### Example 2: Research Swarm (8 products × 3 aspects = 24 agents)

```
User: "Research 8 Shopee laptops, compare specs, reviews, and sellers"

DECOMPOSE: ASPECT-PARALLEL → 8 items × 3 aspects = 24 agents
  Sessions: specs-1..8, rev-1..8, seller-1..8
  URLs: 8 product pages + 8 seller shop pages

SETUP (1 Bash call):
  ab-swarm-setup specs-1=URL1 specs-2=URL2 ... specs-8=URL8 \
    rev-1=URL1 rev-2=URL2 ... rev-8=URL8 \
    seller-1=SHOP1 seller-2=SHOP2 ... seller-8=SHOP8

DISPATCH (24 Agent calls, ALL in ONE message):
  8 specs agents using "Specs extraction" template
  8 review agents using "Negative review reader" template
  8 seller agents using "Seller profile checker" template

AGGREGATE: Comparison table with columns:
  Product | Price | Rating | Reviews | Seller Rating | Top Complaints | Verdict
```

### Example 3: Verification Swarm (4 edited files)

```
User edited: header.html, nav.html, hero.html, footer.html

DECOMPOSE: SECTION-PARALLEL → 4 agents
  Sessions: v-header, v-nav, v-hero, v-footer

SETUP:
  ab-swarm-setup v-header=http://localhost:3000 v-nav=http://localhost:3000 \
    v-hero=http://localhost:3000 v-footer=http://localhost:3000/about

DISPATCH (4 Agent calls, ONE message):
  Each agent: snapshot → find their section → screenshot → describe

AGGREGATE: 4/4 PASSED or list failures
```

### Example 4: Data-Flow Swarm (wave pattern)

```
User: "Submit contact form, verify it appears in admin and email was sent"

DECOMPOSE: DATA-FLOW → Wave 1 (1 write) + Wave 2 (2 reads)

SETUP:
  ab-swarm-setup write-form=http://localhost:3000/contact \
    read-admin=http://localhost:3000/admin \
    read-email=http://localhost:3000/mail

WAVE 1 (foreground, wait for completion):
  1 Agent (run_in_background: false): Fill and submit contact form

WAVE 2 (parallel, after Wave 1 completes):
  2 Agents (run_in_background: true): Check admin + check email
```

---

## Gate Integration

The browser flow tracker records each `--session` name automatically. The gate enforces:
- **3+ visual files edited** + **1 browser session** = BLOCKED
- **3+ visual files edited** + **2+ browser sessions** = PASSES

The browser swarm gate also enforces:
- **3+ sequential agent-browser opens** without ab-swarm-setup = BLOCKED
- Use ab-swarm-setup to clear the gate automatically

Just use different `--session` names and the gate clears.

## Failure Recovery

If an agent fails:
1. Read its error output
2. Re-dispatch ONE replacement agent with the same session name
3. The session tab is still warm — no setup needed

## Rules

- ALWAYS use `ab-swarm-setup` for 3+ agents (bulk tab opening)
- ALWAYS dispatch ALL Agent calls in ONE message (truly parallel)
- ALWAYS use `run_in_background: true` (except Wave 1 data-flow writes)
- Every agent MUST use `--session <unique-name>`
- Every agent MUST follow orient-first discipline (snapshot before click)
- Use eval for data extraction (faster than clicking through UI)
- Session names MUST be descriptive: `specs-1`, `rev-3`, `v-header`, `seller-5`
- For research tasks involving 3+ web pages, use this skill — sequential browsing is wasteful
