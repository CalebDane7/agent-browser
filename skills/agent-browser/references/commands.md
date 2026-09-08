# Authenticated Private-Route Command Reference

This is the source-checked syntax subset for the installed private Agent Browser
route, not a claim that every command has passed a live journey. The pinned
Vercel v0.36 engine exposes more commands, but its standalone `--help` does not
prove that the authenticated page capability permits them.

## Mandatory Prefix

Every invocation needs one globally unique task session. Generate it once and
retain its exact value across tool calls; shell variables may not survive a new
call. Reuse the same account/session on every command:

```bash
IFS= read -r task_uuid </proc/sys/kernel/random/uuid
# For examples with --account, set browser_account from the local mapping.
# Otherwise omit --account consistently to use the runtime default.
task_session="research-pricing-${task_uuid//-/}"
agent-browser --session "$task_session" open https://example.com
```

For a non-default profile, repeat the exact enrolled account handle on **every**
command, including `close`. Use the local installed operator mapping, not an
invented handle or an email guessed from the user's wording:

```bash
IFS= read -r account_uuid </proc/sys/kernel/random/uuid
: "${browser_account:?Set the requested alias from the local operator mapping}"
account_session="account-pricing-${account_uuid//-/}"
agent-browser --account "$browser_account" --session "$account_session" open https://example.com
agent-browser --account "$browser_account" --session "$account_session" snapshot -i --compact
agent-browser --account "$browser_account" --session "$account_session" close
```

For an explicitly invited current-tab session, repeat `--current-tab` as well:

```bash
IFS= read -r current_tab_uuid </proc/sys/kernel/random/uuid
current_tab_session="current-help-${current_tab_uuid//-/}"
agent-browser --session "$current_tab_session" --current-tab get url
agent-browser --session "$current_tab_session" --current-tab snapshot -i --compact
agent-browser --session "$current_tab_session" --current-tab close
```

Do not run two commands concurrently against the same session. Independent
agents should use different semantic session names and may run concurrently,
including in the same profile. The current broker cap is 16 total live sessions.

## Core Page Commands

Use fresh snapshot refs after navigation or a material DOM change:

```bash
agent-browser --session "$task_session" snapshot -i --compact
agent-browser --session "$task_session" snapshot -i --compact -s "#main"

agent-browser --session "$task_session" click @e1
agent-browser --session "$task_session" dblclick @e1
agent-browser --session "$task_session" fill @e2 "text"
agent-browser --session "$task_session" type @e2 "text"
agent-browser --session "$task_session" press Enter
agent-browser --session "$task_session" hover @e1
agent-browser --session "$task_session" check @e3
agent-browser --session "$task_session" uncheck @e3
agent-browser --session "$task_session" select @e4 "value"
agent-browser --session "$task_session" scroll down 500
agent-browser --session "$task_session" scrollintoview @e5
agent-browser --session "$task_session" drag @e5 @e6
agent-browser --session "$task_session" upload @e7 'C:\path\file.pdf'
```

The installed engine (`6612815`) supports caller-relative uploads. A scoped
Chrome check verified the selected file's contents in 58 ms. Use only an
explicitly authorized file that Windows Chrome can access; this does not grant
arbitrary filesystem access or justify transferring files to bypass a failure.
Preserve the current profile's file-access permission boundary.

Never put a password, token, seed phrase, private key, wallet vault, or one-time
code in a command. User-only secrets are entered by the user in the retained
exact task tab.

## Navigation, Observation, And Waits

```bash
agent-browser --session "$task_session" back
agent-browser --session "$task_session" forward
agent-browser --session "$task_session" reload

agent-browser --session "$task_session" get text @e1
agent-browser --session "$task_session" get html @e1
agent-browser --session "$task_session" get value @e1
agent-browser --session "$task_session" get attr @e1 href
agent-browser --session "$task_session" get title
agent-browser --session "$task_session" get url
agent-browser --session "$task_session" get count ".item"
agent-browser --session "$task_session" get box @e1
agent-browser --session "$task_session" is visible @e1
agent-browser --session "$task_session" is enabled @e1
agent-browser --session "$task_session" is checked @e1

agent-browser --session "$task_session" wait "#success"
agent-browser --session "$task_session" wait --text "Success"
agent-browser --session "$task_session" wait --url "**/dashboard"
agent-browser --session "$task_session" wait --load networkidle
agent-browser --session "$task_session" wait --fn "window.ready === true"
```

Prefer an observable wait over arbitrary milliseconds. Selector waits use CSS,
not `@ref`; this engine's wait path does not resolve snapshot references.

## Locators, Screenshots, And Page Diagnostics

```bash
agent-browser --session "$task_session" find role button click --name "Submit"
agent-browser --session "$task_session" find text "Sign In" click --exact
agent-browser --session "$task_session" find label "Email" fill "user@example.com"
agent-browser --session "$task_session" find placeholder "Search" fill "query"

agent-browser --session "$task_session" screenshot "/tmp/${task_session}.png"
agent-browser --session "$task_session" screenshot --full "/tmp/${task_session}-full.png"
agent-browser --session "$task_session" console
agent-browser --session "$task_session" errors
```

### Structured Output

Put output flags after the command, following the usual account/session prefix:

```bash
agent-browser --session "$task_session" snapshot -i --compact -s "#main" --json
```

Check `success` and any `error` before using `data`; command exit alone is not
proof of the requested page result. Scope snapshots/observations first and use
`--max-output` to bound serialized data. JSON alone does not make output small.
For an explicit-account workflow, include the same `--account` used to open it.

### Installed Functions

Verified September 8, 2026: engine `6612815` is installed. The ordinary CLI,
rollback and reapply passed real-Chrome checks. Use these functions through the
normal command; the measurements below remain scoped to their tested cases.

| Function | Syntax after the account/session prefix | Important boundary |
| --- | --- | --- |
| Full-page PNG | `screenshot --full "/tmp/full.png"` | Full document, including below the viewport |
| Element PNG | `screenshot "#chart" "/tmp/chart.png"` | CSS selector, including a tall offscreen region |
| JPEG | `screenshot "/tmp/view.jpg" --screenshot-format jpeg --screenshot-quality 80` | Choose format/quality explicitly |
| Clear captured console | `console --clear` | Only this session's captured console buffer |
| Clear captured errors | `errors --clear` | Preserves console and other owners; the old engine ignores this clear request |
| Bounded JSON data | `snapshot -i --compact -s "#main" --json --max-output 4000` | Per-result serialized-character limit, not a total-byte limit |
| Caller-relative upload | `upload @e7 "./approved-file.txt"` | Only an authorized file; existing upload/path protections still apply |

Oversized JSON data may be omitted with a warning while action status and
control identifiers survive. Missing output does **not** mean an action failed.
Never repeat a click, upload, or submission to recover omitted output; make a
smaller read-only observation instead. Read needed diagnostics before clearing
their buffers.

Candidate captures observed viewport PNG 201 ms, full-page PNG 731 ms, selector
PNG 579 ms, and quality-80 JPEG 589–694 ms. These are individual local results,
not universal speed promises or proof of every later engine/extension pairing.
Use ordinary viewport capture on the current installation when sufficient.

### User-Only Input

With the user's permission at a genuine input boundary, bring only your existing
task tab forward:

```bash
: "${browser_account:?Set the requested alias from the local operator mapping}"
: "${task_session:?Reuse the session already opened for this task}"
agent-browser --account "$browser_account" --session "$task_session" foreground --input-boundary two-factor
# After the user finishes, repeat this command's exact account/session/current-tab prefix:
agent-browser --account "$browser_account" --session "$task_session" background
```

If this is an invited current-tab session, repeat `--current-tab` on both
commands too. Allowed boundary values:
`password`, `two-factor`, `hardware-key`, `captcha`, `file-picker`, `recovery`,
`account-authority`. This wrapper command already returns JSON; do not append
engine flags. It does not create a tab or retry an interrupted activation.
`background` is conditional: it restores the saved prior app or tab only while
the owner-bound handoff's focus history remains unchanged. `cancelled`, `denied`,
`unconfirmed`, or `no-handoff` does not promise where focus is. Do not retry or
force focus.

Multiple explicitly invited agents can use `--current-tab` with their own
sessions to share one user tab. Complete commands are serialized there;
matching `close` detaches each agent without closing that user tab.

Use `eval` only for a page-local observation/action that normal commands cannot
express. It must never bypass profile, extension, cookie, wallet, tab-ownership,
focus, or command restrictions.

## Tabs And Cleanup

```bash
agent-browser --session "$task_session" tab list
agent-browser --session "$task_session" close
```

Only `tab list` is supported; it shows this session's synthetic page entry, not
all Chrome tabs. The private route rejects tab creation, switching,
or closing by mutable index. Page-created opener descendants stay within their
owning session and the matching session `close` retires them. A current-tab
session detaches without closing the user's tab. `close --all` is rejected.

## Intentionally Rejected Surface

The wrapper rejects these commands: `auth`, `chat`, `clipboard`, `connect`,
`cookies`, `dashboard`, `inspect`, `install`, `mcp`, `plugin`, `profiles`,
`storage`, and `upgrade`. It also rejects alternate provider/CDP/profile/state,
restore, extension, config, namespace, headed, engine, executable, proxy,
certificate, unrestricted-file, action-policy, and idle-timeout controls.

The page capability denies `Target.*`, `WebMCP.*`, cookie CDP methods,
`Page.bringToFront`, and `Page.setDownloadBehavior`. Therefore do not use legacy
`window`, trace/profiler, WebMCP, direct-download, donor focus, or profile/state
examples from the standalone donor documentation. Browser-internal and extension
URLs are outside the ordinary HTTP(S) task route.

If a needed command is not documented here, inspect the shipped source to
check the exact wrapper parser, donor dispatch, and page-capability
contract before running it. Do not probe the live browser by guessing commands.
