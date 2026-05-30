# LinkedIn Profile Automation Playbook

## Parallelization Strategy

When automating multiple LinkedIn profile sections, spawn parallel agents with isolated sessions:

```
Agent 1 (--session linkedin-exp): Experience entries (sequential within)
Agent 2 (--session linkedin-skills): Skills (sequential within)
Agent 3 (--session linkedin-feat): Featured links (sequential within)
```

Each agent opens linkedin.com/in/USERNAME independently using `--session` flag.
Different profile sections are independent — no cross-tab dependencies.
This turns a ~45min sequential task into ~15min parallel execution.

Important: Each agent must connect to the user's Chrome debug session separately:
```bash
agent-browser --session linkedin-exp connect 9222
agent-browser --session linkedin-skills connect 9222
agent-browser --session linkedin-feat connect 9222
```

## Pre-Interaction Checklist

Before ANY interaction on LinkedIn:

1. **Dismiss banners first** — LinkedIn shows "Update to our terms" and similar banners. Snapshot, find the close/dismiss button (often an unlabeled `[button]` near "Learn more"), click it.
2. **Use the SECOND "Add section" link** — The first "Add profile section" link (`[nth=0]`) is near the navbar and clicks often land on LinkedIn's "For Business" dropdown instead. Always `scrollintoview` the second one (`[nth=1]`) before clicking.
3. **NEVER press Escape** — LinkedIn's SPA interprets Escape as "Discard changes?" which opens a confirmation dialog. To dismiss dropdowns, click elsewhere or move to the next field.
4. **Navigate to profile first** — `agent-browser open https://www.linkedin.com/in/USERNAME`

## Playbook: Add Experience Entry

### Navigation
1. Scroll to the second "Add profile section" button and click it
2. In the dropdown: click "Add position" (under "Core" section)
3. Wait for the modal form to appear, then snapshot

### Field-by-Field Reference

| Field | Snapshot Type | Command | Notes |
|-------|--------------|---------|-------|
| Title | `[textbox]` | `fill @ref "Founder & Lead Engineer"` | Standard text input |
| Company | `[combobox]` | `fill @ref "MANTIS"` → `wait 1000` → snapshot → click dropdown option | Autocomplete — type partial text, wait for suggestions, click match. If no match, LinkedIn creates a new company entry. |
| Employment type | `[combobox]` | `select @ref "Full-time"` | Options: Full-time, Part-time, Self-employed, Freelance, Contract, Internship, Apprenticeship, Seasonal |
| Currently working | `[checkbox]` | `check @ref` (present role) or `uncheck @ref` (past role) | Controls whether End Date fields appear |
| Start Month | `[combobox]` | `select @ref "January"` | Native select-like dropdown |
| Start Year | `[combobox]` | `select @ref "2025"` | Native select-like dropdown |
| End Month | `[combobox]` | `select @ref "December"` | Only visible if "currently working" is unchecked |
| End Year | `[combobox]` | `select @ref "2024"` | Only visible if "currently working" is unchecked |
| Location | `[combobox]` | `fill @ref "Bali"` → `wait 1000` → snapshot → click option | Autocomplete — type partial, wait, click |
| Location type | `[combobox]` | `select @ref "Remote"` | Options: On-site, Hybrid, Remote |
| Description | `[contenteditable]` | Use eval (see below) | Rich text editor — fill/type DON'T work |

### Description Field (contenteditable)

```bash
agent-browser eval --stdin <<'EVALEOF'
const el = document.querySelector('[contenteditable="true"]');
el.innerHTML = `Your description text here.

Use line breaks for formatting.
- Bullet points work
- Keep under ~2000 chars`;
el.dispatchEvent(new InputEvent('input', { bubbles: true }));
EVALEOF
```

### After Saving
1. Click Save button
2. Wait for modal to close: `wait --load networkidle`
3. LinkedIn may show follow-up prompts ("Add skills to this position?", "Notify network?") — snapshot and click "Skip", "Not now", or dismiss button
4. Re-snapshot before adding the next entry

### Repeating for Multiple Entries
After saving one entry, navigate back to "Add position" and repeat. Each save closes the modal and returns to the profile page.

## Playbook: Add Skills

### Navigation
1. Scroll to second "Add profile section" button → click
2. Click "Add skills" (under "Core" section)
3. Wait for the skills modal

### Workflow (per skill)
```
1. snapshot -i                          # Orient
2. fill @search-ref "AI Development"   # Type skill name in search box
3. wait 1000                           # Wait for dropdown results
4. snapshot -i                          # See dropdown options
5. click @option-ref                   # Click the matching skill option (usually a [button] or [option])
```

### Notes
- LinkedIn has a fixed taxonomy — some custom skill names may not match exactly. Use the closest available option.
- After selecting a skill, LinkedIn may ask "Where did you use this skill?" — click "Skip" or dismiss
- You can add up to 100 skills
- Top 3 skills are featured prominently — add the most important ones first
- Skills are added one at a time in the same modal (no need to re-open)

### Skills to Add (in order of importance)
1. AI Development
2. Claude Code
3. Python
4. AI Governance
5. Browser Automation
6. Full-Stack Development
7. Docker
8. PostgreSQL
9. React
10. Next.js
11. Flask
12. Business Automation
13. WhatsApp API
14. Machine Learning
15. Content Strategy
16. Open Source

## Playbook: Add Featured Links

### Navigation
1. Scroll to second "Add profile section" button → click
2. Click "Add Featured" (under "Recommended" section)
3. Click the "+" button or "Add a link" option

### Workflow (per link)
```
1. snapshot -i                              # Orient
2. fill @url-ref "https://erebora.org"      # Paste URL
3. click @add-button                        # Click Add/Submit
4. wait 2000                                # Wait for LinkedIn to fetch URL metadata
5. snapshot -i                              # See the preview form
6. DO NOT modify title or description       # CRITICAL — see below
7. click @save-button                       # Save with auto-populated defaults
```

### CRITICAL: Do NOT Modify Auto-Populated Fields

When you paste a URL, LinkedIn fetches the page's metadata and auto-populates Title and Description. **Using `fill` on these fields breaks React's internal state, causing "Save failed".** This was verified through 3 failed attempts.

**What works:** Save with whatever LinkedIn auto-populated. Edit the title/description AFTER saving if needed (via the edit pencil icon on the saved featured item).

### Links to Add
1. `https://erebora.org/kittyAI` — MANTIS landing page
2. `https://github.com/CalebDane7/agent-browser` — Agent-Browser GitHub
3. `https://erebora.org` — Erebora Motorcycles

## Playbook: Edit Headline / About Section

### Headline
LinkedIn's headline is a contenteditable field. Click the pencil/edit icon next to the headline, then:

```bash
agent-browser eval --stdin <<'EVALEOF'
const el = document.querySelector('[contenteditable="true"]');
el.innerHTML = 'Your headline text here';
el.dispatchEvent(new InputEvent('input', { bubbles: true }));
EVALEOF
```

Then click Save.

### About Section
Same pattern — click "Edit" on the About section, find the contenteditable div, use eval:

```bash
agent-browser eval --stdin <<'EVALEOF'
const el = document.querySelector('[contenteditable="true"]');
el.innerHTML = `Your about section text here.

Multiple paragraphs work.
Keep under 2,600 characters.`;
el.dispatchEvent(new InputEvent('input', { bubbles: true }));
EVALEOF
```

**Note:** If multiple contenteditable fields are visible, use a more specific selector targeting the parent container of the About section.

## Known LinkedIn Quirks

1. **"Add section" navbar collision** — First "Add profile section" link is near the top navbar. Clicking it without scrolling may hit LinkedIn's "For Business" dropdown button instead. Always `scrollintoview` the second instance before clicking.

2. **Auto-populated metadata breaks React state** — In Featured Links, LinkedIn fetches URL metadata and populates Title/Description. Using `fill` on these fields corrupts React's internal state → "Save failed". Never modify auto-populated metadata fields.

3. **"Update to our terms" banner** — LinkedIn periodically shows a banner at the top with an unlabeled close button. This banner intercepts clicks on elements below it. Dismiss it first (look for an unlabeled `[button]` near "Learn more").

4. **Escape triggers discard dialog** — Pressing Escape in any modal triggers a "Discard changes?" confirmation. Never use Escape. To dismiss dropdowns, click another field or click outside the dropdown.

5. **`type` appends, `fill` replaces** — Using `type` on a pre-filled field creates "Existing TextNew Text". Always use `fill` to clear-then-type. The only exception is appending to an existing value intentionally.

6. **Refs invalidate after every modal/dropdown interaction** — LinkedIn's React app re-renders frequently. After ANY click that opens a dropdown, selects an option, opens a modal, or closes a modal, all refs are stale. Re-snapshot before the next interaction.

7. **Post-save follow-up prompts** — After saving an Experience entry, LinkedIn often shows "Add skills to this position?", "Notify your network?", or suggestion dialogs. These block further interaction until dismissed. Snapshot and click "Skip"/"Not now"/"Close".

8. **Company autocomplete creates new entries** — If you type a company name that doesn't match LinkedIn's database, it silently creates a new company page. This is usually fine for new/small companies but means the logo won't appear.

9. **Session sharing across tabs** — LinkedIn uses a single authenticated session. Multiple `--session` flags in agent-browser create separate browser contexts, but they all share the same LinkedIn login cookies IF connected to the same Chrome instance via CDP. Each session opens its own tab in the user's Chrome.

10. **Location autocomplete is slow** — Location field suggestions can take 2-3 seconds to appear. Use `wait 2000` after typing before snapshotting for dropdown options.
