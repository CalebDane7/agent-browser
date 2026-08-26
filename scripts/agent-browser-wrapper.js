#!/usr/bin/node

// Authenticated persistent-profile route. Production constants are immutable;
// offline tests copy this module into a fixture layout and replace those exact
// literals, so no installed environment variable can select another route.
import { createHash, randomBytes } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  readSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, isAbsolute, join } from "node:path";

const EX_USAGE = 64;
const EX_DATAERR = 65;
const EX_UNAVAILABLE = 69;
const EX_SOFTWARE = 70;
const SOCKET_ROOT = "/tmp/agent-browser-raw";
const FIXED_CONTROLLER_BIN = "/home/cabule/.ai-controller/bin/browser-runtime";
const FIXED_CONTROLLER_SHA256 =
  "c1865f356acc304ba54a2698a5bf50aca2252c6a648561eae3cf7215e34cda12";
const FIXED_CONTROLLER_STATE_ROOT = "";
const ACCEPTED_TRANSPORT_HELPER_REVISIONS = Object.freeze([
  "agent-browser.transport-proof-helper.wsl-stable.v2",
]);
const EXPECTED_NATIVE_MANIFEST_SHA256 =
  "e04a9d1a92b1b00325f3483673bf860a15d0be8efe634164e3583ba56890a915";
const EXPECTED_NATIVE_SHA256 =
  "a34421a9f7c3e498ce30f6dec4780e53488de5e01f330f2f2abcf8e79a6955f4";
const EXPECTED_NATIVE_EXECUTION = "elf";
const EXPECTED_POPUP_CLIENT_SHA256 =
  "0077709cd495775b8ab1a19eb1918d14499ba9f66db73ba7fde18438d3ae2b19";
const EXPECTED_CANONICAL_DIST_SCHEMA = "agent-browser-canonical-dist.v1";
const EXPECTED_CANONICAL_DIST_SHA256 =
  "c70aa3a02b1fc00910e378b417739bfe42ac784726d130c2245c22c859bce194";
const EXPECTED_CANONICAL_GRAPH_SHA256 =
  "4e3ba63ddd1a71f1e2996fdeea8a873453417c55bc2f1e1d5a1f236ecc5aedcf";
const EXPECTED_CANONICAL_GRAPH_FILES = Object.freeze([
  "dist/actions.js",
  "dist/browser.js",
  "dist/cdp.js",
  "dist/daemon.js",
  "dist/diff.js",
  "dist/encryption.js",
  "dist/protocol.js",
  "dist/snapshot.js",
  "dist/state-utils.js",
  "dist/stream-server.js",
  "dist/types.js",
]);
const EXPECTED_NATIVE_CONFIG_SHA256 =
  "ca3d163bab055381827226140568f3bef7eaac187cebd76878e0b63e9e442356";
const BROWSER_ATTESTATION_SCHEMA =
  "agent-browser.supported-existing-transport-attestation.v1";
const TARGET_RECEIPT_SCHEMA = "agent-browser.target-lease.v1";
const TARGET_CLAIM_ENVELOPE_SCHEMA = "agent-browser.target-claim-envelope.v2";
const TARGET_METADATA_SCHEMA = "agent-browser.target-receipt-metadata.v1";
const BROKER_HEALTH_SCHEMA = "agent-browser.cdp-broker-health.v1";
const SUPPORTED_CHROME_DEBUGGING_PORT = 9222;
const BROKER_HEALTH_LIMIT_KEYS = Object.freeze([
  "maxClients",
  "maxFrameBytes",
  "maxHeaderBytes",
  "maxHeaders",
  "maxPendingPerClient",
  "maxPendingTotal",
  "maxInternalPending",
  "maxDetachedSessionTombstones",
  "maxSessionsPerClient",
  "maxQueuedFramesPerClient",
  "maxQueuedBytesPerClient",
  "maxBufferedBytesPerSocket",
  "maxMessagesPerSecond",
  "upstreamResponseTimeoutMs",
  "maxLeaseTtlMs",
  "maxLeaseClockSkewMs",
  "maxTabInventoryTargets",
]);
const TARGET_MAX_TTL_MS = 30_000;
const TARGET_FUTURE_SKEW_MS = 5_000;
// A broker task lease is bounded to one hour. Reacquire a persistent workspace
// before a worst-case native action can cross that boundary; extending the
// bearer token would leave the already-connected daemon on stale authority.
const BROKER_CAPABILITY_REACQUIRE_MARGIN_MS = 3 * 60 * 1000;
const MAX_FILE_BYTES = 64 * 1024;

const scriptPath = realpathSync(fileURLToPath(import.meta.url));
const scriptDir = dirname(scriptPath);
const repoRoot = realpathSync(join(scriptDir, ".."));
const brokerSourcePath = realpathSync(
  join(repoRoot, "scripts", "agent-browser-cdp-broker.js"),
);
const nativePath = join(repoRoot, "bin", "agent-browser-linux-x64");
const nativeManifestPath = join(
  repoRoot,
  "scripts",
  "canonical-native-release.json",
);
const popupClientPath = join(
  repoRoot,
  "scripts",
  "agent-browser-daemon-click.js",
);
const canonicalDistManifestPath = join(
  repoRoot,
  "scripts",
  "canonical-dist.json",
);
const canonicalNativeConfigPath = join(
  repoRoot,
  "scripts",
  "canonical-wrapper-config.json",
);
const uid = process.getuid();

const BASE_CHILD_ENV = Object.freeze({
  HOME: "/home/cabule",
  USER: "cabule",
  LOGNAME: "cabule",
  PATH: "/usr/bin:/bin",
  LANG: "C.UTF-8",
  LC_ALL: "C.UTF-8",
  AGENT_BROWSER_HOME: repoRoot,
  AGENT_BROWSER_SOCKET_DIR: SOCKET_ROOT,
  AGENT_BROWSER_CDP_COMMAND_TIMEOUT_MS: "10000",
});

class WrapperError extends Error {
  constructor(message, code = 1) {
    super(message);
    this.code = code;
  }
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, stableValue(value[key])]),
    );
  }
  return value;
}

function canonicalJson(value) {
  return JSON.stringify(stableValue(value));
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function canonicalRfc3339Milliseconds(value) {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)
  ) {
    return null;
  }
  const milliseconds = Date.parse(value);
  if (
    !Number.isSafeInteger(milliseconds) ||
    new Date(milliseconds).toISOString() !== value
  ) {
    return null;
  }
  return milliseconds;
}

function exactKeys(value, expected) {
  return (
    value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).sort().join("\0") === [...expected].sort().join("\0")
  );
}

function sanitize(value) {
  return String(value ?? "")
    .replace(/\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g, " ")
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, " ")
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, " ")
    .replace(/\b(?:https?|wss?):\/\/[^\s]+/gi, "<redacted-url>")
    .replace(/\bAuthorization\s*:\s*[^\r\n,;}]+/gi, "Authorization: <redacted>")
    .replace(/\bBearer\s+[A-Za-z0-9._~+\/-]+=*/gi, "Bearer <redacted>")
    .replace(
      /(["']?(?:token|access_token|refresh_token|code|password|secret|cookie|authorization)["']?\s*[:=]\s*)(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s,;}\]]+)/gi,
      "$1<redacted>",
    )
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 1200);
}

function fail(message, code = 1) {
  throw new WrapperError(sanitize(message) || "wrapper operation failed", code);
}

function parseJson(raw, label) {
  try {
    return JSON.parse(raw.toString("utf8"));
  } catch {
    fail(`${label} is invalid`, EX_DATAERR);
  }
}

function readFdAll(fd, maxBytes) {
  const chunks = [];
  let total = 0;
  let offset = 0;
  for (;;) {
    const chunk = Buffer.alloc(Math.min(16 * 1024, maxBytes + 1 - total));
    const count = readSync(fd, chunk, 0, chunk.length, offset);
    if (count === 0) break;
    total += count;
    if (total > maxBytes)
      fail("secure file exceeded its size limit", EX_DATAERR);
    chunks.push(chunk.subarray(0, count));
    offset += count;
  }
  return Buffer.concat(chunks);
}

function openStaticFile(path, maxBytes, expectedMode = null) {
  let fd;
  try {
    fd = openSync(
      path,
      constants.O_RDONLY |
        (constants.O_CLOEXEC ?? 0) |
        (constants.O_NOFOLLOW ?? 0),
    );
    const info = fstatSync(fd, { bigint: true });
    const mode = Number(info.mode & 0o777n);
    if (
      !info.isFile() ||
      info.nlink !== 1n ||
      info.size <= 0n ||
      info.size > BigInt(maxBytes) ||
      Number(info.uid) !== uid ||
      (expectedMode !== null && mode !== expectedMode)
    ) {
      fail("trusted package file is unsafe", EX_SOFTWARE);
    }
    return { fd, info, raw: readFdAll(fd, maxBytes) };
  } catch (error) {
    if (fd !== undefined) closeSync(fd);
    if (error instanceof WrapperError) throw error;
    fail("trusted package file is unavailable", EX_UNAVAILABLE);
  }
}

function closeOpened(opened) {
  if (opened?.fd !== undefined) closeSync(opened.fd);
}

class SecureDir {
  constructor(path, fd, info) {
    this.path = path;
    this.fd = fd;
    this.info = info;
  }

  static open(
    path,
    { create = false, mode = 0o700, canonicalPath = path } = {},
  ) {
    try {
      const before = lstatSync(path, { bigint: true });
      if (before.isSymbolicLink() || !before.isDirectory()) {
        fail("secure directory is not a real directory", EX_SOFTWARE);
      }
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      if (!create) return null;
      try {
        mkdirSync(path, { mode });
      } catch (mkdirError) {
        if (mkdirError?.code !== "EEXIST") {
          fail("secure directory could not be created", EX_UNAVAILABLE);
        }
      }
    }

    let fd;
    try {
      fd = openSync(
        path,
        constants.O_RDONLY |
          (constants.O_DIRECTORY ?? 0) |
          (constants.O_CLOEXEC ?? 0) |
          (constants.O_NOFOLLOW ?? 0),
      );
      const info = fstatSync(fd, { bigint: true });
      if (
        !info.isDirectory() ||
        Number(info.uid) !== uid ||
        Number(info.mode & 0o777n) !== mode ||
        realpathSync(path) !== canonicalPath
      ) {
        fail("secure directory ownership or mode is invalid", EX_SOFTWARE);
      }
      return new SecureDir(path, fd, info);
    } catch (error) {
      if (fd !== undefined) closeSync(fd);
      if (error instanceof WrapperError) throw error;
      fail("secure directory is unavailable", EX_UNAVAILABLE);
    }
  }

  entryPath(name) {
    if (!/^[A-Za-z0-9._-]+$/.test(name) || name === "." || name === "..") {
      fail("unsafe state filename", EX_SOFTWARE);
    }
    return `/proc/self/fd/${this.fd}/${name}`;
  }

  lstat(name) {
    try {
      return lstatSync(this.entryPath(name), { bigint: true });
    } catch (error) {
      if (error?.code === "ENOENT") return null;
      throw error;
    }
  }

  openFile(name, maxBytes, mode = 0o600, { allowMissing = false } = {}) {
    const path = this.entryPath(name);
    let fd;
    try {
      fd = openSync(
        path,
        constants.O_RDONLY |
          (constants.O_CLOEXEC ?? 0) |
          (constants.O_NOFOLLOW ?? 0),
      );
      const info = fstatSync(fd, { bigint: true });
      if (
        !info.isFile() ||
        info.nlink !== 1n ||
        Number(info.uid) !== uid ||
        Number(info.mode & 0o777n) !== mode ||
        info.size <= 0n ||
        info.size > BigInt(maxBytes)
      ) {
        fail("secure state file is unsafe", EX_SOFTWARE);
      }
      return { fd, info, raw: readFdAll(fd, maxBytes), path };
    } catch (error) {
      if (fd !== undefined) closeSync(fd);
      if (allowMissing && error?.code === "ENOENT") return null;
      if (error instanceof WrapperError) throw error;
      fail("secure state file is unavailable", EX_UNAVAILABLE);
    }
  }

  openChild(name, { create = false, mode = 0o700 } = {}) {
    const childPath = this.entryPath(name);
    if (create && !this.lstat(name)) {
      try {
        mkdirSync(childPath, { mode });
      } catch (error) {
        if (error?.code !== "EEXIST") {
          fail("secure child directory could not be created", EX_UNAVAILABLE);
        }
      }
    }
    const child = SecureDir.open(childPath, {
      create: false,
      mode,
      canonicalPath: join(this.path, name),
    });
    if (!child) return null;
    child.path = join(this.path, name);
    return child;
  }

  writeAtomic(name, value, { exclusive = false } = {}) {
    const raw = Buffer.isBuffer(value) ? value : Buffer.from(String(value));
    if (raw.length === 0 || raw.length > MAX_FILE_BYTES) {
      fail("secure state payload is invalid", EX_SOFTWARE);
    }
    const tempName = `.tmp-${process.pid}-${randomBytes(12).toString("hex")}`;
    const tempPath = this.entryPath(tempName);
    const finalPath = this.entryPath(name);
    let fd;
    try {
      fd = openSync(
        tempPath,
        constants.O_WRONLY |
          constants.O_CREAT |
          constants.O_EXCL |
          (constants.O_CLOEXEC ?? 0) |
          (constants.O_NOFOLLOW ?? 0),
        0o600,
      );
      writeFileSync(fd, raw);
      fsyncSync(fd);
      const info = fstatSync(fd, { bigint: true });
      if (
        !info.isFile() ||
        info.nlink !== 1n ||
        Number(info.uid) !== uid ||
        Number(info.mode & 0o777n) !== 0o600
      ) {
        fail("secure state transaction is unsafe", EX_SOFTWARE);
      }
      closeSync(fd);
      fd = undefined;
      if (exclusive) {
        linkSync(tempPath, finalPath);
        unlinkSync(tempPath);
      } else {
        renameSync(tempPath, finalPath);
      }
      fsyncSync(this.fd);
    } catch (error) {
      if (fd !== undefined) closeSync(fd);
      try {
        unlinkSync(tempPath);
      } catch {}
      if (error?.code === "EEXIST") return false;
      if (error instanceof WrapperError) throw error;
      fail("secure state transaction failed", EX_UNAVAILABLE);
    }
    return true;
  }

  removeOwned(name, expectedRaw = null) {
    const existing = this.openFile(name, MAX_FILE_BYTES, 0o600, {
      allowMissing: true,
    });
    if (!existing) return false;
    if (expectedRaw !== null && !existing.raw.equals(expectedRaw)) {
      closeOpened(existing);
      fail("secure state changed before cleanup", EX_SOFTWARE);
    }
    closeOpened(existing);
    const quarantine = `.remove-${process.pid}-${randomBytes(12).toString("hex")}`;
    try {
      renameSync(this.entryPath(name), this.entryPath(quarantine));
      const moved = this.openFile(quarantine, MAX_FILE_BYTES, 0o600);
      if (expectedRaw !== null && !moved.raw.equals(expectedRaw)) {
        closeOpened(moved);
        fail("secure state changed during cleanup", EX_SOFTWARE);
      }
      closeOpened(moved);
      unlinkSync(this.entryPath(quarantine));
      fsyncSync(this.fd);
      return true;
    } catch (error) {
      if (error instanceof WrapperError) throw error;
      fail("secure state cleanup failed", EX_UNAVAILABLE);
    }
  }

  removeOwnedEntry(name, expectedInfo, expectedKind) {
    const matches = (info) =>
      Boolean(
        info &&
        !info.isSymbolicLink() &&
        Number(info.uid) === uid &&
        info.dev === expectedInfo.dev &&
        info.ino === expectedInfo.ino &&
        ((expectedKind === "socket" && info.isSocket()) ||
          (expectedKind === "file" && info.isFile())),
      );
    const existing = this.lstat(name);
    if (!existing) return false;
    if (!matches(existing)) {
      fail("owned session artifact changed before cleanup", EX_SOFTWARE);
    }
    const quarantine = `.remove-${process.pid}-${randomBytes(12).toString("hex")}`;
    let moved = false;
    try {
      renameSync(this.entryPath(name), this.entryPath(quarantine));
      moved = true;
      const quarantined = this.lstat(quarantine);
      if (!matches(quarantined)) {
        try {
          renameSync(this.entryPath(quarantine), this.entryPath(name));
          moved = false;
        } catch {}
        fail("owned session artifact changed during cleanup", EX_SOFTWARE);
      }
      unlinkSync(this.entryPath(quarantine));
      moved = false;
      fsyncSync(this.fd);
      return true;
    } catch (error) {
      if (moved) {
        try {
          renameSync(this.entryPath(quarantine), this.entryPath(name));
        } catch {}
      }
      if (error instanceof WrapperError) throw error;
      fail("owned session artifact cleanup failed", EX_UNAVAILABLE);
    }
  }

  close() {
    closeSync(this.fd);
  }
}

function showHelp() {
  process.stdout
    .write(`agent-browser - authenticated real Windows Chrome automation

Usage:
  agent-browser [--account caleb|erebora] --session TASK open URL
  agent-browser --session TASK --target-lease CONTROLLER_PATH open URL
  agent-browser --session TASK snapshot -i --compact
  agent-browser --session TASK click SELECTOR --expect-popup
  agent-browser --session TASK close|doctor

Only explicit nonempty sessions and HTTP(S) navigation are accepted. Caleb is
the default; Erebora must be selected explicitly. A cold ordinary session asks
the controller for its registered workspace lease. An existing user tab is
accepted only through an explicit exact --target-lease. The controller, not
this wrapper, supplies the supported Stable broker and Chrome consent state.
`);
}

const COMMANDS = new Set([
  "open",
  "navigate",
  "click",
  "dblclick",
  "type",
  "fill",
  "press",
  "keydown",
  "keyup",
  "hover",
  "focus",
  "check",
  "uncheck",
  "select",
  "drag",
  "upload",
  "download",
  "scroll",
  "scrollintoview",
  "wait",
  "screenshot",
  "pdf",
  "snapshot",
  "eval",
  "close",
  "back",
  "forward",
  "reload",
  "get",
  "is",
  "find",
  "mouse",
  "set",
  "network",
  "cookies",
  "storage",
  "tab",
  "window",
  "frame",
  "dialog",
  "diff",
  "trace",
  "profiler",
  "record",
  "console",
  "errors",
  "highlight",
  "session",
  "foreground",
  "background",
  "doctor",
  "install",
  "connect",
]);

const DANGEROUS_OPTIONS = new Set([
  "--profile",
  "--state",
  "--executable-path",
  "--extension",
  "--args",
  "--provider",
  "--auto-connect",
  "--headed",
  "--config",
  "--session-name",
  "--allow-file-access",
  "--proxy",
  "--proxy-bypass",
  "--cdp",
  "--target-receipt",
  "-p",
]);

const VALUE_GLOBALS = new Set(["--headers", "--user-agent", "--device"]);
const FLAG_GLOBALS = new Set([
  "--full",
  "-f",
  "--annotate",
  "--ignore-https-errors",
  "--debug",
]);

function takeArg(argv, index, option) {
  if (index + 1 >= argv.length || argv[index + 1] === "") {
    fail(`${option} requires a nonempty value`, EX_USAGE);
  }
  return argv[index + 1];
}

function parseArgs(argv) {
  if (argv.length === 0) fail("a command is required", EX_USAGE);
  if (argv.some((arg) => arg.includes("\0")))
    fail("invalid argument", EX_USAGE);
  let account = "";
  let session = "";
  let targetLease = "";
  let json = false;
  let command = "";
  let commandArgs = [];
  const nativeGlobals = [];
  let help = false;
  let version = false;
  let expectPopup = false;
  let literal = false;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!command) {
      if (arg === "") fail("empty command token is not allowed", EX_USAGE);
      if (arg === "--")
        fail("a leading option sentinel is not allowed", EX_USAGE);
      if (/^--(?:session|account|target-lease|json)=/.test(arg)) {
        fail(`noncanonical option form '${arg.split("=")[0]}'`, EX_USAGE);
      }
      if (
        DANGEROUS_OPTIONS.has(arg) ||
        [...DANGEROUS_OPTIONS].some((x) => arg.startsWith(`${x}=`))
      ) {
        fail(
          `'${arg.split("=")[0]}' is disabled on the persistent profile route`,
          EX_USAGE,
        );
      }
      switch (arg) {
        case "--account": {
          const value = takeArg(argv, index, arg);
          if (account && account !== value)
            fail("conflicting --account values", EX_USAGE);
          account = value;
          index += 1;
          break;
        }
        case "--session": {
          const value = takeArg(argv, index, arg);
          if (session && session !== value)
            fail("conflicting --session values", EX_USAGE);
          session = value;
          index += 1;
          break;
        }
        case "--target-lease":
          targetLease = takeArg(argv, index, arg);
          index += 1;
          break;
        case "--json":
          if (json) fail("duplicate --json", EX_USAGE);
          json = true;
          break;
        case "--help":
        case "-h":
          help = true;
          break;
        case "--version":
        case "-V":
          version = true;
          break;
        default:
          if (VALUE_GLOBALS.has(arg)) {
            nativeGlobals.push(arg, takeArg(argv, index, arg));
            index += 1;
          } else if (FLAG_GLOBALS.has(arg)) {
            nativeGlobals.push(arg);
          } else if (arg.startsWith("-")) {
            fail(`unsupported global option '${arg}'`, EX_USAGE);
          } else {
            command = arg;
          }
      }
      continue;
    }

    if (!literal && arg === "--") {
      literal = true;
      commandArgs.push(arg);
      continue;
    }
    if (!literal && /^--(?:session|account|target-lease)(?:=|$)/.test(arg)) {
      fail(
        `routing option '${arg.split("=")[0]}' must precede the command`,
        EX_USAGE,
      );
    }
    if (
      !literal &&
      (DANGEROUS_OPTIONS.has(arg) ||
        [...DANGEROUS_OPTIONS].some((x) => arg.startsWith(`${x}=`)))
    ) {
      fail(
        `'${arg.split("=")[0]}' is disabled on the persistent profile route`,
        EX_USAGE,
      );
    }
    if (!literal && arg.startsWith("--json=")) {
      fail("noncanonical option form '--json'", EX_USAGE);
    }
    if (!literal && arg === "--json") {
      if (json) fail("duplicate --json", EX_USAGE);
      json = true;
      continue;
    }
    if (!literal && arg === "--expect-popup") {
      if (command !== "click")
        fail("--expect-popup is only valid for click", EX_USAGE);
      if (expectPopup) fail("duplicate --expect-popup", EX_USAGE);
      expectPopup = true;
      continue;
    }
    if (!literal && arg.startsWith("--expect-popup=")) {
      fail("--expect-popup accepts no value", EX_USAGE);
    }
    if (!literal && (arg === "--help" || arg === "-h")) {
      help = true;
      continue;
    }
    commandArgs.push(arg);
  }

  if (help && !command) return { help: true };
  if (
    version &&
    !command &&
    argv.every((arg) => ["--version", "-V"].includes(arg))
  ) {
    return { version: true };
  }
  if (version) fail("--version must be used alone", EX_USAGE);
  if (!command) fail("a command is required", EX_USAGE);
  if (!COMMANDS.has(command)) fail(`unknown command '${command}'`, EX_USAGE);
  if (help) return { help: true };
  if (!session || !/^[A-Za-z0-9_-]+$/.test(session)) {
    fail(
      "an explicit nonempty --session using letters, numbers, '-' or '_' is required",
      EX_USAGE,
    );
  }
  if (account && !normalizeAccount(account)) {
    fail(
      "only caleb (Default) and erebora (Profile 1) are available",
      EX_USAGE,
    );
  }
  if (["connect", "install"].includes(command)) {
    fail(
      `${command} is disabled on the authenticated persistent profile route`,
      EX_USAGE,
    );
  }
  if (
    ["foreground", "background"].includes(command) &&
    (commandArgs.length > 0 || nativeGlobals.length > 0)
  ) {
    fail(`${command} accepts no browser action arguments`, EX_USAGE);
  }
  if (
    targetLease &&
    ["close", "session", "doctor", "foreground", "background"].includes(command)
  ) {
    fail("--target-lease is not valid for lifecycle commands", EX_USAGE);
  }
  if (targetLease) {
    const expected = new RegExp(
      `^${productionControllerStateRoot().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/endpoints/[a-z0-9][a-z0-9-]{0,127}/target-leases/pending/[0-9a-f]{64}\\.json$`,
    );
    if (!isAbsolute(targetLease) || !expected.test(targetLease)) {
      fail(
        "--target-lease must be the exact absolute pending controller path",
        EX_USAGE,
      );
    }
  }
  if (expectPopup && targetLease) {
    fail("--expect-popup requires an already-live session", EX_USAGE);
  }
  if (["open", "navigate"].includes(command)) validateNavigation(commandArgs);
  if (
    command === "session" &&
    canonicalJson(commandArgs) !== canonicalJson(["list"])
  ) {
    fail("only 'session list' is available through this wrapper", EX_USAGE);
  }

  return {
    account: normalizeAccount(account) || "",
    session,
    targetLease,
    targetLeaseSupplied: Boolean(targetLease),
    json,
    command,
    commandArgs,
    nativeGlobals,
    expectPopup,
  };
}

function normalizeAccount(value) {
  switch (String(value).toLowerCase()) {
    case "caleb":
    case "default":
    case "calebdanemusic":
    case "calebdanemusic@gmail.com":
      return "caleb";
    case "erebora":
    case "erebora-crew":
    case "ereboracrew":
    case "ereboreacrew":
    case "ereboracrew@gmail.com":
    case "ereboreacrew@gmail.com":
      return "erebora";
    default:
      return "";
  }
}

function accountIdentity(account) {
  return account === "erebora"
    ? { account, email: "ereboracrew@gmail.com", profile: "Profile 1" }
    : {
        account: "caleb",
        email: "calebdanemusic@gmail.com",
        profile: "Default",
      };
}

function validateNavigation(commandArgs) {
  const urlValue = commandArgs[0];
  if (!urlValue || urlValue.startsWith("-")) {
    fail("open and navigate require an HTTP(S) URL", EX_USAGE);
  }
  let parsed;
  try {
    parsed = new URL(urlValue);
  } catch {
    fail("open and navigate require an HTTP(S) URL", EX_USAGE);
  }
  if (
    !["http:", "https:"].includes(parsed.protocol) ||
    !parsed.hostname ||
    parsed.username ||
    parsed.password
  ) {
    fail(
      "only credential-free HTTP(S) URLs are allowed on the saved profile",
      EX_USAGE,
    );
  }
}

function parseUtcRfc3339(value, label) {
  const canonicalMilliseconds = canonicalRfc3339Milliseconds(value);
  if (canonicalMilliseconds !== null) {
    return canonicalMilliseconds;
  }
  const dotNetRoundTrip =
    typeof value === "string"
      ? /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})\.(\d{7})Z$/.exec(value)
      : null;
  if (dotNetRoundTrip) {
    const millisecondValue = `${dotNetRoundTrip[1]}.${dotNetRoundTrip[2].slice(0, 3)}Z`;
    const parsed = canonicalRfc3339Milliseconds(millisecondValue);
    if (parsed !== null) {
      return parsed;
    }
  }
  fail(`${label} is not canonical UTC`, EX_DATAERR);
}

function productionControllerStateRoot() {
  if (FIXED_CONTROLLER_STATE_ROOT) return FIXED_CONTROLLER_STATE_ROOT;
  const runtimeRoot = `/run/user/${uid}/agent-browser-controller`;
  try {
    const info = lstatSync(runtimeRoot);
    if (
      !info.isSymbolicLink() &&
      info.isDirectory() &&
      info.uid === uid &&
      (info.mode & 0o777) === 0o700 &&
      realpathSync(runtimeRoot) === runtimeRoot
    ) {
      return runtimeRoot;
    }
  } catch {}
  return `/tmp/agent-browser-controller-${uid}`;
}

function openControllerEndpointRoot(endpointId) {
  if (!/^[a-z0-9][a-z0-9-]{0,127}$/.test(endpointId)) {
    fail("controller endpoint identity is invalid", EX_DATAERR);
  }
  const controllerRoot = SecureDir.open(productionControllerStateRoot(), {
    create: false,
    mode: 0o700,
  });
  const endpoints = controllerRoot?.openChild("endpoints", { mode: 0o700 });
  const endpoint = endpoints?.openChild(endpointId, { mode: 0o700 });
  endpoints?.close();
  controllerRoot?.close();
  if (!endpoint)
    fail("controller endpoint authority is unavailable", EX_UNAVAILABLE);
  return endpoint;
}

function expectedBrokerAuthorizationPath(endpointId, leaseId) {
  return join(
    productionControllerStateRoot(),
    "endpoints",
    endpointId,
    "broker-auth",
    `${leaseId}.authorization`,
  );
}

function openBrokerAuthorization(authority, binding) {
  const expectedPath = expectedBrokerAuthorizationPath(
    authority.data.controller_endpoint_id,
    binding.brokerAuthorizationLeaseId,
  );
  if (binding.brokerAuthorizationPath !== expectedPath) {
    fail(
      "broker authorization path is outside controller authority",
      EX_DATAERR,
    );
  }
  const endpointRoot = openControllerEndpointRoot(
    authority.data.controller_endpoint_id,
  );
  const authorizationRoot = endpointRoot.openChild("broker-auth", {
    mode: 0o700,
  });
  if (!authorizationRoot) {
    authorizationRoot?.close();
    endpointRoot.close();
    fail("broker authorization authority is unavailable", EX_UNAVAILABLE);
  }
  let opened;
  try {
    opened = authorizationRoot.openFile(
      `${binding.brokerAuthorizationLeaseId}.authorization`,
      256,
      0o600,
    );
    if (sha256(opened.raw) !== binding.brokerAuthorizationSha256) {
      fail("broker authorization capability hash mismatched", EX_DATAERR);
    }
    const line = opened.raw.toString("utf8");
    const match = line.match(
      /^Authorization: Bearer ([0-9a-f]{64})\.([0-9a-f]{64})\.([A-Za-z0-9_-]{43})\n$/,
    );
    if (
      !match ||
      match[1] !== authority.transportGeneration ||
      match[2] !== binding.brokerAuthorizationLeaseId
    ) {
      fail("broker authorization capability is invalid", EX_DATAERR);
    }
    return {
      header: line.slice(0, -1),
      value: line.slice("Authorization: ".length, -1),
      rawHash: binding.brokerAuthorizationSha256,
      leaseId: binding.brokerAuthorizationLeaseId,
      path: binding.brokerAuthorizationPath,
    };
  } finally {
    closeOpened(opened);
    authorizationRoot.close();
    endpointRoot.close();
  }
}

function exactBoundedString(value, label, maximum = 512) {
  if (
    typeof value !== "string" ||
    !value ||
    value.length > maximum ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    fail(`${label} is invalid`, EX_DATAERR);
  }
  return value;
}

function computeBrowserGeneration(chrome) {
  return sha256(
    Buffer.from(
      canonicalJson({
        pid: chrome.pid,
        startedAtUtc: chrome.startedAtUtc,
        executablePath: chrome.executablePath,
        executableSha256: chrome.executableSha256,
        version: chrome.version,
        userDataRoot: chrome.userDataRoot,
      }),
      "utf8",
    ),
  );
}

function parseBrokerRoutes(data) {
  let websocket;
  let health;
  try {
    websocket = new URL(data.brokerCdpWebSocketUrl);
    health = new URL(data.brokerHealthUrl);
  } catch {
    fail("broker route attestation is invalid", EX_DATAERR);
  }
  if (
    websocket.protocol !== "ws:" ||
    websocket.hostname !== "127.0.0.1" ||
    !websocket.port ||
    websocket.pathname !== `/cdp/${data.transportGeneration}` ||
    websocket.search ||
    websocket.hash ||
    websocket.username ||
    websocket.password ||
    health.protocol !== "http:" ||
    health.hostname !== "127.0.0.1" ||
    health.port !== websocket.port ||
    health.pathname !== `/healthz/${data.transportGeneration}` ||
    health.search ||
    health.hash ||
    health.username ||
    health.password
  ) {
    fail("broker route attestation is noncanonical", EX_DATAERR);
  }
  const port = Number(websocket.port);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) {
    fail("broker attestation port is invalid", EX_DATAERR);
  }
  return {
    port,
    webSocketUrl: `ws://127.0.0.1:${port}/cdp/${data.transportGeneration}`,
    healthUrl: `http://127.0.0.1:${port}/healthz/${data.transportGeneration}`,
  };
}

function expectedControllerEndpointId(port) {
  const normalizedEndpoint = `http://127.0.0.1:${port}`;
  return `${port}-${sha256(Buffer.from(normalizedEndpoint, "utf8")).slice(0, 20)}`;
}

function probeBrokerHealth(authority, authorization) {
  const result = spawnSync(
    "/usr/bin/curl",
    [
      "-fsS",
      "--config",
      "-",
      "--noproxy",
      "*",
      "--max-time",
      "0.5",
      "--dump-header",
      "-",
      authority.healthUrl,
    ],
    {
      encoding: null,
      env: BASE_CHILD_ENV,
      input: Buffer.from(`header = "${authorization.header}"\n`, "utf8"),
      timeout: 1000,
      maxBuffer: 12 * 1024,
    },
  );
  if (
    result.status !== 0 ||
    !result.stdout ||
    result.stdout.length > 12 * 1024
  ) {
    fail(
      "TRANSPORT_FAILURE; attested raw-CDP broker is unavailable",
      EX_UNAVAILABLE,
    );
  }
  const separator = result.stdout.indexOf(Buffer.from("\r\n\r\n"));
  if (separator <= 0 || separator > 4096) {
    fail(
      "TRANSPORT_FAILURE; broker health headers are invalid",
      EX_UNAVAILABLE,
    );
  }
  const headerText = result.stdout.subarray(0, separator).toString("latin1");
  const body = result.stdout.subarray(separator + 4);
  if (
    body.length === 0 ||
    body.length > 8192 ||
    !/^HTTP\/1\.[01] 200(?: |\r?$)/m.test(headerText) ||
    !/^cache-control:\s*no-store\s*$/im.test(headerText)
  ) {
    fail("TRANSPORT_FAILURE; broker health response is unsafe", EX_UNAVAILABLE);
  }
  const data = parseJson(body, "raw-CDP broker health response");
  if (
    !exactKeys(data, [
      "schema",
      "brokerGeneration",
      "browserGeneration",
      "consentGeneration",
      "transportGeneration",
      "state",
      "reconnectRequired",
      "lossReason",
      "uptimeMs",
      "upstreamConnectionAttempts",
      "upstreamSocketOpen",
      "clients",
      "sessions",
      "pendingClientRequests",
      "pendingInternalRequests",
      "configuredClientLeases",
      "limits",
    ]) ||
    data.schema !== BROKER_HEALTH_SCHEMA ||
    data.state !== "ready" ||
    data.reconnectRequired !== false ||
    data.lossReason !== null ||
    data.upstreamSocketOpen !== true ||
    data.brokerGeneration !== authority.data.broker_generation ||
    data.browserGeneration !== authority.browserGeneration ||
    data.consentGeneration !== authority.data.consent_generation ||
    data.transportGeneration !== authority.transportGeneration ||
    !exactKeys(data.limits, BROKER_HEALTH_LIMIT_KEYS) ||
    ![
      data.uptimeMs,
      data.upstreamConnectionAttempts,
      data.clients,
      data.sessions,
      data.pendingClientRequests,
      data.pendingInternalRequests,
      data.configuredClientLeases,
      ...BROKER_HEALTH_LIMIT_KEYS.map((key) => data.limits?.[key]),
    ].every((value) => Number.isSafeInteger(value) && value >= 0)
  ) {
    fail(
      "TRANSPORT_FAILURE; broker health generation is not ready",
      EX_UNAVAILABLE,
    );
  }
  return data;
}

function openTrustedSnapshot(path, expectedHash, controllerEndpointId) {
  const expectedPath = join(
    productionControllerStateRoot(),
    "endpoints",
    controllerEndpointId,
    "profile-attestation",
    "transport-proof-state.v1.json",
  );
  if (path !== expectedPath || !/^[0-9a-f]{64}$/.test(expectedHash)) {
    fail(
      "NEEDS_TRANSPORT_PROCESS_PROOF; trusted controller proof path is invalid",
      EX_UNAVAILABLE,
    );
  }
  const opened = openStaticFile(path, 16 * 1024, 0o600);
  if (sha256(opened.raw) !== expectedHash) {
    closeOpened(opened);
    fail(
      "NEEDS_TRANSPORT_PROCESS_PROOF; trusted controller proof hash mismatched",
      EX_DATAERR,
    );
  }
  const data = parseJson(opened.raw, "trusted process snapshot");
  closeOpened(opened);
  if (
    !exactKeys(data, [
      "schema",
      "observedAtMs",
      "maxAgeMs",
      "helperRevision",
      "chrome",
      "portproxy",
      "socat",
      "broker",
    ]) ||
    data.schema !== "agent-browser.transport-proof-state.v1" ||
    !Number.isSafeInteger(data.observedAtMs) ||
    data.observedAtMs <= 0 ||
    data.maxAgeMs !== 5000 ||
    typeof data.helperRevision !== "string" ||
    !data.helperRevision ||
    data.helperRevision.length > 256 ||
    Date.now() < data.observedAtMs - 1000 ||
    Date.now() - data.observedAtMs > data.maxAgeMs ||
    !exactKeys(data.chrome, [
      "observation",
      "pid",
      "startedAtUtc",
      "executablePath",
      "executableSha256",
      "version",
      "userDataRoot",
      "listener",
      "browserGeneration",
    ]) ||
    data.chrome.observation !==
      "windows-tcp-cim-file-version-devtools-active-port" ||
    !Number.isSafeInteger(data.chrome.pid) ||
    data.chrome.pid <= 0 ||
    !exactKeys(data.chrome.listener, ["address", "port", "owningPid"]) ||
    data.chrome.listener.address !== "127.0.0.1" ||
    data.chrome.listener.port !== SUPPORTED_CHROME_DEBUGGING_PORT ||
    data.chrome.listener.owningPid !== data.chrome.pid ||
    !/^[0-9a-f]{64}$/.test(data.chrome.executableSha256) ||
    !/^[0-9a-f]{64}$/.test(data.chrome.browserGeneration) ||
    !exactKeys(data.portproxy, [
      "observation",
      "pid",
      "startedAtUtc",
      "executablePath",
      "service",
      "listen",
      "connect",
      "adapter",
    ]) ||
    data.portproxy.observation !== "netsh-portproxy-cim-net-ip-address" ||
    !Number.isSafeInteger(data.portproxy.pid) ||
    data.portproxy.pid <= 0 ||
    data.portproxy.service !== "iphlpsvc" ||
    !exactKeys(data.portproxy.listen, ["address", "port"]) ||
    !exactKeys(data.portproxy.connect, ["address", "port"]) ||
    !exactKeys(data.portproxy.adapter, [
      "interfaceIndex",
      "name",
      "description",
      "address",
      "prefixLength",
      "networkCategory",
      "scope",
    ]) ||
    !Number.isSafeInteger(data.portproxy.adapter.interfaceIndex) ||
    data.portproxy.adapter.interfaceIndex < 1 ||
    !Number.isSafeInteger(data.portproxy.adapter.prefixLength) ||
    data.portproxy.adapter.prefixLength < 1 ||
    data.portproxy.adapter.prefixLength > 32 ||
    data.portproxy.adapter.scope !== "wsl-hyper-v-internal" ||
    data.portproxy.listen.address !== data.portproxy.adapter.address ||
    data.portproxy.listen.port !== SUPPORTED_CHROME_DEBUGGING_PORT ||
    data.portproxy.connect.address !== "127.0.0.1" ||
    data.portproxy.connect.port !== SUPPORTED_CHROME_DEBUGGING_PORT ||
    !exactKeys(data.socat, [
      "observation",
      "pid",
      "startTicks",
      "executablePath",
      "executableSha256",
      "listen",
      "connect",
    ]) ||
    data.socat.observation !== "proc-ss" ||
    !Number.isSafeInteger(data.socat.pid) ||
    data.socat.pid <= 0 ||
    !/^[0-9]+$/.test(data.socat.startTicks) ||
    !/^[0-9a-f]{64}$/.test(data.socat.executableSha256) ||
    !exactKeys(data.socat.listen, ["address", "port"]) ||
    !exactKeys(data.socat.connect, ["address", "port"]) ||
    data.socat.listen.address !== "127.0.0.1" ||
    data.socat.listen.port !== SUPPORTED_CHROME_DEBUGGING_PORT ||
    data.socat.connect.address !== data.portproxy.listen.address ||
    data.socat.connect.port !== data.portproxy.listen.port ||
    !exactKeys(data.broker, [
      "observation",
      "pid",
      "startTicks",
      "executablePath",
      "sourcePath",
      "sourceSha256",
      "listen",
      "brokerGeneration",
      "browserGeneration",
      "consentGeneration",
      "transportGeneration",
      "producerContractPath",
      "producerContractSha256",
    ]) ||
    data.broker.observation !==
      "immutable-contract-proc-ss-authenticated-health" ||
    !Number.isSafeInteger(data.broker.pid) ||
    data.broker.pid <= 0 ||
    !/^[0-9]+$/.test(data.broker.startTicks) ||
    !/^[0-9a-f]{64}$/.test(data.broker.sourceSha256) ||
    !exactKeys(data.broker.listen, ["address", "port"]) ||
    data.broker.listen.address !== "127.0.0.1" ||
    !Number.isSafeInteger(data.broker.listen.port) ||
    data.broker.listen.port < 1 ||
    data.broker.listen.port > 65535 ||
    ![
      data.broker.brokerGeneration,
      data.broker.browserGeneration,
      data.broker.consentGeneration,
      data.broker.transportGeneration,
      data.broker.producerContractSha256,
    ].every((value) => /^[0-9a-f]{64}$/.test(value)) ||
    data.broker.browserGeneration !== data.chrome.browserGeneration ||
    data.chrome.pid === data.portproxy.pid ||
    data.socat.pid === data.broker.pid
  ) {
    fail(
      "NEEDS_TRANSPORT_PROCESS_PROOF; trusted process snapshot is invalid",
      EX_UNAVAILABLE,
    );
  }
  for (const [value, label, maximum] of [
    [data.chrome.executablePath, "chrome executable path", 1024],
    [data.chrome.version, "chrome version", 256],
    [data.chrome.userDataRoot, "chrome user data root", 1024],
    [data.portproxy.executablePath, "portproxy executable path", 1024],
    [data.portproxy.adapter.name, "portproxy adapter name", 256],
    [data.portproxy.adapter.description, "portproxy adapter description", 512],
    [data.socat.executablePath, "socat executable path", 1024],
    [data.broker.executablePath, "broker executable path", 1024],
    [data.broker.sourcePath, "broker source path", 1024],
    [data.broker.producerContractPath, "broker producer contract path", 1024],
  ]) {
    exactBoundedString(value, label, maximum);
  }
  // Hyper-V's internal WSL switch can legitimately have no NetworkProfile,
  // which PowerShell represents as null. Scope, adapter identity, and the exact
  // listen/connect tuple—not an optional display category—prove confinement.
  if (data.portproxy.adapter.networkCategory !== null) {
    exactBoundedString(
      data.portproxy.adapter.networkCategory,
      "portproxy network category",
      64,
    );
  }
  parseUtcRfc3339(data.chrome.startedAtUtc, "chrome startedAtUtc");
  parseUtcRfc3339(data.portproxy.startedAtUtc, "portproxy startedAtUtc");
  if (computeBrowserGeneration(data.chrome) !== data.chrome.browserGeneration) {
    fail(
      "NEEDS_TRANSPORT_PROCESS_PROOF; Chrome browser generation is invalid",
      EX_DATAERR,
    );
  }
  return data;
}

function parseControllerJsonLine(
  result,
  label,
  failure = "TRANSPORT_FAILURE; pinned controller did not return a canonical attestation",
  allowControllerFailure = false,
) {
  const canonicalLine = (value) =>
    typeof value === "string" &&
    value.length > 0 &&
    Buffer.byteLength(value) <= 16 * 1024 &&
    value.endsWith("\n") &&
    !value.slice(0, -1).includes("\n");
  const success =
    result.status === 0 &&
    !result.signal &&
    result.stderr === "" &&
    canonicalLine(result.stdout);
  const controllerFailure =
    result.status === 1 &&
    !result.signal &&
    result.stdout === "" &&
    canonicalLine(result.stderr);
  if (!success && !controllerFailure) fail(failure, EX_UNAVAILABLE);

  if (controllerFailure) {
    let diagnostic;
    try {
      diagnostic = JSON.parse(result.stderr.slice(0, -1));
    } catch {
      fail(failure, EX_UNAVAILABLE);
    }
    if (
      !exactKeys(diagnostic, ["ok", "status", "reason"]) ||
      diagnostic.ok !== false ||
      typeof diagnostic.status !== "string" ||
      !/^[A-Za-z0-9._-]{1,80}$/.test(diagnostic.status) ||
      typeof diagnostic.reason !== "string" ||
      diagnostic.reason.length === 0 ||
      diagnostic.reason.length > 480 ||
      /[\u0000-\u001f\u007f-\u009f]/.test(diagnostic.reason)
    ) {
      fail(failure, EX_UNAVAILABLE);
    }
    if (allowControllerFailure) {
      return {
        data: diagnostic,
        raw: Buffer.from(result.stderr, "utf8"),
        controllerFailure: true,
      };
    }
    fail(`${diagnostic.status}; ${diagnostic.reason}`, EX_UNAVAILABLE);
  }
  return {
    data: parseJson(Buffer.from(result.stdout.slice(0, -1)), label),
    raw: Buffer.from(result.stdout, "utf8"),
    controllerFailure: false,
  };
}

function loadTransportAuthority(session = "") {
  if (ACCEPTED_TRANSPORT_HELPER_REVISIONS.length === 0) {
    fail(
      "NEEDS_SUPPORTED_TRANSPORT_CONTROLLER; no audited broker producer is installed",
      EX_UNAVAILABLE,
    );
  }
  const controllerArgs = [
    "ensure-supported-existing-transport",
    "--broker-source-path",
    brokerSourcePath,
  ];
  if (session) controllerArgs.push("--session", session);
  controllerArgs.push("--json");
  const response = parseControllerJsonLine(
    runController(controllerArgs),
    "controller transport attestation",
  );
  const data = response.data;
  if (
    !data ||
    typeof data !== "object" ||
    Array.isArray(data) ||
    data.schema !== BROWSER_ATTESTATION_SCHEMA
  ) {
    fail("controller transport attestation is invalid", EX_DATAERR);
  }
  if (data.ok !== true) {
    if (
      !exactKeys(data, ["schema", "ok", "status", "reason"]) ||
      data.ok !== false ||
      typeof data.reason !== "string" ||
      data.reason.length > 256
    ) {
      fail("controller diagnostic attestation is invalid", EX_DATAERR);
    }
    const diagnostics = {
      "chrome-setup-consent-required":
        "CHROME_SETUP_CONSENT_REQUIRED; Chrome-owned debugging setup needs explicit consent",
      "chrome-reconnect-consent-required":
        "CHROME_RECONNECT_CONSENT_REQUIRED; Chrome-owned debugging reconnect needs explicit consent",
      "transport-failure":
        "TRANSPORT_FAILURE; the attested raw-CDP broker is unavailable",
    };
    fail(
      diagnostics[data.status] ??
        "TRANSPORT_FAILURE; controller transport attestation failed",
      EX_UNAVAILABLE,
    );
  }

  const expectedKeys = [
    "schema",
    "ok",
    "status",
    "controllerEndpointId",
    "browserGeneration",
    "brokerGeneration",
    "consentGeneration",
    "transportGeneration",
    "brokerCdpWebSocketUrl",
    "brokerHealthUrl",
    "brokerProducerContractPath",
    "brokerProducerContractSha256",
    "transportProofStatePath",
    "transportProofStateSha256",
    "transportProofObservedAtMs",
  ];
  if (
    !exactKeys(data, expectedKeys) ||
    data.ok !== true ||
    data.status !== "attested" ||
    !/^[a-z0-9][a-z0-9-]{0,127}$/.test(data.controllerEndpointId) ||
    ![
      data.browserGeneration,
      data.brokerGeneration,
      data.consentGeneration,
      data.transportGeneration,
      data.brokerProducerContractSha256,
      data.transportProofStateSha256,
    ].every((value) => /^[0-9a-f]{64}$/.test(value)) ||
    !Number.isSafeInteger(data.transportProofObservedAtMs) ||
    data.transportProofObservedAtMs <= 0
  ) {
    fail(
      "controller attestation does not identify the supported Stable browser and broker",
      EX_DATAERR,
    );
  }
  const broker = parseBrokerRoutes(data);
  if (
    data.controllerEndpointId !==
    expectedControllerEndpointId(SUPPORTED_CHROME_DEBUGGING_PORT)
  ) {
    fail("controller endpoint identity is invalid", EX_DATAERR);
  }
  const endpointRoot = join(
    productionControllerStateRoot(),
    "endpoints",
    data.controllerEndpointId,
  );
  if (
    data.brokerProducerContractPath !==
    join(endpointRoot, "broker-authority", "producer-contract.json")
  ) {
    fail("broker producer contract path is invalid", EX_DATAERR);
  }
  const snapshot = openTrustedSnapshot(
    data.transportProofStatePath,
    data.transportProofStateSha256,
    data.controllerEndpointId,
  );
  if (
    !ACCEPTED_TRANSPORT_HELPER_REVISIONS.includes(snapshot.helperRevision) ||
    snapshot.observedAtMs !== data.transportProofObservedAtMs ||
    snapshot.broker.listen.port !== broker.port ||
    snapshot.broker.browserGeneration !== data.browserGeneration ||
    snapshot.broker.brokerGeneration !== data.brokerGeneration ||
    snapshot.broker.consentGeneration !== data.consentGeneration ||
    snapshot.broker.transportGeneration !== data.transportGeneration ||
    snapshot.broker.producerContractPath !== data.brokerProducerContractPath ||
    snapshot.broker.producerContractSha256 !==
      data.brokerProducerContractSha256 ||
    snapshot.chrome.executablePath !==
      "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe" ||
    snapshot.chrome.userDataRoot !==
      "C:\\Users\\Kaleeb\\AppData\\Local\\Google\\Chrome\\User Data"
  ) {
    fail(
      "NEEDS_TRANSPORT_PROCESS_PROOF; controller process snapshot mismatched",
      EX_DATAERR,
    );
  }
  const browserGeneration = computeBrowserGeneration(snapshot.chrome);
  if (browserGeneration !== data.browserGeneration) {
    fail("controller browser generation is invalid", EX_DATAERR);
  }
  const normalizedData = {
    ...data,
    controller_endpoint_id: data.controllerEndpointId,
    broker_generation: data.brokerGeneration,
    consent_generation: data.consentGeneration,
  };
  return {
    data: normalizedData,
    attestation: data,
    snapshot,
    webSocketUrl: broker.webSocketUrl,
    healthUrl: broker.healthUrl,
    port: broker.port,
    browserGeneration,
    transportGeneration: data.transportGeneration,
    authorization: null,
    authorizationBinding: null,
    health: null,
    issuedMs: snapshot.observedAtMs,
    expiresMs: snapshot.observedAtMs + snapshot.maxAgeMs,
    rawHash: sha256(response.raw),
  };
}

function bindTransportAuthorization(authority, binding) {
  if (
    !binding ||
    !/^[0-9a-f]{64}$/.test(binding.brokerAuthorizationLeaseId) ||
    !/^[0-9a-f]{64}$/.test(binding.brokerAuthorizationSha256)
  ) {
    fail("broker authorization lease binding is invalid", EX_DATAERR);
  }
  const authorization = openBrokerAuthorization(authority, binding);
  const health = probeBrokerHealth(authority, authorization);
  return {
    ...authority,
    authorization,
    authorizationBinding: {
      brokerAuthorizationLeaseId: binding.brokerAuthorizationLeaseId,
      brokerAuthorizationPath: binding.brokerAuthorizationPath,
      brokerAuthorizationSha256: binding.brokerAuthorizationSha256,
    },
    health,
  };
}

function refreshTransportAuthority(authority, session = "") {
  const current = loadTransportAuthority(session);
  if (
    current.browserGeneration !== authority.browserGeneration ||
    current.transportGeneration !== authority.transportGeneration ||
    current.data.broker_generation !== authority.data.broker_generation ||
    current.webSocketUrl !== authority.webSocketUrl ||
    current.healthUrl !== authority.healthUrl
  ) {
    fail(
      "supported browser or broker generation changed during the action",
      EX_DATAERR,
    );
  }
  return current;
}

function revalidateTransportAuthority(authority, session = "") {
  if (!authority.authorizationBinding) {
    fail("task transport authorization is unavailable", EX_DATAERR);
  }
  return bindTransportAuthorization(
    refreshTransportAuthority(authority, session),
    authority.authorizationBinding,
  );
}

function packageVersion() {
  const opened = openStaticFile(join(repoRoot, "package.json"), 64 * 1024);
  const data = parseJson(opened.raw, "package metadata");
  closeOpened(opened);
  if (data?.version !== "0.13.0") {
    fail("package version is not the accepted release", EX_SOFTWARE);
  }
  return data.version;
}

function canonicalGraphFingerprint(files) {
  const graph = createHash("sha256");
  for (const path of EXPECTED_CANONICAL_GRAPH_FILES) {
    graph.update(path, "utf8");
    graph.update("\0", "utf8");
    graph.update(files[path], "ascii");
    graph.update("\n", "utf8");
  }
  return graph.digest("hex");
}

function loadCanonicalRuntimeGraph() {
  const manifestFile = openStaticFile(canonicalDistManifestPath, 64 * 1024);
  const manifestSha256 = sha256(manifestFile.raw);
  const manifest = parseJson(manifestFile.raw, "canonical dist manifest");
  closeOpened(manifestFile);
  if (
    manifestSha256 !== EXPECTED_CANONICAL_DIST_SHA256 ||
    !exactKeys(manifest, ["schema", "authority", "algorithm", "files"]) ||
    manifest.schema !== EXPECTED_CANONICAL_DIST_SCHEMA ||
    manifest.authority !== "tracked-dist-js" ||
    manifest.algorithm !== "sha256" ||
    !exactKeys(manifest.files, EXPECTED_CANONICAL_GRAPH_FILES) ||
    canonicalJson(Object.keys(manifest.files)) !==
      canonicalJson(EXPECTED_CANONICAL_GRAPH_FILES)
  ) {
    fail(
      "canonical runtime manifest is pending or is not the accepted release",
      EX_SOFTWARE,
    );
  }

  const records = {};
  for (const path of EXPECTED_CANONICAL_GRAPH_FILES) {
    const expectedHash = manifest.files[path];
    if (!/^[0-9a-f]{64}$/.test(expectedHash)) {
      fail("canonical runtime manifest entry is invalid", EX_SOFTWARE);
    }
    const opened = openStaticFile(join(repoRoot, path), 4 * 1024 * 1024);
    const actualHash = sha256(opened.raw);
    if (actualHash !== expectedHash) {
      closeOpened(opened);
      fail("canonical runtime graph bytes mismatched", EX_SOFTWARE);
    }
    records[path] = { hash: actualHash, info: opened.info };
    closeOpened(opened);
  }
  const graphSha256 = canonicalGraphFingerprint(manifest.files);
  if (graphSha256 !== EXPECTED_CANONICAL_GRAPH_SHA256) {
    fail("canonical runtime graph fingerprint is not accepted", EX_SOFTWARE);
  }
  return { manifestSha256, graphSha256, files: manifest.files, records };
}

function revalidateCanonicalRuntimeGraph(expected) {
  const current = loadCanonicalRuntimeGraph();
  if (
    current.manifestSha256 !== expected.manifestSha256 ||
    current.graphSha256 !== expected.graphSha256
  ) {
    fail("canonical runtime graph changed during the action", EX_SOFTWARE);
  }
  return current;
}

function openCanonicalNativeConfig() {
  const opened = openStaticFile(canonicalNativeConfigPath, 4096);
  const data = parseJson(opened.raw, "canonical native config");
  if (
    sha256(opened.raw) !== EXPECTED_NATIVE_CONFIG_SHA256 ||
    !exactKeys(data, [])
  ) {
    closeOpened(opened);
    fail("canonical empty native config is invalid", EX_SOFTWARE);
  }
  return opened;
}

function loadNativeManifest() {
  const opened = openStaticFile(nativeManifestPath, 16 * 1024);
  const manifestHash = sha256(opened.raw);
  const data = parseJson(opened.raw, "native release manifest");
  closeOpened(opened);
  if (
    manifestHash !== EXPECTED_NATIVE_MANIFEST_SHA256 ||
    !exactKeys(data, [
      "schema",
      "packageVersion",
      "platform",
      "binary",
      "sha256",
      "size",
      "versionOutput",
      "provenance",
    ]) ||
    data.schema !== "agent-browser.native-release.v1" ||
    data.packageVersion !== packageVersion() ||
    data.platform !== "linux-x64" ||
    data.binary !== "bin/agent-browser-linux-x64" ||
    data.sha256 !== EXPECTED_NATIVE_SHA256 ||
    !Number.isSafeInteger(data.size) ||
    data.size <= 0 ||
    data.versionOutput !== `agent-browser ${data.packageVersion}` ||
    !exactKeys(data.provenance, [
      "status",
      "acceptedBaseline",
      "sourceReproducible",
      "limitation",
    ]) ||
    data.provenance.status !== "accepted-local-binary" ||
    data.provenance.sourceReproducible !== false ||
    typeof data.provenance.limitation !== "string" ||
    !data.provenance.limitation.includes(
      "does not claim source reproducibility",
    )
  ) {
    fail(
      "native release manifest is not the accepted canonical release",
      EX_SOFTWARE,
    );
  }
  return { data, manifestHash };
}

function openNativeBinary(manifest) {
  let fd;
  try {
    fd = openSync(
      nativePath,
      constants.O_RDONLY |
        (constants.O_CLOEXEC ?? 0) |
        (constants.O_NOFOLLOW ?? 0),
    );
    const info = fstatSync(fd, { bigint: true });
    if (
      !info.isFile() ||
      info.nlink !== 1n ||
      Number(info.uid) !== uid ||
      Number(info.size) !== manifest.data.size ||
      Number(info.mode & 0o111n) === 0
    ) {
      fail("exact canonical native binary is unsafe", EX_SOFTWARE);
    }
    const prefix = Buffer.alloc(20);
    const count = readSync(fd, prefix, 0, prefix.length, 0);
    if (
      EXPECTED_NATIVE_EXECUTION === "elf" &&
      (count < 20 ||
        prefix.subarray(0, 4).toString("hex") !== "7f454c46" ||
        prefix[4] !== 2 ||
        prefix.readUInt16LE(18) !== 0x3e)
    ) {
      fail("canonical native platform is invalid", EX_SOFTWARE);
    }
    return { fd, info };
  } catch (error) {
    if (fd !== undefined) closeSync(fd);
    if (error instanceof WrapperError) throw error;
    fail("exact canonical native binary is unavailable", EX_UNAVAILABLE);
  }
}

function nativeStatRecord(info) {
  return {
    dev: info.dev.toString(),
    ino: info.ino.toString(),
    size: info.size.toString(),
    mtimeNs: info.mtimeNs.toString(),
    ctimeNs: info.ctimeNs.toString(),
  };
}

function spawnVerifiedFd(opened, args, options = {}) {
  const capture = options.capture ?? false;
  const env = { ...BASE_CHILD_ENV, ...(options.env ?? {}) };
  const stdio = capture
    ? ["ignore", "pipe", "pipe", opened.fd]
    : ["inherit", "inherit", "inherit", opened.fd];
  if (options.config) stdio.push(options.config.fd);
  const executable =
    options.execution === "fixture-script"
      ? "/usr/bin/bash"
      : "/proc/self/fd/3";
  const executableArgs =
    options.execution === "fixture-script"
      ? ["/proc/self/fd/3", ...args]
      : args;
  return spawnSync(executable, executableArgs, {
    encoding: capture ? "utf8" : undefined,
    env,
    stdio,
    timeout: options.timeout ?? 120_000,
    maxBuffer: options.maxBuffer ?? 64 * 1024,
  });
}

class NativeRuntime {
  constructor(root) {
    this.root = root;
    this.manifest = loadNativeManifest();
    this.opened = openNativeBinary(this.manifest);
    try {
      this.config = openCanonicalNativeConfig();
    } catch (error) {
      closeOpened(this.opened);
      throw error;
    }
    this.version = this.manifest.data.versionOutput;
    this.receiptName = "native-revision.receipt";
  }

  spawn(args, options = {}) {
    return spawnVerifiedFd(
      this.opened,
      ["--config", "/proc/self/fd/4", ...args],
      { ...options, config: this.config },
    );
  }

  ensureRevision() {
    // A receipt avoids a repeated process launch, but cannot authenticate bytes
    // after a same-user writer replaces the binary and forges fresh stat fields.
    const binaryRaw = readFdAll(this.opened.fd, this.manifest.data.size);
    if (sha256(binaryRaw) !== EXPECTED_NATIVE_SHA256) {
      fail(
        "canonical native binary hash mismatched the release manifest",
        EX_SOFTWARE,
      );
    }
    const existing = this.root.openFile(this.receiptName, 4096, 0o600, {
      allowMissing: true,
    });
    const stat = nativeStatRecord(this.opened.info);
    if (existing) {
      this.validateReceipt(existing, stat);
      return;
    }

    const version = this.spawn(["--version"], {
      capture: true,
      execution: EXPECTED_NATIVE_EXECUTION,
      timeout: 1000,
      maxBuffer: 4096,
    });
    if (
      version.status !== 0 ||
      version.stderr !== "" ||
      version.stdout !== `${this.version}\n`
    ) {
      fail("canonical native live version handshake failed", EX_SOFTWARE);
    }
    const receipt = Buffer.from(
      `${canonicalJson({
        schema: "agent-browser.native-revision.v2",
        manifestSha256: this.manifest.manifestHash,
        binarySha256: EXPECTED_NATIVE_SHA256,
        platform: "linux-x64",
        versionOutput: this.version,
        binaryStat: stat,
      })}\n`,
      "utf8",
    );
    if (
      !this.root.writeAtomic(this.receiptName, receipt, { exclusive: true })
    ) {
      const winner = this.root.openFile(this.receiptName, 4096, 0o600);
      this.validateReceipt(winner, stat);
    }
  }

  validateReceipt(opened, stat) {
    const receipt = parseJson(opened.raw, "native revision receipt");
    closeOpened(opened);
    if (
      !exactKeys(receipt, [
        "schema",
        "manifestSha256",
        "binarySha256",
        "platform",
        "versionOutput",
        "binaryStat",
      ]) ||
      receipt.schema !== "agent-browser.native-revision.v2" ||
      receipt.manifestSha256 !== this.manifest.manifestHash ||
      receipt.binarySha256 !== EXPECTED_NATIVE_SHA256 ||
      receipt.platform !== "linux-x64" ||
      receipt.versionOutput !== this.version ||
      canonicalJson(receipt.binaryStat) !== canonicalJson(stat)
    ) {
      fail("native revision receipt is forged or stale", EX_SOFTWARE);
    }
  }

  run(args, env = {}, capture = false, timeout = 120_000) {
    return this.spawn(args, {
      capture,
      execution: EXPECTED_NATIVE_EXECUTION,
      env,
      timeout,
      maxBuffer: 64 * 1024,
    });
  }

  close() {
    closeOpened(this.config);
    closeOpened(this.opened);
  }
}

function openPinnedTool(path, expectedHash) {
  const opened = openStaticFile(path, 2 * 1024 * 1024);
  if (sha256(opened.raw) !== expectedHash) {
    closeOpened(opened);
    fail("pinned controller helper hash mismatched", EX_SOFTWARE);
  }
  return opened;
}

function runController(args, timeoutOverrideMs = null) {
  const opened = openPinnedTool(FIXED_CONTROLLER_BIN, FIXED_CONTROLLER_SHA256);
  const defaultTimeout = [
    "acquire-focus",
    // Existing-profile target proof, exact lease consumption/registration,
    // and exact abort can exceed five seconds on a healthy real Chrome
    // profile; keep them bounded without killing a valid lifecycle transition.
    "acquire-registered-workspace-target-lease",
    "consume-target-receipt",
    "discover-owned-descendants",
    "ensure-supported-existing-transport",
    "proof-state",
    "register-session",
    "release-focus",
    "release-session",
    "release-target-lease",
    "release-workspace",
  ].includes(args[0])
    ? 25_000
    : 5000;
  const timeout =
    Number.isSafeInteger(timeoutOverrideMs) && timeoutOverrideMs >= 100
      ? Math.min(defaultTimeout, timeoutOverrideMs)
      : defaultTimeout;
  const result = spawnVerifiedFd(opened, args, {
    capture: true,
    execution: "fixture-script",
    timeout,
    maxBuffer: 12 * 1024,
  });
  closeOpened(opened);
  return result;
}

function bindingName(session) {
  return `session-${session}.account`;
}

function taskLeaseName(session) {
  return `session-${session}.task-lease`;
}

function loadBinding(root, session) {
  const opened = root.openFile(bindingName(session), 1024, 0o600, {
    allowMissing: true,
  });
  if (!opened) return null;
  const text = opened.raw.toString("utf8");
  closeOpened(opened);
  const values = Object.fromEntries(
    text
      .trimEnd()
      .split("\n")
      .map((line) => {
        const index = line.indexOf("=");
        if (index <= 0) fail("session account binding is invalid", EX_DATAERR);
        return [line.slice(0, index), line.slice(index + 1)];
      }),
  );
  if (
    !exactKeys(values, ["schema", "account", "profile"]) ||
    values.schema !== "agent-browser-session-account-v1" ||
    accountIdentity(values.account).profile !== values.profile ||
    !["caleb", "erebora"].includes(values.account)
  ) {
    fail("session account binding is invalid", EX_DATAERR);
  }
  return { ...values, raw: Buffer.from(text) };
}

function bindingPayload(identity) {
  return Buffer.from(
    `schema=agent-browser-session-account-v1\naccount=${identity.account}\nprofile=${identity.profile}\n`,
    "utf8",
  );
}

function processStatIdentity(pid) {
  const raw = readFileSync(`/proc/${pid}/stat`, "utf8");
  const end = raw.lastIndexOf(")");
  if (end < 0) fail("session process identity is invalid", EX_DATAERR);
  const fields = raw
    .slice(end + 2)
    .trim()
    .split(/\s+/);
  if (!/^[A-Za-z]$/.test(fields[0] ?? "") || !/^[0-9]+$/.test(fields[19] ?? "")) {
    fail("session process identity is invalid", EX_DATAERR);
  }
  return { state: fields[0], startTicks: fields[19] };
}

function processStartTicks(pid) {
  return processStatIdentity(pid).startTicks;
}

function processIdentityIsLive(pid, expectedStartTicks = null) {
  try {
    process.kill(pid, 0);
    const identity = processStatIdentity(pid);
    return (
      !["Z", "X", "x"].includes(identity.state) &&
      (expectedStartTicks === null || identity.startTicks === expectedStartTicks)
    );
  } catch {
    return false;
  }
}

function readProcBounded(path, maxBytes) {
  let fd;
  try {
    fd = openSync(path, constants.O_RDONLY | (constants.O_CLOEXEC ?? 0));
    return readFdAll(fd, maxBytes);
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function processCommandExecutesDaemon(pid, daemonInfo) {
  try {
    const raw = readProcBounded(`/proc/${pid}/cmdline`, 64 * 1024);
    const args = raw.toString("utf8").split("\0").filter(Boolean);
    if (args.length < 2 || !isAbsolute(args[1])) return false;
    let source;
    if (args[1] === "/proc/self/fd/3") {
      source = statSync(`/proc/${pid}/fd/3`, { bigint: true });
    } else {
      if (realpathSync(args[1]) !== join(repoRoot, "dist", "daemon.js")) {
        return false;
      }
      source = statSync(args[1], { bigint: true });
    }
    return (
      source.isFile() &&
      source.dev === daemonInfo.dev &&
      source.ino === daemonInfo.ino &&
      source.size === daemonInfo.size
    );
  } catch {
    return false;
  }
}

function processOwnsSocket(pid, expectedSocketPath) {
  try {
    const socketInodes = new Set();
    const table = readProcBounded("/proc/net/unix", 1024 * 1024).toString(
      "utf8",
    );
    for (const line of table.split("\n").slice(1)) {
      const fields = line.trim().split(/\s+/);
      if (
        fields.length >= 8 &&
        fields.slice(7).join(" ") === expectedSocketPath &&
        /^[0-9]+$/.test(fields[6])
      ) {
        socketInodes.add(fields[6]);
      }
    }
    if (socketInodes.size === 0) return false;
    const entries = readdirSync(`/proc/${pid}/fd`);
    if (entries.length > 4096) return false;
    return entries.some((entry) => {
      try {
        const match = /^socket:\[([0-9]+)\]$/.exec(
          readlinkSync(`/proc/${pid}/fd/${entry}`),
        );
        return Boolean(match && socketInodes.has(match[1]));
      } catch {
        return false;
      }
    });
  } catch {
    return false;
  }
}

function readDaemonIdentity(root, session) {
  const opened = root.openFile(`${session}.daemon-identity`, 8192, 0o600, {
    allowMissing: true,
  });
  if (!opened) return null;
  const raw = opened.raw;
  closeOpened(opened);
  if (
    raw.length === 0 ||
    raw.at(-1) !== 0x0a ||
    raw.subarray(0, -1).includes(0x0a)
  ) {
    fail("task daemon identity receipt is invalid", EX_SOFTWARE);
  }
  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(
      raw.subarray(0, -1),
    );
  } catch {
    fail("task daemon identity receipt is invalid", EX_SOFTWARE);
  }
  const fields = text.split("\t");
  if (fields.length !== 21 || fields.some((field) => !field)) {
    fail("task daemon identity receipt is invalid", EX_SOFTWARE);
  }
  return { raw, fields };
}

function validateDaemonIdentity(root, session, state, graph) {
  const receipt = readDaemonIdentity(root, session);
  if (!receipt || state.kind !== "live") {
    fail("task daemon identity is not authenticated", EX_SOFTWARE);
  }
  const [
    schema,
    runtimeVersion,
    protocol,
    capabilities,
    receiptSession,
    receiptPid,
    receiptStartTicks,
    receiptUid,
    processExeDev,
    processExeIno,
    receiptSocketRoot,
    socketKind,
    socketEndpoint,
    socketDev,
    socketIno,
    receiptRuntimeRoot,
    manifestSha256,
    graphSha256,
    daemonSourceDev,
    daemonSourceIno,
    daemonSourceSize,
  ] = receipt.fields;
  const daemonInfo = graph.records["dist/daemon.js"].info;
  const expectedSocket = join(SOCKET_ROOT, `${session}.sock`);
  let processExe;
  try {
    processExe = statSync(`/proc/${state.pid}/exe`, { bigint: true });
  } catch {
    fail("task daemon identity is not authenticated", EX_SOFTWARE);
  }
  if (
    schema !== "agent-browser-daemon-identity-v2" ||
    runtimeVersion !== packageVersion() ||
    protocol !== "jsonl-command-v1" ||
    capabilities !== "click-expect-popup-v1" ||
    receiptSession !== session ||
    receiptPid !== String(state.pid) ||
    receiptStartTicks !== state.startTicks ||
    receiptUid !== String(uid) ||
    processExeDev !== processExe.dev.toString() ||
    processExeIno !== processExe.ino.toString() ||
    receiptSocketRoot !== SOCKET_ROOT ||
    socketKind !== "unix" ||
    socketEndpoint !== expectedSocket ||
    socketDev !== state.socketInfo.dev.toString() ||
    socketIno !== state.socketInfo.ino.toString() ||
    receiptRuntimeRoot !== repoRoot ||
    manifestSha256 !== graph.manifestSha256 ||
    graphSha256 !== graph.graphSha256 ||
    daemonSourceDev !== daemonInfo.dev.toString() ||
    daemonSourceIno !== daemonInfo.ino.toString() ||
    daemonSourceSize !== daemonInfo.size.toString() ||
    !processCommandExecutesDaemon(state.pid, daemonInfo) ||
    !processOwnsSocket(state.pid, expectedSocket)
  ) {
    fail("task daemon identity is not authenticated", EX_SOFTWARE);
  }
  try {
    const currentSocket = root.lstat(`${session}.sock`);
    if (
      !currentSocket ||
      currentSocket.dev !== state.socketInfo.dev ||
      currentSocket.ino !== state.socketInfo.ino ||
      processStartTicks(state.pid) !== state.startTicks
    ) {
      fail("task daemon identity changed during preflight", EX_SOFTWARE);
    }
  } catch (error) {
    if (error instanceof WrapperError) throw error;
    fail("task daemon identity changed during preflight", EX_SOFTWARE);
  }
  return receipt;
}

function readSessionState(root, session) {
  const pidFile = root.openFile(`${session}.pid`, 32, 0o600, {
    allowMissing: true,
  });
  let pid = null;
  let pidRaw = null;
  if (pidFile) {
    pidRaw = pidFile.raw;
    const text = pidFile.raw.toString("utf8").trim();
    closeOpened(pidFile);
    if (!/^[1-9][0-9]*$/.test(text))
      fail("session PID file is invalid", EX_DATAERR);
    pid = Number(text);
  }
  const socketInfo = root.lstat(`${session}.sock`);
  if (
    socketInfo &&
    (socketInfo.isSymbolicLink() ||
      !socketInfo.isSocket() ||
      Number(socketInfo.uid) !== uid)
  ) {
    fail("session socket is unsafe", EX_SOFTWARE);
  }
  let pidLive = false;
  if (pid !== null) {
    pidLive = processIdentityIsLive(pid);
  }
  if (pidLive && socketInfo) {
    return {
      kind: "live",
      pid,
      pidRaw,
      socketInfo,
      startTicks: processStartTicks(pid),
    };
  }
  const streamInfo = root.lstat(`${session}.stream`);
  const portInfo = root.lstat(`${session}.port`);
  const identityInfo = root.lstat(`${session}.daemon-identity`);
  if (pidLive)
    return {
      kind: "orphan",
      pid,
      pidRaw,
      socketInfo,
      streamInfo,
      portInfo,
      identityInfo,
    };
  if (pidFile || socketInfo || streamInfo || portInfo || identityInfo) {
    return {
      kind: "stale",
      pid,
      pidRaw,
      socketInfo,
      streamInfo,
      portInfo,
      identityInfo,
    };
  }
  return { kind: "closed" };
}

function loadTaskLease(root, session) {
  const opened = root.openFile(taskLeaseName(session), 4096, 0o600, {
    allowMissing: true,
  });
  if (!opened) return null;
  const data = parseJson(opened.raw, "task ownership lease");
  const raw = opened.raw;
  closeOpened(opened);
  if (
    !exactKeys(data, [
      "schema",
      "session",
      "account",
      "profile",
      "controllerEndpointId",
      "browserGeneration",
      "brokerGeneration",
      "transportGeneration",
      "registrationReceiptSha256",
      "profileBinding",
      "browserContextId",
      "targetId",
      "targetKind",
      "receiptNonce",
      "targetLeaseKind",
      "brokerAuthorizationLeaseId",
      "brokerAuthorizationPath",
      "brokerAuthorizationSha256",
      "brokerCapabilityExpiresAt",
      "pid",
      "startTicks",
      "socketDev",
      "socketIno",
      "leaseId",
      "createdAt",
    ]) ||
    data.schema !== "agent-browser.task-lease.v5" ||
    data.session !== session ||
    !["caleb", "erebora"].includes(data.account) ||
    accountIdentity(data.account).profile !== data.profile ||
    !/^[a-z0-9][a-z0-9-]{0,127}$/.test(data.controllerEndpointId) ||
    !/^[0-9a-f]{64}$/.test(data.browserGeneration) ||
    !/^[0-9a-f]{64}$/.test(data.brokerGeneration) ||
    !/^[0-9a-f]{64}$/.test(data.transportGeneration) ||
    !/^[0-9a-f]{64}$/.test(data.registrationReceiptSha256) ||
    !/^[0-9a-f]{64}$/.test(data.profileBinding) ||
    typeof data.browserContextId !== "string" ||
    !data.browserContextId ||
    data.browserContextId.length > 256 ||
    /[\u0000-\u001f\u007f]/.test(data.browserContextId) ||
    typeof data.targetId !== "string" ||
    !data.targetId ||
    data.targetId.length > 256 ||
    /[\u0000-\u001f\u007f]/.test(data.targetId) ||
    !["agent-workspace", "user-collaboration"].includes(data.targetKind) ||
    !/^[0-9a-f]{64}$/.test(data.receiptNonce) ||
    !["persistent-workspace", "user-adopted"].includes(data.targetLeaseKind) ||
    (data.targetKind === "agent-workspace"
      ? data.targetLeaseKind !== "persistent-workspace"
      : data.targetLeaseKind !== "user-adopted") ||
    !/^[0-9a-f]{64}$/.test(data.brokerAuthorizationLeaseId) ||
    data.brokerAuthorizationPath !==
      expectedBrokerAuthorizationPath(
        data.controllerEndpointId,
        data.brokerAuthorizationLeaseId,
      ) ||
    !/^[0-9a-f]{64}$/.test(data.brokerAuthorizationSha256) ||
    canonicalRfc3339Milliseconds(data.brokerCapabilityExpiresAt) === null ||
    !Number.isSafeInteger(data.pid) ||
    data.pid <= 0 ||
    !/^[0-9]+$/.test(data.startTicks) ||
    !/^[0-9]+$/.test(data.socketDev) ||
    !/^[0-9]+$/.test(data.socketIno) ||
    !/^[0-9a-f]{64}$/.test(data.leaseId) ||
    !Number.isSafeInteger(data.createdAt)
  ) {
    fail("task ownership lease is invalid", EX_DATAERR);
  }
  return { data, raw };
}

function validateTaskLease(lease, state, identity, authority) {
  if (
    !lease ||
    state.kind !== "live" ||
    lease.data.account !== identity.account ||
    lease.data.profile !== identity.profile ||
    lease.data.controllerEndpointId !== authority.data.controller_endpoint_id ||
    lease.data.browserGeneration !== authority.browserGeneration ||
    lease.data.brokerGeneration !== authority.data.broker_generation ||
    lease.data.transportGeneration !== authority.transportGeneration ||
    lease.data.pid !== state.pid ||
    lease.data.startTicks !== state.startTicks ||
    lease.data.socketDev !== state.socketInfo.dev.toString() ||
    lease.data.socketIno !== state.socketInfo.ino.toString()
  ) {
    fail("task session ownership is not attested", EX_DATAERR);
  }
}

function validateLocalTaskOwnership(lease, state, identity) {
  if (
    !lease ||
    state.kind !== "live" ||
    lease.data.account !== identity.account ||
    lease.data.profile !== identity.profile ||
    lease.data.pid !== state.pid ||
    lease.data.startTicks !== state.startTicks ||
    lease.data.socketDev !== state.socketInfo.dev.toString() ||
    lease.data.socketIno !== state.socketInfo.ino.toString()
  ) {
    fail("task session ownership is not attested", EX_DATAERR);
  }
}

function validateStaleOwnership(root, session, state, ownership) {
  if (state.kind !== "stale" || state.streamInfo || state.portInfo) {
    fail(
      "stale session contains artifacts outside the exact task lease",
      EX_DATAERR,
    );
  }
  if (
    (state.pid !== null && state.pid !== ownership.pid) ||
    (state.pidRaw &&
      state.pidRaw.toString("utf8").trim() !== String(ownership.pid)) ||
    (state.socketInfo &&
      (state.socketInfo.dev.toString() !== ownership.socketDev ||
        state.socketInfo.ino.toString() !== ownership.socketIno))
  ) {
    fail("stale session artifacts do not match the task lease", EX_DATAERR);
  }
  const identity = readDaemonIdentity(root, session);
  if (state.identityInfo && !identity) {
    fail("stale daemon identity evidence is unavailable", EX_DATAERR);
  }
  if (identity) {
    const fields = identity.fields;
    if (
      fields[0] !== "agent-browser-daemon-identity-v2" ||
      fields[4] !== session ||
      fields[5] !== String(ownership.pid) ||
      fields[6] !== ownership.startTicks ||
      fields[7] !== String(uid) ||
      fields[10] !== SOCKET_ROOT ||
      fields[11] !== "unix" ||
      fields[12] !== join(SOCKET_ROOT, `${session}.sock`) ||
      fields[13] !== ownership.socketDev ||
      fields[14] !== ownership.socketIno ||
      fields[15] !== repoRoot
    ) {
      fail("stale daemon identity does not match the task lease", EX_DATAERR);
    }
  }
  return identity;
}

function cleanupExactStaleSession(root, session, state, ownership) {
  const identity = validateStaleOwnership(root, session, state, ownership);
  if (state.socketInfo) {
    root.removeOwnedEntry(`${session}.sock`, state.socketInfo, "socket");
  }
  if (identity) {
    root.removeOwned(`${session}.daemon-identity`, identity.raw);
  }
  if (state.pidRaw) {
    root.removeOwned(`${session}.pid`, state.pidRaw);
  }
  if (readSessionState(root, session).kind !== "closed") {
    fail("owned stale session cleanup was incomplete", EX_SOFTWARE);
  }
}

function taskLeasePayload(session, identity, authority, state, registration) {
  return Buffer.from(
    `${canonicalJson({
      schema: "agent-browser.task-lease.v5",
      session,
      account: identity.account,
      profile: identity.profile,
      controllerEndpointId: authority.data.controller_endpoint_id,
      browserGeneration: authority.browserGeneration,
      brokerGeneration: authority.data.broker_generation,
      transportGeneration: authority.transportGeneration,
      registrationReceiptSha256: registration.registrationReceiptSha256,
      profileBinding: registration.profileBinding,
      browserContextId: registration.browserContextId,
      targetId: registration.targetId,
      targetKind: registration.targetKind,
      receiptNonce: registration.receiptNonce,
      targetLeaseKind: registration.targetLeaseKind,
      brokerAuthorizationLeaseId: registration.brokerAuthorizationLeaseId,
      brokerAuthorizationPath: registration.brokerAuthorizationPath,
      brokerAuthorizationSha256: registration.brokerAuthorizationSha256,
      brokerCapabilityExpiresAt: registration.brokerCapabilityExpiresAt,
      pid: state.pid,
      startTicks: state.startTicks,
      socketDev: state.socketInfo.dev.toString(),
      socketIno: state.socketInfo.ino.toString(),
      leaseId: randomBytes(32).toString("hex"),
      createdAt: Date.now(),
    })}\n`,
    "utf8",
  );
}

function validatePublicTargetReceipt(
  receipt,
  session,
  nonce,
  identity,
  authority,
) {
  if (
    !exactKeys(receipt, [
      "schema",
      "session",
      "targetId",
      "targetKind",
      "browserContextId",
      "profileBinding",
      "profileDirectory",
      "accountEmail",
      "browserGeneration",
      "transportGeneration",
      "leaseId",
      "workspaceMarkerUrl",
      "nonce",
      "issuedAt",
      "expiresAt",
    ]) ||
    receipt.schema !== TARGET_RECEIPT_SCHEMA ||
    receipt.session !== session ||
    receipt.nonce !== nonce ||
    !/^[0-9a-f]{64}$/.test(receipt.nonce) ||
    typeof receipt.targetId !== "string" ||
    !receipt.targetId ||
    receipt.targetId.length > 256 ||
    /[\u0000-\u001f\u007f]/.test(receipt.targetId) ||
    !["agent-workspace", "user-collaboration"].includes(receipt.targetKind) ||
    typeof receipt.browserContextId !== "string" ||
    !receipt.browserContextId ||
    receipt.browserContextId.length > 256 ||
    /[\u0000-\u001f\u007f]/.test(receipt.browserContextId) ||
    !/^[0-9a-f]{64}$/.test(receipt.profileBinding) ||
    typeof receipt.profileDirectory !== "string" ||
    !receipt.profileDirectory ||
    receipt.profileDirectory.length > 128 ||
    receipt.profileDirectory !== receipt.profileDirectory.trim() ||
    /[\u0000-\u001f\u007f]/.test(receipt.profileDirectory) ||
    typeof receipt.accountEmail !== "string" ||
    !receipt.accountEmail.includes("@") ||
    receipt.accountEmail.length > 320 ||
    receipt.accountEmail !== receipt.accountEmail.trim() ||
    /[\u0000-\u001f\u007f]/.test(receipt.accountEmail) ||
    !/^[0-9a-f]{64}$/.test(receipt.browserGeneration) ||
    !/^[0-9a-f]{64}$/.test(receipt.transportGeneration) ||
    !/^[0-9a-f]{64}$/.test(receipt.leaseId) ||
    (receipt.targetKind === "agent-workspace"
      ? typeof receipt.workspaceMarkerUrl !== "string" ||
        !/^about:blank#agent-browser-workspace-[0-9a-f]{64}$/.test(
          receipt.workspaceMarkerUrl,
        )
      : receipt.workspaceMarkerUrl !== null) ||
    receipt.profileDirectory !== identity.profile ||
    receipt.accountEmail !== identity.email ||
    receipt.browserGeneration !== authority.browserGeneration ||
    receipt.transportGeneration !== authority.transportGeneration ||
    !Number.isSafeInteger(receipt.issuedAt) ||
    receipt.issuedAt <= 0 ||
    !Number.isSafeInteger(receipt.expiresAt)
  ) {
    fail("pending target receipt is invalid", EX_DATAERR);
  }
  const now = Date.now();
  if (
    receipt.issuedAt > now + TARGET_FUTURE_SKEW_MS ||
    receipt.expiresAt <= now ||
    receipt.expiresAt <= receipt.issuedAt ||
    receipt.expiresAt - receipt.issuedAt > TARGET_MAX_TTL_MS ||
    now - receipt.issuedAt > TARGET_MAX_TTL_MS
  ) {
    fail(
      "pending target receipt is expired or exceeds the 30-second lease",
      EX_DATAERR,
    );
  }
}

function validateTargetClaim(
  envelope,
  metadata,
  session,
  nonce,
  identity,
  authority,
) {
  const receipt = envelope?.receipt;
  validatePublicTargetReceipt(receipt, session, nonce, identity, authority);
  if (
    !exactKeys(envelope, ["schema", "receipt"]) ||
    envelope.schema !== TARGET_CLAIM_ENVELOPE_SCHEMA ||
    !exactKeys(metadata, [
      "schema",
      "receipt",
      "port",
      "runtimeFingerprint",
      "browserGeneration",
      "transportGeneration",
      "provenanceKey",
      "controllerIdentity",
      "claimKind",
      "account",
      "profileDirectory",
      "browserContextId",
      "profileBinding",
      "brokerLeaseId",
      "brokerAuthFilePath",
      "brokerAuthFileSha256",
      "brokerCdpWebSocketUrl",
      "brokerHealthUrl",
      "consentGeneration",
      "brokerProducerContractSha256",
      "brokerCapabilityExpiresAt",
    ]) ||
    metadata.schema !== TARGET_METADATA_SCHEMA ||
    canonicalJson(metadata.receipt) !== canonicalJson(receipt) ||
    metadata.port !== SUPPORTED_CHROME_DEBUGGING_PORT ||
    !/^[0-9a-f]{64}$/.test(metadata.runtimeFingerprint) ||
    metadata.browserGeneration !== receipt.browserGeneration ||
    metadata.transportGeneration !== receipt.transportGeneration ||
    !/^[0-9a-f]{64}$/.test(metadata.provenanceKey) ||
    !/^[0-9a-f]{64}$/.test(metadata.controllerIdentity) ||
    !["persistent-workspace", "user-adopted"].includes(metadata.claimKind) ||
    metadata.account !== identity.account ||
    metadata.profileDirectory !== receipt.profileDirectory ||
    metadata.browserContextId !== receipt.browserContextId ||
    metadata.profileBinding !== receipt.profileBinding ||
    metadata.brokerLeaseId !== receipt.leaseId ||
    !/^[0-9a-f]{64}$/.test(metadata.brokerLeaseId) ||
    metadata.brokerAuthFilePath !==
      expectedBrokerAuthorizationPath(
        authority.data.controller_endpoint_id,
        receipt.leaseId,
      ) ||
    !/^[0-9a-f]{64}$/.test(metadata.brokerAuthFileSha256) ||
    metadata.brokerCdpWebSocketUrl !== authority.webSocketUrl ||
    metadata.brokerHealthUrl !== authority.healthUrl ||
    metadata.consentGeneration !== authority.data.consent_generation ||
    metadata.brokerProducerContractSha256 !==
      authority.snapshot.broker.producerContractSha256 ||
    canonicalRfc3339Milliseconds(metadata.brokerCapabilityExpiresAt) === null ||
    canonicalRfc3339Milliseconds(metadata.brokerCapabilityExpiresAt) <
      receipt.expiresAt ||
    (receipt.targetKind === "agent-workspace"
      ? metadata.claimKind !== "persistent-workspace"
      : metadata.claimKind !== "user-adopted")
  ) {
    fail("controller target lease binding is invalid", EX_DATAERR);
  }
  return {
    receipt,
    browserGeneration: receipt.browserGeneration,
    brokerGeneration: authority.data.broker_generation,
    transportGeneration: receipt.transportGeneration,
    account: metadata.account,
    profile: receipt.profileDirectory,
    accountEmail: receipt.accountEmail,
    browserContextId: receipt.browserContextId,
    targetKind: receipt.targetKind,
    profileBinding: receipt.profileBinding,
    leaseKind: metadata.claimKind,
    brokerAuthorizationLeaseId: metadata.brokerLeaseId,
    brokerAuthorizationPath: metadata.brokerAuthFilePath,
    brokerAuthorizationSha256: metadata.brokerAuthFileSha256,
    runtimeFingerprint: metadata.runtimeFingerprint,
    provenanceKey: metadata.provenanceKey,
    controllerIdentity: metadata.controllerIdentity,
    brokerProducerContractSha256: metadata.brokerProducerContractSha256,
    brokerCapabilityExpiresAt: metadata.brokerCapabilityExpiresAt,
  };
}

function acquireRegisteredWorkspaceTargetLease(
  parsed,
  identity,
  authority,
  verifyRecoveryOwnership,
) {
  let response;
  let recoveredWorkspace = null;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    response = parseControllerJsonLine(
      runController([
        "acquire-registered-workspace-target-lease",
        "--session",
        parsed.session,
        "--account",
        identity.account,
        // The controller and daemon both enforce this supported maximum. The
        // default 15-second receipt can expire during healthy controller proof
        // before the daemon gets its one chance to claim it.
        "--ttl-ms",
        String(TARGET_MAX_TTL_MS),
        "--json",
      ]),
      "controller workspace target lease location",
      "TARGET_REPROVISION_REQUIRED; registered workspace target is unavailable",
      true,
    );
    if (!response.controllerFailure) break;
    if (
      attempt === 0 &&
      response.data.status === "workspace_lease_recovery_required"
    ) {
      // WHY: a controller lease can be issued before transport reproof assigns
      // a local claim. The held bootstrap lock plus a closed local namespace
      // permits exactly one same-session retirement; a foreign session remains
      // a structured conflict and can never be stolen.
      verifyRecoveryOwnership();
      recoveredWorkspace = releasePendingWorkspaceLease(parsed, identity);
      continue;
    }
    fail(
      `${response.data.status}; ${response.data.reason}`,
      EX_UNAVAILABLE,
    );
  }
  if (!response || response.controllerFailure) {
    fail(
      "TARGET_REPROVISION_REQUIRED; registered workspace target is unavailable",
      EX_UNAVAILABLE,
    );
  }
  const result = response.data;
  if (
    !exactKeys(result, [
      "schema",
      "ok",
      "status",
      "controllerEndpointId",
      "path",
      "metadataPath",
      "receipt",
      "brokerAuthFilePath",
      "brokerAuthFileSha256",
      "brokerCdpWebSocketUrl",
      "brokerHealthUrl",
      "consentGeneration",
      "brokerProducerContractSha256",
      "brokerCapabilityExpiresAt",
      "activate",
    ]) ||
    result.schema !== "agent-browser.target-lease-location.v1" ||
    result.ok !== true ||
    result.status !== "issued" ||
    result.controllerEndpointId !== authority.data.controller_endpoint_id ||
    result.activate !== false
  ) {
    fail("controller returned a mismatched workspace target lease", EX_DATAERR);
  }
  validatePublicTargetReceipt(
    result.receipt,
    parsed.session,
    result.receipt?.nonce,
    identity,
    authority,
  );
  if (
    result.receipt.targetKind !== "agent-workspace" ||
    result.path !==
      join(
        productionControllerStateRoot(),
        "endpoints",
        authority.data.controller_endpoint_id,
        "target-leases",
        "pending",
        `${result.receipt.nonce}.json`,
      ) ||
    result.metadataPath !==
      join(
        productionControllerStateRoot(),
        "endpoints",
        authority.data.controller_endpoint_id,
        "target-leases",
        "controller-metadata",
        `${result.receipt.nonce}.json`,
      ) ||
    result.brokerAuthFilePath !==
      expectedBrokerAuthorizationPath(
        authority.data.controller_endpoint_id,
        result.receipt.leaseId,
      ) ||
    !/^[0-9a-f]{64}$/.test(result.brokerAuthFileSha256) ||
    result.brokerCdpWebSocketUrl !== authority.webSocketUrl ||
    result.brokerHealthUrl !== authority.healthUrl ||
    result.consentGeneration !== authority.data.consent_generation ||
    result.brokerProducerContractSha256 !==
      authority.snapshot.broker.producerContractSha256 ||
    canonicalRfc3339Milliseconds(result.brokerCapabilityExpiresAt) === null ||
    canonicalRfc3339Milliseconds(result.brokerCapabilityExpiresAt) <
      result.receipt.expiresAt
  ) {
    fail("controller returned a mismatched workspace target lease", EX_DATAERR);
  }
  if (
    recoveredWorkspace &&
    (recoveredWorkspace.targetId !== result.receipt.targetId ||
      recoveredWorkspace.browserContextId !==
        result.receipt.browserContextId ||
      recoveredWorkspace.profileBinding !== result.receipt.profileBinding ||
      recoveredWorkspace.browserGeneration !==
        result.receipt.browserGeneration ||
      recoveredWorkspace.transportGeneration !==
        result.receipt.transportGeneration ||
      recoveredWorkspace.markerUrl !== result.receipt.workspaceMarkerUrl)
  ) {
    fail(
      "recovered workspace identity changed during bounded reacquisition",
      EX_DATAERR,
    );
  }
  parsed.targetLease = result.path;
  return result;
}

function releasePendingWorkspaceLease(
  parsed,
  identity,
  expectedReceipt = null,
  options = {},
) {
  const response = parseControllerJsonLine(
    runController(
      [
        "release-workspace",
        "--account",
        identity.account,
        "--session",
        parsed.session,
        "--json",
      ],
      options.timeoutMs ?? null,
    ),
    "controller pending workspace release",
    "WORKSPACE_RELEASE_FAILED; exact pre-claim workspace lease remains controller-owned",
    options.allowControllerFailure === true,
  );
  if (response.controllerFailure) return response.data;
  const result = response.data;
  if (
    !exactKeys(result, [
      "ok",
      "status",
      "session",
      "account",
      "profileDirectory",
      "profileEmail",
      "targetId",
      "tabTargetId",
      "windowId",
      "browserContextId",
      "profileDiscriminatorKind",
      "profileBinding",
      "browserGeneration",
      "transportGeneration",
      "markerId",
      "markerUrl",
      "targetPreserved",
      "brokerPreserved",
    ]) ||
    result.ok !== true ||
    result.status !== "released" ||
    result.session !== parsed.session ||
    result.account !== identity.account ||
    result.profileDirectory !== identity.profile ||
    result.profileEmail !== identity.email ||
    !Number.isSafeInteger(result.windowId) ||
    result.windowId <= 0 ||
    !/^[0-9a-f]{64}$/.test(result.profileBinding) ||
    !/^[0-9a-f]{64}$/.test(result.browserGeneration) ||
    !/^[0-9a-f]{64}$/.test(result.transportGeneration) ||
    !/^[0-9a-f]{64}$/.test(result.markerId) ||
    result.markerUrl !== `about:blank#agent-browser-workspace-${result.markerId}` ||
    result.targetPreserved !== true ||
    result.brokerPreserved !== true
  ) {
    fail("controller returned a mismatched pending workspace release", EX_DATAERR);
  }
  for (const [value, label, maximum] of [
    [result.targetId, "released workspace targetId", 160],
    [result.tabTargetId, "released workspace tabTargetId", 160],
    [result.browserContextId, "released workspace browserContextId", 160],
    [
      result.profileDiscriminatorKind,
      "released workspace profile discriminator",
      80,
    ],
  ]) {
    exactBoundedString(value, label, maximum);
  }
  if (
    expectedReceipt &&
    (result.targetId !== expectedReceipt.targetId ||
      result.browserContextId !== expectedReceipt.browserContextId ||
      result.profileBinding !== expectedReceipt.profileBinding ||
      result.browserGeneration !== expectedReceipt.browserGeneration ||
      result.transportGeneration !== expectedReceipt.transportGeneration ||
      result.markerUrl !== expectedReceipt.workspaceMarkerUrl)
  ) {
    fail("pending workspace release identity changed", EX_DATAERR);
  }
  return result;
}

function releaseFailedPendingWorkspaceLease(parsed, identity, expectedReceipt) {
  try {
    const result = releasePendingWorkspaceLease(
      parsed,
      identity,
      expectedReceipt,
      { allowControllerFailure: true },
    );
    return result.ok === true
      ? result
      : cleanupFailure(result.status, result.reason);
  } catch (error) {
    return cleanupFailure(
      "workspace_release_transport_failed",
      error?.message || "Controller pending workspace release failed",
    );
  }
}

function openTargetLeaseTree(authority) {
  const endpoint = openControllerEndpointRoot(
    authority.data.controller_endpoint_id,
  );
  const leases = endpoint.openChild("target-leases", { mode: 0o700 });
  if (!leases) {
    leases?.close();
    endpoint.close();
    fail("target lease authority directories are missing", EX_DATAERR);
  }
  const pendingLeases = leases.openChild("pending", { mode: 0o700 });
  const consumedLeases = leases.openChild("consumed", { mode: 0o700 });
  // WHY: this directory is private controller authority; guessing a generic
  // metadata sibling rejects otherwise exact controller-issued workspace leases.
  const metadata = leases.openChild("controller-metadata", { mode: 0o700 });
  const daemonConsumed = leases.openChild("daemon-consumed", { mode: 0o700 });
  if (!pendingLeases || !consumedLeases || !metadata || !daemonConsumed) {
    pendingLeases?.close();
    consumedLeases?.close();
    metadata?.close();
    daemonConsumed?.close();
    leases.close();
    endpoint.close();
    fail("target lease authority directories are incomplete", EX_DATAERR);
  }
  return {
    endpoint,
    leases,
    pendingLeases,
    consumedLeases,
    metadata,
    daemonConsumed,
  };
}

function closeTargetTree(tree) {
  tree?.pendingLeases?.close();
  tree?.consumedLeases?.close();
  tree?.metadata?.close();
  tree?.daemonConsumed?.close();
  tree?.leases?.close();
  tree?.endpoint?.close();
}

function preflightTargetLease(
  parsed,
  identity,
  authority,
  autoLocation = null,
) {
  const basename = parsed.targetLease.split("/").at(-1);
  const nonce = basename?.endsWith(".json") ? basename.slice(0, -5) : "";
  if (!/^[0-9a-f]{64}$/.test(nonce)) {
    fail("target lease filename is invalid", EX_USAGE);
  }
  const expectedPath = join(
    productionControllerStateRoot(),
    "endpoints",
    authority.data.controller_endpoint_id,
    "target-leases",
    "pending",
    `${nonce}.json`,
  );
  if (parsed.targetLease !== expectedPath) {
    fail(
      "target lease is outside the exact pending authority directory",
      EX_DATAERR,
    );
  }
  const tree = openTargetLeaseTree(authority);
  let pending;
  let metadataFile;
  try {
    if (
      tree.consumedLeases.lstat(`${nonce}.json`) ||
      tree.daemonConsumed.lstat(nonce)
    ) {
      fail("target lease nonce was already consumed", EX_DATAERR);
    }
    pending = tree.pendingLeases.openFile(`${nonce}.json`, 8192, 0o600, {
      allowMissing: true,
    });
    if (!pending) {
      fail(
        "TARGET_REPROVISION_REQUIRED; pending workspace target lease is missing or replayed",
        EX_UNAVAILABLE,
      );
    }
    metadataFile = tree.metadata.openFile(`${nonce}.json`, 16 * 1024, 0o600, {
      allowMissing: true,
    });
    if (!metadataFile) {
      fail("controller target lease metadata is missing", EX_DATAERR);
    }
    const envelope = parseJson(pending.raw, "pending controller target claim");
    const metadata = parseJson(
      metadataFile.raw,
      "controller target lease metadata",
    );
    const lease = validateTargetClaim(
      envelope,
      metadata,
      parsed.session,
      nonce,
      identity,
      authority,
    );
    if (autoLocation) {
      if (
        lease.leaseKind !== "persistent-workspace" ||
        autoLocation.path !== parsed.targetLease ||
        autoLocation.metadataPath !==
          join(
            productionControllerStateRoot(),
            "endpoints",
            authority.data.controller_endpoint_id,
            "target-leases",
            "controller-metadata",
            `${nonce}.json`,
          ) ||
        canonicalJson(autoLocation.receipt) !==
          canonicalJson(envelope.receipt) ||
        autoLocation.brokerAuthFilePath !== metadata.brokerAuthFilePath ||
        autoLocation.brokerAuthFileSha256 !== metadata.brokerAuthFileSha256 ||
        autoLocation.brokerCdpWebSocketUrl !== metadata.brokerCdpWebSocketUrl ||
        autoLocation.brokerHealthUrl !== metadata.brokerHealthUrl ||
        autoLocation.consentGeneration !== metadata.consentGeneration ||
        autoLocation.brokerProducerContractSha256 !==
          metadata.brokerProducerContractSha256 ||
        autoLocation.brokerCapabilityExpiresAt !==
          metadata.brokerCapabilityExpiresAt
      ) {
        fail(
          "controller workspace acquisition did not match its exact target metadata",
          EX_DATAERR,
        );
      }
    }
    return {
      lease,
      envelope,
      envelopeRaw: pending.raw,
      metadata,
      metadataRaw: metadataFile.raw,
      nonce,
      authority: bindTransportAuthorization(authority, lease),
    };
  } finally {
    closeOpened(pending);
    closeOpened(metadataFile);
    closeTargetTree(tree);
  }
}

function consumeTargetLease(parsed, identity, authority, preflight) {
  if (!isAbsolute(parsed.targetLease)) {
    fail("--target-lease requires an absolute pending path", EX_USAGE);
  }
  const basename = parsed.targetLease.split("/").at(-1);
  const nonce = basename?.endsWith(".json") ? basename.slice(0, -5) : "";
  if (!/^[0-9a-f]{64}$/.test(nonce)) {
    fail("target lease filename is invalid", EX_USAGE);
  }
  const expectedPath = join(
    productionControllerStateRoot(),
    "endpoints",
    authority.data.controller_endpoint_id,
    "target-leases",
    "pending",
    `${nonce}.json`,
  );
  if (parsed.targetLease !== expectedPath) {
    fail(
      "target lease is outside the exact pending authority directory",
      EX_DATAERR,
    );
  }
  const tree = openTargetLeaseTree(authority);
  let pending;
  let metadataFile;
  try {
    if (
      tree.consumedLeases.lstat(`${nonce}.json`) ||
      tree.daemonConsumed.lstat(nonce)
    ) {
      fail("target lease nonce was already consumed", EX_DATAERR);
    }
    pending = tree.pendingLeases.openFile(`${nonce}.json`, 8192, 0o600, {
      allowMissing: true,
    });
    if (!pending)
      fail(
        "TARGET_REPROVISION_REQUIRED; pending workspace target lease is missing or replayed",
        EX_UNAVAILABLE,
      );
    metadataFile = tree.metadata.openFile(`${nonce}.json`, 16 * 1024, 0o600, {
      allowMissing: true,
    });
    if (!metadataFile) {
      fail("controller target lease metadata is missing", EX_DATAERR);
    }
    const envelope = parseJson(pending.raw, "pending controller target claim");
    const metadata = parseJson(
      metadataFile.raw,
      "controller target lease metadata",
    );
    const lease = validateTargetClaim(
      envelope,
      metadata,
      parsed.session,
      nonce,
      identity,
      authority,
    );
    if (
      !preflight ||
      preflight.nonce !== nonce ||
      !pending.raw.equals(preflight.envelopeRaw) ||
      !metadataFile.raw.equals(preflight.metadataRaw)
    ) {
      fail("target lease changed after preflight", EX_DATAERR);
    }
    bindTransportAuthorization(authority, lease);
    const envelopeRaw = pending.raw;
    const metadataRaw = metadataFile.raw;
    closeOpened(pending);
    pending = null;
    closeOpened(metadataFile);
    metadataFile = null;

    const relay = runController([
      "consume-target-receipt",
      "--path",
      parsed.targetLease,
      "--session",
      parsed.session,
      "--json",
    ]);
    if (
      relay.status !== 0 ||
      relay.signal ||
      relay.stderr !== "" ||
      typeof relay.stdout !== "string" ||
      relay.stdout.length === 0 ||
      Buffer.byteLength(relay.stdout) > 8192 ||
      !relay.stdout.endsWith("\n") ||
      relay.stdout.slice(0, -1).includes("\n")
    ) {
      fail(
        "target lease was not consumed by the pinned controller",
        EX_DATAERR,
      );
    }
    const publicReceipt = parseJson(
      Buffer.from(relay.stdout.slice(0, -1)),
      "target receipt relay",
    );
    validatePublicTargetReceipt(
      publicReceipt,
      parsed.session,
      nonce,
      identity,
      authority,
    );
    if (canonicalJson(publicReceipt) !== canonicalJson(lease.receipt)) {
      fail("controller returned a mismatched exact target receipt", EX_DATAERR);
    }
    if (tree.pendingLeases.lstat(`${nonce}.json`)) {
      fail("controller did not remove the pending target lease", EX_DATAERR);
    }
    const consumedLease = tree.consumedLeases.openFile(
      `${nonce}.json`,
      8192,
      0o600,
      { allowMissing: true },
    );
    if (!consumedLease || !consumedLease.raw.equals(envelopeRaw)) {
      closeOpened(consumedLease);
      fail(
        "controller did not preserve the exact consumed target claim",
        EX_DATAERR,
      );
    }
    const engineEnvelope = parseJson(consumedLease.raw, "engine target claim");
    if (canonicalJson(engineEnvelope) !== canonicalJson(envelope)) {
      closeOpened(consumedLease);
      fail("controller changed the exact engine target claim", EX_DATAERR);
    }
    const engineEnvelopeRaw = consumedLease.raw;
    closeOpened(consumedLease);
    return {
      tree,
      nonce,
      lease,
      metadata,
      metadataRaw,
      engineEnvelope,
      engineEnvelopeRaw,
      publicJson: canonicalJson(publicReceipt),
      consumedPath: join(
        productionControllerStateRoot(),
        "endpoints",
        authority.data.controller_endpoint_id,
        "target-leases",
        "consumed",
        `${nonce}.json`,
      ),
    };
  } catch (error) {
    closeOpened(pending);
    closeOpened(metadataFile);
    closeTargetTree(tree);
    throw error;
  }
}

function verifyTargetClaimed(claim) {
  if (claim.tree.consumedLeases.lstat(`${claim.nonce}.json`)) {
    fail(
      "engine did not claim the controller-issued target receipt",
      EX_DATAERR,
    );
  }
  const tombstoneDir = claim.tree.daemonConsumed.openChild(claim.nonce, {
    mode: 0o700,
  });
  if (!tombstoneDir)
    fail("engine target replay tombstone is missing", EX_DATAERR);
  const receipt = tombstoneDir.openFile("receipt.json", 8192, 0o600, {
    allowMissing: true,
  });
  if (!receipt || !receipt.raw.equals(claim.engineEnvelopeRaw)) {
    closeOpened(receipt);
    tombstoneDir.close();
    fail("engine target replay tombstone mismatched", EX_DATAERR);
  }
  closeOpened(receipt);
  tombstoneDir.close();
  const metadataFile = claim.tree.metadata.openFile(
    `${claim.nonce}.json`,
    16 * 1024,
    0o600,
  );
  const exactMetadata = metadataFile.raw.equals(claim.metadataRaw);
  closeOpened(metadataFile);
  if (!exactMetadata) fail("target lease metadata audit changed", EX_DATAERR);
  closeTargetTree(claim.tree);
  claim.tree = null;
}

function releaseConsumedTargetLease(parsed, claim) {
  const result = parseControllerJsonLine(
    runController([
      "release-target-lease",
      "--session",
      parsed.session,
      "--target-id",
      claim.lease.receipt.targetId,
      "--receipt-nonce",
      claim.nonce,
      "--json",
    ]),
    "controller target lease abort",
    "TARGET_LEASE_ABORT_FAILED; consumed target and client authorization remain controller-owned",
  ).data;
  if (
    !exactKeys(result, [
      "ok",
      "status",
      "session",
      "targetId",
      "targetKind",
      "targetPreserved",
      "brokerCapabilityRevoked",
    ]) ||
    result.ok !== true ||
    !["aborted", "TARGET_REPROVISION_REQUIRED"].includes(result.status) ||
    result.session !== parsed.session ||
    result.targetId !== claim.lease.receipt.targetId ||
    result.targetKind !== claim.lease.targetKind ||
    (result.status === "aborted"
      ? result.targetPreserved !== true
      : result.targetPreserved !== false) ||
    result.brokerCapabilityRevoked !== true
  ) {
    fail("controller returned a mismatched target lease abort", EX_DATAERR);
  }
}

function registerTaskSession(parsed, identity, authority, state, claim) {
  const response = parseControllerJsonLine(
    runController([
      "register-session",
      "--session",
      parsed.session,
      "--target-id",
      claim.lease.receipt.targetId,
      "--pid",
      String(state.pid),
      "--socket",
      join(SOCKET_ROOT, `${parsed.session}.sock`),
      "--receipt-nonce",
      claim.nonce,
      "--account",
      identity.account,
      "--profile-directory",
      identity.profile,
      "--profile-email",
      identity.email,
      "--browser-context-id",
      claim.lease.browserContextId,
      "--target-kind",
      claim.lease.targetKind,
      "--browser-generation",
      authority.browserGeneration,
      "--transport-generation",
      authority.transportGeneration,
      "--profile-binding",
      claim.lease.profileBinding,
      "--broker-lease-id",
      claim.lease.brokerAuthorizationLeaseId,
      "--broker-auth-file-path",
      claim.lease.brokerAuthorizationPath,
      "--broker-auth-file-sha256",
      claim.lease.brokerAuthorizationSha256,
      "--broker-cdp-websocket-url",
      authority.webSocketUrl,
      "--broker-health-url",
      authority.healthUrl,
      "--consent-generation",
      authority.data.consent_generation,
      "--broker-producer-contract-sha256",
      claim.lease.brokerProducerContractSha256,
      "--broker-capability-expires-at",
      claim.lease.brokerCapabilityExpiresAt,
      "--json",
    ]),
    "controller session registration",
    "SESSION_REGISTRATION_FAILED; controller did not register the exact attached workspace",
  );
  const result = response.data;
  if (
    !exactKeys(result, [
      "ok",
      "status",
      "session",
      "targetId",
      "targetKind",
      "account",
      "profileDirectory",
      "profileEmail",
      "browserContextId",
      "profileBinding",
      "browserGeneration",
      "transportGeneration",
      "receiptNonce",
      "daemonPid",
      "daemonStartTicks",
      "socketDev",
      "socketIno",
      "brokerLeaseId",
      "brokerAuthFilePath",
      "brokerAuthFileSha256",
      "brokerCdpWebSocketUrl",
      "brokerHealthUrl",
      "consentGeneration",
      "brokerProducerContractSha256",
      "brokerCapabilityExpiresAt",
    ]) ||
    result.ok !== true ||
    result.status !== "registered" ||
    result.session !== parsed.session ||
    result.targetId !== claim.lease.receipt.targetId ||
    result.targetKind !== claim.lease.targetKind ||
    result.account !== identity.account ||
    result.profileDirectory !== identity.profile ||
    result.profileEmail !== identity.email ||
    result.browserContextId !== claim.lease.browserContextId ||
    result.profileBinding !== claim.lease.profileBinding ||
    result.browserGeneration !== authority.browserGeneration ||
    result.transportGeneration !== authority.transportGeneration ||
    result.receiptNonce !== claim.nonce ||
    result.daemonPid !== state.pid ||
    result.daemonStartTicks !== state.startTicks ||
    result.socketDev !== state.socketInfo.dev.toString() ||
    result.socketIno !== state.socketInfo.ino.toString() ||
    result.brokerLeaseId !== claim.lease.brokerAuthorizationLeaseId ||
    result.brokerAuthFilePath !== claim.lease.brokerAuthorizationPath ||
    result.brokerAuthFileSha256 !== claim.lease.brokerAuthorizationSha256 ||
    result.brokerCdpWebSocketUrl !== authority.webSocketUrl ||
    result.brokerHealthUrl !== authority.healthUrl ||
    result.consentGeneration !== authority.data.consent_generation ||
    result.brokerProducerContractSha256 !==
      claim.lease.brokerProducerContractSha256 ||
    result.brokerCapabilityExpiresAt !== claim.lease.brokerCapabilityExpiresAt
  ) {
    fail("controller returned a mismatched session registration", EX_DATAERR);
  }
  return {
    ...result,
    registrationReceiptSha256: sha256(response.raw),
    profile: result.profileDirectory,
    accountEmail: result.profileEmail,
    targetLeaseKind: claim.lease.leaseKind,
    brokerAuthorizationLeaseId: result.brokerLeaseId,
    brokerAuthorizationPath: result.brokerAuthFilePath,
    brokerAuthorizationSha256: result.brokerAuthFileSha256,
  };
}

function validateRegisteredSessionProof(
  parsed,
  identity,
  authority,
  state,
  claim,
) {
  const result = parseControllerJsonLine(
    runController([
      "proof-state",
      "--session",
      parsed.session,
      "--target-id",
      claim.lease.receipt.targetId,
      "--receipt-nonce",
      claim.nonce,
      "--json",
    ]),
    "controller registered session proof",
    "SESSION_PROOF_FAILED; controller did not prove the exact registered daemon and target",
  ).data;
  if (
    !exactKeys(result, [
      "schema",
      "ok",
      "status",
      "session",
      "targetId",
      "targetKind",
      "browserContextId",
      "profileBinding",
      "profileDirectory",
      "accountEmail",
      "browserGeneration",
      "transportGeneration",
      "leaseId",
      "brokerCdpWebSocketUrl",
      "brokerHealthUrl",
      "brokerAuthFilePath",
      "brokerAuthFileSha256",
      "consentGeneration",
      "brokerProducerContractPath",
      "brokerProducerContractSha256",
      "transportProofStatePath",
      "transportProofStateSha256",
      "transportProofObservedAtMs",
      "daemonPid",
      "daemonStartTicks",
      "socketPath",
      "socketDev",
      "socketIno",
      "peerPidMatches",
    ]) ||
    result.schema !== "agent-browser.session-proof-state.v1" ||
    result.ok !== true ||
    result.status !== "ready" ||
    result.session !== parsed.session ||
    result.targetId !== claim.lease.receipt.targetId ||
    result.targetKind !== claim.lease.targetKind ||
    result.browserContextId !== claim.lease.browserContextId ||
    result.profileBinding !== claim.lease.profileBinding ||
    result.profileDirectory !== identity.profile ||
    result.accountEmail !== identity.email ||
    result.browserGeneration !== authority.browserGeneration ||
    result.transportGeneration !== authority.transportGeneration ||
    result.leaseId !== claim.lease.brokerAuthorizationLeaseId ||
    result.brokerCdpWebSocketUrl !== authority.webSocketUrl ||
    result.brokerHealthUrl !== authority.healthUrl ||
    result.brokerAuthFilePath !== claim.lease.brokerAuthorizationPath ||
    result.brokerAuthFileSha256 !== claim.lease.brokerAuthorizationSha256 ||
    result.consentGeneration !== authority.data.consent_generation ||
    result.brokerProducerContractPath !==
      authority.attestation.brokerProducerContractPath ||
    result.brokerProducerContractSha256 !==
      claim.lease.brokerProducerContractSha256 ||
    result.transportProofStatePath !==
      authority.attestation.transportProofStatePath ||
    !/^[0-9a-f]{64}$/.test(result.transportProofStateSha256) ||
    !Number.isSafeInteger(result.transportProofObservedAtMs) ||
    result.transportProofObservedAtMs <
      authority.attestation.transportProofObservedAtMs ||
    result.daemonPid !== state.pid ||
    result.daemonStartTicks !== state.startTicks ||
    result.socketPath !== join(SOCKET_ROOT, `${parsed.session}.sock`) ||
    result.socketDev !== state.socketInfo.dev.toString() ||
    result.socketIno !== state.socketInfo.ino.toString() ||
    result.peerPidMatches !== true
  ) {
    fail(
      "controller returned a mismatched registered session proof",
      EX_DATAERR,
    );
  }
  const snapshot = openTrustedSnapshot(
    result.transportProofStatePath,
    result.transportProofStateSha256,
    authority.data.controller_endpoint_id,
  );
  const { observedAtMs: priorObservedAtMs, ...priorSnapshotIdentity } =
    authority.snapshot;
  const { observedAtMs: refreshedObservedAtMs, ...refreshedSnapshotIdentity } =
    snapshot;
  if (
    snapshot.observedAtMs !== result.transportProofObservedAtMs ||
    refreshedObservedAtMs < priorObservedAtMs ||
    canonicalJson(refreshedSnapshotIdentity) !==
      canonicalJson(priorSnapshotIdentity) ||
    snapshot.broker.browserGeneration !== authority.browserGeneration ||
    snapshot.broker.transportGeneration !== authority.transportGeneration ||
    snapshot.broker.consentGeneration !== authority.data.consent_generation ||
    snapshot.broker.producerContractPath !==
      result.brokerProducerContractPath ||
    snapshot.broker.producerContractSha256 !==
      result.brokerProducerContractSha256
  ) {
    fail("registered session transport proof mismatched", EX_DATAERR);
  }
  return result;
}

function releaseTaskRegistration(
  session,
  targetId,
  targetKind,
  receiptNonce,
  options = {},
) {
  const response = parseControllerJsonLine(
    runController([
      "release-session",
      "--session",
      session,
      "--target-id",
      targetId,
      "--receipt-nonce",
      receiptNonce,
      "--json",
    ], options.timeoutMs ?? null),
    "controller session release",
    "SESSION_RELEASE_FAILED; exact controller registration remains owned",
    options.allowControllerFailure === true,
  );
  if (response.controllerFailure) return response.data;
  const result = response.data;
  if (
    !exactKeys(result, [
      "schema",
      "ok",
      "status",
      "session",
      "targetId",
      "targetKind",
      "receiptNonce",
      "descendantsClosed",
      "targetPreserved",
      "workspaceReady",
      "brokerCapabilityRevoked",
      "focusDisposition",
      "releasedAt",
    ]) ||
    result.schema !== "agent-browser.session-release-result.v1" ||
    result.ok !== true ||
    !["released", "TARGET_REPROVISION_REQUIRED"].includes(result.status) ||
    result.session !== session ||
    result.targetId !== targetId ||
    result.targetKind !== targetKind ||
    result.receiptNonce !== receiptNonce ||
    !Number.isSafeInteger(result.descendantsClosed) ||
    result.descendantsClosed < 0 ||
    (result.status === "released"
      ? result.targetPreserved !== true
      : result.targetPreserved !== false) ||
    (targetKind === "agent-workspace"
      ? result.workspaceReady !== (result.status === "released")
      : result.workspaceReady !== null) ||
    result.brokerCapabilityRevoked !== true ||
    !["none", "restored", "skipped-concurrent-change"].includes(
      result.focusDisposition,
    ) ||
    !Number.isSafeInteger(result.releasedAt)
  ) {
    fail("controller returned a mismatched session release", EX_DATAERR);
  }
  return result;
}

function cleanupFailure(status, reason) {
  return {
    ok: false,
    status: sanitize(status || "cleanup_failed").slice(0, 80),
    reason: sanitize(reason || "Exact failed-session cleanup did not complete").slice(
      0,
      480,
    ),
  };
}

function releaseFailedTaskRegistration(
  session,
  targetId,
  targetKind,
  receiptNonce,
) {
  const deadline = Date.now() + 15_000;
  const transientStatuses = new Set([
    "session_still_active",
    "session_release_busy",
  ]);
  let lastFailure = cleanupFailure(
    "session_release_timeout",
    "Exact controller registration release deadline expired",
  );
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const remaining = deadline - Date.now();
    if (remaining < 100) break;
    let result;
    try {
      result = releaseTaskRegistration(
        session,
        targetId,
        targetKind,
        receiptNonce,
        {
          allowControllerFailure: true,
          timeoutMs: remaining,
        },
      );
    } catch (error) {
      return cleanupFailure(
        "session_release_transport_failed",
        error?.message || "Controller session release transport failed",
      );
    }
    if (result.ok === true) {
      if (
        result.status !== "released" ||
        result.targetPreserved !== true ||
        result.workspaceReady !==
          (targetKind === "agent-workspace" ? true : null) ||
        result.brokerCapabilityRevoked !== true ||
        result.focusDisposition !== "none"
      ) {
        return cleanupFailure(
          "session_release_result_invalid",
          "Failed-session release changed the target, workspace, or focus disposition",
        );
      }
      return { ok: true, status: "released", reason: "" };
    }
    lastFailure = cleanupFailure(result.status, result.reason);
    if (!transientStatuses.has(result.status) || attempt === 2) break;
    sleepSync(Math.min(100 * 2 ** attempt, Math.max(1, deadline - Date.now())));
  }
  return lastFailure;
}

function appendCleanupFailure(error, cleanup) {
  if (!cleanup || cleanup.ok === true) return error;
  const primary =
    error instanceof WrapperError
      ? error.message
      : sanitize(error?.message || "unexpected wrapper failure");
  const message = sanitize(
    `${primary}; CLEANUP_INCOMPLETE; ${cleanup.status}; ${cleanup.reason}`,
  );
  return new WrapperError(
    message || "CLEANUP_INCOMPLETE; exact failed-session cleanup did not complete",
    error instanceof WrapperError ? error.code : EX_SOFTWARE,
  );
}

const TARGET_CREATING_COMMANDS = new Set([
  "open",
  "navigate",
  "click",
  "dblclick",
  "type",
  "fill",
  "press",
  "keydown",
  "keyup",
  "hover",
  "focus",
  "check",
  "uncheck",
  "select",
  "drag",
  "upload",
  "download",
  "scroll",
  "scrollintoview",
  "eval",
  "back",
  "forward",
  "reload",
  "find",
  "mouse",
  "set",
  "tab",
  "window",
  "frame",
  "dialog",
]);

function reconcileSessionTargets(parsed, authority, registration) {
  const result = parseControllerJsonLine(
    runController([
      "discover-owned-descendants",
      "--session",
      parsed.session,
      "--root-target-id",
      registration.targetId,
      "--receipt-nonce",
      registration.receiptNonce,
      "--json",
    ]),
    "controller target ledger",
    "TARGET_RECONCILIATION_REQUIRED; controller could not record same-context opener descendants",
  ).data;
  if (
    !exactKeys(result, [
      "schema",
      "ok",
      "status",
      "session",
      "rootTargetId",
      "receiptNonce",
      "browserContextId",
      "browserGeneration",
      "transportGeneration",
      "discoveredTargetIds",
      "registeredTargetIds",
      "truncated",
      "reconciledAt",
    ]) ||
    result.schema !== "agent-browser.descendant-reconcile-result.v1" ||
    result.ok !== true ||
    result.status !== "reconciled" ||
    result.session !== parsed.session ||
    result.rootTargetId !== registration.targetId ||
    result.receiptNonce !== registration.receiptNonce ||
    result.browserContextId !== registration.browserContextId ||
    result.browserGeneration !== authority.browserGeneration ||
    result.transportGeneration !== authority.transportGeneration ||
    ![result.discoveredTargetIds, result.registeredTargetIds].every(
      (values) =>
        Array.isArray(values) &&
        values.length <= 20 &&
        new Set(values).size === values.length &&
        values.every(
          (value) =>
            typeof value === "string" &&
            value.length > 0 &&
            value.length <= 256 &&
            !/[\u0000-\u001f\u007f]/.test(value),
        ),
    ) ||
    result.truncated !== false ||
    !Number.isSafeInteger(result.reconciledAt)
  ) {
    fail("controller returned a mismatched target ledger receipt", EX_DATAERR);
  }
  return result;
}

function focusLeaseName(session) {
  return `session-${session}.focus-lease`;
}

function validControllerTargetId(value) {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 256 &&
    !/[\u0000-\u001f\u007f]/.test(value)
  );
}

function validateFocusAcquireResult(data, session, taskLease) {
  if (
    !exactKeys(data, [
      "schema",
      "ok",
      "status",
      "session",
      "targetId",
      "targetKind",
      "browserContextId",
      "profileBinding",
      "profileDirectory",
      "accountEmail",
      "browserGeneration",
      "transportGeneration",
      "leaseId",
      "receiptNonce",
      "daemonPid",
      "daemonStartTicks",
      "socketPath",
      "socketDev",
      "socketIno",
      "focusLeaseId",
      "leasedTabId",
      "windowId",
      "restorationKind",
      "priorActiveTabId",
      "priorForegroundWindowHandle",
      "foregroundWindowHandle",
      "acquiredAt",
      "deadlineAt",
    ]) ||
    data.schema !== "agent-browser.focus-acquire-result.v1" ||
    data.ok !== true ||
    data.status !== "foreground" ||
    data.session !== session ||
    data.targetId !== taskLease.data.targetId ||
    data.targetKind !== taskLease.data.targetKind ||
    data.browserContextId !== taskLease.data.browserContextId ||
    data.profileBinding !== taskLease.data.profileBinding ||
    data.profileDirectory !== taskLease.data.profile ||
    data.accountEmail !== accountIdentity(taskLease.data.account).email ||
    data.browserGeneration !== taskLease.data.browserGeneration ||
    data.transportGeneration !== taskLease.data.transportGeneration ||
    data.leaseId !== taskLease.data.brokerAuthorizationLeaseId ||
    data.receiptNonce !== taskLease.data.receiptNonce ||
    data.daemonPid !== taskLease.data.pid ||
    data.daemonStartTicks !== taskLease.data.startTicks ||
    data.socketPath !== join(SOCKET_ROOT, `${session}.sock`) ||
    data.socketDev !== taskLease.data.socketDev ||
    data.socketIno !== taskLease.data.socketIno ||
    !/^[0-9a-f]{64}$/.test(data.focusLeaseId) ||
    !validControllerTargetId(data.leasedTabId) ||
    !Number.isSafeInteger(data.windowId) ||
    data.windowId < 0 ||
    !Number.isSafeInteger(data.priorForegroundWindowHandle) ||
    data.priorForegroundWindowHandle < 0 ||
    !Number.isSafeInteger(data.foregroundWindowHandle) ||
    data.foregroundWindowHandle < 0 ||
    !Number.isSafeInteger(data.acquiredAt) ||
    !Number.isSafeInteger(data.deadlineAt) ||
    data.deadlineAt <= data.acquiredAt ||
    (data.targetKind === "agent-workspace"
      ? data.restorationKind !== "workspace-hwnd-only" ||
        data.priorActiveTabId !== null
      : data.restorationKind !== "user-tab-and-hwnd" ||
        !validControllerTargetId(data.priorActiveTabId))
  ) {
    fail(
      "focus lease is foreign or does not match exact task ownership",
      EX_DATAERR,
    );
  }
  return data;
}

function loadFocusLease(root, session, taskLease) {
  const opened = root.openFile(focusLeaseName(session), 8192, 0o600, {
    allowMissing: true,
  });
  if (!opened) return null;
  const data = parseJson(opened.raw, "controller focus lease");
  const raw = opened.raw;
  closeOpened(opened);
  validateFocusAcquireResult(data, session, taskLease);
  return { data, raw };
}

function acquireOwnedFocusLease(root, session, taskLease) {
  const existing = loadFocusLease(root, session, taskLease);
  if (existing) return requireActiveForegroundLease(root, session, taskLease);

  const result = parseControllerJsonLine(
    runController([
      "acquire-focus",
      "--session",
      session,
      "--target-id",
      taskLease.data.targetId,
      "--receipt-nonce",
      taskLease.data.receiptNonce,
      "--json",
    ]),
    "controller foreground acquisition",
    "FOREGROUND_ACQUIRE_FAILED; controller did not acquire exact registered-session focus",
  ).data;
  validateFocusAcquireResult(result, session, taskLease);
  const raw = Buffer.from(`${canonicalJson(result)}\n`, "utf8");
  const name = focusLeaseName(session);
  let published = false;
  let publicationError = null;
  try {
    published = root.writeAtomic(name, raw, { exclusive: true });
  } catch (error) {
    publicationError = error;
  }
  if (!published) {
    try {
      releaseControllerFocusLease(result);
    } catch {
      fail(
        "FOCUS_ROLLBACK_FAILED; controller focus remains active after local publication failure",
        EX_UNAVAILABLE,
      );
    }
    if (publicationError) throw publicationError;
    fail("foreground lease publication raced another invocation", EX_SOFTWARE);
  }
  try {
    const stored = loadFocusLease(root, session, taskLease);
    if (!stored || !stored.raw.equals(raw)) {
      fail("foreground lease publication was not durable", EX_SOFTWARE);
    }
    return stored;
  } catch (error) {
    if (published) {
      try {
        root.removeOwned(name, raw);
      } catch {}
    }
    try {
      releaseControllerFocusLease(result);
    } catch {
      fail(
        "FOCUS_ROLLBACK_FAILED; controller focus remains active after local publication failure",
        EX_UNAVAILABLE,
      );
    }
    throw error;
  }
}

function requireActiveForegroundLease(root, session, taskLease) {
  const focus = loadFocusLease(root, session, taskLease);
  if (!focus) {
    fail(
      "FOREGROUND_REQUIRED; popup-producing collaboration needs an exact active controller foreground lease",
      EX_UNAVAILABLE,
    );
  }
  const data = focus.data;
  const result = parseControllerJsonLine(
    runController([
      "validate-focus-lease",
      "--session",
      data.session,
      "--focus-lease-id",
      data.focusLeaseId,
      "--json",
    ]),
    "controller foreground lease status",
    "FOREGROUND_REQUIRED; controller did not confirm the exact foreground lease",
  ).data;
  if (
    !exactKeys(result, [
      "schema",
      "ok",
      "status",
      "session",
      "focusLeaseId",
      "targetId",
      "targetKind",
      "receiptNonce",
      "browserContextId",
      "browserGeneration",
      "transportGeneration",
      "daemonPid",
      "daemonStartTicks",
      "socketPath",
      "socketDev",
      "socketIno",
      "leasedTabId",
      "windowId",
      "deadlineAt",
    ]) ||
    result.schema !== "agent-browser.focus-lease-validation.v1" ||
    result.ok !== true ||
    result.status !== "valid" ||
    result.session !== data.session ||
    result.focusLeaseId !== data.focusLeaseId ||
    result.targetId !== data.targetId ||
    result.targetKind !== data.targetKind ||
    result.receiptNonce !== data.receiptNonce ||
    result.browserContextId !== data.browserContextId ||
    result.browserGeneration !== data.browserGeneration ||
    result.transportGeneration !== data.transportGeneration ||
    result.daemonPid !== data.daemonPid ||
    result.daemonStartTicks !== data.daemonStartTicks ||
    result.socketPath !== data.socketPath ||
    result.socketDev !== data.socketDev ||
    result.socketIno !== data.socketIno ||
    result.leasedTabId !== data.leasedTabId ||
    result.windowId !== data.windowId ||
    result.deadlineAt !== data.deadlineAt
  ) {
    fail("controller foreground lease status mismatched", EX_DATAERR);
  }
  return focus;
}

function releaseControllerFocusLease(data) {
  const result = parseControllerJsonLine(
    runController([
      "release-focus",
      "--session",
      data.session,
      "--focus-lease-id",
      data.focusLeaseId,
      "--json",
    ]),
    "controller focus release",
    "FOCUS_RESTORE_FAILED; exact owned focus lease remains active",
  ).data;
  if (
    !exactKeys(result, [
      "schema",
      "ok",
      "status",
      "session",
      "targetId",
      "receiptNonce",
      "focusLeaseId",
      "restorationKind",
      "focusRestored",
      "restorationDisposition",
      "releasedAt",
    ]) ||
    result.schema !== "agent-browser.focus-release-result.v1" ||
    result.ok !== true ||
    result.status !== "background" ||
    result.session !== data.session ||
    result.targetId !== data.targetId ||
    result.receiptNonce !== data.receiptNonce ||
    result.focusLeaseId !== data.focusLeaseId ||
    result.restorationKind !== data.restorationKind ||
    typeof result.focusRestored !== "boolean" ||
    !["restored", "skipped-concurrent-change"].includes(
      result.restorationDisposition,
    ) ||
    (result.restorationDisposition === "restored"
      ? result.focusRestored !== true
      : result.focusRestored !== false) ||
    !Number.isSafeInteger(result.releasedAt)
  ) {
    fail("controller returned a mismatched focus release", EX_DATAERR);
  }
}

function restoreOwnedFocusLease(root, session, taskLease) {
  const focus = loadFocusLease(root, session, taskLease);
  if (!focus) return false;
  releaseControllerFocusLease(focus.data);
  root.removeOwned(focusLeaseName(session), focus.raw);
  return true;
}

function transportCacheName() {
  return "supported-existing-transport.receipt";
}

function writeTransportCache(root, authority, native) {
  const payload = Buffer.from(
    `${canonicalJson({
      schema: "agent-browser.transport-cache.v5",
      browserGeneration: authority.browserGeneration,
      brokerGeneration: authority.data.broker_generation,
      transportGeneration: authority.transportGeneration,
      attestationSha256: authority.rawHash,
      expiresAt: authority.expiresMs,
      nativeManifestSha256: native.manifest.manifestHash,
    })}\n`,
    "utf8",
  );
  root.writeAtomic(transportCacheName(), payload);
}

function validateTransportCache(root, authority, native) {
  const opened = root.openFile(transportCacheName(), 4096, 0o600, {
    allowMissing: true,
  });
  if (!opened) return false;
  const data = parseJson(opened.raw, "transport cache");
  closeOpened(opened);
  if (
    !exactKeys(data, [
      "schema",
      "browserGeneration",
      "brokerGeneration",
      "transportGeneration",
      "attestationSha256",
      "expiresAt",
      "nativeManifestSha256",
    ])
  ) {
    fail("transport cache is forged", EX_SOFTWARE);
  }
  return (
    data.schema === "agent-browser.transport-cache.v5" &&
    data.browserGeneration === authority.browserGeneration &&
    data.brokerGeneration === authority.data.broker_generation &&
    data.transportGeneration === authority.transportGeneration &&
    data.attestationSha256 === authority.rawHash &&
    data.expiresAt === authority.expiresMs &&
    data.nativeManifestSha256 === native.manifest.manifestHash &&
    authority.expiresMs > Date.now()
  );
}

function parsePopupClick(parsed) {
  let selector = "";
  let newTab = false;
  let literal = false;
  for (const arg of parsed.commandArgs) {
    if (!literal && arg === "--") {
      literal = true;
      continue;
    }
    if (!literal && arg === "--new-tab") {
      if (newTab) fail("duplicate --new-tab", EX_USAGE);
      newTab = true;
      continue;
    }
    if (!literal && arg.startsWith("-")) {
      fail(`unsupported click option '${arg}' with --expect-popup`, EX_USAGE);
    }
    if (selector) fail("click accepts exactly one selector", EX_USAGE);
    selector = arg;
  }
  if (!selector) fail("click requires a selector", EX_USAGE);
  return { selector, newTab };
}

function runPopupClick(parsed) {
  const click = parsePopupClick(parsed);
  const opened = openStaticFile(popupClientPath, 128 * 1024);
  if (sha256(opened.raw) !== EXPECTED_POPUP_CLIENT_SHA256) {
    closeOpened(opened);
    fail("exact popup client hash mismatched", EX_SOFTWARE);
  }
  const args = [
    "/proc/self/fd/3",
    "--socket-root",
    SOCKET_ROOT,
    "--session",
    parsed.session,
    "--selector",
    click.selector,
    "--runtime-root",
    repoRoot,
    "--runtime-version",
    packageVersion(),
    "--manifest-path",
    canonicalDistManifestPath,
    "--timeout-ms",
    "10000",
  ];
  if (click.newTab) args.push("--new-tab");
  if (parsed.json) args.push("--json");
  const result = spawnSync("/usr/bin/node", args, {
    env: BASE_CHILD_ENV,
    stdio: ["inherit", "inherit", "inherit", opened.fd],
    timeout: 15_000,
  });
  closeOpened(opened);
  return result;
}

function nativeArgs(parsed, authority) {
  return [
    ...parsed.nativeGlobals,
    ...(parsed.json ? ["--json"] : []),
    "--cdp",
    authority.webSocketUrl,
    "--session",
    parsed.session,
    parsed.command,
    ...parsed.commandArgs,
  ];
}

function daemonIdentityEnv(graph) {
  return {
    AGENT_BROWSER_DAEMON_IDENTITY_REQUIRED: "1",
    AGENT_BROWSER_CANONICAL_DIST_MANIFEST: canonicalDistManifestPath,
    AGENT_BROWSER_EXPECTED_CANONICAL_DIST_MANIFEST_SHA256: graph.manifestSha256,
  };
}

function nativeProfileEnv(identity, claim = null, graph, authority) {
  if (!authority.authorization || !authority.authorizationBinding) {
    fail("task transport authorization is unavailable", EX_DATAERR);
  }
  return {
    ...daemonIdentityEnv(graph),
    AGENT_BROWSER_CHROME_PROFILE_EMAIL: identity.email,
    AGENT_BROWSER_CHROME_PROFILE_DIRECTORY: identity.profile,
    AGENT_BROWSER_SUPPORTED_EXISTING_TRANSPORT: "1",
    AGENT_BROWSER_BROKER_WEBSOCKET_URL: authority.webSocketUrl,
    AGENT_BROWSER_BROKER_GENERATION: authority.data.broker_generation,
    AGENT_BROWSER_BROWSER_GENERATION: authority.browserGeneration,
    AGENT_BROWSER_TRANSPORT_GENERATION: authority.transportGeneration,
    AGENT_BROWSER_BROKER_AUTHORIZATION: authority.authorization.value,
    ...(claim
      ? {
          AGENT_BROWSER_TARGET_RECEIPT: claim.publicJson,
          AGENT_BROWSER_TARGET_CLAIM_PATH: claim.consumedPath,
        }
      : {}),
  };
}

function daemonSupportedTransportEnv(identity, claim, graph, authority) {
  return nativeProfileEnv(identity, claim, graph, authority);
}

function sleepSync(milliseconds) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

function exactProcessIsLive(pid, startTicks) {
  return processIdentityIsLive(pid, startTicks);
}

function stopExactProcess(pid, startTicks, deadlineMs = Date.now() + 1000) {
  if (!exactProcessIsLive(pid, startTicks)) return true;
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    return !exactProcessIsLive(pid, startTicks);
  }
  while (Date.now() < deadlineMs) {
    if (!exactProcessIsLive(pid, startTicks)) return true;
    sleepSync(Math.min(20, Math.max(1, deadlineMs - Date.now())));
  }
  return !exactProcessIsLive(pid, startTicks);
}

function openCanonicalDaemonSource(graph) {
  const opened = openStaticFile(
    join(repoRoot, "dist", "daemon.js"),
    4 * 1024 * 1024,
  );
  const expected = graph.records["dist/daemon.js"];
  if (
    sha256(opened.raw) !== expected.hash ||
    opened.info.dev !== expected.info.dev ||
    opened.info.ino !== expected.info.ino ||
    opened.info.size !== expected.info.size
  ) {
    closeOpened(opened);
    fail("canonical daemon source changed before bootstrap", EX_SOFTWARE);
  }
  return opened;
}

function bootstrapAttestedDaemon(
  root,
  session,
  graph,
  identity,
  authority,
  claim,
) {
  if (readSessionState(root, session).kind !== "closed") {
    fail(
      "cold daemon bootstrap found an occupied session namespace",
      EX_SOFTWARE,
    );
  }
  const source = openCanonicalDaemonSource(graph);
  let child;
  let childStartTicks = "";
  try {
    child = spawn("/usr/bin/node", ["/proc/self/fd/3"], {
      cwd: repoRoot,
      detached: true,
      env: {
        ...BASE_CHILD_ENV,
        ...daemonSupportedTransportEnv(identity, claim, graph, authority),
        AGENT_BROWSER_DAEMON: "1",
        AGENT_BROWSER_SESSION: session,
      },
      stdio: ["ignore", "ignore", "ignore", source.fd],
    });
    child.once("error", () => {});
    if (!Number.isSafeInteger(child.pid) || child.pid <= 1) {
      fail("canonical daemon could not be started", EX_UNAVAILABLE);
    }
    childStartTicks = processStartTicks(child.pid);
    child.unref();

    const deadline = Date.now() + 3000;
    while (Date.now() < deadline) {
      const state = readSessionState(root, session);
      if (state.kind === "live") {
        if (state.pid !== child.pid || state.startTicks !== childStartTicks) {
          fail("cold daemon bootstrap published another process", EX_SOFTWARE);
        }
        // listen(2) publishes the socket before the daemon's listen callback can
        // link its authenticated identity receipt.  The exact spawned PID/start
        // tuple may therefore be live briefly while receipt publication is still
        // in progress.  Wait only inside the existing bounded bootstrap deadline;
        // a present malformed or mismatched receipt still fails immediately.
        if (!root.lstat(`${session}.daemon-identity`)) {
          if (!exactProcessIsLive(child.pid, childStartTicks)) break;
          sleepSync(10);
          continue;
        }
        const identity = validateDaemonIdentity(root, session, state, graph);
        return {
          pid: state.pid,
          startTicks: state.startTicks,
          socketDev: state.socketInfo.dev.toString(),
          socketIno: state.socketInfo.ino.toString(),
          identityRaw: identity.raw,
        };
      }
      if (!exactProcessIsLive(child.pid, childStartTicks)) break;
      sleepSync(10);
    }
    fail(
      "canonical daemon did not publish an authenticated identity",
      EX_SOFTWARE,
    );
  } catch (error) {
    if (child?.pid && childStartTicks) {
      stopExactProcess(child.pid, childStartTicks);
    }
    throw error;
  } finally {
    closeOpened(source);
  }
}

function bootstrapLockName(session) {
  return `session-${session}.bootstrap-lock`;
}

function loadBootstrapLock(root, session) {
  const opened = root.openFile(bootstrapLockName(session), 4096, 0o600, {
    allowMissing: true,
  });
  if (!opened) return null;
  const data = parseJson(opened.raw, "session bootstrap lock");
  const raw = opened.raw;
  closeOpened(opened);
  if (
    !exactKeys(data, [
      "schema",
      "session",
      "account",
      "pid",
      "startTicks",
      "nonce",
    ]) ||
    data.schema !== "agent-browser.bootstrap-lock.v1" ||
    data.session !== session ||
    !["caleb", "erebora"].includes(data.account) ||
    !Number.isSafeInteger(data.pid) ||
    data.pid <= 1 ||
    !/^[0-9]+$/.test(data.startTicks) ||
    !/^[0-9a-f]{64}$/.test(data.nonce)
  ) {
    fail("session bootstrap lock is invalid", EX_DATAERR);
  }
  return { data, raw };
}

function bootstrapOwnerIsLive(lock) {
  return exactProcessIsLive(lock.data.pid, lock.data.startTicks);
}

function acquireBootstrapLock(root, parsed, identity) {
  const raw = Buffer.from(
    `${canonicalJson({
      schema: "agent-browser.bootstrap-lock.v1",
      session: parsed.session,
      account: identity.account,
      pid: process.pid,
      startTicks: processStartTicks(process.pid),
      nonce: randomBytes(32).toString("hex"),
    })}\n`,
    "utf8",
  );
  const name = bootstrapLockName(parsed.session);
  if (!root.writeAtomic(name, raw, { exclusive: true })) {
    const prior = loadBootstrapLock(root, parsed.session);
    if (!prior || bootstrapOwnerIsLive(prior)) {
      fail("another invocation owns this session bootstrap", EX_DATAERR);
    }
    root.removeOwned(name, prior.raw);
    if (!root.writeAtomic(name, raw, { exclusive: true })) {
      fail("another invocation won this session bootstrap", EX_DATAERR);
    }
  }
  return raw;
}

function requireClosedBootstrapNamespace(root, parsed, bootstrapRaw) {
  const requireExactLock = () => {
    const lock = loadBootstrapLock(root, parsed.session);
    if (!lock || !lock.raw.equals(bootstrapRaw)) {
      fail("session bootstrap ownership changed", EX_DATAERR);
    }
  };
  requireExactLock();
  const state = readSessionState(root, parsed.session);
  if (
    state.kind !== "closed" ||
    loadBinding(root, parsed.session) ||
    loadTaskLease(root, parsed.session) ||
    root.lstat(focusLeaseName(parsed.session))
  ) {
    fail("session namespace changed under exact bootstrap ownership", EX_DATAERR);
  }
  // Re-read the lock after the namespace snapshot so a replacement during the
  // check cannot authorize retirement from stale local ownership evidence.
  requireExactLock();
  return state;
}

function rollbackCreatedSession(
  native,
  parsed,
  identity,
  authority,
  graph,
  bootstrap,
) {
  if (!bootstrap) return { ok: true, status: "not-created", reason: "" };
  const deadline = Date.now() + 5000;
  const liveStateMatchesBootstrap = (state) =>
    state.kind === "live" &&
    state.pid === bootstrap.pid &&
    state.startTicks === bootstrap.startTicks &&
    state.socketInfo.dev.toString() === bootstrap.socketDev &&
    state.socketInfo.ino.toString() === bootstrap.socketIno;
  let state;
  try {
    state = readSessionState(native.root, parsed.session);
  } catch (error) {
    return cleanupFailure(
      "daemon_cleanup_state_invalid",
      error?.message || "Exact daemon cleanup state is invalid",
    );
  }
  if (state.kind === "live") {
    if (!liveStateMatchesBootstrap(state)) {
      return cleanupFailure(
        "daemon_cleanup_identity_changed",
        "Failed-session daemon/socket identity changed before cleanup",
      );
    }
    try {
      revalidateCanonicalRuntimeGraph(graph);
      validateDaemonIdentity(native.root, parsed.session, state, graph);
      native.run(
        nativeArgs({ ...parsed, command: "close", commandArgs: [] }, authority),
        nativeProfileEnv(identity, null, graph, authority),
        false,
        Math.max(100, Math.min(3000, deadline - Date.now())),
      );
    } catch {}
  }
  let terminationSent = false;
  while (Date.now() < deadline) {
    try {
      state = readSessionState(native.root, parsed.session);
      if (state.kind === "live") {
        if (!liveStateMatchesBootstrap(state)) {
          return cleanupFailure(
            "daemon_cleanup_identity_changed",
            "Failed-session daemon/socket identity changed during cleanup",
          );
        }
      } else if (state.kind === "orphan") {
        if (
          state.pid !== bootstrap.pid ||
          !exactProcessIsLive(bootstrap.pid, bootstrap.startTicks)
        ) {
          return cleanupFailure(
            "daemon_cleanup_identity_changed",
            "Failed-session orphan process no longer matches the exact bootstrap",
          );
        }
      } else if (state.kind === "stale") {
        cleanupExactStaleSession(
          native.root,
          parsed.session,
          state,
          bootstrap,
        );
        continue;
      } else if (
        state.kind === "closed" &&
        !exactProcessIsLive(bootstrap.pid, bootstrap.startTicks)
      ) {
        return { ok: true, status: "closed", reason: "" };
      }
      if (
        !terminationSent &&
        exactProcessIsLive(bootstrap.pid, bootstrap.startTicks)
      ) {
        try {
          process.kill(bootstrap.pid, "SIGTERM");
        } catch {}
        terminationSent = true;
      }
    } catch (error) {
      return cleanupFailure(
        "daemon_cleanup_failed",
        error?.message || "Exact failed-session daemon cleanup failed",
      );
    }
    sleepSync(Math.min(20, Math.max(1, deadline - Date.now())));
  }
  try {
    state = readSessionState(native.root, parsed.session);
    if (state.kind === "stale") {
      cleanupExactStaleSession(native.root, parsed.session, state, bootstrap);
      state = readSessionState(native.root, parsed.session);
    }
    if (
      state.kind === "closed" &&
      !exactProcessIsLive(bootstrap.pid, bootstrap.startTicks)
    ) {
      return { ok: true, status: "closed", reason: "" };
    }
  } catch (error) {
    return cleanupFailure(
      "daemon_cleanup_failed",
      error?.message || "Exact failed-session daemon cleanup failed",
    );
  }
  return cleanupFailure(
    "daemon_cleanup_timeout",
    "Exact failed-session daemon/socket remained live at the cleanup deadline",
  );
}

function runDoctor(parsed) {
  let status = 1;
  let rootStatus = "missing";
  let bindingStatus = "none";
  let sessionStatus = "closed";
  let nativeStatus = "invalid";
  let receiptStatus = "missing";
  try {
    const manifest = loadNativeManifest();
    const opened = openNativeBinary(manifest);
    const raw = readFdAll(opened.fd, manifest.data.size);
    nativeStatus =
      sha256(raw) === EXPECTED_NATIVE_SHA256 ? "verified" : "invalid";
    closeOpened(opened);
  } catch {
    nativeStatus = "invalid";
  }

  let root;
  try {
    root = SecureDir.open(SOCKET_ROOT, { create: false, mode: 0o700 });
    if (root) {
      rootStatus = "secure";
      const binding = loadBinding(root, parsed.session);
      if (binding) bindingStatus = binding.account;
      sessionStatus = readSessionState(root, parsed.session).kind;
      const receipt = root.openFile("native-revision.receipt", 4096, 0o600, {
        allowMissing: true,
      });
      if (receipt) {
        receiptStatus = "secure-present";
        closeOpened(receipt);
      }
      root.close();
    }
  } catch {
    rootStatus = "unsafe";
    bindingStatus = "invalid";
    sessionStatus = "invalid";
  }
  const transportStatus =
    ACCEPTED_TRANSPORT_HELPER_REVISIONS.length === 0
      ? "NEEDS_SUPPORTED_TRANSPORT_CONTROLLER"
      : "controller-proof-required";
  if (
    rootStatus === "secure" &&
    nativeStatus === "verified" &&
    transportStatus === "local-evidence-present"
  ) {
    status = 0;
  }
  process.stdout.write(
    [
      `wrapper_version=${packageVersion()}`,
      `state_root=${rootStatus}`,
      `native_manifest=${nativeStatus}`,
      `native_receipt=${receiptStatus}`,
      `session=${parsed.session}`,
      `session_binding=${bindingStatus}`,
      `session_state=${sessionStatus}`,
      `transport=${transportStatus}`,
    ].join("\n") + "\n",
  );
  return status;
}

function handleClose(root, parsed, binding) {
  let state = readSessionState(root, parsed.session);
  const lease = loadTaskLease(root, parsed.session);
  if (state.kind === "closed") {
    // Local metadata may be released only when both records prove this wrapper
    // owned the already-empty lane. Exact focus/session registrations are
    // restored/released; the broker and workspace target are never closed.
    if (binding && lease && binding.account === lease.data.account) {
      restoreOwnedFocusLease(root, parsed.session, lease);
      releaseTaskRegistration(
        parsed.session,
        lease.data.targetId,
        lease.data.targetKind,
        lease.data.receiptNonce,
      );
      root.removeOwned(bindingName(parsed.session), binding.raw);
      root.removeOwned(taskLeaseName(parsed.session), lease.raw);
    }
    return 0;
  }
  if (state.kind === "stale") {
    if (!binding || !lease || binding.account !== lease.data.account) {
      fail(
        "stale session ownership is incomplete; cleanup evidence is preserved",
        EX_DATAERR,
      );
    }
    if (parsed.account && parsed.account !== binding.account) {
      fail(
        `session is bound to ${binding.account}; close it without rebinding`,
        EX_DATAERR,
      );
    }
    validateStaleOwnership(root, parsed.session, state, lease.data);
    restoreOwnedFocusLease(root, parsed.session, lease);
    cleanupExactStaleSession(root, parsed.session, state, lease.data);
    releaseTaskRegistration(
      parsed.session,
      lease.data.targetId,
      lease.data.targetKind,
      lease.data.receiptNonce,
    );
    root.removeOwned(bindingName(parsed.session), binding.raw);
    root.removeOwned(taskLeaseName(parsed.session), lease.raw);
    return 0;
  }
  if (state.kind === "orphan") {
    fail(
      "live session PID has no owned socket; cleanup is refused",
      EX_DATAERR,
    );
  }
  if (!binding || !lease) {
    fail("live session is unowned; target close is refused", EX_DATAERR);
  }
  if (parsed.account && parsed.account !== binding.account) {
    fail(
      `session is bound to ${binding.account}; close it without rebinding`,
      EX_DATAERR,
    );
  }
  const graph = loadCanonicalRuntimeGraph();
  validateDaemonIdentity(root, parsed.session, state, graph);
  const identity = accountIdentity(binding.account);
  restoreOwnedFocusLease(root, parsed.session, lease);
  let authority = loadTransportAuthority(parsed.session);
  let native;
  try {
    state = readSessionState(root, parsed.session);
    validateTaskLease(lease, state, identity, authority);
    authority = bindTransportAuthorization(authority, lease.data);
    revalidateCanonicalRuntimeGraph(graph);
    validateDaemonIdentity(root, parsed.session, state, graph);
    native = new NativeRuntime(root);
    native.ensureRevision();
    revalidateCanonicalRuntimeGraph(graph);
    state = readSessionState(root, parsed.session);
    validateTaskLease(lease, state, identity, authority);
    validateDaemonIdentity(root, parsed.session, state, graph);
    const result = native.run(
      nativeArgs(parsed, authority),
      nativeProfileEnv(identity, null, graph, authority),
    );
    authority = revalidateTransportAuthority(authority, parsed.session);
    if (result.status !== 0) return result.status ?? 1;
    releaseTaskRegistration(
      parsed.session,
      lease.data.targetId,
      lease.data.targetKind,
      lease.data.receiptNonce,
    );
    root.removeOwned(bindingName(parsed.session), binding.raw);
    root.removeOwned(taskLeaseName(parsed.session), lease.raw);
    return 0;
  } finally {
    native?.close();
  }
}

function handleSessionList(root, parsed, binding) {
  let state = readSessionState(root, parsed.session);
  const lease = loadTaskLease(root, parsed.session);
  if (state.kind !== "live" || !binding || !lease) {
    fail(
      "session list requires an authenticated live task session",
      EX_DATAERR,
    );
  }
  const graph = loadCanonicalRuntimeGraph();
  validateDaemonIdentity(root, parsed.session, state, graph);
  const identity = accountIdentity(binding.account);
  let authority = loadTransportAuthority(parsed.session);
  let native;
  try {
    validateTaskLease(lease, state, identity, authority);
    authority = bindTransportAuthorization(authority, lease.data);
    native = new NativeRuntime(root);
    native.ensureRevision();
    revalidateCanonicalRuntimeGraph(graph);
    state = readSessionState(root, parsed.session);
    validateTaskLease(lease, state, identity, authority);
    validateDaemonIdentity(root, parsed.session, state, graph);
    const result = native.run(
      ["--session", parsed.session, "session", "list"],
      nativeProfileEnv(identity, null, graph, authority),
    );
    authority = revalidateTransportAuthority(authority, parsed.session);
    return result.status ?? 1;
  } finally {
    native?.close();
  }
}

function recycleExpiringWorkspaceSession(root, parsed, binding, state) {
  if (
    state.kind !== "live" ||
    !binding ||
    parsed.targetLease ||
    ["foreground", "background"].includes(parsed.command)
  ) {
    return { state, binding };
  }
  const lease = loadTaskLease(root, parsed.session);
  const expiresAt = lease
    ? canonicalRfc3339Milliseconds(lease.data.brokerCapabilityExpiresAt)
    : null;
  if (expiresAt === null) {
    fail("task broker capability expiry is invalid", EX_DATAERR);
  }
  if (expiresAt > Date.now() + BROKER_CAPABILITY_REACQUIRE_MARGIN_MS) {
    return { state, binding };
  }
  const identity = accountIdentity(binding.account);
  validateLocalTaskOwnership(lease, state, identity);
  if (lease.data.targetKind !== "agent-workspace") {
    fail(
      "TARGET_RESELECTION_REQUIRED; an expiring explicit user-tab collaboration cannot be silently reacquired",
      EX_UNAVAILABLE,
    );
  }

  // The task token authenticates the daemon's one broker connection. Replacing
  // that token cannot re-authorize an existing socket, so retire only this exact
  // daemon/registration and reacquire the same persistent workspace below.
  const graph = loadCanonicalRuntimeGraph();
  validateDaemonIdentity(root, parsed.session, state, graph);
  const focus = loadFocusLease(root, parsed.session, lease);
  let focusReleasedLocally = false;
  if (focus && expiresAt > Date.now()) {
    restoreOwnedFocusLease(root, parsed.session, lease);
    focusReleasedLocally = true;
  }
  if (!stopExactProcess(state.pid, state.startTicks)) {
    fail(
      "SESSION_REACQUIRE_FAILED; exact expiring workspace daemon did not stop",
      EX_UNAVAILABLE,
    );
  }
  state = readSessionState(root, parsed.session);
  if (state.kind === "stale") {
    cleanupExactStaleSession(root, parsed.session, state, lease.data);
    state = readSessionState(root, parsed.session);
  }
  if (state.kind !== "closed") {
    fail(
      "SESSION_REACQUIRE_FAILED; exact expiring workspace namespace did not close",
      EX_UNAVAILABLE,
    );
  }
  const released = releaseTaskRegistration(
    parsed.session,
    lease.data.targetId,
    lease.data.targetKind,
    lease.data.receiptNonce,
  );
  if (focus && !focusReleasedLocally) {
    if (
      !["restored", "skipped-concurrent-change"].includes(
        released.focusDisposition,
      )
    ) {
      fail(
        "SESSION_REACQUIRE_FAILED; controller did not retire the expired focus lease",
        EX_UNAVAILABLE,
      );
    }
    root.removeOwned(focusLeaseName(parsed.session), focus.raw);
  }
  root.removeOwned(bindingName(parsed.session), binding.raw);
  root.removeOwned(taskLeaseName(parsed.session), lease.raw);
  if (released.status !== "released") {
    fail(
      "TARGET_REPROVISION_REQUIRED; persistent workspace disappeared during capability reacquisition",
      EX_UNAVAILABLE,
    );
  }
  return { state: readSessionState(root, parsed.session), binding: null };
}

function handleBrowserAction(root, parsed, binding) {
  let state = readSessionState(root, parsed.session);
  ({ state, binding } = recycleExpiringWorkspaceSession(
    root,
    parsed,
    binding,
    state,
  ));
  if (state.kind === "orphan") {
    fail("live session PID has no owned socket", EX_DATAERR);
  }
  const createsSession = state.kind === "closed";
  if (state.kind === "stale") {
    fail("stale session artifacts require an explicit owned close", EX_DATAERR);
  }
  if (!createsSession && !binding) {
    fail("live session has no account binding", EX_DATAERR);
  }
  if (createsSession && binding) {
    fail(
      "closed session retains an account binding; close it before reuse",
      EX_DATAERR,
    );
  }
  if (createsSession && ["foreground", "background"].includes(parsed.command)) {
    fail(
      `${parsed.command} requires an authenticated live task session`,
      EX_DATAERR,
    );
  }
  if (createsSession && parsed.expectPopup) {
    fail(
      "FOREGROUND_REQUIRED; popup-producing collaboration requires an already registered foreground session",
      EX_UNAVAILABLE,
    );
  }
  if (parsed.targetLease && !createsSession) {
    fail(
      "target leases are bootstrap-only and cannot rebind a live daemon",
      EX_DATAERR,
    );
  }

  const selectedAccount = binding?.account ?? parsed.account ?? "caleb";
  if (binding && parsed.account && parsed.account !== binding.account) {
    fail(
      `session is bound to ${binding.account}; close it before rebinding`,
      EX_DATAERR,
    );
  }
  const identity = accountIdentity(selectedAccount);
  let bootstrapRaw = null;
  let authority;
  let native;
  let claim = null;
  let createdLeaseRaw = null;
  let createdBindingRaw = null;
  let shouldRollback = false;
  let ownershipCommitted = false;
  let graph;
  let daemonBootstrap = null;
  let lease = null;
  let registration = null;
  let targetLeasePreflight = null;
  let autoAcquiredLocation = null;
  let claimReleased = false;

  try {
    graph = loadCanonicalRuntimeGraph();
    if (!createsSession) {
      validateDaemonIdentity(root, parsed.session, state, graph);
    }
    if (createsSession) {
      bootstrapRaw = acquireBootstrapLock(root, parsed, identity);
      state = requireClosedBootstrapNamespace(root, parsed, bootstrapRaw);
    }
    if (!createsSession && parsed.command === "background") {
      lease = loadTaskLease(root, parsed.session);
      validateLocalTaskOwnership(lease, state, identity);
      restoreOwnedFocusLease(root, parsed.session, lease);
      return 0;
    }
    authority = loadTransportAuthority(parsed.session);
    if (createsSession) {
      const autoAcquired = !parsed.targetLease;
      if (autoAcquired) {
        autoAcquiredLocation = acquireRegisteredWorkspaceTargetLease(
          parsed,
          identity,
          authority,
          () => {
            state = requireClosedBootstrapNamespace(root, parsed, bootstrapRaw);
          },
        );
        // Lease discovery can legitimately outlive the five-second process
        // snapshot. Re-prove the same generations before trusting its result.
        authority = refreshTransportAuthority(authority, parsed.session);
      }
      targetLeasePreflight = preflightTargetLease(
        parsed,
        identity,
        authority,
        autoAcquiredLocation,
      );
      authority = targetLeasePreflight.authority;
    } else {
      state = readSessionState(root, parsed.session);
      lease = loadTaskLease(root, parsed.session);
      validateTaskLease(lease, state, identity, authority);
      authority = bindTransportAuthorization(authority, lease.data);
    }
    if (!createsSession && parsed.command === "foreground") {
      graph = revalidateCanonicalRuntimeGraph(graph);
      state = readSessionState(root, parsed.session);
      validateTaskLease(lease, state, identity, authority);
      validateDaemonIdentity(root, parsed.session, state, graph);
      acquireOwnedFocusLease(root, parsed.session, lease);
      authority = revalidateTransportAuthority(authority, parsed.session);
      return 0;
    }
    native = new NativeRuntime(root);
    native.ensureRevision();
    graph = revalidateCanonicalRuntimeGraph(graph);
    if (createsSession) {
      claim = consumeTargetLease(
        parsed,
        identity,
        authority,
        targetLeasePreflight,
      );
      daemonBootstrap = bootstrapAttestedDaemon(
        root,
        parsed.session,
        graph,
        identity,
        authority,
        claim,
      );
      shouldRollback = true;
      state = readSessionState(root, parsed.session);
    } else validateDaemonIdentity(root, parsed.session, state, graph);
    validateTransportCache(root, authority, native);

    if (parsed.expectPopup) {
      graph = revalidateCanonicalRuntimeGraph(graph);
      state = readSessionState(root, parsed.session);
      validateTaskLease(lease, state, identity, authority);
      validateDaemonIdentity(root, parsed.session, state, graph);
      requireActiveForegroundLease(root, parsed.session, lease);
      const result = runPopupClick(parsed);
      if (TARGET_CREATING_COMMANDS.has(parsed.command)) {
        reconcileSessionTargets(parsed, authority, lease.data);
      }
      authority = revalidateTransportAuthority(authority, parsed.session);
      writeTransportCache(root, authority, native);
      return result.status ?? 1;
    }

    graph = revalidateCanonicalRuntimeGraph(graph);
    state = readSessionState(root, parsed.session);
    if (!createsSession) {
      validateTaskLease(lease, state, identity, authority);
    }
    validateDaemonIdentity(root, parsed.session, state, graph);
    const result = native.run(
      nativeArgs(parsed, authority),
      nativeProfileEnv(identity, claim, graph, authority),
    );
    if (claim) verifyTargetClaimed(claim);
    if (!createsSession || result.status !== 0) {
      authority = revalidateTransportAuthority(authority, parsed.session);
    }
    if (result.status !== 0) {
      if (createsSession) {
        rollbackCreatedSession(
          native,
          parsed,
          identity,
          authority,
          graph,
          daemonBootstrap,
        );
        shouldRollback = false;
        releaseConsumedTargetLease(parsed, claim);
        claimReleased = true;
      } else if (TARGET_CREATING_COMMANDS.has(parsed.command)) {
        reconcileSessionTargets(parsed, authority, lease.data);
      }
      return result.status ?? 1;
    }
    graph = revalidateCanonicalRuntimeGraph(graph);
    state = readSessionState(root, parsed.session);
    validateDaemonIdentity(root, parsed.session, state, graph);
    if (createsSession) {
      // Controller registration re-proves the profile, workspace, broker, and
      // daemon; proof-state then refreshes the final five-second same-owner
      // snapshot. Repeating wrapper ensure/broker probes after native success
      // exhausted the bounded bootstrap window without adding authority and
      // could leave a registered daemon without its local ownership lease.
      registration = registerTaskSession(
        parsed,
        identity,
        authority,
        state,
        claim,
      );
      validateRegisteredSessionProof(parsed, identity, authority, state, claim);
      createdLeaseRaw = taskLeasePayload(
        parsed.session,
        identity,
        authority,
        state,
        registration,
      );
      if (
        !root.writeAtomic(taskLeaseName(parsed.session), createdLeaseRaw, {
          exclusive: true,
        })
      ) {
        fail("task ownership lease raced another invocation", EX_SOFTWARE);
      }
      createdBindingRaw = bindingPayload(identity);
      if (
        !root.writeAtomic(bindingName(parsed.session), createdBindingRaw, {
          exclusive: true,
        })
      ) {
        root.removeOwned(taskLeaseName(parsed.session), createdLeaseRaw);
        createdLeaseRaw = null;
        fail("session account binding raced another invocation", EX_SOFTWARE);
      }
      ownershipCommitted = true;
      shouldRollback = false;
    }
    if (createsSession || TARGET_CREATING_COMMANDS.has(parsed.command)) {
      reconcileSessionTargets(
        parsed,
        authority,
        createsSession ? registration : lease.data,
      );
    }
    writeTransportCache(root, authority, native);
    return 0;
  } catch (error) {
    let failedCleanup = null;
    if (shouldRollback && native) {
      const rollback = rollbackCreatedSession(
        native,
        parsed,
        identity,
        authority,
        graph,
        daemonBootstrap,
      );
      if (rollback.ok !== true) failedCleanup = rollback;
    }
    if (!ownershipCommitted && registration) {
      if (!failedCleanup) {
        const released = releaseFailedTaskRegistration(
          parsed.session,
          registration.targetId,
          registration.targetKind,
          registration.receiptNonce,
        );
        if (released.ok !== true) failedCleanup = released;
      }
    }
    if (
      !ownershipCommitted &&
      !registration &&
      !claim &&
      autoAcquiredLocation &&
      !failedCleanup
    ) {
      const released = releaseFailedPendingWorkspaceLease(
        parsed,
        identity,
        autoAcquiredLocation.receipt,
      );
      if (released.ok !== true) failedCleanup = released;
    }
    if (!ownershipCommitted && !registration && claim && !claimReleased) {
      releaseConsumedTargetLease(parsed, claim);
      claimReleased = true;
    }
    if (!ownershipCommitted && createdBindingRaw) {
      try {
        root.removeOwned(bindingName(parsed.session), createdBindingRaw);
      } catch {}
    }
    if (!ownershipCommitted && createdLeaseRaw) {
      try {
        root.removeOwned(taskLeaseName(parsed.session), createdLeaseRaw);
      } catch {}
    }
    throw appendCleanupFailure(error, failedCleanup);
  } finally {
    if (claim?.tree) closeTargetTree(claim.tree);
    native?.close();
    if (bootstrapRaw) {
      try {
        root.removeOwned(bootstrapLockName(parsed.session), bootstrapRaw);
      } catch {}
    }
  }
}

function main() {
  const parsed = parseArgs(process.argv.slice(2));
  if (parsed.help) {
    showHelp();
    return 0;
  }
  if (parsed.version) {
    const root = SecureDir.open(SOCKET_ROOT, { create: true, mode: 0o700 });
    const native = new NativeRuntime(root);
    try {
      native.ensureRevision();
      process.stdout.write(`${native.version}\n`);
      return 0;
    } finally {
      native.close();
      root.close();
    }
  }
  if (parsed.command === "doctor") return runDoctor(parsed);

  if (parsed.command === "close") {
    const root = SecureDir.open(SOCKET_ROOT, { create: false, mode: 0o700 });
    if (!root) return 0;
    try {
      return handleClose(root, parsed, loadBinding(root, parsed.session));
    } finally {
      root.close();
    }
  }

  const root = SecureDir.open(SOCKET_ROOT, { create: true, mode: 0o700 });
  try {
    if (parsed.command === "session")
      return handleSessionList(root, parsed, loadBinding(root, parsed.session));
    return handleBrowserAction(root, parsed, loadBinding(root, parsed.session));
  } finally {
    root.close();
  }
}

let parsedJsonOutput = false;
try {
  const args = process.argv.slice(2);
  parsedJsonOutput =
    args.includes("--json") && !args.some((arg) => arg.startsWith("--json="));
  const status = main();
  process.exit(status);
} catch (error) {
  const code = error instanceof WrapperError ? error.code : EX_SOFTWARE;
  const message =
    error instanceof WrapperError
      ? error.message
      : sanitize(error?.message || "unexpected wrapper failure");
  if (parsedJsonOutput) {
    process.stdout.write(
      `${JSON.stringify({ success: false, data: null, error: message })}\n`,
    );
  } else {
    process.stderr.write(`agent-browser: ${message}\n`);
  }
  process.exit(code);
}
