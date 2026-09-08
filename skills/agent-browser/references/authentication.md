# Authentication

Use the real persistent Chrome profile as authentication authority. Never start
from a clean browser or export cookies just because a site shows a login page.

## Resolve The Account First

- Omit `--account` only when the runtime's configured default matches the task.
- For a requested account, pass `--account HANDLE` using its exact enrolled
  alias from the local installed operator mapping. Keep that map private.
- Do not invent an account handle from an email or profile label. For a new
  profile, follow the [setup and enrollment guide](setup.md).

A session name does not select an account. Verify the destination page's visible
identity before changing account data, sending anything, or submitting payment.

```bash
IFS= read -r default_auth_uuid </proc/sys/kernel/random/uuid
default_auth_session="default-auth-${default_auth_uuid//-/}"
agent-browser --session "$default_auth_session" open URL
agent-browser --session "$default_auth_session" snapshot -i --compact
agent-browser --session "$default_auth_session" close

# Explicit account lane, using the locally mapped alias
: "${browser_account:?Set the requested alias from the local operator mapping}"
IFS= read -r account_auth_uuid </proc/sys/kernel/random/uuid
account_auth_session="account-auth-${account_auth_uuid//-/}"
agent-browser --account "$browser_account" --session "$account_auth_session" open URL
agent-browser --account "$browser_account" --session "$account_auth_session" snapshot -i --compact
agent-browser --account "$browser_account" --session "$account_auth_session" close
```

## Automate Before Asking

If the site is not already at the authenticated destination:

1. Inspect the visible page and current identity.
2. Use the site's normal account chooser, Continue, Sign in, or OAuth controls
   when they can reuse the selected Chrome profile's saved session.
3. Follow redirects in the same named session and verify the returned identity.
4. Check the requested/default profile's existing signed-in state before saying
   login is unavailable. Do not silently switch to a different identity for an
   account-sensitive action.

Do not ask the user to "sign in first" while a saved-profile path remains. Never
request or expose a password, cookie, token, one-time code, or recovery secret in
chat or shell commands.

## Genuine Human-Input Boundary

Only pause when the rendered page proves an unavoidable password, 2FA,
hardware-key, recovery, CAPTCHA, file-picker, or account-authority decision that
the agent cannot safely complete. A consent page is not automatically a user
boundary: inspect the identity, requested scope, and existing grant first.

Keep the exact named session through the interruption. With the user's
permission, use `foreground --input-boundary TYPE` from the command reference;
otherwise identify the profile and task tab for the user to select. The user
supplies secrets there—not in chat. After input, use `background` with the same
account, session, and `--current-tab` prefix when applicable. It restores the
saved prior app or tab only while the handoff's focus history is unchanged.
Cancellation, denial, an unconfirmed result, or no handoff does not promise where
focus ends up; do not retry or force focus. Resume the same session, verify the
authenticated identity and destination, and close it when shared work is finished.

## OAuth And Persistence

- Continue same-tab OAuth redirects in the same task session and use fresh refs
  after every navigation. Exact task-owned popup descendants require cleanup,
  but the ordinary route cannot switch to or control them. Website-triggered
  popups may bring Chrome forward; this accepted limitation does not waive
  their cleanup. A successful root `close` alone does not prove a popup is gone;
  report a surviving owned popup as cleanup failure to the runtime maintainer,
  without closing guessed or user-owned tabs. If popup interaction
  is required, do not guess tab commands or adopt it as the current tab; only a
  genuine human-input boundary may be handed to the user, otherwise route the
  unsupported browser action to the runtime maintainer.
- Authentication persists in the selected Chrome profile. Do not use portable
  state files for user-owned accounts.
- Never replace an attachment or transport failure with a new clean tab that
  forces another login.
- Keep task tabs inactive by default. The user may select the exact retained
  task tab for input or ongoing collaboration; that does not authorize the agent
  to repeatedly bring Chrome forward or to close the tab during shared work.

## Browser Extensions And MetaMask

- The ordinary private route controls HTTP(S) page tabs; it does not grant
  extension-UI or extension-storage authority. Never use `eval`, raw CDP, or a
  guessed internal URL to bypass that boundary.
- Never reinstall, reset, side-load, unlock, connect, sign, create/import, or
  repair a wallet merely because a site or transport is blocked.
- MetaMask onboarding (`Create a new wallet` / `I have an existing wallet`) is
  a wrong-state RED when the user expects an existing wallet. Preserve the live
  data and stop the ordinary lane. Only a separately explicit wallet/state task
  authorizes investigating that state; never ask for a seed phrase, private
  key, vault, password, or hardware-wallet secret.
- Site connection never authorizes a wallet signature or transaction. Never
  repeat either until the first attempt is proven absent.
- Transport work never authorizes changing MetaMask data or hardware-wallet/USB
  behavior.

Run the matching session `close` promptly when finished, including after failure
or cancellation, unless that exact tab is still in active collaboration with the
user or awaits genuine user-only input. Retain and repeat the same explicit
account/session. End an invited user-tab attachment with matching `close`, which
detaches without closing the user's tab.
