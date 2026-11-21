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
import { basename, dirname, isAbsolute, join } from "node:path";

const EX_USAGE = 64;
const EX_DATAERR = 65;
const EX_UNAVAILABLE = 69;
const EX_SOFTWARE = 70;
const SOCKET_ROOT = "/tmp/agent-browser-raw";
const FIXED_CONTROLLER_BIN = "/home/cabule/.ai-controller/bin/browser-runtime";
// WHY: this authenticates the launcher bytes, not the Python implementation
// that launcher pins. A launcher change must update this pin and its exact
// binding guard before installation; otherwise every real action fails closed.
const FIXED_CONTROLLER_SHA256 =
  "b9bf2c8cae6a1cc4b4a68851125c533e7250e1aad86c098be00763f607f065d0";
const FIXED_CONTROLLER_STATE_ROOT = "";
const ACCEPTED_TRANSPORT_HELPER_REVISIONS = Object.freeze([
  "agent-browser.transport-proof-helper.wsl-stable.v2",
  "agent-browser.transport-proof-helper.wsl-stable.v3",
]);
const EXPECTED_NATIVE_MANIFEST_SHA256 =
  "e04a9d1a92b1b00325f3483673bf860a15d0be8efe634164e3583ba56890a915";
const EXPECTED_NATIVE_SHA256 =
  "a34421a9f7c3e498ce30f6dec4780e53488de5e01f330f2f2abcf8e79a6955f4";
const EXPECTED_NATIVE_EXECUTION = "elf";
const EXPECTED_POPUP_CLIENT_SHA256 =
  "1fecbc748983b2eba152897650e27c720aac3fb72bf6c9098aebeab2bd5d7468";
const EXPECTED_REBIND_CLIENT_SHA256 =
  "c8671fbc24dacf084e264c7b03a883990e46740fc9332b99f27531d242274e7d";
const EXPECTED_CANONICAL_DIST_SCHEMA = "agent-browser-canonical-dist.v1";
const EXPECTED_CANONICAL_DIST_SHA256 =
  "968a4f83d8001c74c66b79d48dc344efa2bcb08db84a0a3942e54a880aa7a88d";
const EXPECTED_CANONICAL_GRAPH_SHA256 =
  "787b124112d6cc638a0c5417dcf1c5d3f66de20cdbc67d92e69551a013a7aff6";
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
const WARM_BROWSER_ATTESTATION_SCHEMA =
  "agent-browser.supported-warm-transport-attestation.v1";
const WARM_BROWSER_RECONCILIATION_SCHEMA =
  "agent-browser.supported-warm-transport-reconciliation.v1";
const WARM_BROWSER_ATTESTATION_MAX_AGE_MS = 5_000;
const TARGET_RECEIPT_SCHEMA = "agent-browser.target-lease.v2";
const TARGET_CLAIM_ENVELOPE_SCHEMA = "agent-browser.target-claim-envelope.v3";
const TARGET_METADATA_SCHEMA = "agent-browser.target-receipt-metadata.v2";
const TASK_LEASE_SCHEMA = "agent-browser.task-lease.v7";
const LEGACY_OWNERLESS_TASK_LEASE_SCHEMA = "agent-browser.task-lease.v6";
const SESSION_RELEASE_SCHEMA = "agent-browser.session-release-result.v3";
const TASK_ROOT_RELEASE_SCHEMA = "agent-browser.task-root-release-result.v2";
const TARGET_LEASE_ABORT_SCHEMA = "agent-browser.target-lease-abort-result.v1";
const ANCHOR_RETIREMENT_RESULT_SCHEMA =
  "agent-browser.anchor-retirement-result.v1";
const SESSION_TRANSPORT_RENEWAL_SCHEMA =
  "agent-browser.session-transport-renewal.v1";
const DAEMON_TRANSPORT_REBIND_REQUEST_SCHEMA =
  "agent-browser.daemon-transport-rebind-request.v1";
const DAEMON_TRANSPORT_REBIND_RESULT_SCHEMA =
  "agent-browser.daemon-transport-rebind-result.v1";
const DAEMON_TRANSPORT_REBIND_CAPABILITIES =
  "click-expect-popup-v1,transport-rebind-v1,session-inventory-v1";
const WORKSPACE_ENSURE_SCHEMA = "agent-browser.workspace-ensure-result.v1";
const TASK_ROOT_TARGET_KIND = "agent-task-root";
const TASK_ROOT_LEASE_KIND = "task-root";
const BROKER_HEALTH_SCHEMA = "agent-browser.cdp-broker-health.v1";
const BROKER_HEALTH_LIMIT_KEYS = Object.freeze([
  "maxClients",
  "maxTaskClients",
  "maxControllerClients",
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
// A broker task lease is bounded to one hour. Renew its transport authorization
// before a worst-case native action can cross that boundary. The exact daemon
// and controller-created task root stay live; only transport-bound authority
// may rotate, and a browser-generation change fails closed.
const BROKER_CAPABILITY_REACQUIRE_MARGIN_MS = 3 * 60 * 1000;
const MAX_FILE_BYTES = 64 * 1024;
const NATIVE_RECEIPT_PUBLICATION_SETTLE_MS = 250;
const EXACT_EXPIRED_RELEASE_HEALTH_DRIFT =
  "broker_reconnect_blocked; Broker authenticated health identity changed";

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
const rebindClientPath = join(
  repoRoot,
  "scripts",
  "agent-browser-daemon-rebind.js",
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

export function validateAnchorDisposition(
  value,
  expectedAnchorTargetId,
  expectedAccount = "",
  expectedProfileBinding = "",
  expectedBrowserGeneration = "",
) {
  const countFields = [
    "taskLeaseCount",
    "legacyLeaseCount",
    "adoptionReservationCount",
    "creationJournalCount",
  ];
  if (
    !exactKeys(value, [
      "schema",
      "status",
      "account",
      "anchorTargetId",
      "profileBinding",
      "browserGeneration",
      "consumerRecordCount",
      ...countFields,
      "anchorRetired",
      "registrationRetired",
      "profileBindingReceiptRetired",
      "userTargetsPreserved",
      "focusPreserved",
      "brokerPreserved",
    ]) ||
    value.schema !== ANCHOR_RETIREMENT_RESULT_SCHEMA ||
    !["retired-last-consumer", "preserved-active-consumers"].includes(
      value.status,
    ) ||
    !/^(?:caleb|erebora|profile-[0-9a-f]{64})$/.test(value.account) ||
    (expectedAccount && value.account !== expectedAccount) ||
    typeof value.anchorTargetId !== "string" ||
    !value.anchorTargetId ||
    value.anchorTargetId.length > 160 ||
    (expectedAnchorTargetId &&
      value.anchorTargetId !== expectedAnchorTargetId) ||
    !/^[0-9a-f]{64}$/.test(value.profileBinding) ||
    (expectedProfileBinding &&
      value.profileBinding !== expectedProfileBinding) ||
    !/^[0-9a-f]{64}$/.test(value.browserGeneration) ||
    (expectedBrowserGeneration &&
      value.browserGeneration !== expectedBrowserGeneration) ||
    !Number.isSafeInteger(value.consumerRecordCount) ||
    value.consumerRecordCount < 0 ||
    value.consumerRecordCount > 4 * 256 ||
    countFields.some(
      (field) =>
        !Number.isSafeInteger(value[field]) ||
        value[field] < 0 ||
        value[field] > 256,
    ) ||
    countFields.reduce((sum, field) => sum + value[field], 0) !==
      value.consumerRecordCount ||
    value.userTargetsPreserved !== true ||
    value.focusPreserved !== true ||
    value.brokerPreserved !== true
  ) {
    fail("controller returned an invalid anchor disposition", EX_DATAERR);
  }
  const retired = value.status === "retired-last-consumer";
  if (
    (retired && value.consumerRecordCount !== 0) ||
    (!retired && value.consumerRecordCount === 0) ||
    value.anchorRetired !== retired ||
    value.registrationRetired !== retired ||
    value.profileBindingReceiptRetired !== retired
  ) {
    fail("controller returned an incoherent anchor disposition", EX_DATAERR);
  }
  return value;
}

export function validateReleaseAnchorDisposition(
  value,
  targetKind,
  expectedAnchorTargetId,
  expectedAccount = "",
  expectedProfileBinding = "",
  expectedBrowserGeneration = "",
) {
  if (
    targetKind === TASK_ROOT_TARGET_KIND ||
    targetKind === "agent-workspace"
  ) {
    return validateAnchorDisposition(
      value,
      expectedAnchorTargetId,
      expectedAccount,
      expectedProfileBinding,
      expectedBrowserGeneration,
    );
  }
  if (targetKind === "user-collaboration" && value === null) return null;
  fail("controller returned an invalid release anchor disposition", EX_DATAERR);
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

  openFile(
    name,
    maxBytes,
    mode = 0o600,
    {
      allowMissing = false,
      settleNativeReceiptPublication = false,
    } = {},
  ) {
    const path = this.entryPath(name);
    let fd;
    try {
      fd = openSync(
        path,
        constants.O_RDONLY |
          (constants.O_CLOEXEC ?? 0) |
          (constants.O_NOFOLLOW ?? 0),
      );
      let info = fstatSync(fd, { bigint: true });
      if (
        settleNativeReceiptPublication &&
        name === "native-revision.receipt" &&
        info.nlink === 2n
      ) {
        // WHY: exclusive publication links the fully fsynced temporary inode
        // to its final name before removing the temporary link. A simultaneous
        // safe first-use reader can therefore observe exactly two links for a
        // few milliseconds. Wait only on this non-authority cache receipt and
        // only while the already-open inode remains exact; never weaken the
        // one-link rule for leases, credentials, or any other state file.
        const expectedDev = info.dev;
        const expectedIno = info.ino;
        const deadline = Date.now() + NATIVE_RECEIPT_PUBLICATION_SETTLE_MS;
        while (info.nlink === 2n && Date.now() < deadline) {
          sleepSync(2);
          info = fstatSync(fd, { bigint: true });
          if (info.dev !== expectedDev || info.ino !== expectedIno) {
            fail("native revision receipt inode changed during publication", EX_SOFTWARE);
          }
        }
        let published;
        try {
          published = lstatSync(path, { bigint: true });
        } catch {
          fail("native revision receipt changed during publication", EX_SOFTWARE);
        }
        if (
          info.nlink !== 1n ||
          !published.isFile() ||
          published.dev !== expectedDev ||
          published.ino !== expectedIno ||
          published.nlink !== 1n
        ) {
          fail("native revision receipt publication did not settle exactly", EX_SOFTWARE);
        }
      }
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

  replaceOwned(name, expectedRaw, value) {
    const raw = Buffer.isBuffer(value) ? value : Buffer.from(String(value));
    if (
      !Buffer.isBuffer(expectedRaw) ||
      expectedRaw.length === 0 ||
      raw.length === 0 ||
      raw.length > MAX_FILE_BYTES
    ) {
      fail("secure state replacement payload is invalid", EX_SOFTWARE);
    }
    const current = this.openFile(name, MAX_FILE_BYTES, 0o600, {
      allowMissing: true,
    });
    if (!current || !current.raw.equals(expectedRaw)) {
      closeOpened(current);
      fail("secure state changed before replacement", EX_SOFTWARE);
    }
    closeOpened(current);

    const tempName = `.tmp-${process.pid}-${randomBytes(12).toString("hex")}`;
    const tempPath = this.entryPath(tempName);
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
        fail("secure state replacement is unsafe", EX_SOFTWARE);
      }
      closeSync(fd);
      fd = undefined;
      const unchanged = this.openFile(name, MAX_FILE_BYTES, 0o600, {
        allowMissing: true,
      });
      if (!unchanged || !unchanged.raw.equals(expectedRaw)) {
        closeOpened(unchanged);
        fail("secure state changed during replacement", EX_SOFTWARE);
      }
      closeOpened(unchanged);
      renameSync(tempPath, this.entryPath(name));
      fsyncSync(this.fd);
    } catch (error) {
      if (fd !== undefined) closeSync(fd);
      try {
        unlinkSync(tempPath);
      } catch {}
      if (error instanceof WrapperError) throw error;
      fail("secure state replacement failed", EX_UNAVAILABLE);
    }
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
  agent-browser [--account ALIAS|PROFILE_DIRECTORY|EMAIL] --session TASK open URL
  agent-browser [--account ALIAS|PROFILE_DIRECTORY|EMAIL] --session TASK --current-tab snapshot
  agent-browser --session TASK --target-lease CONTROLLER_PATH open URL
  agent-browser --session TASK snapshot -i --compact
  agent-browser --session TASK click SELECTOR --expect-popup
  agent-browser --session TASK foreground --input-boundary KIND
  agent-browser --session TASK background
  agent-browser --session TASK close|doctor

Only explicit nonempty sessions and HTTP(S) navigation are accepted. Caleb is
the default; Erebora or another exact existing Stable profile must be selected
explicitly. A cold ordinary session asks
the controller for a distinct registered task root. An existing user tab is
accepted only through an explicit exact --target-lease or the cold-bootstrap
--current-tab invitation. The controller, not this wrapper, selects and leases
the unique foreground tab in the exact profile context without activating it.
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
  "recover-metamask-vault",
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

const HUMAN_INPUT_BOUNDARIES = new Set([
  "password",
  "two-factor",
  "hardware-key",
  "captcha",
  "file-picker",
  "recovery",
  "account-authority",
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
  let currentTab = false;
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
      if (/^--(?:session|account|target-lease|current-tab|json)=/.test(arg)) {
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
        case "--current-tab":
          if (currentTab) fail("duplicate --current-tab", EX_USAGE);
          currentTab = true;
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
    if (
      !literal &&
      /^--(?:session|account|target-lease|current-tab)(?:=|$)/.test(arg)
    ) {
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
  if (account) validateAccountSelector(account);
  if (["connect", "install"].includes(command)) {
    fail(
      `${command} is disabled on the authenticated persistent profile route`,
      EX_USAGE,
    );
  }
  if (command === "recover-metamask-vault") {
    // WHY: wallet recovery is one controller-owned action with no caller-
    // selectable profile, target, extension, or payload path. The exact Caleb
    // workspace and MetaMask origin are proven again inside the controller;
    // the wrapper contributes only its canonical socket environment and the
    // caller's already-open private stdin descriptor.
    if (
      session !== "metamask-recovery" ||
      (account && !isCalebAccountAlias(account)) ||
      targetLease ||
      currentTab ||
      !json ||
      nativeGlobals.length > 0 ||
      expectPopup ||
      commandArgs.length !== 2 ||
      commandArgs[0] !== "--expected-sha256" ||
      !/^[0-9a-f]{64}$/.test(commandArgs[1])
    ) {
      fail(
        "recover-metamask-vault requires Caleb session 'metamask-recovery', --json, and one lowercase --expected-sha256 digest; payload bytes must arrive only on stdin",
        EX_USAGE,
      );
    }
  }
  if (
    command === "background" &&
    (commandArgs.length > 0 || nativeGlobals.length > 0)
  ) {
    fail("background accepts no browser action arguments", EX_USAGE);
  }
  if (command === "foreground") {
    // WHY: navigation, screenshots, automated clicks, popups, and storage work
    // are background-safe. Requiring a narrow user-only boundary makes focus
    // acquisition an explicit exception instead of an easy accidental screen
    // takeover. The controller still binds the exact HWND/tab and restores the
    // previous workspace on background/close.
    if (
      nativeGlobals.length > 0 ||
      commandArgs.length !== 2 ||
      commandArgs[0] !== "--input-boundary" ||
      !HUMAN_INPUT_BOUNDARIES.has(commandArgs[1])
    ) {
      fail(
        "foreground requires --input-boundary password|two-factor|hardware-key|captcha|file-picker|recovery|account-authority after the exact pending user-only input is observed",
        EX_USAGE,
      );
    }
  }
  if (
    targetLease &&
    ["close", "session", "doctor", "foreground", "background"].includes(command)
  ) {
    fail("--target-lease is not valid for lifecycle commands", EX_USAGE);
  }
  if (
    currentTab &&
    ["close", "session", "doctor", "foreground", "background"].includes(
      command,
    )
  ) {
    fail("--current-tab is valid only for cold-bootstrap browser actions", EX_USAGE);
  }
  if (currentTab && targetLease) {
    fail("--current-tab cannot be combined with --target-lease", EX_USAGE);
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
  if (expectPopup && currentTab) {
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
    account,
    session,
    targetLease,
    targetLeaseSupplied: Boolean(targetLease),
    currentTab,
    json,
    command,
    commandArgs,
    nativeGlobals,
    expectPopup,
  };
}

function validateAccountSelector(value) {
  const selector = String(value);
  if (
    selector !== selector.trim() ||
    Buffer.byteLength(selector, "utf8") > 320 ||
    /[\u0000-\u001f\u007f]/.test(selector)
  ) {
    fail("--account must be one bounded exact Stable profile selector", EX_USAGE);
  }
  return selector;
}

function isCalebAccountAlias(value) {
  return [
    "caleb",
    "default",
    "calebdanemusic",
    "calebdanemusic@gmail.com",
  ].includes(String(value).toLowerCase());
}

const accountIdentityCache = new Map();

function accountIdentity(selector = "") {
  const exactSelector = validateAccountSelector(selector);
  if (accountIdentityCache.has(exactSelector)) {
    return accountIdentityCache.get(exactSelector);
  }
  const args = ["resolve-stable-profile"];
  if (exactSelector) args.push("--account", exactSelector);
  args.push("--json");
  const data = parseControllerJsonLine(
    runController(args),
    "controller Stable profile selection",
    "PROFILE_SELECTION_FAILED; pinned controller did not resolve one exact existing Stable profile",
  ).data;
  if (
    !exactKeys(data, [
      "schema",
      "ok",
      "status",
      "account",
      "profileDirectory",
      "profileEmail",
      "selectorKind",
    ]) ||
    data.schema !== "agent-browser.stable-profile-selection.v1" ||
    data.ok !== true ||
    data.status !== "resolved" ||
    !/^(?:caleb|erebora|profile-[0-9a-f]{64})$/.test(data.account) ||
    typeof data.profileDirectory !== "string" ||
    !data.profileDirectory ||
    Buffer.byteLength(data.profileDirectory, "utf8") > 128 ||
    [".", ".."].includes(data.profileDirectory) ||
    /[\\/\u0000-\u001f\u007f]/.test(data.profileDirectory) ||
    typeof data.profileEmail !== "string" ||
    data.profileEmail !== data.profileEmail.trim().toLowerCase() ||
    Buffer.byteLength(data.profileEmail, "utf8") > 254 ||
    (data.profileEmail !== "" && !/^[^\s@]+@[^\s@]+$/.test(data.profileEmail)) ||
    !/^(?:default|alias|directory|email|account-key)(?:\+(?:directory|email|account-key))*$/.test(
      data.selectorKind,
    )
  ) {
    fail("controller returned an invalid Stable profile selection", EX_DATAERR);
  }
  const identity = {
    account: data.account,
    email: data.profileEmail,
    profile: data.profileDirectory,
  };
  accountIdentityCache.set(exactSelector, identity);
  accountIdentityCache.set(identity.account, identity);
  return identity;
}

function accountIdentityForBinding(binding) {
  const identity = accountIdentity(binding.account);
  if (identity.profile !== binding.profile) {
    fail("session account binding no longer matches Stable Local State", EX_DATAERR);
  }
  return identity;
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

function controllerEndpointPort(endpointId) {
  const match = /^([1-9][0-9]{0,4})-[0-9a-f]{20}$/.exec(endpointId);
  const port = match ? Number(match[1]) : 0;
  if (
    !Number.isSafeInteger(port) ||
    port < 1 ||
    port > 65535 ||
    endpointId !== expectedControllerEndpointId(port)
  ) {
    fail("controller endpoint identity is invalid", EX_DATAERR);
  }
  return port;
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
      "configuredClientLeasesSha256",
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
    !/^[0-9a-f]{64}$/.test(data.configuredClientLeasesSha256) ||
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

function openTrustedSnapshotOnce(
  path,
  expectedHash,
  controllerEndpointId,
  supportedChromePort,
) {
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
    data.chrome.listener.port !== supportedChromePort ||
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
    data.portproxy.listen.port !== supportedChromePort ||
    data.portproxy.connect.address !== "127.0.0.1" ||
    data.portproxy.connect.port !== supportedChromePort ||
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
    data.socat.listen.port !== supportedChromePort ||
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
  Object.defineProperties(data, {
    trustedProofSha256: { value: expectedHash, enumerable: false },
    trustedProofObservedAtMs: {
      value: data.observedAtMs,
      enumerable: false,
    },
  });
  return data;
}

function currentTrustedProofBinding(
  controllerEndpointId,
  supportedChromePort,
) {
  const profileAttestationRoot = join(
    productionControllerStateRoot(),
    "endpoints",
    controllerEndpointId,
    "profile-attestation",
  );
  const proofPath = join(
    profileAttestationRoot,
    "transport-proof-state.v1.json",
  );
  const opened = openStaticFile(
    join(profileAttestationRoot, "stable-chrome.v2.json"),
    16 * 1024,
    0o600,
  );
  const data = parseJson(opened.raw, "current Stable profile attestation");
  closeOpened(opened);
  if (
    !exactKeys(data, [
      "schema",
      "profile_kind",
      "profile_root",
      "cdp_http_url",
      "browser_generation",
      "broker_generation",
      "consent_generation",
      "transport_generation",
      "transport_proof_state_path",
      "transport_proof_state_sha256",
      "helper_revision",
      "issued_at",
      "expires_at",
      "browser_ownership",
    ]) ||
    data.schema !== "agent-browser.profile-attestation.v2" ||
    data.profile_kind !== "windows-stable" ||
    data.profile_root !==
      "C:\\Users\\Kaleeb\\AppData\\Local\\Google\\Chrome\\User Data" ||
    data.cdp_http_url !== `http://127.0.0.1:${supportedChromePort}` ||
    data.transport_proof_state_path !== proofPath ||
    ![
      data.browser_generation,
      data.broker_generation,
      data.consent_generation,
      data.transport_generation,
      data.transport_proof_state_sha256,
    ].every((value) => /^[0-9a-f]{64}$/.test(value)) ||
    !ACCEPTED_TRANSPORT_HELPER_REVISIONS.includes(data.helper_revision) ||
    data.browser_ownership !== "external-user-stable"
  ) {
    fail(
      "NEEDS_TRANSPORT_PROCESS_PROOF; current controller proof binding is invalid",
      EX_DATAERR,
    );
  }
  const issuedAtMs = parseUtcRfc3339(
    data.issued_at,
    "current Stable profile attestation issued_at",
  );
  const expiresAtMs = parseUtcRfc3339(
    data.expires_at,
    "current Stable profile attestation expires_at",
  );
  const now = Date.now();
  if (
    issuedAtMs > now + 1000 ||
    expiresAtMs <= now ||
    expiresAtMs <= issuedAtMs ||
    expiresAtMs - issuedAtMs > 120_000
  ) {
    fail(
      "NEEDS_TRANSPORT_PROCESS_PROOF; current controller proof binding is stale",
      EX_UNAVAILABLE,
    );
  }
  return {
    path: proofPath,
    sha256: data.transport_proof_state_sha256,
    observedAtMs: issuedAtMs,
  };
}

function openTrustedSnapshot(
  path,
  expectedHash,
  controllerEndpointId,
  supportedChromePort,
  expectedObservedAtMs,
) {
  let selectedPath = path;
  let selectedHash = expectedHash;
  let minimumObservedAtMs =
    Number.isSafeInteger(expectedObservedAtMs) && expectedObservedAtMs > 0
      ? expectedObservedAtMs
      : 0;
  // WHY: proof and attestation are two independently atomic names. Another
  // cold session can publish the same four-owner generation after a pinned
  // controller response but before this process opens its proof. Select only
  // a coherent exact current pair, monotonically and with a hard attempt cap;
  // arbitrary hashes, changed owners, stale state, and unbounded retries stay
  // rejected by this function and its caller's full identity comparison.
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      const snapshot = openTrustedSnapshotOnce(
        selectedPath,
        selectedHash,
        controllerEndpointId,
        supportedChromePort,
      );
      if (snapshot.observedAtMs < minimumObservedAtMs) {
        fail(
          "NEEDS_TRANSPORT_PROCESS_PROOF; controller proof observation regressed",
          EX_DATAERR,
        );
      }
      return snapshot;
    } catch (error) {
      if (
        !(error instanceof WrapperError) ||
        error.code !== EX_DATAERR ||
        error.message !==
          "NEEDS_TRANSPORT_PROCESS_PROOF; trusted controller proof hash mismatched" ||
        attempt === 3
      ) {
        throw error;
      }
      const current = currentTrustedProofBinding(
        controllerEndpointId,
        supportedChromePort,
      );
      if (
        minimumObservedAtMs <= 0 ||
        current.observedAtMs <= minimumObservedAtMs
      ) {
        throw error;
      }
      minimumObservedAtMs = Math.max(
        minimumObservedAtMs,
        current.observedAtMs,
      );
      selectedPath = current.path;
      selectedHash = current.sha256;
    }
  }
  fail(
    "NEEDS_TRANSPORT_PROCESS_PROOF; controller proof publication did not stabilize",
    EX_UNAVAILABLE,
  );
}

function trustedSnapshotMatchesControllerPublication(
  snapshot,
  expectedHash,
  expectedObservedAtMs,
) {
  return snapshot.trustedProofSha256 === expectedHash
    ? snapshot.observedAtMs === expectedObservedAtMs
    : snapshot.observedAtMs > expectedObservedAtMs;
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

function parseMetaMaskRecoveryControllerResult(result) {
  const canonicalLine = (value) =>
    typeof value === "string" &&
    value.length > 0 &&
    Buffer.byteLength(value) <= 2 * 1024 &&
    value.endsWith("\n") &&
    !value.slice(0, -1).includes("\n");
  const success =
    result.status === 0 &&
    !result.signal &&
    result.stderr === "" &&
    canonicalLine(result.stdout);
  const failure =
    result.status === 1 &&
    !result.signal &&
    result.stdout === "" &&
    canonicalLine(result.stderr);
  if (!success && !failure) {
    fail(
      "METAMASK_RECOVERY_FAILURE; pinned controller did not return one bounded canonical result",
      EX_UNAVAILABLE,
    );
  }
  const raw = success ? result.stdout : result.stderr;
  let data;
  try {
    data = JSON.parse(raw.slice(0, -1));
  } catch {
    fail(
      "METAMASK_RECOVERY_FAILURE; pinned controller returned invalid JSON",
      EX_UNAVAILABLE,
    );
  }
  const allowed = new Set([
    "ok",
    "status",
    "noWrite",
    "vaultPresent",
    "defaultWorldProof",
    "protectedStorageMatchesPreflight",
    "rollbackPerformed",
    "rollbackCompareMatched",
    "cleanupComplete",
  ]);
  const safeSuccessStatuses = new Set([
    "already_initialized",
    "vault_restored_locked",
  ]);
  if (
    !data ||
    typeof data !== "object" ||
    Array.isArray(data) ||
    Object.keys(data).some((key) => !allowed.has(key)) ||
    typeof data.ok !== "boolean" ||
    typeof data.status !== "string" ||
    !/^[A-Za-z0-9._-]{1,80}$/.test(data.status) ||
    Object.entries(data).some(
      ([key, value]) =>
        key !== "status" && key !== "ok" && typeof value !== "boolean",
    ) ||
    data.ok !== success ||
    (data.ok === true) !== safeSuccessStatuses.has(data.status) ||
    raw !== canonicalJson(data) + "\n"
  ) {
    fail(
      "METAMASK_RECOVERY_FAILURE; pinned controller result was not the safe recovery schema",
      EX_UNAVAILABLE,
    );
  }
  return data;
}

const WARM_TRANSPORT_ATTESTATION_KEYS = Object.freeze([
  "schema",
  "ok",
  "status",
  "session",
  "account",
  "profileDirectory",
  "profileEmail",
  "anchorTargetId",
  "targetId",
  "targetKind",
  "browserContextId",
  "profileBinding",
  "receiptNonce",
  "controllerEndpointId",
  "browserGeneration",
  "brokerGeneration",
  "consentGeneration",
  "transportGeneration",
  "brokerCdpWebSocketUrl",
  "brokerHealthUrl",
  "brokerProducerContractPath",
  "brokerProducerContractSha256",
  "brokerOwnerReceiptPath",
  "brokerOwnerReceiptSha256",
  "brokerValidationReceiptPath",
  "brokerValidationReceiptSha256",
  "brokerUpstreamAuthorityPath",
  "brokerUpstreamAuthoritySha256",
  "brokerAuthorizationLeaseId",
  "brokerAuthorizationPath",
  "brokerAuthorizationSha256",
  "brokerCapabilityExpiresAt",
  "upstreamExpiresAtMs",
  "validatedAtMs",
]);

function warmTransportAuthorityFromData(
  data,
  raw,
  session,
  lease,
  {
    schema = WARM_BROWSER_ATTESTATION_SCHEMA,
    status = "warm-attested",
    extraKeys = [],
  } = {},
) {
  if (
    !data ||
    typeof data !== "object" ||
    Array.isArray(data) ||
    !exactKeys(data, [...WARM_TRANSPORT_ATTESTATION_KEYS, ...extraKeys]) ||
    data.schema !== schema ||
    data.ok !== true ||
    data.status !== status ||
    !/^(?:caleb|erebora|profile-[0-9a-f]{64})$/.test(data.account) ||
    typeof data.profileDirectory !== "string" ||
    !data.profileDirectory ||
    Buffer.byteLength(data.profileDirectory, "utf8") > 128 ||
    [".", ".."].includes(data.profileDirectory) ||
    /[\\/\u0000-\u001f\u007f]/.test(data.profileDirectory) ||
    typeof data.profileEmail !== "string" ||
    data.profileEmail !== data.profileEmail.trim().toLowerCase() ||
    Buffer.byteLength(data.profileEmail, "utf8") > 254 ||
    (data.profileEmail !== "" && !/^[^\s@]+@[^\s@]+$/.test(data.profileEmail)) ||
    !validControllerTargetId(data.anchorTargetId) ||
    !validControllerTargetId(data.targetId) ||
    !validControllerTargetId(data.browserContextId)
  ) {
    return null;
  }
  const digestFields = [
    data.profileBinding,
    data.receiptNonce,
    data.browserGeneration,
    data.brokerGeneration,
    data.consentGeneration,
    data.transportGeneration,
    data.brokerProducerContractSha256,
    data.brokerOwnerReceiptSha256,
    data.brokerValidationReceiptSha256,
    data.brokerUpstreamAuthoritySha256,
    data.brokerAuthorizationLeaseId,
    data.brokerAuthorizationSha256,
  ];
  if (!digestFields.every((value) => /^[0-9a-f]{64}$/.test(value))) {
    return null;
  }
  const supportedChromePort = controllerEndpointPort(
    data.controllerEndpointId,
  );
  const endpointRoot = join(
    productionControllerStateRoot(),
    "endpoints",
    data.controllerEndpointId,
  );
  const brokerRoot = join(endpointRoot, "broker-authority");
  const now = Date.now();
  const capabilityExpiresAtMs = canonicalRfc3339Milliseconds(
    data.brokerCapabilityExpiresAt,
  );
  if (
    data.session === session &&
    data.account === lease.data.account &&
    data.profileDirectory === lease.data.profile &&
    data.anchorTargetId === lease.data.anchorTargetId &&
    data.targetId === lease.data.targetId &&
    data.receiptNonce === lease.data.receiptNonce &&
    data.browserGeneration !== lease.data.browserGeneration
  ) {
    fail(
      "BROWSER_GENERATION_CHANGED; the exact task root cannot cross a browser restart",
      EX_UNAVAILABLE,
    );
  }
  if (
    data.session !== session ||
    data.account !== lease.data.account ||
    data.profileDirectory !== lease.data.profile ||
    data.anchorTargetId !== lease.data.anchorTargetId ||
    data.targetId !== lease.data.targetId ||
    data.targetKind !== lease.data.targetKind ||
    data.browserContextId !== lease.data.browserContextId ||
    data.profileBinding !== lease.data.profileBinding ||
    data.receiptNonce !== lease.data.receiptNonce ||
    data.controllerEndpointId !== lease.data.controllerEndpointId ||
    data.browserGeneration !== lease.data.browserGeneration ||
    data.brokerGeneration !== lease.data.brokerGeneration ||
    data.transportGeneration !== lease.data.transportGeneration ||
    data.brokerAuthorizationLeaseId !==
      lease.data.brokerAuthorizationLeaseId ||
    data.brokerAuthorizationPath !== lease.data.brokerAuthorizationPath ||
    data.brokerAuthorizationSha256 !==
      lease.data.brokerAuthorizationSha256 ||
    data.brokerCapabilityExpiresAt !==
      lease.data.brokerCapabilityExpiresAt ||
    data.brokerAuthorizationPath !==
      expectedBrokerAuthorizationPath(
        data.controllerEndpointId,
        data.brokerAuthorizationLeaseId,
      ) ||
    data.brokerProducerContractPath !==
      join(brokerRoot, "producer-contract.json") ||
    data.brokerOwnerReceiptPath !==
      join(brokerRoot, "controller-broker-owner.json") ||
    data.brokerValidationReceiptPath !==
      join(brokerRoot, "producer-validation.json") ||
    data.brokerUpstreamAuthorityPath !==
      join(brokerRoot, "upstream-authority.json") ||
    capabilityExpiresAtMs === null ||
    capabilityExpiresAtMs <= now ||
    !Number.isSafeInteger(data.upstreamExpiresAtMs) ||
    data.upstreamExpiresAtMs <= now ||
    !Number.isSafeInteger(data.validatedAtMs) ||
    data.validatedAtMs > now + 1_000 ||
    data.validatedAtMs < now - WARM_BROWSER_ATTESTATION_MAX_AGE_MS
  ) {
    return null;
  }
  const broker = parseBrokerRoutes(data);
  const expiresMs = Math.min(
    data.validatedAtMs + WARM_BROWSER_ATTESTATION_MAX_AGE_MS,
    capabilityExpiresAtMs,
    data.upstreamExpiresAtMs,
  );
  if (expiresMs <= now) return null;
  const normalizedData = {
    ...data,
    controller_endpoint_id: data.controllerEndpointId,
    broker_generation: data.brokerGeneration,
    consent_generation: data.consentGeneration,
  };
  return {
    data: normalizedData,
    attestation: data,
    profileIdentity: {
      account: data.account,
      email: data.profileEmail,
      profile: data.profileDirectory,
    },
    snapshot: null,
    webSocketUrl: broker.webSocketUrl,
    healthUrl: broker.healthUrl,
    port: broker.port,
    upstreamPort: supportedChromePort,
    browserGeneration: data.browserGeneration,
    transportGeneration: data.transportGeneration,
    authorization: null,
    authorizationBinding: null,
    health: null,
    issuedMs: data.validatedAtMs,
    expiresMs,
    rawHash: sha256(raw),
    warm: true,
  };
}

function tryLoadWarmTransportAuthority(session, lease) {
  if (!session || !lease?.data) return null;
  try {
    const response = parseControllerJsonLine(
      runController([
        "attest-supported-warm-transport",
        "--broker-source-path",
        brokerSourcePath,
        "--session",
        session,
        "--controller-endpoint-id",
        lease.data.controllerEndpointId,
        "--json",
      ]),
      "controller warm transport attestation",
      "TRANSPORT_FAILURE; pinned controller did not return a canonical warm attestation",
      true,
    );
    if (response.controllerFailure) return null;
    return warmTransportAuthorityFromData(
      response.data,
      response.raw,
      session,
      lease,
    );
  } catch (error) {
    if (
      error instanceof WrapperError &&
      error.message.startsWith("BROWSER_GENERATION_CHANGED;")
    ) {
      throw error;
    }
    // Warm evidence never broadens authority. Any malformed, stale, or
    // unavailable local proof falls through to the existing full ensure.
    return null;
  }
}

function transportAuthorityFromControllerResult(
  controllerResult,
  label = "controller transport attestation",
  failure =
    "TRANSPORT_FAILURE; pinned controller did not return a canonical attestation",
  allowControllerFailure = false,
) {
  const response = parseControllerJsonLine(
    controllerResult,
    label,
    failure,
    allowControllerFailure,
  );
  if (response.controllerFailure) return null;
  let data = response.data;
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
    "transportProofIdentitySha256",
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
      data.transportProofIdentitySha256,
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
  // Chrome's supported existing-profile mode owns a dynamic DevToolsActivePort.
  // The endpoint ID cryptographically binds that exact port; hard-coding 9222
  // rejects the genuine controller after Chrome has already approved the one
  // broker and can strand a fresh prompt. Derive the port only from the exact
  // endpoint identity, then require every attested Chrome/portproxy/socat owner
  // and later target receipt to agree with it.
  const supportedChromePort = controllerEndpointPort(data.controllerEndpointId);
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
    supportedChromePort,
    data.transportProofObservedAtMs,
  );
  if (
    !trustedSnapshotMatchesControllerPublication(
      snapshot,
      data.transportProofStateSha256,
      data.transportProofObservedAtMs,
    ) ||
    !ACCEPTED_TRANSPORT_HELPER_REVISIONS.includes(snapshot.helperRevision) ||
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
      "C:\\Users\\Kaleeb\\AppData\\Local\\Google\\Chrome\\User Data" ||
    transportProofIdentitySha256(snapshot) !==
      data.transportProofIdentitySha256
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
  data = {
    ...data,
    transportProofStateSha256: snapshot.trustedProofSha256,
    transportProofObservedAtMs: snapshot.observedAtMs,
  };
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
    upstreamPort: supportedChromePort,
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

function tryLoadCachedTransportAuthority(timeoutOverrideMs = null) {
  try {
    return transportAuthorityFromControllerResult(
      runController(
        ["attest-supported-existing-transport", "--json"],
        timeoutOverrideMs,
      ),
      "controller cached transport attestation",
      "TRANSPORT_FAILURE; pinned controller did not return a canonical cached attestation",
      true,
    );
  } catch {
    // Cached evidence authorizes no mutation.  Timeout, malformed, stale, or
    // mismatched proof falls through exactly once to the stronger full ensure.
    return null;
  }
}

function sameTransportAuthorityIdentity(prior, current) {
  if (!prior || !current) return false;
  const { observedAtMs: _priorObservedAtMs, ...priorSnapshotIdentity } =
    prior.snapshot;
  const { observedAtMs: _currentObservedAtMs, ...currentSnapshotIdentity } =
    current.snapshot;
  return (
    prior.data.controller_endpoint_id === current.data.controller_endpoint_id &&
    prior.browserGeneration === current.browserGeneration &&
    prior.data.broker_generation === current.data.broker_generation &&
    prior.data.consent_generation === current.data.consent_generation &&
    prior.transportGeneration === current.transportGeneration &&
    prior.webSocketUrl === current.webSocketUrl &&
    prior.healthUrl === current.healthUrl &&
    prior.attestation.brokerProducerContractPath ===
      current.attestation.brokerProducerContractPath &&
    prior.attestation.brokerProducerContractSha256 ===
      current.attestation.brokerProducerContractSha256 &&
    canonicalJson(priorSnapshotIdentity) ===
      canonicalJson(currentSnapshotIdentity)
  );
}

function waitForCachedTransportAuthority({
  verify = null,
  expected = null,
  timeoutMs = 50_000,
} = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (verify) verify();
    const remaining = deadline - Date.now();
    const current = tryLoadCachedTransportAuthority(
      Math.max(100, Math.min(5000, remaining)),
    );
    if (verify) verify();
    if (current) {
      if (expected && !sameTransportAuthorityIdentity(expected, current)) {
        fail(
          "supported browser or broker generation changed during concurrent transport convergence",
          EX_DATAERR,
        );
      }
      return current;
    }
    if (Date.now() >= deadline) break;
    sleepSync(Math.min(25, deadline - Date.now()));
  }
  return null;
}

function loadTransportAuthority(
  session = "",
  warmLease = null,
  upstreamPort = null,
  coldBootstrap = null,
) {
  if (ACCEPTED_TRANSPORT_HELPER_REVISIONS.length === 0) {
    fail(
      "NEEDS_SUPPORTED_TRANSPORT_CONTROLLER; no audited broker producer is installed",
      EX_UNAVAILABLE,
    );
  }
  const warm = tryLoadWarmTransportAuthority(session, warmLease);
  if (warm) return warm;
  const controllerArgs = [
    "ensure-supported-existing-transport",
    "--broker-source-path",
    brokerSourcePath,
  ];
  if (session) controllerArgs.push("--session", session);
  if (Number.isSafeInteger(upstreamPort) && upstreamPort > 0) {
    controllerArgs.push("--port", String(upstreamPort));
  }
  if (coldBootstrap !== null) {
    if (
      typeof coldBootstrap !== "object" ||
      Array.isArray(coldBootstrap) ||
      !exactKeys(coldBootstrap, [
        "account",
        "requestId",
        "requesterPid",
        "requesterStartTicks",
        "verify",
      ]) ||
      !/^(?:caleb|erebora|profile-[0-9a-f]{64})$/.test(
        coldBootstrap.account,
      ) ||
      !/^[0-9a-f]{64}$/.test(coldBootstrap.requestId) ||
      !Number.isSafeInteger(coldBootstrap.requesterPid) ||
      coldBootstrap.requesterPid <= 1 ||
      !/^[0-9]+$/.test(coldBootstrap.requesterStartTicks) ||
      typeof coldBootstrap.verify !== "function"
    ) {
      fail("cold Chrome bootstrap authority is invalid", EX_DATAERR);
    }
    controllerArgs.push(
      "--account",
      coldBootstrap.account,
      "--bootstrap-request-id",
      coldBootstrap.requestId,
      "--requester-pid",
      String(coldBootstrap.requesterPid),
      "--requester-start-ticks",
      coldBootstrap.requesterStartTicks,
    );
  }
  controllerArgs.push("--json");
  if (coldBootstrap !== null) {
    const cached = tryLoadCachedTransportAuthority();
    // Requester loss must fail closed and must never be swallowed by the
    // optional cache or enter the approval-capable full ensure.
    coldBootstrap.verify();
    if (cached !== null) return cached;
  }
  const controllerResult = runController(controllerArgs);
  if (coldBootstrap !== null) coldBootstrap.verify();
  const parsedControllerResult = parseControllerJsonLine(
    controllerResult,
    "controller transport attestation",
    "TRANSPORT_FAILURE; pinned controller did not return a canonical attestation",
    true,
  );
  if (
    parsedControllerResult.controllerFailure &&
    parsedControllerResult.data.status === "profile_operation_busy"
  ) {
    // WHY: a follower that merely arrived behind the one exclusive
    // launch/reconnect/approval owner must converge on that owner's fresh
    // cached publication. Re-entering full ensure creates a lock convoy and a
    // second approval-capable path. This loop performs only bounded read-only
    // attestation and revalidates the exact cold requester around every wait.
    const converged = waitForCachedTransportAuthority({
      verify: coldBootstrap?.verify ?? null,
      timeoutMs: 50_000,
    });
    if (converged) return converged;
  }
  return transportAuthorityFromControllerResult(controllerResult);
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
  // WHY: this Bearer capability is scoped to /cdp only. The broker's /healthz
  // route intentionally accepts a separate controller-owned BrokerHealth
  // credential, so probing health with the task credential returns 401 and
  // rejects every valid new session. load/refreshTransportAuthority already
  // carries the controller's fresh authenticated broker-health attestation.
  return {
    ...authority,
    authorization,
    authorizationBinding: {
      brokerAuthorizationLeaseId: binding.brokerAuthorizationLeaseId,
      brokerAuthorizationPath: binding.brokerAuthorizationPath,
      brokerAuthorizationSha256: binding.brokerAuthorizationSha256,
    },
    health: null,
  };
}

function refreshTransportAuthority(authority, session = "", warmLease = null) {
  const current = loadTransportAuthority(
    session,
    warmLease,
    authority.upstreamPort,
  );
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

function revalidateTransportAuthority(authority, session = "", warmLease = null) {
  if (!authority.authorizationBinding) {
    fail("task transport authorization is unavailable", EX_DATAERR);
  }
  return bindTransportAuthorization(
    refreshTransportAuthority(authority, session, warmLease),
    authority.authorizationBinding,
  );
}

function freshTransportProofArgs(authority) {
  const hash = authority?.attestation?.transportProofStateSha256;
  const observedAt = authority?.attestation?.transportProofObservedAtMs;
  const identitySha256 = transportProofIdentitySha256(authority?.snapshot);
  if (
    authority?.warm ||
    !/^[0-9a-f]{64}$/.test(hash ?? "") ||
    !/^[0-9a-f]{64}$/.test(identitySha256 ?? "") ||
    !Number.isSafeInteger(observedAt) ||
    observedAt <= 0
  ) {
    fail("fresh transport proof binding is unavailable", EX_DATAERR);
  }
  return [
    "--fresh-transport-proof-sha256",
    hash,
    "--fresh-transport-proof-observed-at-ms",
    String(observedAt),
    "--fresh-transport-proof-identity-sha256",
    identitySha256,
  ];
}

function transportProofIdentitySha256(snapshot) {
  if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) {
    return "";
  }
  const chrome = snapshot.chrome ?? {};
  const portproxy = snapshot.portproxy ?? {};
  const portproxyListen = portproxy.listen ?? {};
  const portproxyConnect = portproxy.connect ?? {};
  const socat = snapshot.socat ?? {};
  const broker = snapshot.broker ?? {};
  return sha256(
    canonicalJson([
      String(chrome.browserGeneration ?? ""),
      String(portproxy.pid ?? ""),
      String(portproxy.startedAtUtc ?? ""),
      String(portproxyListen.address ?? ""),
      String(portproxyListen.port ?? ""),
      String(portproxyConnect.address ?? ""),
      String(portproxyConnect.port ?? ""),
      String(socat.pid ?? ""),
      String(socat.startTicks ?? ""),
      String(broker.pid ?? ""),
      String(broker.startTicks ?? ""),
      String(broker.brokerGeneration ?? ""),
      String(broker.consentGeneration ?? ""),
      String(broker.transportGeneration ?? ""),
      String(broker.producerContractSha256 ?? ""),
    ]),
  );
}

function adoptAcquiredTransportProof(authority, location) {
  const proofSha256 = location?.transportProofStateSha256;
  const observedAtMs = location?.transportProofObservedAtMs;
  if (
    !/^[0-9a-f]{64}$/.test(proofSha256 ?? "") ||
    !Number.isSafeInteger(observedAtMs) ||
    observedAtMs <= 0
  ) {
    fail(
      "NEEDS_TRANSPORT_PROCESS_PROOF; acquired transport proof binding is invalid",
      EX_UNAVAILABLE,
    );
  }
  const snapshot = openTrustedSnapshot(
    authority.attestation.transportProofStatePath,
    proofSha256,
    authority.data.controller_endpoint_id,
    authority.upstreamPort,
    observedAtMs,
  );
  const { observedAtMs: priorObservedAtMs, ...priorIdentity } =
    authority.snapshot;
  const { observedAtMs: renewedObservedAtMs, ...renewedIdentity } = snapshot;
  if (
    !trustedSnapshotMatchesControllerPublication(
      snapshot,
      proofSha256,
      observedAtMs,
    ) ||
    renewedObservedAtMs < priorObservedAtMs ||
    canonicalJson(renewedIdentity) !== canonicalJson(priorIdentity) ||
    snapshot.broker.browserGeneration !== authority.browserGeneration ||
    snapshot.broker.brokerGeneration !== authority.data.broker_generation ||
    snapshot.broker.consentGeneration !== authority.data.consent_generation ||
    snapshot.broker.transportGeneration !== authority.transportGeneration ||
    snapshot.broker.producerContractPath !==
      authority.attestation.brokerProducerContractPath ||
    snapshot.broker.producerContractSha256 !==
      authority.attestation.brokerProducerContractSha256
  ) {
    fail(
      "NEEDS_TRANSPORT_PROCESS_PROOF; acquired transport proof identity changed",
      EX_UNAVAILABLE,
    );
  }
  return {
    ...authority,
    attestation: {
      ...authority.attestation,
      transportProofStateSha256: snapshot.trustedProofSha256,
      transportProofObservedAtMs: snapshot.observedAtMs,
    },
    snapshot,
    issuedMs: snapshot.observedAtMs,
    expiresMs: snapshot.observedAtMs + snapshot.maxAgeMs,
  };
}

function tryAttestAndReconcileWarmTransportAuthority(
  authority,
  session,
  lease,
) {
  if (!authority?.authorizationBinding || !lease?.data) {
    return null;
  }
  try {
    const response = parseControllerJsonLine(
      runController([
        "attest-and-reconcile-supported-warm-transport",
        "--broker-source-path",
        brokerSourcePath,
        "--session",
        session,
        "--controller-endpoint-id",
        lease.data.controllerEndpointId,
        "--anchor-target-id",
        lease.data.anchorTargetId,
        "--root-target-id",
        lease.data.targetId,
        "--receipt-nonce",
        lease.data.receiptNonce,
        "--json",
      ]),
      "controller warm transport reconciliation",
      "TRANSPORT_FAILURE; pinned controller did not return a canonical warm reconciliation",
      true,
    );
    if (response.controllerFailure) return null;
    const extraKeys = [
      "discoveredTargetIds",
      "registeredTargetIds",
      "truncated",
      "reconciledAt",
    ];
    const current = warmTransportAuthorityFromData(
      response.data,
      response.raw,
      session,
      lease,
      {
        schema: WARM_BROWSER_RECONCILIATION_SCHEMA,
        status: "warm-attested-reconciled",
        extraKeys,
      },
    );
    if (!current) return null;
    const data = response.data;
    const stableFields = authority.warm
      ? WARM_TRANSPORT_ATTESTATION_KEYS.filter(
          (key) => !["schema", "status", "validatedAtMs"].includes(key),
        )
      : [
          "controllerEndpointId",
          "browserGeneration",
          "brokerGeneration",
          "consentGeneration",
          "transportGeneration",
          "brokerCdpWebSocketUrl",
          "brokerHealthUrl",
          "brokerProducerContractPath",
          "brokerProducerContractSha256",
        ];
    const now = Date.now();
    if (
      stableFields.some(
        (key) => data[key] !== authority.attestation?.[key],
      ) ||
      ![data.discoveredTargetIds, data.registeredTargetIds].every(
        (values) =>
          Array.isArray(values) &&
          values.length <= 20 &&
          new Set(values).size === values.length &&
          values.every(validControllerTargetId),
      ) ||
      data.registeredTargetIds.some(
        (targetId) => !data.discoveredTargetIds.includes(targetId),
      ) ||
      data.truncated !== false ||
      !Number.isSafeInteger(data.reconciledAt) ||
      data.reconciledAt > now + 1_000 ||
      data.reconciledAt < now - WARM_BROWSER_ATTESTATION_MAX_AGE_MS
    ) {
      return null;
    }
    return bindTransportAuthorization(
      current,
      authority.authorizationBinding,
    );
  } catch (error) {
    if (
      error instanceof WrapperError &&
      error.message.startsWith("BROWSER_GENERATION_CHANGED;")
    ) {
      throw error;
    }
    return null;
  }
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
  const stdin =
    capture && options.inheritStdin !== true ? "ignore" : "inherit";
  const stdio = capture
    ? [stdin, "pipe", "pipe", opened.fd]
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
      settleNativeReceiptPublication: true,
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
      const winner = this.root.openFile(this.receiptName, 4096, 0o600, {
        settleNativeReceiptPublication: true,
      });
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

function runController(args, timeoutOverrideMs = null, options = {}) {
  const opened = openPinnedTool(FIXED_CONTROLLER_BIN, FIXED_CONTROLLER_SHA256);
  // WHY: transport setup includes a bounded 30-second native Windows owner
  // observation plus exact Chrome approval and broker-contract proof.  Its
  // parent deadline must outlive those child bounds; otherwise the wrapper
  // kills a healthy controller mid-approval and strands a dead broker receipt
  // with an orphan native prompt.  Other lifecycle calls keep the tighter cap.
  const defaultTimeout =
    args[0] === "ensure-supported-existing-transport" &&
    args.includes("--bootstrap-request-id")
      ? 120_000
      : ["ensure-supported-existing-transport", "ensure-workspace"].includes(args[0])
      ? 60_000
      : args[0] === "recover-metamask-vault"
        ? 60_000
      : [
          "acquire-focus",
          // Existing-profile target proof, exact lease consumption/registration,
          // and exact abort can exceed five seconds on a healthy real Chrome
          // profile; keep them bounded without killing a valid lifecycle transition.
          "acquire-session-task-root-lease",
          "consume-target-receipt",
          "discover-owned-descendants",
          "proof-state",
          "register-session",
          "release-focus",
          "release-session",
          "release-task-root",
          "release-target-lease",
          "renew-session-transport",
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
    inheritStdin: options.inheritStdin === true,
  });
  closeOpened(opened);
  return result;
}

function runMetaMaskVaultRecovery(parsed) {
  // WHY: the process-bound Stable-profile receipt intentionally expires after
  // two minutes.  Recovery can be invoked long after the task daemon started,
  // so using only its warm broker proof makes a valid persistent connection
  // fail generically and invites retries.  Force the normal controller-owned
  // transport attestation here; it reuses the approved broker while refreshing
  // the short-lived profile receipt before any private payload reaches Python.
  loadTransportAuthority(parsed.session);
  const result = runController(
    [
      "recover-metamask-vault",
      "--expected-sha256",
      parsed.commandArgs[1],
      "--json",
    ],
    60_000,
    { inheritStdin: true },
  );
  const data = parseMetaMaskRecoveryControllerResult(result);
  const stream = data.ok === true ? process.stdout : process.stderr;
  stream.write(canonicalJson(data) + "\n");
  return data.ok === true ? 0 : 1;
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
    !/^(?:caleb|erebora|profile-[0-9a-f]{64})$/.test(values.account) ||
    !values.profile ||
    Buffer.byteLength(values.profile, "utf8") > 128 ||
    [".", ".."].includes(values.profile) ||
    /[\\/\u0000-\u001f\u007f]/.test(values.profile)
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

function processAncestorIdentity(pid) {
  const identity = processStatIdentity(pid);
  const raw = readProcBounded(`/proc/${pid}/stat`, 4096).toString("utf8");
  const end = raw.lastIndexOf(")");
  const fields = end < 0 ? [] : raw.slice(end + 2).trim().split(/\s+/);
  const parentPid = Number(fields[1]);
  if (!Number.isSafeInteger(parentPid) || parentPid < 0) {
    fail("agent owner process ancestry is invalid", EX_DATAERR);
  }
  let executable = "";
  let argv = [];
  try {
    executable = readlinkSync(`/proc/${pid}/exe`);
    argv = readProcBounded(`/proc/${pid}/cmdline`, 64 * 1024)
      .toString("utf8")
      .split("\0")
      .filter(Boolean)
      .slice(0, 8);
  } catch {}
  return { ...identity, pid, parentPid, executable, argv };
}

function recognizedAgentProcess(identity) {
  const names = [
    basename(identity.executable || ""),
    ...identity.argv.slice(0, 4).map((value) => basename(value)),
  ].map((value) => value.toLowerCase().replace(/\.exe$/, ""));
  return names.some((value) => ["codex", "claude", "gemini"].includes(value));
}

function invokingAgentIdentity() {
  // WHY: the daemon outlives the short wrapper and shell command. Binding it
  // only to the daemon lets another Codex/Claude process silently reuse the
  // same tab. Walk the observed parent chain once, select the nearest known
  // agent process (or the immediate caller for ordinary CLI use), then re-read
  // its birth identity so PID reuse cannot transfer ownership.
  const chain = [];
  let pid = process.ppid;
  for (let depth = 0; depth < 16 && pid > 1; depth += 1) {
    const identity = processAncestorIdentity(pid);
    chain.push(identity);
    if (identity.parentPid === pid || identity.parentPid < 1) break;
    pid = identity.parentPid;
  }
  if (chain.length === 0) {
    fail("agent owner process ancestry is unavailable", EX_UNAVAILABLE);
  }
  const selected = chain.find(recognizedAgentProcess) ?? chain[0];
  const current = processAncestorIdentity(selected.pid);
  if (
    current.startTicks !== selected.startTicks ||
    current.parentPid !== selected.parentPid ||
    ["Z", "X", "x"].includes(current.state)
  ) {
    fail("agent owner process changed during attribution", EX_UNAVAILABLE);
  }
  return { pid: selected.pid, startTicks: selected.startTicks };
}

function processStartTicks(pid) {
  return processStatIdentity(pid).startTicks;
}

// WHY: ownerless retirement needs proof of death, not merely failure to observe
// a process. Permission, parsing, and transient /proc errors remain ambiguous;
// only absence, a terminal state, or another birth at the PID proves death.
function processIdentityStatus(pid, expectedStartTicks = null) {
  try {
    process.kill(pid, 0);
  } catch (error) {
    return error?.code === "ESRCH" ? "dead" : "ambiguous";
  }
  let identity;
  try {
    identity = processStatIdentity(pid);
  } catch (error) {
    return ["ENOENT", "ESRCH"].includes(error?.code) ? "dead" : "ambiguous";
  }
  if (["Z", "X", "x"].includes(identity.state)) return "dead";
  if (expectedStartTicks !== null && identity.startTicks !== expectedStartTicks) {
    return "dead";
  }
  return "live";
}

function processIdentityIsLive(pid, expectedStartTicks = null) {
  return processIdentityStatus(pid, expectedStartTicks) === "live";
}

function processIdentityIsDefinitelyDead(pid, expectedStartTicks) {
  return processIdentityStatus(pid, expectedStartTicks) === "dead";
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

function socketPathHasLiveKernelEndpoint(expectedSocketPath) {
  try {
    const table = readProcBounded("/proc/net/unix", 1024 * 1024).toString(
      "utf8",
    );
    return table
      .split("\n")
      .slice(1)
      .some((line) => {
        const fields = line.trim().split(/\s+/);
        return (
          fields.length >= 8 && fields.slice(7).join(" ") === expectedSocketPath
        );
      });
  } catch {
    // An unavailable kernel ownership observation is ambiguous, not proof that
    // an old endpoint is dead.
    return true;
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
    capabilities !== DAEMON_TRANSPORT_REBIND_CAPABILITIES ||
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

const LEGACY_OWNERLESS_TASK_LEASE_KEYS = Object.freeze([
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
  "anchorTargetId",
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
]);

const TASK_LEASE_KEYS = Object.freeze([
  ...LEGACY_OWNERLESS_TASK_LEASE_KEYS,
  "agentPid",
  "agentStartTicks",
]);

function loadTaskLease(root, session) {
  const opened = root.openFile(taskLeaseName(session), 4096, 0o600, {
    allowMissing: true,
  });
  if (!opened) return null;
  const data = parseJson(opened.raw, "task ownership lease");
  const raw = opened.raw;
  closeOpened(opened);
  const legacyOwnerless = data.schema === LEGACY_OWNERLESS_TASK_LEASE_SCHEMA;
  if (
    !exactKeys(
      data,
      legacyOwnerless ? LEGACY_OWNERLESS_TASK_LEASE_KEYS : TASK_LEASE_KEYS,
    ) ||
    (!legacyOwnerless && data.schema !== TASK_LEASE_SCHEMA) ||
    data.session !== session ||
    (legacyOwnerless
      ? !(
          (data.account === "caleb" && data.profile === "Default") ||
          (data.account === "erebora" && data.profile === "Profile 1")
        )
      : !/^(?:caleb|erebora|profile-[0-9a-f]{64})$/.test(data.account)) ||
    typeof data.profile !== "string" ||
    !data.profile ||
    Buffer.byteLength(data.profile, "utf8") > 128 ||
    [".", ".."].includes(data.profile) ||
    /[\\/\u0000-\u001f\u007f]/.test(data.profile) ||
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
    typeof data.anchorTargetId !== "string" ||
    !data.anchorTargetId ||
    data.anchorTargetId.length > 256 ||
    /[\u0000-\u001f\u007f]/.test(data.anchorTargetId) ||
    typeof data.targetId !== "string" ||
    !data.targetId ||
    data.targetId.length > 256 ||
    /[\u0000-\u001f\u007f]/.test(data.targetId) ||
    ![TASK_ROOT_TARGET_KIND, "user-collaboration"].includes(data.targetKind) ||
    !/^[0-9a-f]{64}$/.test(data.receiptNonce) ||
    ![TASK_ROOT_LEASE_KIND, "user-adopted"].includes(data.targetLeaseKind) ||
    (data.targetKind === TASK_ROOT_TARGET_KIND
      ? data.targetLeaseKind !== TASK_ROOT_LEASE_KIND
      : data.targetLeaseKind !== "user-adopted") ||
    !/^[0-9a-f]{64}$/.test(data.brokerAuthorizationLeaseId) ||
    data.brokerAuthorizationPath !==
      expectedBrokerAuthorizationPath(
        data.controllerEndpointId,
        data.brokerAuthorizationLeaseId,
      ) ||
    !/^[0-9a-f]{64}$/.test(data.brokerAuthorizationSha256) ||
    canonicalRfc3339Milliseconds(data.brokerCapabilityExpiresAt) === null ||
    (!legacyOwnerless &&
      (!Number.isSafeInteger(data.agentPid) ||
        data.agentPid <= 1 ||
        !/^[0-9]+$/.test(data.agentStartTicks))) ||
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
  return {
    data,
    raw,
    ownership: legacyOwnerless ? "legacy-ownerless" : "agent",
  };
}

function validateAgentOwner(lease, owner, { allowDeadOwner = false } = {}) {
  if (lease?.ownership === "legacy-ownerless") {
    // WHY: v6 predates exact agent PID/start ownership. The current caller is
    // not evidence of the original owner, so a live v6 namespace must never be
    // adopted, renewed, dispatched, or routed through generic dead-owner reuse.
    fail(
      "LEGACY_SESSION_OWNER_UNKNOWN; the exact legacy session is preserved until its daemon and socket are proven dead",
      EX_UNAVAILABLE,
    );
  }
  if (
    !lease ||
    !owner ||
    !Number.isSafeInteger(owner.pid) ||
    owner.pid <= 1 ||
    !/^[0-9]+$/.test(owner.startTicks)
  ) {
    fail("session agent owner is not authenticated", EX_DATAERR);
  }
  const ownerMatches =
    lease.data.agentPid === owner.pid &&
    lease.data.agentStartTicks === owner.startTicks;
  if (ownerMatches) return "owned";
  const recordedOwnerLive = processIdentityIsLive(
    lease.data.agentPid,
    lease.data.agentStartTicks,
  );
  if (!allowDeadOwner || recordedOwnerLive) {
    fail(
      recordedOwnerLive
        ? "session belongs to another live agent owner"
        : "session agent owner is dead; exact cleanup is required",
      EX_DATAERR,
    );
  }
  return "dead-owner";
}

function requireLegacyOwnerlessRetirement(root, session, state, lease) {
  if (lease?.ownership !== "legacy-ownerless") return false;
  const socketPath = join(SOCKET_ROOT, `${session}.sock`);
  if (
    !processIdentityIsDefinitelyDead(lease.data.pid, lease.data.startTicks) ||
    socketPathHasLiveKernelEndpoint(socketPath) ||
    !["closed", "stale"].includes(state.kind)
  ) {
    fail(
      "LEGACY_SESSION_OWNER_UNKNOWN; the exact legacy session remains preserved while daemon or socket ownership is live or ambiguous",
      EX_UNAVAILABLE,
    );
  }
  if (state.kind === "stale") {
    validateStaleOwnership(root, session, state, lease.data);
  }
  return true;
}

function sameRetirementEntry(left, right) {
  if (!left || !right) return left === right;
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.mode === right.mode &&
    left.uid === right.uid &&
    left.nlink === right.nlink &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}

function sameLegacyRetirementState(left, right) {
  return (
    left.kind === right.kind &&
    (left.pid ?? null) === (right.pid ?? null) &&
    ((!left.pidRaw && !right.pidRaw) ||
      Boolean(left.pidRaw && right.pidRaw && left.pidRaw.equals(right.pidRaw))) &&
    sameRetirementEntry(left.socketInfo, right.socketInfo) &&
    sameRetirementEntry(left.streamInfo, right.streamInfo) &&
    sameRetirementEntry(left.portInfo, right.portInfo) &&
    sameRetirementEntry(left.identityInfo, right.identityInfo)
  );
}

function requireCloseMetadataPair(binding, lease, stateKind) {
  if (
    !binding ||
    !lease ||
    binding.account !== lease.data.account ||
    binding.profile !== lease.data.profile
  ) {
    fail(
      `${stateKind} session ownership is incomplete; cleanup evidence is preserved`,
      EX_DATAERR,
    );
  }
}

function requireUnchangedLegacyMetadata(root, session, binding, lease) {
  const currentBinding = loadBinding(root, session);
  const currentLease = loadTaskLease(root, session);
  if (
    !currentBinding ||
    !currentLease ||
    currentLease.ownership !== "legacy-ownerless" ||
    !currentBinding.raw.equals(binding.raw) ||
    !currentLease.raw.equals(lease.raw) ||
    currentBinding.account !== currentLease.data.account ||
    currentBinding.profile !== currentLease.data.profile
  ) {
    fail(
      "legacy session ownership changed during exact retirement",
      EX_UNAVAILABLE,
    );
  }
}

function validateTaskLease(
  lease,
  state,
  identity,
  authority,
  owner,
  options = {},
) {
  validateAgentOwner(lease, owner, options);
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

function validateLocalTaskOwnership(
  lease,
  state,
  identity,
  owner,
  options = {},
) {
  validateAgentOwner(lease, owner, options);
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

function taskLeasePayload(
  session,
  identity,
  authority,
  state,
  registration,
  owner,
) {
  return Buffer.from(
    `${canonicalJson({
      schema: TASK_LEASE_SCHEMA,
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
      anchorTargetId: registration.anchorTargetId,
      targetId: registration.targetId,
      targetKind: registration.targetKind,
      receiptNonce: registration.receiptNonce,
      targetLeaseKind: registration.targetLeaseKind,
      brokerAuthorizationLeaseId: registration.brokerAuthorizationLeaseId,
      brokerAuthorizationPath: registration.brokerAuthorizationPath,
      brokerAuthorizationSha256: registration.brokerAuthorizationSha256,
      brokerCapabilityExpiresAt: registration.brokerCapabilityExpiresAt,
      agentPid: owner.pid,
      agentStartTicks: owner.startTicks,
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
      "anchorTargetId",
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
    typeof receipt.anchorTargetId !== "string" ||
    !receipt.anchorTargetId ||
    receipt.anchorTargetId.length > 256 ||
    /[\u0000-\u001f\u007f]/.test(receipt.anchorTargetId) ||
    typeof receipt.targetId !== "string" ||
    !receipt.targetId ||
    receipt.targetId.length > 256 ||
    /[\u0000-\u001f\u007f]/.test(receipt.targetId) ||
    receipt.anchorTargetId === receipt.targetId ||
    ![TASK_ROOT_TARGET_KIND, "user-collaboration"].includes(
      receipt.targetKind,
    ) ||
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
    (receipt.accountEmail !== "" && !receipt.accountEmail.includes("@")) ||
    receipt.accountEmail.length > 320 ||
    receipt.accountEmail !== receipt.accountEmail.trim() ||
    /[\u0000-\u001f\u007f]/.test(receipt.accountEmail) ||
    !/^[0-9a-f]{64}$/.test(receipt.browserGeneration) ||
    !/^[0-9a-f]{64}$/.test(receipt.transportGeneration) ||
    !/^[0-9a-f]{64}$/.test(receipt.leaseId) ||
    (receipt.targetKind === TASK_ROOT_TARGET_KIND
      ? typeof receipt.workspaceMarkerUrl !== "string" ||
        !/^about:blank#agent-browser-task-[0-9a-f]{64}$/.test(
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
      "ownershipKind",
      "claimKind",
      "account",
      "profileDirectory",
      "anchorTargetId",
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
    metadata.port !== authority.upstreamPort ||
    !/^[0-9a-f]{64}$/.test(metadata.runtimeFingerprint) ||
    metadata.browserGeneration !== receipt.browserGeneration ||
    metadata.transportGeneration !== receipt.transportGeneration ||
    !/^[0-9a-f]{64}$/.test(metadata.provenanceKey) ||
    !/^[0-9a-f]{64}$/.test(metadata.controllerIdentity) ||
    !["workspace-task", "user-adopted"].includes(metadata.ownershipKind) ||
    ![TASK_ROOT_LEASE_KIND, "user-adopted"].includes(metadata.claimKind) ||
    metadata.account !== identity.account ||
    metadata.profileDirectory !== receipt.profileDirectory ||
    metadata.anchorTargetId !== receipt.anchorTargetId ||
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
    (receipt.targetKind === TASK_ROOT_TARGET_KIND
      ? metadata.claimKind !== TASK_ROOT_LEASE_KIND ||
        metadata.ownershipKind !== "workspace-task"
      : metadata.claimKind !== "user-adopted" ||
        metadata.ownershipKind !== "user-adopted")
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
    anchorTargetId: receipt.anchorTargetId,
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

function ensureSessionWorkspace(identity, authority) {
  const result = parseControllerJsonLine(
    runController([
      "ensure-workspace",
      "--account",
      identity.account,
      "--port",
      String(authority.upstreamPort),
      "--json",
    ]),
    "controller lazy workspace",
    "TARGET_REPROVISION_REQUIRED; controller could not establish the exact profile workspace",
  ).data;
  const markerId = result.markerId;
  if (
    !exactKeys(result, [
      "schema",
      "ok",
      "status",
      "action",
      "account",
      "profileDirectory",
      "profileEmail",
      "targetId",
      "tabTargetId",
      "windowId",
      "windowDisposition",
      "browserContextId",
      "profileDiscriminatorKind",
      "profileBinding",
      "browserGeneration",
      "transportGeneration",
      "markerId",
      "markerUrl",
      "workspaceStatus",
      "activate",
    ]) ||
    result.schema !== WORKSPACE_ENSURE_SCHEMA ||
    result.ok !== true ||
    result.status !== "ready" ||
    !["existing", "provisioned", "recovered"].includes(result.action) ||
    result.account !== identity.account ||
    result.profileDirectory !== identity.profile ||
    result.profileEmail !== identity.email ||
    !validControllerTargetId(result.targetId) ||
    !validControllerTargetId(result.tabTargetId) ||
    !Number.isSafeInteger(result.windowId) ||
    result.windowId < 0 ||
    ![
      "reused-existing-window",
      "temporary-profile-window",
    ].includes(result.windowDisposition) ||
    !validControllerTargetId(result.browserContextId) ||
    result.profileDiscriminatorKind !== "browser-context-id" ||
    !/^[0-9a-f]{64}$/.test(result.profileBinding) ||
    result.browserGeneration !== authority.browserGeneration ||
    result.transportGeneration !== authority.transportGeneration ||
    !/^[0-9a-f]{64}$/.test(markerId) ||
    result.markerUrl !== `about:blank#agent-browser-workspace-${markerId}` ||
    !["ready", "leased"].includes(result.workspaceStatus) ||
    result.activate !== false
  ) {
    fail("controller returned a mismatched lazy workspace", EX_DATAERR);
  }
  return result;
}

function acquireSessionTaskRootLease(
  parsed,
  identity,
  authority,
  verifyRecoveryOwnership,
) {
  let response;
  let recoveredTaskRoot = null;
  let workspaceEnsured = false;
  let taskRootRecovered = false;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    response = parseControllerJsonLine(
      runController([
        "acquire-session-task-root-lease",
        "--session",
        parsed.session,
        "--account",
        identity.account,
        // The controller and daemon both enforce this supported maximum. The
        // default 15-second receipt can expire during healthy controller proof
        // before the daemon gets its one chance to claim it.
        "--ttl-ms",
        String(TARGET_MAX_TTL_MS),
        "--port",
        String(authority.upstreamPort),
        ...freshTransportProofArgs(authority),
        "--json",
      ]),
      "controller task-root lease location",
      "TARGET_REPROVISION_REQUIRED; controller-created task root is unavailable",
      true,
    );
    if (!response.controllerFailure) break;
    if (
      !workspaceEnsured &&
      ["workspace_not_registered", "TARGET_REPROVISION_REQUIRED"].includes(
        response.data.status,
      )
    ) {
      ensureSessionWorkspace(identity, authority);
      workspaceEnsured = true;
      continue;
    }
    if (
      !taskRootRecovered &&
      response.data.status === "task_root_lease_recovery_required"
    ) {
      // WHY: a controller-created task root can be issued before transport
      // reproof assigns a local claim. The held bootstrap lock plus a closed
      // local namespace permits exactly one same-session retirement; a foreign
      // session remains a structured conflict and can never be stolen.
      verifyRecoveryOwnership();
      recoveredTaskRoot = releasePendingTaskRootLease(parsed, identity);
      taskRootRecovered = true;
      continue;
    }
    fail(
      `${response.data.status}; ${response.data.reason}`,
      EX_UNAVAILABLE,
    );
  }
  if (!response || response.controllerFailure) {
    fail(
      "TARGET_REPROVISION_REQUIRED; controller-created task root is unavailable",
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
      "transportProofStateSha256",
      "transportProofObservedAtMs",
      "activate",
    ]) ||
    result.schema !== "agent-browser.target-lease-location.v1" ||
    result.ok !== true ||
    result.status !== "issued" ||
    result.controllerEndpointId !== authority.data.controller_endpoint_id ||
    !/^[0-9a-f]{64}$/.test(result.transportProofStateSha256) ||
    !Number.isSafeInteger(result.transportProofObservedAtMs) ||
    result.transportProofObservedAtMs <= 0 ||
    result.activate !== false
  ) {
    fail("controller returned a mismatched task-root lease", EX_DATAERR);
  }
  validatePublicTargetReceipt(
    result.receipt,
    parsed.session,
    result.receipt?.nonce,
    identity,
    authority,
  );
  if (
    result.receipt.targetKind !== TASK_ROOT_TARGET_KIND ||
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
    fail("controller returned a mismatched task-root lease", EX_DATAERR);
  }
  if (
    recoveredTaskRoot &&
    (recoveredTaskRoot.anchorTargetId !== result.receipt.anchorTargetId ||
      recoveredTaskRoot.targetId === result.receipt.targetId ||
      recoveredTaskRoot.browserContextId !==
        result.receipt.browserContextId ||
      recoveredTaskRoot.profileBinding !== result.receipt.profileBinding ||
      recoveredTaskRoot.browserGeneration !==
        result.receipt.browserGeneration ||
      recoveredTaskRoot.transportGeneration !==
        result.receipt.transportGeneration ||
      recoveredTaskRoot.markerUrl === result.receipt.workspaceMarkerUrl)
  ) {
    fail(
      "bounded reacquisition did not retain the anchor while replacing the released task root",
      EX_DATAERR,
    );
  }
  parsed.targetLease = result.path;
  return result;
}

function acquireCurrentTabTargetLease(parsed, identity, authority) {
  const response = parseControllerJsonLine(
    runController([
      "mint-current-tab-adoption-receipt",
      "--session",
      parsed.session,
      "--account",
      identity.account,
      "--ttl-ms",
      String(TARGET_MAX_TTL_MS),
      "--port",
      String(authority.upstreamPort),
      "--json",
    ]),
    "controller current-tab lease location",
    "CURRENT_TAB_INVITATION_FAILED; no unique foreground tab was leased",
    true,
  );
  if (response.controllerFailure) {
    fail(`${response.data.status}; ${response.data.reason}`, EX_UNAVAILABLE);
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
    fail("controller returned a mismatched current-tab lease", EX_DATAERR);
  }
  validatePublicTargetReceipt(
    result.receipt,
    parsed.session,
    result.receipt?.nonce,
    identity,
    authority,
  );
  if (
    result.receipt.targetKind !== "user-collaboration" ||
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
    fail("controller returned a mismatched current-tab lease", EX_DATAERR);
  }
  parsed.targetLease = result.path;
  return result;
}

function releasePendingTaskRootLease(
  parsed,
  identity,
  expectedReceipt = null,
  options = {},
) {
  const response = parseControllerJsonLine(
    runController(
      [
        "release-task-root",
        "--account",
        identity.account,
        "--session",
        parsed.session,
        "--json",
      ],
      options.timeoutMs ?? null,
    ),
    "controller pending task-root release",
    "TASK_ROOT_RELEASE_FAILED; exact pre-claim task root remains controller-owned",
    options.allowControllerFailure === true,
  );
  if (response.controllerFailure) return response.data;
  const result = response.data;
  const anchorDisposition = validateAnchorDisposition(
    result.anchorDisposition,
    result.anchorTargetId,
    identity.account,
    expectedReceipt?.profileBinding ?? result.profileBinding,
    expectedReceipt?.browserGeneration ?? result.browserGeneration,
  );
  if (
    !exactKeys(result, [
      "schema",
      "ok",
      "status",
      "session",
      "account",
      "profileDirectory",
      "profileEmail",
      "anchorTargetId",
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
      "taskRootClosed",
      "anchorReady",
      "anchorDisposition",
      "brokerCapabilityRevoked",
      "brokerPreserved",
    ]) ||
    result.schema !== TASK_ROOT_RELEASE_SCHEMA ||
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
    result.markerUrl !== `about:blank#agent-browser-task-${result.markerId}` ||
    result.taskRootClosed !== true ||
    result.anchorReady !== !anchorDisposition.anchorRetired ||
    result.brokerCapabilityRevoked !== true ||
    result.brokerPreserved !== true
  ) {
    fail("controller returned a mismatched pending task-root release", EX_DATAERR);
  }
  for (const [value, label, maximum] of [
    [result.anchorTargetId, "workspace anchor targetId", 160],
    [result.targetId, "released task-root targetId", 160],
    [result.tabTargetId, "released task-root tabTargetId", 160],
    [result.browserContextId, "released task-root browserContextId", 160],
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
    (result.anchorTargetId !== expectedReceipt.anchorTargetId ||
      result.targetId !== expectedReceipt.targetId ||
      result.browserContextId !== expectedReceipt.browserContextId ||
      result.profileBinding !== expectedReceipt.profileBinding ||
      result.browserGeneration !== expectedReceipt.browserGeneration ||
      result.transportGeneration !== expectedReceipt.transportGeneration ||
      result.markerUrl !== expectedReceipt.workspaceMarkerUrl)
  ) {
    fail("pending task-root release identity changed", EX_DATAERR);
  }
  return result;
}

function releaseFailedPendingTaskRootLease(parsed, identity, expectedReceipt) {
  try {
    const result = releasePendingTaskRootLease(
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
      "task_root_release_transport_failed",
      error?.message || "Controller pending task-root release failed",
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
  // metadata sibling rejects otherwise exact controller-issued task-root leases.
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
        "TARGET_REPROVISION_REQUIRED; pending task-root lease is missing or replayed",
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
      const expectedLeaseKind = parsed.currentTab
        ? "user-adopted"
        : TASK_ROOT_LEASE_KIND;
      if (
        lease.leaseKind !== expectedLeaseKind ||
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
          "controller bootstrap acquisition did not match its exact target metadata",
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
        "TARGET_REPROVISION_REQUIRED; pending task-root lease is missing or replayed",
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
      "--port",
      String(authority.upstreamPort),
      ...freshTransportProofArgs(authority),
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

function releaseUserTargetLease(parsed, expected) {
  const result = parseControllerJsonLine(
    runController([
      "release-target-lease",
      "--session",
      parsed.session,
      "--anchor-target-id",
      expected.anchorTargetId,
      "--target-id",
      expected.targetId,
      "--receipt-nonce",
      expected.nonce,
      "--json",
    ]),
    "controller target lease abort",
    "TARGET_LEASE_ABORT_FAILED; consumed target and client authorization remain controller-owned",
  ).data;
  const anchorDisposition = validateReleaseAnchorDisposition(
    result.anchorDisposition,
    result.targetKind,
    expected.anchorTargetId,
    expected.account,
    expected.profileBinding,
    expected.browserGeneration,
  );
  if (
    !exactKeys(result, [
      "schema",
      "ok",
      "status",
      "session",
      "anchorTargetId",
      "targetId",
      "targetKind",
      "taskRootClosed",
      "userTargetPreserved",
      "anchorReady",
      "anchorDisposition",
      "brokerCapabilityRevoked",
    ]) ||
    result.schema !== TARGET_LEASE_ABORT_SCHEMA ||
    result.ok !== true ||
    result.status !== "aborted" ||
    result.session !== parsed.session ||
    result.anchorTargetId !== expected.anchorTargetId ||
    result.targetId !== expected.targetId ||
    result.targetKind !== expected.targetKind ||
    !["agent-workspace", "user-collaboration"].includes(result.targetKind) ||
    (result.targetKind === "agent-workspace"
      ? result.taskRootClosed !== null ||
        result.userTargetPreserved !== null ||
        result.anchorReady !== !anchorDisposition.anchorRetired
      : result.taskRootClosed !== null ||
        result.userTargetPreserved !== true ||
        result.anchorReady !== null ||
        anchorDisposition !== null) ||
    result.brokerCapabilityRevoked !== true
  ) {
    fail("controller returned a mismatched target lease abort", EX_DATAERR);
  }
  return result;
}

function releaseConsumedTargetLease(parsed, identity, claim) {
  if (claim.lease.targetKind === TASK_ROOT_TARGET_KIND) {
    // A consumed-but-unregistered task root still belongs to the controller's
    // workspace-task lifecycle. Its exact release closes that created tab and
    // descendants, then retires only an idle account anchor; the generic
    // non-owned abort deliberately preserves user collaboration targets and is
    // not semantically interchangeable.
    releasePendingTaskRootLease(parsed, identity, claim.lease.receipt);
    return;
  }
  releaseUserTargetLease(parsed, {
    account: identity.account,
    profileBinding: claim.lease.profileBinding,
    browserGeneration: claim.lease.browserGeneration,
    anchorTargetId: claim.lease.anchorTargetId,
    targetId: claim.lease.receipt.targetId,
    targetKind: claim.lease.targetKind,
    nonce: claim.nonce,
  });
}

function releaseFailedPendingCurrentTabLease(parsed, identity, location) {
  const receipt = location?.receipt;
  try {
    return releaseUserTargetLease(parsed, {
      account: identity.account,
      profileBinding: receipt?.profileBinding,
      browserGeneration: receipt?.browserGeneration,
      anchorTargetId: receipt?.anchorTargetId,
      targetId: receipt?.targetId,
      targetKind: receipt?.targetKind,
      nonce: receipt?.nonce,
    });
  } catch (error) {
    return cleanupFailure(
      "current_tab_lease_abort_failed",
      error?.message ||
        "Exact current-tab lease abort did not prove user-target preservation",
    );
  }
}

function registerTaskSession(parsed, identity, authority, state, claim, owner) {
  const response = parseControllerJsonLine(
    runController([
      "register-session",
      "--session",
      parsed.session,
      "--anchor-target-id",
      claim.lease.anchorTargetId,
      "--target-id",
      claim.lease.receipt.targetId,
      "--pid",
      String(state.pid),
      "--agent-pid",
      String(owner.pid),
      "--agent-start-ticks",
      owner.startTicks,
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
      "--port",
      String(authority.upstreamPort),
      ...freshTransportProofArgs(authority),
      "--json",
    ]),
    "controller session registration",
    "SESSION_REGISTRATION_FAILED; controller did not register the exact attached task root",
  );
  const result = response.data;
  if (
    !exactKeys(result, [
      "ok",
      "status",
      "session",
      "anchorTargetId",
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
      "agentPid",
      "agentStartTicks",
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
    result.anchorTargetId !== claim.lease.anchorTargetId ||
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
    result.agentPid !== owner.pid ||
    result.agentStartTicks !== owner.startTicks ||
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
      "--anchor-target-id",
      claim.lease.anchorTargetId,
      "--target-id",
      claim.lease.receipt.targetId,
      "--receipt-nonce",
      claim.nonce,
      "--port",
      String(authority.upstreamPort),
      ...freshTransportProofArgs(authority),
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
      "anchorTargetId",
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
    result.anchorTargetId !== claim.lease.anchorTargetId ||
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
    authority.upstreamPort,
    result.transportProofObservedAtMs,
  );
  const { observedAtMs: priorObservedAtMs, ...priorSnapshotIdentity } =
    authority.snapshot;
  const { observedAtMs: refreshedObservedAtMs, ...refreshedSnapshotIdentity } =
    snapshot;
  if (
    !trustedSnapshotMatchesControllerPublication(
      snapshot,
      result.transportProofStateSha256,
      result.transportProofObservedAtMs,
    ) ||
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
  anchorTargetId,
  targetId,
  targetKind,
  receiptNonce,
  options = {},
) {
  const controllerArgs = [
    "release-session",
    "--session",
    session,
    "--anchor-target-id",
    anchorTargetId,
    "--target-id",
    targetId,
    "--receipt-nonce",
    receiptNonce,
  ];
  if (Number.isSafeInteger(options.port) && options.port > 0) {
    controllerArgs.push("--port", String(options.port));
  }
  if (
    [
      options.browserGeneration,
      options.transportGeneration,
      options.brokerAuthorizationLeaseId,
    ].every((value) => /^[0-9a-f]{64}$/.test(value ?? ""))
  ) {
    controllerArgs.push(
      "--browser-generation",
      options.browserGeneration,
      "--transport-generation",
      options.transportGeneration,
      "--broker-lease-id",
      options.brokerAuthorizationLeaseId,
      "--broker-source-path",
      brokerSourcePath,
    );
    if (/^[0-9a-f]{64}$/.test(options.brokerProducerContractSha256 ?? "")) {
      controllerArgs.push(
        "--broker-producer-contract-sha256",
        options.brokerProducerContractSha256,
      );
    }
  }
  controllerArgs.push("--json");
  const response = parseControllerJsonLine(
    runController(controllerArgs, options.timeoutMs ?? null),
    "controller session release",
    "SESSION_RELEASE_FAILED; exact controller registration remains owned",
    options.allowControllerFailure === true,
  );
  if (response.controllerFailure) return response.data;
  const result = response.data;
  const anchorDisposition = validateReleaseAnchorDisposition(
    result.anchorDisposition,
    result.targetKind,
    anchorTargetId,
    options.account ?? "",
    options.profileBinding ?? "",
    options.browserGeneration ?? "",
  );
  if (
    !exactKeys(result, [
      "schema",
      "ok",
      "status",
      "session",
      "anchorTargetId",
      "targetId",
      "targetKind",
      "receiptNonce",
      "descendantsClosed",
      "taskRootClosed",
      "userTargetPreserved",
      "anchorReady",
      "anchorDisposition",
      "brokerCapabilityRevoked",
      "focusDisposition",
      "releasedAt",
    ]) ||
    result.schema !== SESSION_RELEASE_SCHEMA ||
    result.ok !== true ||
    result.status !== "released" ||
    result.session !== session ||
    result.anchorTargetId !== anchorTargetId ||
    result.targetId !== targetId ||
    result.targetKind !== targetKind ||
    result.receiptNonce !== receiptNonce ||
    !Number.isSafeInteger(result.descendantsClosed) ||
    result.descendantsClosed < 0 ||
    ![
      TASK_ROOT_TARGET_KIND,
      "agent-workspace",
      "user-collaboration",
    ].includes(targetKind) ||
    (targetKind === TASK_ROOT_TARGET_KIND
      ? result.taskRootClosed !== true ||
        result.userTargetPreserved !== null ||
        result.anchorReady !== !anchorDisposition.anchorRetired
      : targetKind === "agent-workspace"
        ? result.taskRootClosed !== null ||
          result.userTargetPreserved !== null ||
          result.anchorReady !== !anchorDisposition.anchorRetired
        : result.taskRootClosed !== null ||
        result.userTargetPreserved !== true ||
        result.anchorReady !== null ||
        anchorDisposition !== null) ||
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

function releaseLocalOptions(lease, overrides = {}) {
  const data = lease?.data ?? {};
  return {
    port: controllerEndpointPort(data.controllerEndpointId),
    account: data.account,
    profileBinding: data.profileBinding,
    browserGeneration: data.browserGeneration,
    transportGeneration: data.transportGeneration,
    brokerAuthorizationLeaseId: data.brokerAuthorizationLeaseId,
    ...overrides,
  };
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
  anchorTargetId,
  targetId,
  targetKind,
  receiptNonce,
  account,
  profileBinding,
  browserGeneration,
  port = null,
  localOptions = {},
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
        anchorTargetId,
        targetId,
        targetKind,
        receiptNonce,
        {
          ...localOptions,
          allowControllerFailure: true,
          timeoutMs: remaining,
          port: localOptions.port ?? port,
          account: localOptions.account ?? account,
          profileBinding: localOptions.profileBinding ?? profileBinding,
          browserGeneration:
            localOptions.browserGeneration ?? browserGeneration,
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
        (targetKind === TASK_ROOT_TARGET_KIND
          ? result.taskRootClosed !== true ||
            result.userTargetPreserved !== null ||
            result.anchorReady !== !result.anchorDisposition.anchorRetired
          : targetKind === "agent-workspace"
            ? result.taskRootClosed !== null ||
              result.userTargetPreserved !== null ||
              result.anchorReady !== !result.anchorDisposition.anchorRetired
            : result.taskRootClosed !== null ||
            result.userTargetPreserved !== true ||
            result.anchorReady !== null) ||
        result.brokerCapabilityRevoked !== true ||
        result.focusDisposition !== "none"
      ) {
        return cleanupFailure(
          "session_release_result_invalid",
          "Failed-session release did not prove the exact root disposition, anchor state, or focus disposition",
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

function releaseFailedExplicitClose(root, parsed, binding, lease) {
  // WHY: native close can terminate the exact daemon and still return nonzero
  // or throw. Once ownership is proven, retire only that controller session;
  // its controller-created task root and owned descendants must close while
  // the broker, user tabs, and unrelated sessions remain; an idle account
  // anchor retires separately.
  // Local ownership evidence survives until bounded release proves that exact
  // root disposition and broker-capability revocation.
  let cleanup = releaseFailedTaskRegistration(
    parsed.session,
    lease.data.anchorTargetId,
    lease.data.targetId,
    lease.data.targetKind,
    lease.data.receiptNonce,
    lease.data.account,
    lease.data.profileBinding,
    lease.data.browserGeneration,
    controllerEndpointPort(lease.data.controllerEndpointId),
    releaseLocalOptions(lease),
  );
  if (cleanup.ok !== true) return cleanup;
  try {
    root.removeOwned(bindingName(parsed.session), binding.raw);
    root.removeOwned(taskLeaseName(parsed.session), lease.raw);
  } catch (error) {
    cleanup = cleanupFailure(
      "session_metadata_cleanup_failed",
      error?.message || "Released session metadata cleanup failed",
    );
  }
  return cleanup;
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
      "--anchor-target-id",
      registration.anchorTargetId,
      "--root-target-id",
      registration.targetId,
      "--receipt-nonce",
      registration.receiptNonce,
      // WHY [AGENT-BROWSER-DYNAMIC-PORT-RECONCILE-001]: EREBORA runs on the
      // controller-attested dynamic Chrome port. Omitting it made the helper
      // scan the default endpoint, cross this call's 25-second deadline, and
      // falsely reject an otherwise successful browser action.
      "--port",
      String(authority.upstreamPort),
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
      "anchorTargetId",
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
    result.anchorTargetId !== registration.anchorTargetId ||
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
    (data.targetKind === TASK_ROOT_TARGET_KIND
      ? data.restorationKind !== "task-root-tab-and-hwnd" ||
        !validControllerTargetId(data.priorActiveTabId)
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
      "FOREGROUND_REQUIRED; the declared user-input boundary has no exact active controller focus lease",
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

function daemonTransportRebindBase(parsed, lease, state) {
  return {
    schema: DAEMON_TRANSPORT_REBIND_REQUEST_SCHEMA,
    requestId: randomBytes(32).toString("hex"),
    session: parsed.session,
    daemon: {
      pid: state.pid,
      startTicks: state.startTicks,
      socketPath: join(SOCKET_ROOT, `${parsed.session}.sock`),
      socketDev: state.socketInfo.dev.toString(),
      socketIno: state.socketInfo.ino.toString(),
    },
    root: {
      anchorTargetId: lease.data.anchorTargetId,
      targetId: lease.data.targetId,
      targetKind: lease.data.targetKind,
      browserContextId: lease.data.browserContextId,
      profileBinding: lease.data.profileBinding,
      browserGeneration: lease.data.browserGeneration,
      receiptNonce: lease.data.receiptNonce,
    },
    prior: {
      transportGeneration: lease.data.transportGeneration,
      brokerLeaseId: lease.data.brokerAuthorizationLeaseId,
    },
  };
}

function parseDaemonTransportRebindResult(result, requestId) {
  const canonicalLine = (value) =>
    typeof value === "string" &&
    value.length > 0 &&
    Buffer.byteLength(value) <= 16 * 1024 &&
    value.endsWith("\n") &&
    !value.slice(0, -1).includes("\n");
  if (
    result.status !== 0 ||
    result.signal ||
    result.stderr !== "" ||
    !canonicalLine(result.stdout)
  ) {
    fail(
      "SESSION_TRANSPORT_REBIND_HELPER_FAILED; the exact daemon handover did not settle",
      EX_UNAVAILABLE,
    );
  }
  const data = parseJson(
    Buffer.from(result.stdout.slice(0, -1), "utf8"),
    "daemon transport rebind result",
  );
  if (
    data?.schema !== DAEMON_TRANSPORT_REBIND_RESULT_SCHEMA ||
    data.requestId !== requestId ||
    typeof data.ok !== "boolean" ||
    typeof data.status !== "string"
  ) {
    fail("daemon transport rebind result is mismatched", EX_DATAERR);
  }
  if (data.ok !== true) {
    if (
      !exactKeys(data, [
        "schema",
        "ok",
        "status",
        "requestId",
        "reasonCode",
        "reason",
      ]) ||
      data.status !== "rejected" ||
      !/^[A-Z][A-Z0-9_]{2,63}$/.test(data.reasonCode) ||
      typeof data.reason !== "string" ||
      data.reason.length === 0 ||
      data.reason.length > 240 ||
      /[\u0000-\u001f\u007f-\u009f]/.test(data.reason)
    ) {
      fail("daemon transport rebind failure is invalid", EX_DATAERR);
    }
    fail(`${data.reasonCode}; ${data.reason}`, EX_UNAVAILABLE);
  }
  return data;
}

function invokeDaemonTransportRebind(request) {
  const opened = openStaticFile(rebindClientPath, 128 * 1024);
  if (sha256(opened.raw) !== EXPECTED_REBIND_CLIENT_SHA256) {
    closeOpened(opened);
    fail("exact daemon rebind client hash mismatched", EX_SOFTWARE);
  }
  const input = Buffer.from(canonicalJson(request), "utf8");
  let result;
  try {
    result = spawnSync(
      "/usr/bin/node",
      [
        "/proc/self/fd/3",
        "--socket-root",
        SOCKET_ROOT,
        "--session",
        request.session,
        "--socket",
        request.daemon.socketPath,
        "--timeout-ms",
        "5000",
      ],
      {
        encoding: "utf8",
        env: BASE_CHILD_ENV,
        stdio: ["pipe", "pipe", "pipe", opened.fd],
        input,
        timeout: 7000,
        maxBuffer: 20 * 1024,
      },
    );
  } finally {
    input.fill(0);
    closeOpened(opened);
  }
  return parseDaemonTransportRebindResult(result, request.requestId);
}

function validateDaemonRebindIdentity(result, parsed, state) {
  if (
    result.session !== parsed.session ||
    result.daemonPid !== state.pid ||
    result.daemonStartTicks !== state.startTicks ||
    result.socketPath !== join(SOCKET_ROOT, `${parsed.session}.sock`) ||
    result.socketDev !== state.socketInfo.dev.toString() ||
    result.socketIno !== state.socketInfo.ino.toString()
  ) {
    fail("daemon changed during transport handover", EX_DATAERR);
  }
}

function prepareDaemonTransportRebind(parsed, lease, state) {
  const base = daemonTransportRebindBase(parsed, lease, state);
  const result = invokeDaemonTransportRebind({ ...base, phase: "prepare" });
  if (
    !exactKeys(result, [
      "schema",
      "ok",
      "status",
      "requestId",
      "session",
      "daemonPid",
      "daemonStartTicks",
      "socketPath",
      "socketDev",
      "socketIno",
      "handoverId",
      "rootTargetId",
      "targetCount",
      "topologySha256",
      "deadlineAt",
    ]) ||
    result.status !== "prepared" ||
    !/^[0-9a-f]{64}$/.test(result.handoverId) ||
    result.rootTargetId !== lease.data.targetId ||
    !Number.isSafeInteger(result.targetCount) ||
    result.targetCount < 1 ||
    result.targetCount > 64 ||
    !/^[0-9a-f]{64}$/.test(result.topologySha256) ||
    !Number.isSafeInteger(result.deadlineAt) ||
    result.deadlineAt <= Date.now() ||
    result.deadlineAt > Date.now() + 36_000
  ) {
    fail("daemon transport handover preparation is invalid", EX_DATAERR);
  }
  validateDaemonRebindIdentity(result, parsed, state);
  return { base, result };
}

function abortDaemonTransportRebind(prepared, parsed, state) {
  try {
    const request = {
      ...prepared.base,
      requestId: randomBytes(32).toString("hex"),
      phase: "abort",
      handoverId: prepared.result.handoverId,
    };
    const result = invokeDaemonTransportRebind(request);
    if (
      !exactKeys(result, [
        "schema",
        "ok",
        "status",
        "requestId",
        "session",
        "daemonPid",
        "daemonStartTicks",
        "socketPath",
        "socketDev",
        "socketIno",
        "handoverId",
        "rootTargetId",
      ]) ||
      result.status !== "aborted" ||
      result.handoverId !== prepared.result.handoverId ||
      result.rootTargetId !== prepared.base.root.targetId
    ) {
      return false;
    }
    validateDaemonRebindIdentity(result, parsed, state);
    return true;
  } catch {
    return false;
  }
}

function commitDaemonTransportRebind(
  prepared,
  parsed,
  state,
  renewal,
  authority,
) {
  const request = {
    ...prepared.base,
    requestId: randomBytes(32).toString("hex"),
    phase: "commit",
    handoverId: prepared.result.handoverId,
    renewed: {
      brokerGeneration: renewal.brokerGeneration,
      transportGeneration: renewal.transportGeneration,
      brokerLeaseId: renewal.brokerLeaseId,
      authorization: authority.authorization.value,
      brokerCdpWebSocketUrl: renewal.brokerCdpWebSocketUrl,
      consentGeneration: renewal.consentGeneration,
      brokerProducerContractSha256: renewal.brokerProducerContractSha256,
      brokerCapabilityExpiresAt: renewal.brokerCapabilityExpiresAt,
      renewedAt: renewal.renewedAt,
    },
  };
  const result = invokeDaemonTransportRebind(request);
  if (
    !exactKeys(result, [
      "schema",
      "ok",
      "status",
      "requestId",
      "session",
      "daemonPid",
      "daemonStartTicks",
      "socketPath",
      "socketDev",
      "socketIno",
      "handoverId",
      "rootTargetId",
      "activeTargetId",
      "targetCount",
      "priorTransportGeneration",
      "transportGeneration",
      "priorBrokerLeaseId",
      "brokerLeaseId",
      "topologySha256",
    ]) ||
    result.status !== "rebound" ||
    result.handoverId !== prepared.result.handoverId ||
    result.rootTargetId !== prepared.base.root.targetId ||
    typeof result.activeTargetId !== "string" ||
    !result.activeTargetId ||
    !Number.isSafeInteger(result.targetCount) ||
    result.targetCount < prepared.result.targetCount ||
    result.targetCount > 64 ||
    result.priorTransportGeneration !==
      prepared.base.prior.transportGeneration ||
    result.transportGeneration !== renewal.transportGeneration ||
    result.priorBrokerLeaseId !== prepared.base.prior.brokerLeaseId ||
    result.brokerLeaseId !== renewal.brokerLeaseId ||
    result.topologySha256 !== prepared.result.topologySha256
  ) {
    fail("daemon transport handover result is invalid", EX_DATAERR);
  }
  validateDaemonRebindIdentity(result, parsed, state);
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
  // The same transition lock guards cold creation and exact legacy retirement.
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
    !/^(?:caleb|erebora|profile-[0-9a-f]{64})$/.test(data.account) ||
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
  // An observation error cannot transfer the transition lock. Only proof that
  // the recorded process birth ended permits exact lock reclamation.
  return (
    processIdentityStatus(lock.data.pid, lock.data.startTicks) !== "dead"
  );
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

function requireExactBootstrapLock(root, session, bootstrapRaw) {
  const lock = loadBootstrapLock(root, session);
  if (!lock || !lock.raw.equals(bootstrapRaw)) {
    fail("session bootstrap ownership changed", EX_DATAERR);
  }
  return lock;
}

function requireClosedBootstrapNamespace(root, parsed, bootstrapRaw) {
  requireExactBootstrapLock(root, parsed.session, bootstrapRaw);
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
  requireExactBootstrapLock(root, parsed.session, bootstrapRaw);
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

function requireUnchangedLegacyRetirementSnapshot(
  root,
  session,
  binding,
  lease,
  expectedState,
  bootstrapRaw,
) {
  const check = () => {
    requireExactBootstrapLock(root, session, bootstrapRaw);
    requireUnchangedLegacyMetadata(root, session, binding, lease);
    const currentState = readSessionState(root, session);
    if (!sameLegacyRetirementState(currentState, expectedState)) {
      fail(
        "legacy session state changed during exact retirement",
        EX_UNAVAILABLE,
      );
    }
    requireLegacyOwnerlessRetirement(root, session, currentState, lease);
    return currentState;
  };
  check();
  return check();
}

function legacySocketReservationPayload(session, bootstrapRaw) {
  return Buffer.from(
    `${canonicalJson({
      schema: "agent-browser.socket-retirement-reservation.v1",
      session,
      bootstrapSha256: sha256(bootstrapRaw),
      pid: process.pid,
      startTicks: processStartTicks(process.pid),
      nonce: randomBytes(32).toString("hex"),
    })}\n`,
    "utf8",
  );
}

function requireLegacySocketReservation(
  root,
  session,
  binding,
  lease,
  bootstrapRaw,
  reservationRaw,
) {
  const check = () => {
    requireExactBootstrapLock(root, session, bootstrapRaw);
    requireUnchangedLegacyMetadata(root, session, binding, lease);
    const reservation = root.openFile(`${session}.sock`, 4096, 0o600, {
      allowMissing: true,
    });
    if (!reservation || !reservation.raw.equals(reservationRaw)) {
      closeOpened(reservation);
      fail(
        "legacy socket retirement reservation changed",
        EX_UNAVAILABLE,
      );
    }
    closeOpened(reservation);
    if (
      root.lstat(`${session}.pid`) ||
      root.lstat(`${session}.stream`) ||
      root.lstat(`${session}.port`) ||
      root.lstat(`${session}.daemon-identity`) ||
      !processIdentityIsDefinitelyDead(lease.data.pid, lease.data.startTicks) ||
      socketPathHasLiveKernelEndpoint(join(SOCKET_ROOT, `${session}.sock`))
    ) {
      fail(
        "LEGACY_SESSION_OWNER_UNKNOWN; the exact legacy session changed while its socket path was reserved",
        EX_UNAVAILABLE,
      );
    }
  };
  check();
  check();
}

function acquireLegacySocketReservation(
  root,
  session,
  binding,
  lease,
  bootstrapRaw,
) {
  const raw = legacySocketReservationPayload(session, bootstrapRaw);
  if (!root.writeAtomic(`${session}.sock`, raw, { exclusive: true })) {
    fail(
      "LEGACY_SESSION_OWNER_UNKNOWN; the legacy socket path changed before retirement",
      EX_UNAVAILABLE,
    );
  }
  try {
    requireLegacySocketReservation(
      root,
      session,
      binding,
      lease,
      bootstrapRaw,
      raw,
    );
    return raw;
  } catch (error) {
    root.removeOwned(`${session}.sock`, raw);
    throw error;
  }
}

function retireLegacyOwnerlessSession(
  root,
  parsed,
  binding,
  lease,
  identity,
  initialState,
) {
  let bootstrapRaw = null;
  let reservationRaw = null;
  try {
    bootstrapRaw = acquireBootstrapLock(root, parsed, identity);
    const state = requireUnchangedLegacyRetirementSnapshot(
      root,
      parsed.session,
      binding,
      lease,
      initialState,
      bootstrapRaw,
    );
    if (state.kind === "stale") {
      cleanupExactStaleSession(root, parsed.session, state, lease.data);
    }
    if (readSessionState(root, parsed.session).kind !== "closed") {
      fail(
        "legacy session did not reach a closed local namespace",
        EX_UNAVAILABLE,
      );
    }
    // WHY: the transition lock serializes supported creators, while this exact
    // regular-file reservation closes the Unix bind gap between death proof and
    // metadata retirement. Any competing endpoint wins O_EXCL and is preserved.
    reservationRaw = acquireLegacySocketReservation(
      root,
      parsed.session,
      binding,
      lease,
      bootstrapRaw,
    );
    requireLegacySocketReservation(
      root,
      parsed.session,
      binding,
      lease,
      bootstrapRaw,
      reservationRaw,
    );
    restoreOwnedFocusLease(root, parsed.session, lease);
    requireLegacySocketReservation(
      root,
      parsed.session,
      binding,
      lease,
      bootstrapRaw,
      reservationRaw,
    );
    releaseTaskRegistration(
      parsed.session,
      lease.data.anchorTargetId,
      lease.data.targetId,
      lease.data.targetKind,
      lease.data.receiptNonce,
      releaseLocalOptions(lease),
    );
    requireLegacySocketReservation(
      root,
      parsed.session,
      binding,
      lease,
      bootstrapRaw,
      reservationRaw,
    );
    root.removeOwned(bindingName(parsed.session), binding.raw);
    root.removeOwned(taskLeaseName(parsed.session), lease.raw);
    root.removeOwned(`${parsed.session}.sock`, reservationRaw);
    reservationRaw = null;
    if (readSessionState(root, parsed.session).kind !== "closed") {
      fail("legacy session retirement did not remain closed", EX_UNAVAILABLE);
    }
    return 0;
  } finally {
    if (reservationRaw) {
      root.removeOwned(`${parsed.session}.sock`, reservationRaw);
    }
    if (bootstrapRaw) {
      root.removeOwned(bootstrapLockName(parsed.session), bootstrapRaw);
    }
  }
}

function handleClose(
  root,
  parsed,
  binding,
  { allowDeadOwner = true } = {},
) {
  let state = readSessionState(root, parsed.session);
  const lease = loadTaskLease(root, parsed.session);
  const owner = parsed.agentOwner;
  if (state.kind === "closed") {
    if (!binding && !lease) return 0;
    requireCloseMetadataPair(binding, lease, "closed");
  }
  if (state.kind === "stale") {
    requireCloseMetadataPair(binding, lease, "stale");
  }
  if (lease?.ownership === "legacy-ownerless") {
    requireCloseMetadataPair(binding, lease, "legacy");
  }
  let requestedIdentity = null;
  let identity = binding
    ? { account: binding.account, profile: binding.profile, email: "" }
    : null;
  if (binding && parsed.account) {
    requestedIdentity = accountIdentity(parsed.account);
    identity = requestedIdentity;
    parsed.account = requestedIdentity.account;
    if (requestedIdentity.account !== binding.account) {
      fail(
        `session is bound to ${binding.account}; close it without rebinding`,
        EX_DATAERR,
      );
    }
  }
  if (lease?.ownership === "legacy-ownerless") {
    identity = requestedIdentity ?? accountIdentityForBinding(binding);
    return retireLegacyOwnerlessSession(
      root,
      parsed,
      binding,
      lease,
      identity,
      state,
    );
  }
  if (state.kind === "closed") {
    // Local metadata may be released only when both records prove this wrapper
    // owned the already-empty lane. Exact focus/session registrations are
    // restored/released; the exact task root closes while the broker, user
    // tabs, and unrelated sessions remain, and an idle anchor retires.
    validateAgentOwner(lease, owner, { allowDeadOwner });
    restoreOwnedFocusLease(root, parsed.session, lease);
    releaseTaskRegistration(
      parsed.session,
      lease.data.anchorTargetId,
      lease.data.targetId,
      lease.data.targetKind,
      lease.data.receiptNonce,
      releaseLocalOptions(lease),
    );
    root.removeOwned(bindingName(parsed.session), binding.raw);
    root.removeOwned(taskLeaseName(parsed.session), lease.raw);
    return 0;
  }
  if (state.kind === "stale") {
    validateAgentOwner(lease, owner, { allowDeadOwner });
    validateStaleOwnership(root, parsed.session, state, lease.data);
    restoreOwnedFocusLease(root, parsed.session, lease);
    cleanupExactStaleSession(root, parsed.session, state, lease.data);
    releaseTaskRegistration(
      parsed.session,
      lease.data.anchorTargetId,
      lease.data.targetId,
      lease.data.targetKind,
      lease.data.receiptNonce,
      releaseLocalOptions(lease),
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
  const graph = loadCanonicalRuntimeGraph();
  validateDaemonIdentity(root, parsed.session, state, graph);
  validateLocalTaskOwnership(lease, state, identity, owner, {
    allowDeadOwner,
  });
  restoreOwnedFocusLease(root, parsed.session, lease);
  let authority;
  try {
    authority = loadTransportAuthority(parsed.session, lease);
  } catch (error) {
    if (
      !(error instanceof WrapperError) ||
      error.code !== EX_UNAVAILABLE ||
      error.message !== EXACT_EXPIRED_RELEASE_HEALTH_DRIFT
    ) {
      throw error;
    }
    const expiresAtMs = canonicalRfc3339Milliseconds(
      lease.data.brokerCapabilityExpiresAt,
    );
    if (expiresAtMs === null || expiresAtMs > Date.now()) throw error;

    // WHY [AGENT-BROWSER-HEALTH-DRIFT-EXPIRED-CLOSE-001]: an exact task root
    // can disappear before its expired broker capability is revoked, causing
    // the broker to disable authentication for every caller. Native close can
    // no longer authenticate in that state. Only after re-proving the exact
    // local agent, daemon source, PID/start, socket, lease bytes, and expired
    // capability may close stop that daemon and invoke the controller's exact
    // release transaction. The controller then revokes only this lease and
    // closes only its registered task tree; no user tab or sibling session is
    // selected here.
    revalidateCanonicalRuntimeGraph(graph);
    const currentBinding = loadBinding(root, parsed.session);
    const currentLease = loadTaskLease(root, parsed.session);
    state = readSessionState(root, parsed.session);
    if (
      !currentBinding ||
      !currentLease ||
      currentLease.ownership !== "agent" ||
      !currentBinding.raw.equals(binding.raw) ||
      !currentLease.raw.equals(lease.raw)
    ) {
      fail(
        "expired health-drift close ownership changed before recovery",
        EX_DATAERR,
      );
    }
    validateLocalTaskOwnership(currentLease, state, identity, owner, {
      allowDeadOwner,
    });
    validateDaemonIdentity(root, parsed.session, state, graph);
    if (!stopExactProcess(state.pid, state.startTicks, Date.now() + 3000)) {
      fail(
        "expired health-drift close daemon remained live",
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
        "expired health-drift close did not retire the exact daemon namespace",
        EX_UNAVAILABLE,
      );
    }
    releaseTaskRegistration(
      parsed.session,
      lease.data.anchorTargetId,
      lease.data.targetId,
      lease.data.targetKind,
      lease.data.receiptNonce,
      releaseLocalOptions(lease),
    );
    root.removeOwned(bindingName(parsed.session), binding.raw);
    root.removeOwned(taskLeaseName(parsed.session), lease.raw);
    return 0;
  }
  if (authority.warm) {
    const attestedIdentity = authority.profileIdentity;
    if (
      !attestedIdentity ||
      attestedIdentity.account !== binding.account ||
      attestedIdentity.profile !== binding.profile ||
      (requestedIdentity &&
        (requestedIdentity.account !== attestedIdentity.account ||
          requestedIdentity.profile !== attestedIdentity.profile ||
          requestedIdentity.email !== attestedIdentity.email))
    ) {
      fail(
        "warm close identity no longer matches the exact Stable profile binding",
        EX_DATAERR,
      );
    }
    identity = attestedIdentity;
  } else if (!requestedIdentity) {
    identity = accountIdentityForBinding(binding);
  }
  let native;
  try {
    state = readSessionState(root, parsed.session);
    validateTaskLease(lease, state, identity, authority, owner, {
      allowDeadOwner,
    });
    authority = bindTransportAuthorization(authority, lease.data);
    revalidateCanonicalRuntimeGraph(graph);
    validateDaemonIdentity(root, parsed.session, state, graph);
    native = new NativeRuntime(root);
    native.ensureRevision();
    revalidateCanonicalRuntimeGraph(graph);
    state = readSessionState(root, parsed.session);
    validateTaskLease(lease, state, identity, authority, owner, {
      allowDeadOwner,
    });
    validateDaemonIdentity(root, parsed.session, state, graph);
    let result;
    try {
      result = native.run(
        nativeArgs(parsed, authority),
        nativeProfileEnv(identity, null, graph, authority),
      );
    } catch (error) {
      throw appendCleanupFailure(
        error,
        releaseFailedExplicitClose(root, parsed, binding, lease),
      );
    }
    if (result.status !== 0) {
      const status = result.status ?? 1;
      const cleanup = releaseFailedExplicitClose(root, parsed, binding, lease);
      if (cleanup.ok !== true) {
        throw appendCleanupFailure(
          new WrapperError(
            `NATIVE_CLOSE_FAILED; exact native close exited with status ${status}`,
            status,
          ),
          cleanup,
        );
      }
      return status;
    }
    releaseTaskRegistration(
      parsed.session,
      lease.data.anchorTargetId,
      lease.data.targetId,
      lease.data.targetKind,
      lease.data.receiptNonce,
      releaseLocalOptions(lease, {
        port: authority.upstreamPort,
        brokerProducerContractSha256:
          authority.attestation.brokerProducerContractSha256,
      }),
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
  const identity = accountIdentityForBinding(binding);
  const owner = parsed.agentOwner;
  if (parsed.account) {
    const requested = accountIdentity(parsed.account);
    parsed.account = requested.account;
    if (requested.account !== binding.account) {
      fail(`session is bound to ${binding.account}; close it before rebinding`, EX_DATAERR);
    }
  }
  validateLocalTaskOwnership(lease, state, identity, owner);
  let authority = loadTransportAuthority(parsed.session, lease);
  let native;
  try {
    validateTaskLease(lease, state, identity, authority, owner);
    authority = bindTransportAuthorization(authority, lease.data);
    native = new NativeRuntime(root);
    native.ensureRevision();
    revalidateCanonicalRuntimeGraph(graph);
    state = readSessionState(root, parsed.session);
    validateTaskLease(lease, state, identity, authority, owner);
    validateDaemonIdentity(root, parsed.session, state, graph);
    const result = native.run(
      ["--session", parsed.session, "session", "list"],
      nativeProfileEnv(identity, null, graph, authority),
    );
    authority = revalidateTransportAuthority(authority, parsed.session, lease);
    return result.status ?? 1;
  } finally {
    native?.close();
  }
}

function renewedTaskLeasePayload(lease, renewal, authority) {
  return Buffer.from(
    `${canonicalJson({
      ...lease.data,
      controllerEndpointId: authority.data.controller_endpoint_id,
      browserGeneration: authority.browserGeneration,
      brokerGeneration: authority.data.broker_generation,
      transportGeneration: authority.transportGeneration,
      registrationReceiptSha256: renewal.registrationReceiptSha256,
      brokerAuthorizationLeaseId: renewal.brokerLeaseId,
      brokerAuthorizationPath: renewal.brokerAuthFilePath,
      brokerAuthorizationSha256: renewal.brokerAuthFileSha256,
      brokerCapabilityExpiresAt: renewal.brokerCapabilityExpiresAt,
      leaseId: randomBytes(32).toString("hex"),
    })}\n`,
    "utf8",
  );
}

function renewExpiringTaskSessionTransport(root, parsed, binding, state) {
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
  const identity = accountIdentityForBinding(binding);
  const owner = parsed.agentOwner;
  validateLocalTaskOwnership(lease, state, identity, owner);
  if (lease.data.targetKind !== TASK_ROOT_TARGET_KIND) {
    fail(
      "TARGET_RESELECTION_REQUIRED; an expiring explicit user-tab collaboration cannot be silently renewed",
      EX_UNAVAILABLE,
    );
  }
  const graph = loadCanonicalRuntimeGraph();
  validateDaemonIdentity(root, parsed.session, state, graph);
  if (loadFocusLease(root, parsed.session, lease)) {
    if (expiresAt <= Date.now()) {
      fail(
        "TRANSPORT_RENEWAL_REQUIRES_BACKGROUND; expired foreground authority cannot be changed implicitly",
        EX_UNAVAILABLE,
      );
    }
    restoreOwnedFocusLease(root, parsed.session, lease);
  }

  const priorAuthority = loadTransportAuthority(parsed.session, lease);
  if (
    priorAuthority.data.controller_endpoint_id !==
      lease.data.controllerEndpointId ||
    priorAuthority.browserGeneration !== lease.data.browserGeneration
  ) {
    fail(
      "BROWSER_GENERATION_CHANGED; the exact task root cannot cross a browser restart",
      EX_UNAVAILABLE,
    );
  }

  const prepared = prepareDaemonTransportRebind(parsed, lease, state);
  let response;
  let result;
  let authority;
  let commitStarted = false;
  try {
    response = parseControllerJsonLine(
      runController([
      "renew-session-transport",
      "--session",
      parsed.session,
      "--anchor-target-id",
      lease.data.anchorTargetId,
      "--target-id",
      lease.data.targetId,
      "--receipt-nonce",
      lease.data.receiptNonce,
      "--daemon-pid",
      String(lease.data.pid),
      "--daemon-start-ticks",
      lease.data.startTicks,
      "--socket",
      join(SOCKET_ROOT, `${parsed.session}.sock`),
      "--socket-dev",
      lease.data.socketDev,
      "--socket-ino",
      lease.data.socketIno,
      "--prior-browser-generation",
      lease.data.browserGeneration,
      "--prior-transport-generation",
      lease.data.transportGeneration,
      "--prior-broker-lease-id",
      lease.data.brokerAuthorizationLeaseId,
      "--port",
      String(priorAuthority.upstreamPort),
      "--json",
      ]),
      "controller session transport renewal",
      "SESSION_TRANSPORT_RENEWAL_FAILED; exact task root remains on expiring authority",
    );
    result = response.data;
    if (
      !exactKeys(result, [
      "schema",
      "ok",
      "status",
      "session",
      "account",
      "profileDirectory",
      "profileEmail",
      "anchorTargetId",
      "targetId",
      "targetKind",
      "browserContextId",
      "profileBinding",
      "browserGeneration",
      "brokerGeneration",
      "transportGeneration",
      "receiptNonce",
      "daemonPid",
      "daemonStartTicks",
      "socketPath",
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
      "priorBrokerCapabilityRevoked",
      "renewedAt",
    ]) ||
    result.schema !== SESSION_TRANSPORT_RENEWAL_SCHEMA ||
    result.ok !== true ||
    result.status !== "renewed" ||
    result.session !== parsed.session ||
    result.account !== identity.account ||
    result.profileDirectory !== identity.profile ||
    result.profileEmail !== identity.email ||
    result.anchorTargetId !== lease.data.anchorTargetId ||
    result.targetId !== lease.data.targetId ||
    result.targetKind !== lease.data.targetKind ||
    result.browserContextId !== lease.data.browserContextId ||
    result.profileBinding !== lease.data.profileBinding ||
    result.browserGeneration !== lease.data.browserGeneration ||
    !/^[0-9a-f]{64}$/.test(result.brokerGeneration) ||
    !/^[0-9a-f]{64}$/.test(result.transportGeneration) ||
    result.receiptNonce !== lease.data.receiptNonce ||
    result.daemonPid !== lease.data.pid ||
    result.daemonStartTicks !== lease.data.startTicks ||
    result.socketPath !== join(SOCKET_ROOT, `${parsed.session}.sock`) ||
    result.socketDev !== lease.data.socketDev ||
    result.socketIno !== lease.data.socketIno ||
    !/^[0-9a-f]{64}$/.test(result.brokerLeaseId) ||
    result.brokerAuthFilePath !==
      expectedBrokerAuthorizationPath(
        lease.data.controllerEndpointId,
        result.brokerLeaseId,
      ) ||
    !/^[0-9a-f]{64}$/.test(result.brokerAuthFileSha256) ||
    typeof result.brokerCdpWebSocketUrl !== "string" ||
    typeof result.brokerHealthUrl !== "string" ||
    !/^[0-9a-f]{64}$/.test(result.consentGeneration) ||
    !/^[0-9a-f]{64}$/.test(result.brokerProducerContractSha256) ||
    canonicalRfc3339Milliseconds(result.brokerCapabilityExpiresAt) === null ||
    canonicalRfc3339Milliseconds(result.brokerCapabilityExpiresAt) <=
      Date.now() + BROKER_CAPABILITY_REACQUIRE_MARGIN_MS ||
    result.priorBrokerCapabilityRevoked !== true ||
    !Number.isSafeInteger(result.renewedAt) ||
    result.renewedAt <= 0 ||
      result.renewedAt > Date.now() + 1_000
    ) {
      fail(
        "controller returned a mismatched session transport renewal",
        EX_DATAERR,
      );
    }

    authority = loadTransportAuthority(parsed.session);
    if (
      authority.data.controller_endpoint_id !==
        lease.data.controllerEndpointId ||
      authority.browserGeneration !== lease.data.browserGeneration
    ) {
      fail(
        "BROWSER_GENERATION_CHANGED; the exact task root cannot cross a browser restart",
        EX_UNAVAILABLE,
      );
    }
    if (
      authority.data.broker_generation !== result.brokerGeneration ||
      authority.transportGeneration !== result.transportGeneration ||
      authority.webSocketUrl !== result.brokerCdpWebSocketUrl ||
      authority.healthUrl !== result.brokerHealthUrl ||
      authority.data.consent_generation !== result.consentGeneration ||
      authority.snapshot.broker.producerContractSha256 !==
        result.brokerProducerContractSha256
    ) {
      fail(
        "renewed session transport did not match current controller authority",
        EX_DATAERR,
      );
    }
    authority = bindTransportAuthorization(authority, {
      brokerAuthorizationLeaseId: result.brokerLeaseId,
      brokerAuthorizationPath: result.brokerAuthFilePath,
      brokerAuthorizationSha256: result.brokerAuthFileSha256,
    });
    state = readSessionState(root, parsed.session);
    validateLocalTaskOwnership(lease, state, identity, owner);
    validateDaemonIdentity(root, parsed.session, state, graph);
    commitStarted = true;
    commitDaemonTransportRebind(
      prepared,
      parsed,
      state,
      result,
      authority,
    );
    state = readSessionState(root, parsed.session);
    validateLocalTaskOwnership(lease, state, identity, owner);
    validateDaemonIdentity(root, parsed.session, state, graph);
  } catch (error) {
    if (!commitStarted) {
      let aborted = false;
      try {
        const abortState = readSessionState(root, parsed.session);
        validateLocalTaskOwnership(lease, abortState, identity, owner);
        validateDaemonIdentity(root, parsed.session, abortState, graph);
        aborted = abortDaemonTransportRebind(prepared, parsed, abortState);
      } catch {
        aborted = false;
      }
      if (!aborted) {
        const code = Number.isSafeInteger(error?.code)
          ? error.code
          : EX_UNAVAILABLE;
        throw new WrapperError(
          sanitize(
            `${error?.message || "session transport renewal failed"}; TRANSPORT_REBIND_ABORT_FAILED; exact daemon handover remains blocked until its bounded deadline`,
          ),
          code,
        );
      }
    }
    throw error;
  }
  const renewed = {
    ...result,
    registrationReceiptSha256: sha256(response.raw),
  };
  const renewedRaw = renewedTaskLeasePayload(lease, renewed, authority);
  root.replaceOwned(taskLeaseName(parsed.session), lease.raw, renewedRaw);
  const published = loadTaskLease(root, parsed.session);
  if (!published || !published.raw.equals(renewedRaw)) {
    fail("renewed task ownership lease was not durably published", EX_SOFTWARE);
  }
  validateTaskLease(published, state, identity, authority, owner);
  return { state, binding };
}

function handleBrowserAction(root, parsed, binding) {
  let state = readSessionState(root, parsed.session);
  const owner = parsed.agentOwner;
  const priorLease = loadTaskLease(root, parsed.session);
  if (priorLease?.ownership === "legacy-ownerless") {
    requireLegacyOwnerlessRetirement(root, parsed.session, state, priorLease);
    fail(
      "LEGACY_SESSION_RETIRE_REQUIRED; close the exact dead legacy namespace before reuse",
      EX_UNAVAILABLE,
    );
  }
  if (binding && priorLease) {
    const ownerState = validateAgentOwner(priorLease, owner, {
      allowDeadOwner: true,
    });
    if (ownerState === "dead-owner") {
      // WHY: a named session may be reused only after the exact prior agent
      // birth is dead and the normal close path has retired its attested
      // daemon, socket, root/descendants, capability, and local records.  A
      // live foreign owner is rejected above; no URL/title/tab guess is used.
      handleClose(
        root,
        {
          ...parsed,
          account: null,
          command: "close",
          commandArgs: [],
          expectPopup: false,
          targetLease: null,
        },
        binding,
        { allowDeadOwner: true },
      );
      state = readSessionState(root, parsed.session);
      binding = loadBinding(root, parsed.session);
      if (state.kind !== "closed" || binding || loadTaskLease(root, parsed.session)) {
        fail(
          "DEAD_OWNER_RECOVERY_FAILED; exact prior session did not retire",
          EX_UNAVAILABLE,
        );
      }
    }
  }
  if (parsed.currentTab && state.kind !== "closed") {
    fail(
      "--current-tab is cold-bootstrap-only and cannot rebind an existing session namespace",
      EX_DATAERR,
    );
  }
  ({ state, binding } = renewExpiringTaskSessionTransport(
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
      "POPUP_SESSION_REQUIRED; popup-producing collaboration requires an already registered session",
      EX_UNAVAILABLE,
    );
  }
  if (parsed.targetLease && !createsSession) {
    fail(
      "target leases are bootstrap-only and cannot rebind a live daemon",
      EX_DATAERR,
    );
  }

  const requestedIdentity = parsed.account ? accountIdentity(parsed.account) : null;
  if (requestedIdentity) parsed.account = requestedIdentity.account;
  if (binding && requestedIdentity && requestedIdentity.account !== binding.account) {
    fail(
      `session is bound to ${binding.account}; close it before rebinding`,
      EX_DATAERR,
    );
  }
  // A live task lease already binds the exact account/profile. Its email is
  // accepted only after the controller reopens the matching registered
  // provenance and Stable Local State in the warm attestation below. This
  // avoids a separate resolver process without trusting local binding text as
  // profile authority.
  let identity = binding
    ? requestedIdentity ?? {
        account: binding.account,
        email: "",
        profile: binding.profile,
      }
    : requestedIdentity ?? accountIdentity("");
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
      lease = loadTaskLease(root, parsed.session);
      validateLocalTaskOwnership(lease, state, identity, owner);
    }
    if (createsSession) {
      bootstrapRaw = acquireBootstrapLock(root, parsed, identity);
      state = requireClosedBootstrapNamespace(root, parsed, bootstrapRaw);
    }
    if (!createsSession && parsed.command === "background") {
      restoreOwnedFocusLease(root, parsed.session, lease);
      return 0;
    }
    let coldBootstrap = null;
    if (createsSession) {
      const exactLock = requireExactBootstrapLock(
        root,
        parsed.session,
        bootstrapRaw,
      );
      coldBootstrap = {
        account: identity.account,
        requestId: exactLock.data.nonce,
        requesterPid: exactLock.data.pid,
        requesterStartTicks: exactLock.data.startTicks,
        verify: () => {
          state = requireClosedBootstrapNamespace(
            root,
            parsed,
            bootstrapRaw,
          );
        },
      };
    }
    authority = loadTransportAuthority(
      parsed.session,
      lease,
      null,
      coldBootstrap,
    );
    if (!createsSession) {
      if (authority.warm) {
        const attestedIdentity = authority.profileIdentity;
        if (
          !attestedIdentity ||
          attestedIdentity.account !== binding.account ||
          attestedIdentity.profile !== binding.profile ||
          (requestedIdentity &&
            (requestedIdentity.account !== attestedIdentity.account ||
              requestedIdentity.profile !== attestedIdentity.profile ||
              requestedIdentity.email !== attestedIdentity.email))
        ) {
          fail(
            "warm session identity no longer matches the exact Stable profile binding",
            EX_DATAERR,
          );
        }
        identity = attestedIdentity;
      } else if (!requestedIdentity) {
        // Any warm mismatch keeps the existing full resolver/ensure path.
        identity = accountIdentityForBinding(binding);
      }
    }
    if (createsSession) {
      if (parsed.currentTab) {
        autoAcquiredLocation = acquireCurrentTabTargetLease(
          parsed,
          identity,
          authority,
        );
        // Target invitation can outlive the five-second process snapshot.
        // Re-prove the same generations before trusting its exact receipt.
        authority = refreshTransportAuthority(authority, parsed.session, lease);
      } else if (!parsed.targetLease) {
        autoAcquiredLocation = acquireSessionTaskRootLease(
          parsed,
          identity,
          authority,
          () => {
            state = requireClosedBootstrapNamespace(root, parsed, bootstrapRaw);
          },
        );
        // Record the exact issued root before validating the controller's
        // locally renewed proof. A mismatch can therefore retire only this
        // root and can never reach receipt consumption or native execution.
        authority = adoptAcquiredTransportProof(
          authority,
          autoAcquiredLocation,
        );
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
      validateTaskLease(lease, state, identity, authority, owner);
      authority = bindTransportAuthorization(authority, lease.data);
    }
    if (!createsSession && parsed.command === "foreground") {
      graph = revalidateCanonicalRuntimeGraph(graph);
      state = readSessionState(root, parsed.session);
      validateTaskLease(lease, state, identity, authority, owner);
      validateDaemonIdentity(root, parsed.session, state, graph);
      acquireOwnedFocusLease(root, parsed.session, lease);
      authority =
        tryAttestAndReconcileWarmTransportAuthority(
          authority,
          parsed.session,
          lease,
        ) ??
        revalidateTransportAuthority(authority, parsed.session, lease);
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
      // Popups are target-lifecycle work, not a human-input boundary. Keep the
      // exact session in the background and reconcile the new target through
      // broker provenance; foreground is reserved for --input-boundary.
      graph = revalidateCanonicalRuntimeGraph(graph);
      state = readSessionState(root, parsed.session);
      validateTaskLease(lease, state, identity, authority, owner);
      validateDaemonIdentity(root, parsed.session, state, graph);
      const result = runPopupClick(parsed);
      const warmReconciled = tryAttestAndReconcileWarmTransportAuthority(
        authority,
        parsed.session,
        lease,
      );
      if (warmReconciled) {
        authority = warmReconciled;
      } else {
        if (TARGET_CREATING_COMMANDS.has(parsed.command)) {
          reconcileSessionTargets(parsed, authority, lease.data);
        }
        authority = revalidateTransportAuthority(
          authority,
          parsed.session,
          lease,
        );
      }
      writeTransportCache(root, authority, native);
      return result.status ?? 1;
    }

    graph = revalidateCanonicalRuntimeGraph(graph);
    state = readSessionState(root, parsed.session);
    if (!createsSession) {
      validateTaskLease(lease, state, identity, authority, owner);
    }
    validateDaemonIdentity(root, parsed.session, state, graph);
    const result = native.run(
      nativeArgs(parsed, authority),
      nativeProfileEnv(identity, claim, graph, authority),
    );
    if (claim) verifyTargetClaimed(claim);
    let warmReconciled = false;
    if (!createsSession || result.status !== 0) {
      const warmAuthority = !createsSession
        ? tryAttestAndReconcileWarmTransportAuthority(
            authority,
            parsed.session,
            lease,
          )
        : null;
      if (warmAuthority) {
        authority = warmAuthority;
        warmReconciled = true;
      } else {
        authority = revalidateTransportAuthority(
          authority,
          parsed.session,
          lease,
        );
      }
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
        releaseConsumedTargetLease(parsed, identity, claim);
        claimReleased = true;
      } else if (
        TARGET_CREATING_COMMANDS.has(parsed.command) &&
        !warmReconciled
      ) {
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
        owner,
      );
      validateRegisteredSessionProof(parsed, identity, authority, state, claim);
      createdLeaseRaw = taskLeasePayload(
        parsed.session,
        identity,
        authority,
        state,
        registration,
        owner,
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
      lease = loadTaskLease(root, parsed.session);
      const warmAuthority = tryAttestAndReconcileWarmTransportAuthority(
        authority,
        parsed.session,
        lease,
      );
      if (warmAuthority) {
        authority = warmAuthority;
        warmReconciled = true;
      }
    }
    if (
      !warmReconciled &&
      (createsSession || TARGET_CREATING_COMMANDS.has(parsed.command))
    ) {
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
          registration.anchorTargetId,
          registration.targetId,
          registration.targetKind,
          registration.receiptNonce,
          registration.account,
          registration.profileBinding,
          registration.browserGeneration,
          authority?.upstreamPort ?? null,
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
      const released = parsed.currentTab
        ? releaseFailedPendingCurrentTabLease(
            parsed,
            identity,
            autoAcquiredLocation,
          )
        : releaseFailedPendingTaskRootLease(
            parsed,
            identity,
            autoAcquiredLocation.receipt,
          );
      if (released.ok !== true) failedCleanup = released;
    }
    if (!ownershipCommitted && !registration && claim && !claimReleased) {
      releaseConsumedTargetLease(parsed, identity, claim);
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
  if (parsed.command === "recover-metamask-vault")
    return runMetaMaskVaultRecovery(parsed);
  parsed.agentOwner = invokingAgentIdentity();

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

let isMainModule = false;
try {
  isMainModule = Boolean(process.argv[1]) && realpathSync(process.argv[1]) === scriptPath;
} catch {}

if (isMainModule) {
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
}
