# Session Management

Named sessions isolate task ownership, tabs, and element refs. They do not
select or isolate the Google account; Chrome profiles own cookies and saved
sign-in state.

The installed session key includes the observed owner process birth and the
native Codex child-thread namespace, not just the human alias. Different owners
using the same alias get separate tabs; reusing an alias is not a handoff API.
Keep commands and close in the original worker. Never overwrite owner metadata
to impersonate another session. Confirmed native process death permits exact
automatic cleanup; a completed child thread may share a still-live process.

## One Workflow, One Named Session

```bash
IFS= read -r task_uuid </proc/sys/kernel/random/uuid
# An exact enrolled handle; to use the runtime default, omit --account on every command.
: "${browser_account:?Set the requested alias from the local operator mapping}"
task_session="checkout-${task_uuid//-/}"
agent-browser --account "$browser_account" --session "$task_session" open URL
agent-browser --account "$browser_account" --session "$task_session" snapshot -i --compact
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
mapping (see `SKILL.md`); never guess that an email is itself a valid
`--account` value or silently use default.
Repeat the same explicit account handle on every command for that session.

## Background And Current-Tab Collaboration

Normal `open` creates an inactive tab. If the selected profile has no ordinary
window, its extension lazily creates one minimized task window; closing its last
task removes that extension-owned window. Do not keep idle windows per profile.

Use the user's current tab only after an explicit request to help in that tab.
Start a fresh session with `--current-tab get url` while the intended profile's
tab is selected and its Chrome window is foreground. Verify the returned URL
before reading or changing the page. The installed broker performs a one-shot
focus proof and claim; it never searches for a likely substitute. Another
agent's task tab is not claimable.

At initial claim, wait for the intended document to render, not merely for its
address to appear. Chrome may report an empty frame URL before document loading
has begun. If focus changes during the claim, preserve the failure; do not
force focus back or repeatedly claim. A new attempt needs an observed change
at that exact failed boundary. This requirement is only for initial attachment,
not ordinary background commands or later work in an already attached tab.

Two explicitly invited agents sharing one user tab passed a separate real-Chrome
check: overlapping commands serialized, each detach preserved the other agent,
and the user's document and input value survived. Each agent needs its own
session and invitation; a task-owned tab remains exclusive to its owner.
Prefer independent tabs when work can actually run in parallel.

Keep `--current-tab` and the same explicit account/session on every command.
After attachment, the user may minimize Chrome or switch to other work; the
agent continues in the retained tab without activating it. Finish with matching
`close`: this detaches but preserves the user's tab. This claim → minimized
interaction → detach/survival flow passed the maintainer's real-Chrome check on
September 6, 2026. A failed
initial focus claim needs the actual selected-tab condition resolved, not a
different tab or repeated guesses. Normal owned-tab work needs no focus claim.

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
profile. Use only accounts listed in the local installed operator mapping.
Enrollment is a one-time setup step per profile that the agent performs through
the [setup guide](setup.md); it is not repeated during ordinary use: an offline
enrolled profile is started on demand and reconnects automatically. A new
approval or pairing prompt during reuse is a real failure; do not click through
it, re-pair, reinstall, or create another Chrome to retry.

## Cleanup

Close a finished task session promptly on success, failure, or cancellation.
Keep it only while the user and agent are still working together in that tab or
while genuine user input is pending. Retain the original account/session across
that pause. Do not leave idle or blank task tabs consuming memory.

Use the **original** account and session (substitute the retained values):

```bash
agent-browser --account "$browser_account" --session "$task_session" close
```

The wrapper closes task-owned targets and preserves the user's real Stable
Chrome, unrelated retained user/auth tabs, extensions, settings, and profile.
It follows exact opener descendants created by the task and closes only those it
owns. A user-tab attachment must detach without closing the user tab; the current
availability limit above still applies. Never close another worker's tabs or
the user's pre-existing tabs. Wait for close to exit and report failure if it
fails. A parent must resume the original worker for its cleanup when possible,
or report an exact cleanup failure to the runtime maintainer. A successful
parent close
under the same alias does not prove the child's tab was closed.

User-owned authentication remains in the selected Chrome profile. Never print,
export, copy, save, or transfer its cookies, tokens, passwords, or recovery data.
