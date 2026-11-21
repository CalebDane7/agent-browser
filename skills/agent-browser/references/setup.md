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

## New Machine: You Do All Of It

You, the agent, perform every step below yourself, including loading the Chrome
extension and the one pairing click. Do not hand any step to the person, and do
not ask them to open, click or confirm anything in Chrome. Run this only on a
machine whose owner asked you to install Agent Browser: pairing lets this tool
control tabs in that person's signed-in Chrome profile.

Requirements. Check them first and stop with a plain explanation if one fails:

- Windows 10 or 11 with WSL2, and you are running inside that WSL distribution
  (`echo "$WSL_DISTRO_NAME"` prints its name; `uname -m` prints `x86_64`).
- Google Chrome Stable at `C:\Program Files\Google\Chrome\Application\chrome.exe`
  (`test -f "/mnt/c/Program Files/Google/Chrome/Application/chrome.exe"`). A
  per-user or 32-bit Chrome location is not supported yet.
- Agent hosts with stable tab ownership: Claude Code, Codex and Gemini CLI.

The steps take a few minutes. Keep one shell so the variables survive, or set
them again in each new shell.

### 1. Get the code and the Linux pieces

Root commands need no password: `wsl.exe -u root` runs them as root.

```bash
# Tools and Node 22+ at /usr/bin/node (the launcher uses that exact path).
as_root() { /mnt/c/Windows/System32/wsl.exe -d "$WSL_DISTRO_NAME" -u root -- bash -lc "$1"; }
{ command -v git >/dev/null && command -v curl >/dev/null; } ||
  as_root 'apt-get update && apt-get install -y git curl ca-certificates'
/usr/bin/node -e 'process.exit(+process.versions.node.split(".")[0] >= 22 ? 0 : 1)' 2>/dev/null ||
  as_root 'curl -fsSL https://deb.nodesource.com/setup_22.x | bash - && apt-get install -y nodejs'

# The folder is permanent: Windows calls back into it on every connection.
git clone https://github.com/CalebDane7/agent-browser.git "$HOME/agent-browser"
cd "$HOME/agent-browser"
# The broker's only dependency (a full npm install is not needed).
npm pack ws@8.21.0 --silent --pack-destination /tmp
mkdir -p node_modules/ws && tar -xzf /tmp/ws-8.21.0.tgz -C node_modules/ws --strip-components=1

# Engine: the wrapper accepts only this exact binary.
install -D -m 500 engine/agent-browser-v0.36.0-linux-x64 \
  "$HOME/.local/lib/agent-browser/agent-browser-v0.36.0-linux-x64"
sha256sum "$HOME/.local/lib/agent-browser/agent-browser-v0.36.0-linux-x64"
grep -m1 '"sha256"' scripts/pinned-agent-browser-engine.json   # must show the same hash

# Command on PATH.
mkdir -p "$HOME/.local/bin"
ln -sfn "$HOME/agent-browser/scripts/agent-browser-real-chrome" "$HOME/.local/bin/agent-browser"
case ":$PATH:" in *":$HOME/.local/bin:"*) ;; *)
  echo 'export PATH="$HOME/.local/bin:$PATH"' >> "$HOME/.bashrc"; export PATH="$HOME/.local/bin:$PATH";;
esac

# Operator skill, where your agent host discovers skills.
mkdir -p "$HOME/.claude/skills" && cp -r skills/agent-browser "$HOME/.claude/skills/"   # Claude Code
# Codex: mkdir -p "$HOME/.codex/skills" && cp -r skills/agent-browser "$HOME/.codex/skills/"
```

### 2. Stage the Windows pieces and register the bridge

```bash
cd "$HOME/agent-browser"
AB_WIN="$(powershell.exe -NoProfile -Command '[Environment]::GetFolderPath("LocalApplicationData")' | tr -d '\r')\\AgentBrowser"
AB_WSL="$(wslpath -u "$AB_WIN")"
ps_file() { powershell.exe -NoProfile -ExecutionPolicy RemoteSigned -File "$@"; }

mkdir -p "$AB_WSL/Extension/0.1.0" "$AB_WSL/Setup"
cp -r extension/. "$AB_WSL/Extension/0.1.0/"
cp native-host/install.ps1 native-host/generate-manifest.ps1 \
   native-host/prebuilt/agent-browser-native-host.exe "$AB_WSL/Setup/"

# Chrome derives an unpacked extension's ID from its folder path.
EXT_ID="$(node scripts/agent-browser-enroll.mjs --extension-id-for "$AB_WIN\\Extension\\0.1.0")"

# Per-user native messaging host (no administrator rights needed).
ps_file "$AB_WIN\\Setup\\install.ps1" -ExtensionId "$EXT_ID" \
  -HostExecutablePath "$AB_WIN\\Setup\\agent-browser-native-host.exe" \
  -WslDistro "$WSL_DISTRO_NAME" \
  -WslBridgePath "$HOME/agent-browser/scripts/agent-browser-extension-stdio.js"

# Private profile map + broker, so the extension connects the moment it loads.
node scripts/agent-browser-enroll.mjs --prepare-only yes --extension-id "$EXT_ID"
```

`install.ps1` refuses to run when a registration or its install folder already
exists. That means Agent Browser is already installed for this Windows user:
do not uninstall it; skip to step 4 or to "Already Installed".

### 3. Load the extension into the Chrome profile

Pick the profile the person named. If they named none, use the one Chrome used
last. This lists the folder names (`Default`, `Profile 1`, ...) with labels:

```bash
powershell.exe -NoProfile -Command '$s = Get-Content -Raw -LiteralPath (Join-Path $env:LOCALAPPDATA "Google\Chrome\User Data\Local State") | ConvertFrom-Json; "last_used = " + $s.profile.last_used; $s.profile.info_cache.PSObject.Properties | ForEach-Object { $_.Name + " = " + $_.Value.name }' | tr -d '\r'
PROFILE_DIR="Default"   # set to the chosen folder name
```

Open the extensions page in that profile:

```bash
powershell.exe -NoProfile -Command "Start-Process -FilePath 'C:\Program Files\Google\Chrome\Application\chrome.exe' -ArgumentList '--profile-directory=\"$PROFILE_DIR\"','chrome://extensions'"
```

Now do there what a person would do, using your own computer-control or
screen-clicking tool. A shell-only agent can script Windows UI Automation
through `powershell.exe`; the ids below are what Chrome exposes to it.

1. Turn on **Developer mode** (toggle, automation id `devMode`).
2. Press **Load unpacked** (button, automation id `loadUnpacked`).
3. In the folder dialog, enter the staged folder
   `%LOCALAPPDATA%\AgentBrowser\Extension\0.1.0` and confirm.

The "Agent Browser Private Transport" card must appear and the ID on it must
equal `$EXT_ID`. A different ID means a different folder was loaded.

### 4. Pair the profile

Pairing binds this Chrome profile to an account handle you choose (`main`
below). Start the enrollment, then within 30 seconds click the extension's
toolbar icon in that same Chrome window: press the puzzle-piece **Extensions**
button (automation class `ExtensionsToolbarButton`), then
**Agent Browser Private Transport**.

```bash
node scripts/agent-browser-enroll.mjs --account main \
  --profile-directory "$PROFILE_DIR" --extension-id "$EXT_ID" &
# click the icon now, then:
wait
```

If one command of yours performs that click, pass it as
`--click-command '...'` instead; it runs the moment the window opens.

Success is the JSON line `{"ok":true,"status":"enrolled",...}`. The first
enrolled account becomes the default for commands without `--account`. To add
another Chrome profile later, repeat steps 3 and 4 with its folder name and a
different handle.

### 5. Prove it works

```bash
agent-browser --session setup-check open https://example.com
agent-browser --session setup-check snapshot -i --compact
agent-browser --session setup-check close
```

Setup is finished only when the snapshot shows the Example Domain page and
`close` exits cleanly. A successful installer or a visible extension icon is not
that proof. Then read the operator skill and tell the person it is ready.

### If a step fails

- **You have no way to operate Chrome's own pages.** Only then, tell the
  person the exact clicks from steps 3 and 4 and continue as soon as they are
  done. Everything else stays yours.
- **Pairing reports that no click reached the extension.** Run the same step 4
  command once more; the extension retries its bridge connection every 30
  seconds.
  `node scripts/agent-browser-enroll.mjs --prepare-only yes --extension-id "$EXT_ID"`
  prints which profiles are connected. If it repeats, check that
  `%LOCALAPPDATA%\AgentBrowser\NativeHost\com.kaleeb.agent_browser.json` exists
  and that the ID on `chrome://extensions` equals `$EXT_ID`.
- **`Pinned Agent Browser engine identity is invalid`.** Repeat the engine
  `install` line from step 1 and compare the two hashes again.
- **`extension is not online` during ordinary use later.** That is a connection
  problem, not a missing installation. Follow the operator skill's recovery
  section; do not reinstall or pair again to retry.

Do not ask the person to locate logs, rebuild binaries, or reconstruct
accessible configuration. Ask only for a missing choice, such as which Chrome
profile to use when several exist and none was named.

## Skill And Runtime Belong Together

Keep the operator skill's references with it. Codex, Claude Code and other
command-capable agents can use the same instructions; discovery paths and
caller-identity integration are host-specific. Do not claim a new agent host
works until its ordinary ownership and cleanup path is verified.

Keep machine-specific account aliases private. The distributable skill explains
how to select a locally mapped account; it must not ship someone's emails,
profile paths, enrollment data or credentials.

The shipped engine and native host are prebuilt from this repository's sources:
`scripts/agent-browser-engine-build.md` records the engine recipe, and
`native-host/build.sh` reproduces the Windows host byte for byte.

**Never reset Chrome, another extension, MetaMask, wallet storage, cookies,
credentials, or hardware-wallet/USB settings as a setup shortcut.**
