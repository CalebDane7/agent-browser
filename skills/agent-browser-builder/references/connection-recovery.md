# Connection recovery after restart or account change

Use this only for the installed Agent Browser transport. Site sign-in and Codex
OAuth are separate owners; their timing alone does not diagnose the transport.

1. Resolve the installed `agent-browser` entrypoint and current wrapper, account
   mapping, supervisor and state root. Read only mapping identities, not key values.
2. Use the installed supervisor's `requireExtensionBroker` and the control
   client's `health`. In the current private route, the code below is read-only.
   If source/config/receipt identity fails, inspect that exact mismatch; do not
   delete locks or overwrite profile mappings to make validation pass.
3. If `connectedProfiles` contains the requested account, resume its existing
   named session. Check URL, navigate to the intended app if the tab is blank,
   then take a compact snapshot. Sign in normally using the app's authorized
   credentials if needed. Preserve unfinished forms and other owners' tabs.
4. If a previously working profile is now offline, first use existing recovery
   authority to normally close and reopen that exact mapped Stable Chrome profile
   once. Resolve its actual directory, PID/start identity, windows and affected
   owners; preserve saved work/tabs and stop at an unsaved-work prompt. Use the
   supported native recovery owner and existing profile, not kill-all, a copied
   profile or new settings. A shared-owner conflict blocks only that restart.
   Ordinary windowless bootstrap is not this normal close/reopen attempt.
5. Resume the same account/session through the ordinary command and check the
   intended page. If recovered, stop. Only after a failed or unsafe restart,
   inspect the latest native receipt, broker generation and exact profile/host
   chain before proposing setup, pinning or pairing. `profile-unbound` or a
   matching avatar label alone does not prove that the mapped directory lost its
   enrollment. Prepare accessible setup yourself only for the supported remaining
   cause; follow enrollment guidance only for an established binding fault.
6. Any further restart must target the implicated Agent Browser owner once its PID/start identity,
   executable and affected leases are resolved. Other live sessions veto a shared
   broker/extension retirement until safely coordinated. The current broker handles
   SIGTERM with `stop()` and the installed supervisor owns replacement; its process
   may drain after its public endpoints retire. Never blindly delete state, kill by
   broad process name, escalate to Chrome/WSL, or call engine shutdown a preserving
   reconnect: graceful engine cleanup can close task tabs.
7. Prove recovery by ordinary open/snapshot and the intended app's visible state.
   Close a disposable recovery session; retain ongoing task sessions. Report the
   exact repair and limits. A warm reconnect does not prove cold restart durability.

Current read-only diagnostic (run it from the installed checkout's root):

```bash
node --input-type=module <<'JS'
import os from 'node:os';
import path from 'node:path';
import {requireExtensionBroker} from './scripts/agent-browser-extension-supervisor.js';
import {requestExtensionControl} from './scripts/agent-browser-extension-control.js';
const receipt = await requireExtensionBroker({
  stateRoot: `/tmp/agent-browser-extension-${process.getuid()}`,
  profileConfig: path.join(os.homedir(), '.config/agent-browser/extension-profiles.json')
});
console.log(JSON.stringify(await requestExtensionControl(receipt.controlSocket, {op:'health'})));
JS
```

## October 2 evidence and limit

One maintainer session retained an earlier
extension-offline error with empty profile/session health. The next current probe
showed the default profile connected and active sessions on the same broker, while an older
`profile-unbound` receipt still existed. Ordinary same-session open/snapshot worked;
normal app sign-in then reached the authenticated app. No broker/Chrome restart,
re-enrollment or profile reset was performed. The reconnection cause and cold
restart durability remain unknown; do not describe OAuth or a restart as the
verified fix. The decision change is to refresh owner evidence and complete
accessible recovery, rather than repeat a stale block or request routine user setup.

## October 31 correction

In a later session, the human
rejected a pairing detour and requested ordinary Chrome close/reopen first.
Exact existing-profile reopening restored ordinary open/snapshot/close on the
unchanged broker and mapping. The earlier avatar-label/key-mismatch observation
had not independently bound the inspected context to the mapped profile directory.
It did not establish lost enrollment. The old offline cause remains unknown;
the recovery is proven, not a permanent-cause diagnosis. Preserve this simpler
first action without turning it into a restart loop or a website-error remedy.
