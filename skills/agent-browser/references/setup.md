# Fast Setup And Reuse

Read this only for first-time setup, a missing command, or a newly requested
profile. An already working installation needs no reinstall, prewarm, browser
restart, or fresh enrollment before each task.

## Already Installed: Start The Task

`command -v agent-browser` checks whether the command is available without
opening Chrome. If present, follow the operator skill: retain a unique session
and the requested account, then `open` the actual task URL. Verify the page's
visible account before sensitive work. Close your task when finished.

An attachment failure is not evidence that installation is missing. Keep its
exact error and diagnose it against the installed wrapper, broker and extension;
do not install over a live browser or cycle through profiles.

## New Machine: Agent-Prepared, User-Approved

This fork currently targets Windows Stable Chrome with WSL. It is not yet a
portable one-command installer. Installing upstream `agent-browser` from npm,
or copying this skill alone, does not install this fork's private transport.

The agent handling setup should use the shipped source and build instructions
below to prepare the supported pieces in one pass:

1. Resolve this machine's actual Windows user, Stable Chrome, WSL distribution,
   repository location and requested Chrome profile. Reuse existing profiles;
   never copy a profile or use another person's machine-local configuration.
2. Bind one coherent engine, wrapper, broker and relay revision. Use the
   repository's `scripts/agent-browser-engine-build.md` and engine-acquisition
   helper for verified artifacts and licenses. They prepare artifacts, not a
   complete installed browser. Reconcile any pin/recipe mismatch before install;
   the verified local installation uses the selected engine in that recipe.
3. Prepare the Windows native host and transport extension. Inspect the exact
   host executable and observed extension ID before registration. The supported
   first-install entrypoint is `native-host/install.ps1`, with required inputs
   `-ExtensionId`, `-HostExecutablePath`, `-WslDistro`, and `-WslBridgePath`.
   It registers only the current user's host and deliberately refuses an
   existing registration/install directory. Do not uninstall a working host to
   get around that refusal. An upgrade needs a separately verified migration
   and rollback for that exact installed version, not this first-install path.
4. Stage the exact transport extension, then guide the user's one-time load and
   pairing gesture in each requested Chrome profile. The agent prepares the
   files and identifies the exact profile; it does not auto-click consent.
   Extensions and pairing are per profile, not automatically shared by every
   profile in the same Chrome. Enroll only requested profiles.
5. Confirm the native connection and account mapping through the supported
   broker, then prove the ordinary CLI path: open a harmless owned background
   tab, read its compact snapshot, close it, and verify cleanup without disturbing
   existing tabs. Save only nonsecret setup evidence and local account aliases.
   A present extension icon or successful installer is not that proof.

Do not ask the user to locate logs, rebuild binaries, or reconstruct accessible
configuration. Ask only for missing choices and genuine Chrome/user-only consent.
Ordinary tasks should reuse enrollment; a fresh prompt during reuse needs
diagnosis, not another click loop.

## Skill And Runtime Belong Together

Install this operator payload where the chosen agent host discovers skills, and
keep its references with it. Codex, Claude Code and other command-capable agents
can use the same instructions; discovery paths and caller-identity integration
are host-specific. Do not claim a new agent host works until its ordinary
ownership/cleanup path is verified.

Keep machine-specific account aliases private. The distributable skill explains
how to select a locally mapped account; it must not ship someone's emails,
profile paths, enrollment data or credentials.

After a verified runtime upgrade, update the skill's availability notes to match
the installed commands. Candidate proof alone does not enable a function.

**Never reset Chrome, another extension, MetaMask, wallet storage, cookies,
credentials, or hardware-wallet/USB settings as a setup shortcut.**
