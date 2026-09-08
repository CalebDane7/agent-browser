# Session Management

Named sessions isolate task ownership, tabs, and element refs. They do not
select or isolate the Google account; Chrome profiles own cookies and saved
sign-in state.

The installed session key binds the alias to the real owner process birth and
native child-thread namespace. Different owners using the same alias get
separate tabs; a matching alias is not a handoff or cleanup capability. Keep
the original worker for ongoing work and close. Native process-death cleanup
does not imply that a completed child thread has closed its tabs.

## One Workflow, One Named Session

```bash
IFS= read -r task_uuid </proc/sys/kernel/random/uuid
# This workflow uses the runtime default; omit --account on every command.
task_session="checkout-${task_uuid//-/}"
agent-browser --session "$task_session" open URL
agent-browser --session "$task_session" snapshot -i --compact
# interact and verify, then run the matching close shown under Cleanup
```

- Reuse the matching named session/target for the same workflow.
- Open a new session only when no matching target exists or a genuinely
  independent lane needs one.
- The writer boundary is one owned session/tab tree, not the whole profile.
- Give every concurrent agent a globally unique semantic session name. Run
  independent browser lanes concurrently in separate sessions when that
  materially shortens the full task; the same profile may host several owned
  sessions safely. Serialize dependent actions and any work on the same tab.
- The installed broker currently allows 16 total live sessions. This is
  scalable capacity, not a reason to pre-open tabs; normally keep only a few.
- If the matching target exists but cannot reconnect, fail closed and resolve its
  owner or transport. Do not create a replacement tab that repeats login/2FA.

## Account Lanes

```bash
# Runtime default
IFS= read -r default_uuid </proc/sys/kernel/random/uuid
default_session="default-settings-${default_uuid//-/}"
agent-browser --session "$default_session" open URL
agent-browser --session "$default_session" snapshot -i --compact
agent-browser --session "$default_session" close

# Explicit account, using the locally mapped alias
: "${browser_account:?Set the requested alias from the local operator mapping}"
IFS= read -r account_uuid </proc/sys/kernel/random/uuid
account_session="account-settings-${account_uuid//-/}"
agent-browser --account "$browser_account" --session "$account_session" open URL
agent-browser --account "$browser_account" --session "$account_session" snapshot -i --compact
agent-browser --account "$browser_account" --session "$account_session" close
```

Always verify visible identity before account-sensitive work. For another named
profile or email, use its enrolled alias from the local installed operator
mapping; never guess that an email is itself a valid `--account` value or silently
use default.
Repeat the same explicit account handle on every command for that session.

## Background And Current-Tab Collaboration

Normal `open` creates an inactive tab. If the selected profile has no ordinary
window, its extension lazily creates one minimized task window; closing its last
task removes that extension-owned window. Do not keep idle windows per profile.

Use the user's current tab only after an explicit request to help in that tab:

```bash
IFS= read -r current_tab_uuid </proc/sys/kernel/random/uuid
current_tab_session="current-help-${current_tab_uuid//-/}"
agent-browser --session "$current_tab_session" --current-tab get url
agent-browser --session "$current_tab_session" --current-tab close
```

This is a cold-bootstrap, one-shot claim of the exact focused profile/window/tab.
It never means “find a likely tab.” Another agent's task tab is not claimable.
Repeat `--current-tab` and the same account/session selectors on every
command. Closing this session detaches Agent Browser and preserves the user's tab.

Verify the returned URL before acting. At initial claim, wait for the intended
document to render, not merely for its address to appear. Chrome may report an
empty frame URL before document loading has begun. If focus changes during the
claim, preserve the failure; do not force focus back or repeatedly claim. A new
attempt needs an observed change at that exact failed boundary. After attachment,
the user may minimize Chrome or switch apps while commands continue in the
retained tab without activating it.

Two explicitly invited agents sharing one user tab passed a separate real-Chrome
check: overlapping commands serialized, each detach preserved the other agent,
and the user's document and input value survived. Each agent needs its own
session and invitation; a task-owned tab remains exclusive to its owner.
Prefer independent tabs when work can actually run in parallel.

If a task reaches unavoidable user-only input, preserve its exact session.
With permission, use `foreground --input-boundary TYPE` from the command
reference; otherwise let the user select the tab. After input, run `background`
with the exact same account, session, and `--current-tab` selectors used for the
handoff. Return is conditional on the saved owner/focus state. Cancellation,
denial, an unconfirmed result, or no handoff does not promise focus; never retry
or force it. Resume the same session and keep it open while collaborating,
rather than creating a replacement.

## Pairing And Reconnect

The transport extension is installed, enabled, and enrolled separately in each
profile. Use only accounts listed in the local installed operator mapping. The
one-time enrollment gesture is not repeated during ordinary use: an offline
enrolled profile is started on demand and reconnects automatically. A new approval prompt
during reuse is a real failure; do not auto-click it or create another Chrome.

## Cleanup

Close a finished task session on success, failure, or cancellation, using the
original worker and account/session selectors. Retain it only for ongoing
user collaboration or genuine user-only input:

```bash
agent-browser --session "$task_session" close
# For an explicit-account workflow, repeat --account "$browser_account" too.
```

The wrapper closes task-owned targets and preserves the user's real Stable
Chrome, unrelated retained user/auth tabs, extensions, settings, and profile.
It follows exact opener descendants created by the task and closes only those it
owns. For a `--current-tab` session, it detaches without closing the user tab.
Never leave blank sessions for later cleanup.

Wait for command exit. If a child stops before cleanup, resume that exact worker
when possible or report the failure to the runtime maintainer. Parent-side close
with the same alias operates in the parent's namespace, not the child's. Never
spoof owner metadata to bypass isolation.

User-owned authentication remains in the selected Chrome profile. Never print,
export, copy, save, or transfer its cookies, tokens, passwords, or recovery data.
