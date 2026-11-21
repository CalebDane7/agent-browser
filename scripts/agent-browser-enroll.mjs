#!/usr/bin/node

// WHY: first-time setup had no supported command for pairing a Chrome profile.
// Agents had to hand-write requests against the broker's control socket and
// guess the private config format, which made setup slow and easy to get wrong.
// This helper performs only the existing enrollment contract: it creates the
// empty private profile map when none exists, starts the normal broker, opens
// the broker's 30-second `enroll.begin` window, optionally runs the caller's
// click command, and reports success only when the broker shows the profile
// online. The trust rule is unchanged: a profile binds only through the
// extension's toolbar action inside that exact Chrome profile. Removing this
// file does not affect ordinary browsing; it only removes the setup shortcut.

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { requestExtensionControl } from "./agent-browser-extension-control.js";
import {
  PROFILE_CONFIG_SCHEMA,
  canonicalJson,
  isAccount,
  isProfileDirectory,
  validateProfileConfig,
} from "./agent-browser-extension-protocol.js";
import { ensureExtensionBroker } from "./agent-browser-extension-supervisor.js";

const USAGE = `usage: node scripts/agent-browser-enroll.mjs \\
  --account NAME --profile-directory "Default" --extension-id <32 letters a-p> \\
  [--click-command 'shell command that activates the extension icon']

  --account            short handle you will pass as --account later (e.g. main)
  --profile-directory  Chrome profile folder name: Default, "Profile 1", ...
  --extension-id       ID shown for the extension on chrome://extensions
  --click-command      run right after the enrollment window opens

other modes:
  --prepare-only yes --extension-id ID
      only create the private profile map and start the broker
  --extension-id-for 'C:\\Users\\me\\AppData\\Local\\AgentBrowser\\Extension\\0.1.0'
      print the ID Chrome gives an unpacked extension loaded from that folder
`;

function finish(result, exitCode) {
  process.stdout.write(`${JSON.stringify(result)}\n`);
  process.exit(exitCode);
}

function parseArgs(argv) {
  const allowed = new Set([
    "--account", "--profile-directory", "--extension-id", "--click-command",
    "--prepare-only", "--extension-id-for",
    // Isolated-test seams only; ordinary setup never passes these.
    "--config-dir", "--state-root",
  ]);
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];
    if (!allowed.has(name) || typeof value !== "string" || values.has(name)) {
      process.stderr.write(USAGE);
      process.exit(64);
    }
    values.set(name, value);
  }
  return values;
}

function assertPrivateDirectory(path) {
  if (!existsSync(path)) mkdirSync(path, { recursive: true, mode: 0o700 });
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || !stat.isDirectory() || stat.uid !== process.getuid()) {
    finish({ ok: false, error: `not a private directory you own: ${path}` }, 69);
  }
  // WHY: the wrapper and broker refuse group/world-accessible configuration.
  if ((stat.mode & 0o777) !== 0o700) chmodSync(path, 0o700);
}

const args = parseArgs(process.argv.slice(2));

if (args.has("--extension-id-for")) {
  // WHY: the native host must be registered for the extension's exact ID, and
  // an unpacked extension's ID is derived from its folder path. Chrome hashes
  // the absolute Windows path as UTF-16LE (drive letter upper-cased) with
  // SHA-256 and maps the first 32 hex digits 0-f to a-p. Computing it here lets
  // setup register the host before the extension is loaded, so the extension
  // connects on its first attempt. Verified against a live installation.
  const folder = args.get("--extension-id-for").replace(/[\\/]+$/, "");
  if (!/^[A-Za-z]:\\/.test(folder)) {
    finish({ ok: false, error: "pass the absolute Windows folder path, e.g. C:\\Users\\me\\..." }, 64);
  }
  const normalized = folder[0].toUpperCase() + folder.slice(1);
  const digest = createHash("sha256").update(Buffer.from(normalized, "utf16le")).digest("hex");
  const id = [...digest.slice(0, 32)]
    .map((digit) => String.fromCharCode(97 + Number.parseInt(digit, 16)))
    .join("");
  // Bare ID on stdout so a shell can capture it with $(...).
  process.stdout.write(`${id}\n`);
  process.exit(0);
}

const prepareOnly = args.get("--prepare-only") === "yes";
const account = args.get("--account");
const profileDirectory = args.get("--profile-directory");
const extensionId = args.get("--extension-id");
if (!/^[a-p]{32}$/.test(extensionId ?? "") ||
    (!prepareOnly && (!isAccount(account) || !isProfileDirectory(profileDirectory)))) {
  process.stderr.write(USAGE);
  process.exit(64);
}

const home = os.userInfo().homedir;
const configDir = resolve(args.get("--config-dir") ?? join(home, ".config", "agent-browser"));
const stateRoot = resolve(
  args.get("--state-root") ?? `/tmp/agent-browser-extension-${process.getuid()}`,
);
if (!isAbsolute(configDir) || !isAbsolute(stateRoot)) process.exit(64);
const profileConfig = join(configDir, "extension-profiles.json");
const defaultAccountPath = join(configDir, "default-account");
const extensionOrigin = `chrome-extension://${extensionId}/`;

assertPrivateDirectory(configDir);

let config;
if (existsSync(profileConfig)) {
  try {
    config = JSON.parse(readFileSync(profileConfig, "utf8"));
  } catch {
    finish({ ok: false, error: `unreadable profile map: ${profileConfig}` }, 69);
  }
  if (!validateProfileConfig(config)) {
    finish({ ok: false, error: `invalid profile map: ${profileConfig}` }, 69);
  }
  if (config.extensionOrigin !== extensionOrigin) {
    // WHY: one installation has one extension origin. Never rewrite an existing
    // map to a different ID; that would silently orphan every enrolled profile.
    finish({
      ok: false,
      error: "the existing profile map belongs to a different extension ID",
      expected: config.extensionOrigin,
    }, 69);
  }
} else {
  config = { schema: PROFILE_CONFIG_SCHEMA, extensionOrigin, profiles: [] };
  writeFileSync(profileConfig, `${canonicalJson(config)}\n`, { mode: 0o600, flag: "wx" });
}

function ensureDefaultAccount() {
  // WHY: commands without --account read this file. Only the first enrolled
  // profile becomes the default; an existing choice is never replaced.
  if (existsSync(defaultAccountPath)) return readFileSync(defaultAccountPath, "utf8").trim();
  writeFileSync(defaultAccountPath, `${account}\n`, { mode: 0o600, flag: "wx" });
  return account;
}

const receipt = await ensureExtensionBroker({ stateRoot, profileConfig });
const health = () => requestExtensionControl(receipt.controlSocket, { op: "health" }, 1_000);

if (prepareOnly) {
  // WHY: with the broker already listening, a freshly loaded extension connects
  // on its first attempt instead of waiting for its 30-second retry alarm.
  finish({
    ok: true, status: "broker-ready",
    connectedProfiles: (await health()).connectedProfiles,
  }, 0);
}

const existing = config.profiles.find((item) => item.account === account);
if (existing) {
  if (existing.profileDirectory !== profileDirectory) {
    finish({
      ok: false,
      error: `account ${account} is already enrolled for ${existing.profileDirectory}`,
    }, 69);
  }
  const online = (await health()).connectedProfiles.includes(account);
  finish({
    ok: true, status: "already-enrolled", account, profileDirectory, online,
    defaultAccount: ensureDefaultAccount(),
  }, 0);
}

let pending;
try {
  pending = await requestExtensionControl(
    receipt.controlSocket,
    { op: "enroll.begin", account, profileDirectory },
    5_000,
  );
} catch (error) {
  finish({
    ok: false,
    error: "the broker rejected enrollment (profile directory already enrolled, or another enrollment is running)",
    code: error?.code ?? "CONTROL_UNAVAILABLE",
  }, 69);
}

process.stderr.write(
  `enrollment window open for 30 s: activate the "Agent Browser Private Transport" ` +
  `toolbar icon in Chrome profile "${profileDirectory}" now\n`,
);

let clickExit = null;
const clickCommand = args.get("--click-command");
if (clickCommand) {
  // WHY: the window is short, so the caller's click must start the moment the
  // challenge exists. Its output goes to stderr; stdout stays one JSON line.
  const child = spawn("/bin/sh", ["-c", clickCommand], { stdio: ["ignore", 2, 2] });
  child.once("exit", (code) => { clickExit = code; });
  child.once("error", () => { clickExit = 127; });
}

while (Date.now() < pending.expiresAt) {
  await new Promise((resolveWait) => setTimeout(resolveWait, 250));
  let state;
  try { state = await health(); } catch { continue; }
  if (state.connectedProfiles.includes(account)) {
    finish({
      ok: true, status: "enrolled", account, profileDirectory,
      defaultAccount: ensureDefaultAccount(),
    }, 0);
  }
}

// WHY: leaving the challenge pending would block the next attempt until it
// expires. Cancellation is exact (by ID) and harmless if it already expired.
try {
  await requestExtensionControl(
    receipt.controlSocket,
    { op: "enroll.cancel", enrollmentId: pending.enrollmentId },
    1_000,
  );
} catch {}

let actionObserved = null;
try {
  // Key-free receipt written by the broker when the extension reports a click.
  const action = JSON.parse(readFileSync(join(stateRoot, "enrollment-action.json"), "utf8"));
  actionObserved = Number.isSafeInteger(action?.observedAt) &&
    action.observedAt >= pending.expiresAt - 30_000;
} catch {}

finish({
  ok: false,
  error: actionObserved
    ? "the click reached the extension but did not match this enrollment; run the command again"
    : "no toolbar click reached the extension in that profile within 30 s",
  account, profileDirectory, clickExit, actionObserved,
}, 1);
