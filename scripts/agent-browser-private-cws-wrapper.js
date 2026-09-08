#!/usr/bin/node

import { createHash, randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  realpathSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { requestExtensionControl } from "./agent-browser-extension-control.js";
import {
  canonicalJson,
  isAccount,
  isSession,
  sha256,
  validateProfileConfig,
} from "./agent-browser-extension-protocol.js";
import { ensureExtensionBroker, requireExtensionBroker } from "./agent-browser-extension-supervisor.js";
import { ownerSession, resolveInvokingOwner } from "./agent-browser-owner.js";

const EX_USAGE = 64;
const EX_UNAVAILABLE = 69;
const EX_SOFTWARE = 70;
const scriptPath = realpathSync(fileURLToPath(import.meta.url));
const scriptDir = dirname(scriptPath);
const uid = process.getuid();

// Candidate-only overrides are dropped by the installed environment-scrubbing
// launcher. They let the isolated proof bind the same code to SHA-pinned test
// artifacts without adding a production route to another Chrome or profile.
const ENGINE_PATH = resolve(
  process.env.AGENT_BROWSER_PRIVATE_CWS_ENGINE_PATH ??
    join(os.homedir(), ".local", "lib", "agent-browser", "agent-browser-v0.36.0-linux-x64"),
);
const PROFILE_CONFIG = resolve(
  process.env.AGENT_BROWSER_PRIVATE_CWS_PROFILE_CONFIG ??
    join(os.homedir(), ".config", "agent-browser", "extension-profiles.json"),
);
const STATE_ROOT = resolve(
  process.env.AGENT_BROWSER_PRIVATE_CWS_STATE_ROOT ??
    `/tmp/agent-browser-extension-${uid}`,
);
const CHROME_EXE = resolve(
  process.env.AGENT_BROWSER_PRIVATE_CWS_CHROME_EXE ??
    "/mnt/c/Program Files/Google/Chrome/Application/chrome.exe",
);
const ENGINE_PIN = JSON.parse(
  readFileSync(join(scriptDir, "pinned-agent-browser-engine.json"), "utf8"),
);
const PROVIDER_PATH = join(scriptDir, "agent-browser-provider-plugin.js");
const ENGINE_CONFIG = join(scriptDir, "canonical-wrapper-config.json");
const PROVIDER_NAME = "private-cws";
const PROVIDER_FAILURE_SCHEMA = "agent-browser.provider-failure.v2";
const RUNTIME_HOME = resolve(
  process.env.AGENT_BROWSER_PRIVATE_CWS_RUNTIME_HOME ?? os.homedir(),
);
// WHY: the public launcher clears the environment; without HOME, Node resolves
// the actual OS home. Never embed private identity or forward USER/LOGNAME.
const RUNTIME_USER = os.userInfo().username;
const ENGINE_SOCKET_ROOT = resolve(
  process.env.AGENT_BROWSER_PRIVATE_CWS_SOCKET_ROOT ?? `/tmp/ab36-${uid}`,
);
const NAMESPACE =
  process.env.AGENT_BROWSER_PRIVATE_CWS_NAMESPACE ?? "p";
const PROFILE_WAIT_MS = 10_000;
const RETIRE_WAIT_MS = 16_000;
const HUMAN_INPUT_BOUNDARIES = new Set([
  "password", "two-factor", "hardware-key", "captcha", "file-picker",
  "recovery", "account-authority",
]);

if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(NAMESPACE)) {
  throw new Error("Agent Browser namespace is invalid");
}

class WrapperFailure extends Error {
  constructor(message, exitCode = EX_SOFTWARE) {
    super(message);
    this.exitCode = exitCode;
  }
}

function fail(message, exitCode = EX_SOFTWARE) {
  throw new WrapperFailure(message, exitCode);
}

function assertExactAbsolute(path, label) {
  if (!isAbsolute(path) || resolve(path) !== path) fail(`${label} path is invalid`);
  return path;
}

function assertPrivateFile(path, maxBytes = 128 * 1024) {
  let stat;
  try {
    stat = lstatSync(path, { bigint: true });
  } catch {
    fail("Agent Browser configuration is unavailable", EX_UNAVAILABLE);
  }
  if (
    stat.isSymbolicLink() ||
    !stat.isFile() ||
    Number(stat.uid) !== uid ||
    Number(stat.mode & 0o077n) !== 0 ||
    stat.size <= 0n ||
    stat.size > BigInt(maxBytes)
  ) {
    fail("Agent Browser configuration is unsafe", EX_UNAVAILABLE);
  }
  return stat;
}

function assertPrivateDirectory(path) {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  const stat = lstatSync(path, { bigint: true });
  if (
    stat.isSymbolicLink() ||
    !stat.isDirectory() ||
    Number(stat.uid) !== uid ||
    Number(stat.mode & 0o777n) !== 0o700 ||
    realpathSync(path) !== path
  ) {
    fail("Agent Browser private state directory is unsafe", EX_UNAVAILABLE);
  }
}

function readProfileConfig() {
  assertPrivateFile(PROFILE_CONFIG);
  let value;
  try {
    value = JSON.parse(readFileSync(PROFILE_CONFIG, "utf8"));
  } catch {
    fail("Agent Browser profile configuration is invalid", EX_UNAVAILABLE);
  }
  if (!validateProfileConfig(value)) {
    fail("Agent Browser profile configuration is invalid", EX_UNAVAILABLE);
  }
  return value;
}

function readDefaultAccount() {
  // WHY: omitted --account must preserve the installation's explicit mapping,
  // not guess a profile from list order/name. Explicit --account never needs
  // this file. Descriptor checks avoid a path-check/open race or symlink target;
  // the read is bounded even if another owner process changes the file size.
  const path = join(os.userInfo().homedir, ".config", "agent-browser", "default-account");
  let fd;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const stat = fstatSync(fd, { bigint: true });
    if (!stat.isFile() || Number(stat.uid) !== uid || (stat.mode & 0o077n) !== 0n ||
        stat.size <= 0n || stat.size > 130n) {
      fail("Agent Browser default account configuration is unsafe", EX_UNAVAILABLE);
    }
    const bytes = Buffer.alloc(131);
    const count = readSync(fd, bytes, 0, bytes.length, 0);
    const account = bytes.subarray(0, count).toString("utf8").replace(/\r?\n$/, "");
    if (count !== Number(stat.size) || !isAccount(account)) {
      fail("Agent Browser default account configuration is invalid", EX_UNAVAILABLE);
    }
    return account;
  } catch (error) {
    if (error instanceof WrapperFailure) throw error;
    fail("Agent Browser default account configuration is unavailable", EX_UNAVAILABLE);
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function validateEngine() {
  assertExactAbsolute(ENGINE_PATH, "engine");
  let stat;
  try {
    stat = lstatSync(ENGINE_PATH);
  } catch {
    fail("Pinned Agent Browser engine is not installed", EX_UNAVAILABLE);
  }
  if (
    stat.isSymbolicLink() ||
    !stat.isFile() ||
    stat.size !== ENGINE_PIN.engine.size ||
    (stat.mode & 0o022) !== 0 ||
    sha256(readFileSync(ENGINE_PATH)) !== ENGINE_PIN.engine.sha256
  ) {
    fail("Pinned Agent Browser engine identity is invalid", EX_UNAVAILABLE);
  }
}

const VALUE_FLAGS = new Set([
  "--account",
  "--session",
]);

const ARCHITECTURE_FLAGS = [
  "--provider",
  "-p",
  "--cdp",
  "--auto-connect",
  "--profile",
  "--restore",
  "--restore-save",
  "--state",
  "--extension",
  "--config",
  "--namespace",
  "--headed",
  "--no-pin-tab",
  "--allowed-domains",
  "--action-policy",
  "--confirm-actions",
  "--confirm-interactive",
  "--engine",
  "--executable-path",
  "--args",
  "--proxy",
  "--proxy-bypass",
  "--ca-cert",
  "--ignore-https-errors",
  "--allow-file-access",
  "--idle-timeout",
];

const DENIED_COMMANDS = new Set([
  "auth",
  "chat",
  "clipboard",
  "connect",
  "cookies",
  "dashboard",
  "inspect",
  "install",
  "mcp",
  "plugin",
  "profiles",
  "storage",
  "upgrade",
]);

function isArchitectureFlag(arg) {
  return ARCHITECTURE_FLAGS.some(
    (flag) => arg === flag || (flag.startsWith("--") && arg.startsWith(`${flag}=`)),
  );
}

export function parseWrapperArgs(argv) {
  const forwarded = [];
  let account;
  let session = null;
  let currentTab = false;
  let accountSeen = false;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (isArchitectureFlag(arg)) {
      fail(`unsupported Agent Browser option: ${arg}`, EX_USAGE);
    }
    if (arg === "--current-tab") {
      if (currentTab) fail("--current-tab was repeated", EX_USAGE);
      currentTab = true;
      continue;
    }
    if (arg.startsWith("--account=")) {
      if (accountSeen) fail("--account was repeated", EX_USAGE);
      account = arg.slice("--account=".length);
      accountSeen = true;
      continue;
    }
    if (arg.startsWith("--session=")) {
      if (session !== null) fail("--session was repeated", EX_USAGE);
      session = arg.slice("--session=".length);
      continue;
    }
    if (VALUE_FLAGS.has(arg)) {
      const value = argv[++index];
      if (typeof value !== "string") fail(`${arg} requires a value`, EX_USAGE);
      if (arg === "--account") {
        if (accountSeen) fail("--account was repeated", EX_USAGE);
        account = value;
        accountSeen = true;
      } else {
        if (session !== null) fail("--session was repeated", EX_USAGE);
        session = value;
      }
      continue;
    }
    forwarded.push(arg);
  }
  if (!accountSeen) account = readDefaultAccount();
  if (!isAccount(account)) fail("account name is invalid", EX_USAGE);
  if (!isSession(session)) fail("a unique --session is required", EX_USAGE);
  if (forwarded.length === 0 || forwarded[0].startsWith("-")) {
    fail("an Agent Browser command is required after wrapper options", EX_USAGE);
  }
  if (DENIED_COMMANDS.has(forwarded[0])) {
    fail(`unsupported Agent Browser command: ${forwarded[0]}`, EX_USAGE);
  }
  // directPage exposes one synthetic page entry and performs no Target.*
  // discovery. Listing that one entry is useful; every tab mutation remains
  // extension-owned so the donor engine cannot reach a neighboring tab.
  if (forwarded[0] === "tab" && forwarded[1] !== "list") {
    fail("only tab list is supported inside this page capability", EX_USAGE);
  }
  if (forwarded[0] === "close" && forwarded.includes("--all")) {
    fail("close --all is outside this session capability", EX_USAGE);
  }
  if (forwarded[0] === "foreground" &&
      (forwarded.length !== 3 || forwarded[1] !== "--input-boundary" ||
       !HUMAN_INPUT_BOUNDARIES.has(forwarded[2]))) {
    // WHY: ordinary page actions never authorize screen takeover. This is the
    // narrow user-input grammar, never an ordinary engine navigation verb.
    fail("foreground requires --input-boundary password|two-factor|hardware-key|captcha|file-picker|recovery|account-authority", EX_USAGE);
  }
  if (forwarded[0] === "background" && forwarded.length !== 1)
    fail("background takes no arguments", EX_USAGE);
  return { account, session, currentTab, forwarded };
}

function launchProfileWithoutWindow(profileDirectory) {
  assertExactAbsolute(CHROME_EXE, "Chrome");
  const stat = statSync(CHROME_EXE);
  if (!stat.isFile()) fail("Windows Stable Chrome is unavailable", EX_UNAVAILABLE);
  // WHY: never supplying --user-data-dir is the profile-copy/vault boundary.
  // Stable receives only an allowlisted profile basename and its supported
  // no-startup-window mode; the extension creates an inactive task surface.
  const child = spawn(
    CHROME_EXE,
    [
      `--profile-directory=${profileDirectory}`,
      "--no-startup-window",
      "--no-first-run",
      "--no-default-browser-check",
    ],
    { detached: true, stdio: "ignore", windowsHide: true },
  );
  child.unref();
}

async function profileHealth(controlSocket) {
  return requestExtensionControl(controlSocket, { op: "health" }, 500);
}

async function ensureProfileOnline(receipt, profile) {
  const lockPath = join(STATE_ROOT, `bootstrap-${profile.account}.lock`);
  let fd;
  const deadline = Date.now() + PROFILE_WAIT_MS;
  try {
    while (Date.now() < deadline) {
      try {
        fd = openSync(lockPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
        break;
      } catch (error) {
        if (error?.code !== "EEXIST") throw error;
        await new Promise((resolveWait) => setTimeout(resolveWait, 50));
      }
    }
    if (fd === undefined) fail("profile bootstrap lock timed out", EX_UNAVAILABLE);
    let health = await profileHealth(receipt.controlSocket);
    if (!health.connectedProfiles.includes(profile.account)) {
      launchProfileWithoutWindow(profile.profileDirectory);
      while (Date.now() < deadline) {
        await new Promise((resolveWait) => setTimeout(resolveWait, 50));
        health = await profileHealth(receipt.controlSocket);
        if (health.connectedProfiles.includes(profile.account)) return;
      }
      fail(`Agent Browser extension is not online for ${profile.account}; install/enroll it once`, EX_UNAVAILABLE);
    }
  } finally {
    if (fd !== undefined) closeSync(fd);
    try { unlinkSync(lockPath); } catch (error) { if (error?.code !== "ENOENT") throw error; }
  }
}

function grantPathForSession(session) {
  const grantsRoot = join(STATE_ROOT, "grants");
  assertPrivateDirectory(STATE_ROOT);
  assertPrivateDirectory(grantsRoot);
  return join(
    grantsRoot,
    `${createHash("sha256").update(session).digest("hex")}.json`,
  );
}

export function engineSessionFor(session, agentOwner) {
  // WHY: the donor daemon embeds its session in an AF_UNIX path. A fixed
  // digest preserves exact caller isolation without rejecting useful human
  // task names or leaking those names into process/socket listings.
  return ownerSession(agentOwner, sha256(session));
}

function retireExpiredGrant(path) {
  if (!existsSync(path)) return;
  const stat = assertPrivateFile(path, 8 * 1024);
  let value;
  try {
    value = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    fail("existing session grant is invalid", EX_UNAVAILABLE);
  }
  if (!Number.isSafeInteger(value?.expiresAt) || value.expiresAt > Date.now()) {
    fail("another command owns this Agent Browser session", EX_UNAVAILABLE);
  }
  const current = lstatSync(path, { bigint: true });
  if (current.dev !== stat.dev || current.ino !== stat.ino) {
    fail("existing session grant identity changed", EX_UNAVAILABLE);
  }
  unlinkSync(path);
}

function createGrant(path, values) {
  retireExpiredGrant(path);
  let fd;
  try {
    fd = openSync(
      path,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        (constants.O_NOFOLLOW ?? 0),
      0o600,
    );
    writeFileSync(fd, canonicalJson(values), "utf8");
    fsyncSync(fd);
    const stat = fstatSync(fd, { bigint: true });
    if (
      !stat.isFile() ||
      Number(stat.uid) !== uid ||
      Number(stat.mode & 0o777n) !== 0o600 ||
      stat.nlink !== 1n
    ) {
      fail("session grant could not be secured", EX_UNAVAILABLE);
    }
    return stat;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function removeUnusedGrant(path, identity) {
  try {
    const stat = lstatSync(path, { bigint: true });
    if (stat.dev === identity.dev && stat.ino === identity.ino) unlinkSync(path);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}

function providerDiagnosticPath() {
  const root = join(STATE_ROOT, "provider-diagnostics");
  assertPrivateDirectory(STATE_ROOT);
  assertPrivateDirectory(root);
  return join(root, `${randomBytes(32).toString("hex")}.json`);
}

function consumeProviderDiagnostic(path) {
  if (!existsSync(path)) return null;
  const before = lstatSync(path, { bigint: true });
  if (
    before.isSymbolicLink() ||
    !before.isFile() ||
    Number(before.uid) !== uid ||
    Number(before.mode & 0o777n) !== 0o600 ||
    before.nlink !== 1n ||
    before.size <= 0n ||
    before.size > 512n
  ) {
    fail("Agent Browser provider diagnostic is unsafe", EX_UNAVAILABLE);
  }
  let value;
  try {
    value = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    fail("Agent Browser provider diagnostic is invalid", EX_UNAVAILABLE);
  }
  const after = lstatSync(path, { bigint: true });
  if (after.dev !== before.dev || after.ino !== before.ino) {
    fail("Agent Browser provider diagnostic identity changed", EX_UNAVAILABLE);
  }
  unlinkSync(path);
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).sort().join(",") !== "code,schema,scope" ||
    value.schema !== PROVIDER_FAILURE_SCHEMA ||
    (value.scope !== "broker" && value.scope !== "provider") ||
    typeof value.code !== "string" ||
    (value.scope === "broker"
      ? !/^[A-Z][A-Z0-9_]{2,63}$/.test(value.code)
      : !/^[a-z][a-z0-9_]{2,63}$/.test(value.code))
  ) {
    fail("Agent Browser provider diagnostic is invalid", EX_UNAVAILABLE);
  }
  return { scope: value.scope, code: value.code };
}

function engineEnvironment(receipt, grantPath, diagnosticPath) {
  return {
    HOME: RUNTIME_HOME,
    USER: RUNTIME_USER,
    LOGNAME: RUNTIME_USER,
    PATH: "/usr/bin:/bin",
    LANG: "C.UTF-8",
    LC_ALL: "C.UTF-8",
    AGENT_BROWSER_PLUGINS: canonicalJson([
      {
        name: PROVIDER_NAME,
        command: "/usr/bin/node",
        args: [PROVIDER_PATH],
        capabilities: ["browser.provider"],
      },
    ]),
    AGENT_BROWSER_PROVIDER_GRANT_PATH: grantPath,
    AGENT_BROWSER_PROVIDER_DIAGNOSTIC_PATH: diagnosticPath,
    AGENT_BROWSER_CONFIG: ENGINE_CONFIG,
    AGENT_BROWSER_HEADED: "0",
    AGENT_BROWSER_EXTENSION_CONTROL_SOCKET: receipt.controlSocket,
    AGENT_BROWSER_SOCKET_DIR: ENGINE_SOCKET_ROOT,
    AGENT_BROWSER_NO_WEBMCP: "1",
    AGENT_BROWSER_PIN_TAB: "1",
    AGENT_BROWSER_IDLE_TIMEOUT_MS: "3600000",
    AGENT_BROWSER_MAX_OUTPUT: "20000",
  };
}

export async function run(argv) {
  const options = parseWrapperArgs(argv);
  const agentOwner = resolveInvokingOwner();
  const engineSession = engineSessionFor(options.session, agentOwner);
  const foreground = options.forwarded[0] === "foreground";
  const background = options.forwarded[0] === "background";
  const focusControl = foreground || background;
  if (!focusControl) validateEngine();
  const config = readProfileConfig();
  const profile = config.profiles.find((item) => item.account === options.account);
  if (!profile) fail(`profile is not enrolled: ${options.account}`, EX_UNAVAILABLE);
  const receipt = await (focusControl ? requireExtensionBroker : ensureExtensionBroker)({
    stateRoot: STATE_ROOT,
    profileConfig: PROFILE_CONFIG,
  });
  if (!focusControl) await ensureProfileOnline(receipt, profile);

  const grantPath = grantPathForSession(engineSession);
  const diagnosticPath = focusControl ? undefined : providerDiagnosticPath();
  const closesSession = options.forwarded[0] === "close";
  const providerArgs = closesSession ? [] : ["--provider", PROVIDER_NAME];
  const issuedAt = Date.now();
  const grant = {
    session: engineSession,
    agentOwner,
    aliasHash: sha256(options.session),
    account: options.account,
    currentTab: options.currentTab,
    issuedAt,
    expiresAt: issuedAt + 30_000,
    nonce: randomBytes(32).toString("hex"),
  };
  const identity = createGrant(grantPath, grant);
  let result;
  try {
    if (background) {
      // WHY: returning from a manual-input handoff is owner-bound broker work,
      // not a donor command, tab adoption, launch, retry or blind focus reset.
      let observed;
      try {
        observed = await requestExtensionControl(receipt.controlSocket,
          { op: "background", grant }, RETIRE_WAIT_MS);
      } catch (error) {
        const code = /^[A-Z][A-Z0-9_]{2,63}$/.test(error?.code ?? "")
          ? error.code : "CONTROL_UNAVAILABLE";
        fail(`background return not confirmed: ${code}`, EX_UNAVAILABLE);
      }
      if (!observed || Object.keys(observed).join(",") !== "status" ||
          !["returned", "already-current", "cancelled", "denied", "unconfirmed", "no-handoff"]
            .includes(observed.status))
        fail("background response is invalid", EX_UNAVAILABLE);
      const success = !["denied", "unconfirmed"].includes(observed.status);
      process.stdout.write(`${canonicalJson({ success, data: observed })}\n`);
      return success ? 0 : EX_UNAVAILABLE;
    }
    if (foreground) {
      // No engine, allocation, rebind, Chrome launch or retry here.
      // The broker/worker resolve only this existing owner-bound root.
      let observed;
      try {
        observed = await requestExtensionControl(receipt.controlSocket,
          { op: "foreground", grant, inputBoundary: options.forwarded[2] }, RETIRE_WAIT_MS);
      } catch (error) {
        const code = /^[A-Z][A-Z0-9_]{2,63}$/.test(error?.code ?? "")
          ? error.code : "CONTROL_UNAVAILABLE";
        fail(`foreground not confirmed: ${code}`, EX_UNAVAILABLE);
      }
      if (!observed || Object.keys(observed).sort().join(",") !== "active,focused,tabId,windowId" ||
          !/^tab_[a-f0-9]{64}$/.test(observed.tabId) ||
          !/^window_[a-f0-9]{64}$/.test(observed.windowId) ||
          observed.active !== true || observed.focused !== true) {
        fail("foreground response is invalid", EX_UNAVAILABLE);
      }
      process.stdout.write(`${canonicalJson({ success: true, data: observed })}\n`);
      return 0;
    }
    if (closesSession) {
      let retirement;
      try {
        retirement = await requestExtensionControl(
          receipt.controlSocket,
          { op: "retire", grant },
          RETIRE_WAIT_MS,
        );
      } catch (error) {
        const code =
          typeof error?.code === "string" &&
          /^[A-Z][A-Z0-9_]{2,63}$/.test(error.code)
            ? error.code
            : "CONTROL_UNAVAILABLE";
        fail(`provider retirement rejected: ${code}`, EX_UNAVAILABLE);
      }
      if (
        !retirement ||
        typeof retirement !== "object" ||
        Array.isArray(retirement) ||
        Object.keys(retirement).join(",") !== "status" ||
        (retirement.status !== "retired" &&
          retirement.status !== "already-retired")
      ) {
        fail("provider retirement response is invalid", EX_UNAVAILABLE);
      }
    }
    result = await new Promise((resolveChild, rejectChild) => {
      const child = spawn(
        ENGINE_PATH,
        [
          "--session",
          engineSession,
          "--namespace",
          NAMESPACE,
          // WHY: broker retire already consumed the close grant and retired the
          // exact session. Omitting provider keeps donor shutdown Page-free.
          ...providerArgs,
          "--no-webmcp",
          "--pin-tab",
          ...options.forwarded,
        ],
        {
          env: {
            ...engineEnvironment(receipt, grantPath, diagnosticPath),
            // The native daemon, not this short-lived wrapper, owns completion.
            // Close remains the separately proven exact retirement route.
            ...(!closesSession ? { AGENT_BROWSER_PRIVATE_CWS_TRANSACTION: "1" } : {}),
          },
          stdio: "inherit",
        },
      );
      child.once("error", rejectChild);
      child.once("exit", (code, signal) => resolveChild({ code, signal }));
    });
  } catch (error) {
    if (error instanceof WrapperFailure) throw error;
    fail("Agent Browser engine could not start", EX_UNAVAILABLE);
  } finally {
    removeUnusedGrant(grantPath, identity);
  }
  const providerFailure = consumeProviderDiagnostic(diagnosticPath);
  if (providerFailure) {
    // WHY: v0.36.0 intentionally discards provider stderr and suppresses the
    // plugin error string. Surface only the broker's validated bounded code so
    // a single real failure identifies its owner without exposing page state.
    const label = providerFailure.scope === "broker"
      ? "provider control rejected"
      : "provider failed";
    process.stderr.write(`agent-browser: ${label}: ${providerFailure.code}\n`);
  }
  return Number.isInteger(result.code) ? result.code : EX_SOFTWARE;
}

async function main() {
  try {
    process.exitCode = await run(process.argv.slice(2));
  } catch (error) {
    const message = error instanceof WrapperFailure ? error.message : "Agent Browser failed";
    process.stderr.write(`agent-browser: ${message}\n`);
    process.exitCode = error instanceof WrapperFailure ? error.exitCode : EX_SOFTWARE;
  }
}

if (resolve(process.argv[1] ?? "") === scriptPath) await main();
