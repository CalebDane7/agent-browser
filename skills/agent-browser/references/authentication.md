# Authentication

Use the real persistent Chrome profile for the browser session. The requested
app's actual deployment owns its application-login configuration; a Chrome
profile handle does not select an app user. Never start from a clean browser or
export cookies just because a site shows a login page.

## Resolve The Account First

- Omit `--account` only when the runtime's configured default matches the task.
- For a requested account, pass `--account HANDLE` using its exact enrolled
  alias from the local installed operator mapping (see `SKILL.md`). Keep that
  map private.
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
4. If a password is required, retrieve the existing app credential from its
   authorized deployment as below, complete the sign-in, and verify the visible
   account/tenant and requested destination. Do not silently switch identities.

Do not ask the user to "sign in first" or supply a password that the agent can
obtain from the authorized server. A login prompt is part of the task, not proof
that the user must intervene. Never request secrets in chat or expose their values.

When the site offers **Continue with Google**, use the selected Chrome profile's
existing Google session if it matches the intended site account. Follow the normal
account chooser and redirects, then verify the site's returned identity. Do not
choose a different Google identity merely because it is offered.

Whenever a sign-in sends an **email verification code**, use the intended account's
already signed-in Gmail in the selected Chrome profile. Read only that site's
relevant message, enter the code through the private
[`eval --stdin`](commands.md#private-app-login-input) route after checking the
expected site origin and code field, and verify the returned site identity. Keep
the code in memory; never put it in chat, a command argument, file, log, or
screenshot. If Gmail is unavailable but the authorized Google Workspace CLI
session works, use it for the same narrow lookup. A CLI reauthorization prompt
does not block an already signed-in Gmail browser route. Stop only at a proven
account-authority or user-only verification boundary.

## Retrieve The Existing App Login

For authorized work on a user-owned app, identify the intended app, origin,
account/role and real running build from the task and current deployment evidence.
Reach that deployment through its own authorized server access. A browser
`--account` handle selects a Chrome profile; it is never a server locator.

Follow the running service/container or deployment's references to the relevant
environment/secret source, maintained seed/test-account setup or app runbook.
Inspect metadata and key names first; retrieve only the needed existing login
into a local process's memory. Do not dump `.env`, process environments, databases
or unrelated apps' secrets into tool output. Check actual deployment evidence
before trusting a local example or assuming a seed password still works.

Use the supported private input route in [commands](commands.md#private-app-login-input):
pipe an expression generated in memory to `eval --stdin`, with the password
JSON-encoded as data, the expected origin and observed form selector checked, and
only a fixed nonsecret result returned. Submit the normal sign-in control, then
inspect the authenticated destination. Do not read back the password or include
it in chat, tool-call literals, process arguments, logs, screenshots or files.

If a recovered credential is rejected, distinguish wrong app/build/account or
stale seed data before another attempt. Do not guess defaults, cycle passwords,
crack hashes, reset/rotate credentials, create users, mint sessions or disable
authentication merely to get access. A password hash is not a recoverable login;
look for an existing authorized sign-in source, not a bypass. Deployment access
does not authorize using unrelated users' accounts.

WHY: the old rule treated a password form as a human-only boundary and forbade
all credential inspection, omitting the user's authorized server lookup. The
protection is private, scoped credential use; it must not force the user to do
work the agent can complete. This fails if a server-available password is handed
back to the user, or if retrieval expands into credential changes or other accounts.

## Genuine Human-Input Boundary

Only pause after the rendered flow and authorized sources establish an actual
blocker: an unavailable credential, user-only 2FA/hardware-key, recovery, CAPTCHA,
unsupported file selection, or an unresolved account-authority decision. A password
field by itself never establishes this. State the precise blocker and nonsecret
sources already checked; ask only for the remaining user action. A consent page
is not automatically a user boundary: inspect identity, scope and existing grant.

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

Run the matching session `close` promptly when finished, including after failure,
unless that exact tab is still in use with the user or awaiting genuine input.
Repeat the same explicit account handle and session. Never close a user's
pre-existing tab; end an invited attachment by detaching once supported and done.
