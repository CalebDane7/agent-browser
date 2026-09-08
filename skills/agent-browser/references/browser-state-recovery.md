# Protected Browser And Extension State Boundary

This reference is a stop/route rule, not permission or a repair procedure. The
ordinary private Agent Browser route controls HTTP(S) task tabs. It does not
grant authority to inspect or mutate Chrome profile files, extension storage,
cookies, credentials, MetaMask, wallets, USB, or hardware-wallet behavior.

## If Expected State Looks Missing

- Treat onboarding, a logged-out page, a missing extension state, or a new
  approval prompt as a real red. Do not create/import/reset anything to make the
  symptom disappear.
- Keep Windows Stable Chrome's actual `User Data` root and exact enrolled profile
  as authority. Never substitute `ChromeCDP`, a copied/temporary profile, or an
  alternate `--user-data-dir`.
- Do not restart Chrome, WSL, the broker, or the extension merely to retry, and
  do not repeat the same browser action without a causal evidence delta.
- Never print, export, copy, or persist cookies, tokens, passwords, vaults, seed
  phrases, private keys, one-time codes, or recovery secrets.
- Stop ordinary browser work and give a maintainer a separately authorized
  state-recovery task. That work
  must bind the exact current version/profile/origin, preserve a scoped preimage,
  name a rollback consumer, and prove the literal fresh lifecycle.

## Historical Why, Not Current Procedure

In the August 26 MetaMask 13.44/13.45 recovery, visible extension presence and a
key count did not prove a usable wallet. Evidence showed version-specific split
controller state, and loaded extension code could rewrite storage after a write.
An immediate hash match therefore proved only the write boundary; the normal
fresh unlock/account surface was the literal result. This history forbids those
failed shortcuts. It must be revalidated against the installed version before
it can support any future state action.

For genuine user-only input, preserve the exact task session. Let the user
select its tab, or use the documented `foreground --input-boundary TYPE` action
only with permission. After input, use `background` with the exact same account,
session, and `--current-tab` prefix when applicable. Return to the saved prior
app or tab is conditional on unchanged focus history; cancellation, denial,
an unconfirmed result, or no handoff does not promise focus. Never retry or force
focus, and never pass secrets through chat or shell.
