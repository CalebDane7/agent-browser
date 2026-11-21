import net from "node:net";
import { acquireAdmissionLock } from "./agent-browser-admission-lock.mjs";
import { spawn } from "node:child_process";
import {
  closeSync,
  constants,
  fstatSync,
  openSync,
  readSync,
  lstatSync,
  readFileSync,
  realpathSync,
  unlinkSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { requestExtensionControl } from "./agent-browser-extension-control.js";
import { exactKeys, sha256 } from "./agent-browser-extension-protocol.js";

const scriptDir = dirname(realpathSync(fileURLToPath(import.meta.url)));
const brokerPath = join(scriptDir, "agent-browser-extension-broker.js");

function processStartTicks(pid) {
  const raw = readFileSync(`/proc/${pid}/stat`, "utf8").trim();
  const close = raw.lastIndexOf(")");
  if (close < 0) throw new Error("broker process identity is unavailable");
  const fields = raw.slice(close + 2).split(" ");
  const value = fields[19];
  if (!/^[0-9]+$/.test(value ?? "")) {
    throw new Error("broker process identity is invalid");
  }
  return value;
}

function assertPrivateFile(path, maxBytes = 64 * 1024) {
  const stat = lstatSync(path, { bigint: true });
  if (
    stat.isSymbolicLink() ||
    !stat.isFile() ||
    Number(stat.uid) !== process.getuid() ||
    Number(stat.mode & 0o077n) !== 0 ||
    stat.size <= 0n ||
    stat.size > BigInt(maxBytes)
  ) {
    throw new Error("broker authority file is unsafe");
  }
  return stat;
}

function assertPrivateDirectory(path) {
  const stat = lstatSync(path, { bigint: true });
  if (
    stat.isSymbolicLink() ||
    !stat.isDirectory() ||
    Number(stat.uid) !== process.getuid() ||
    Number(stat.mode & 0o777n) !== 0o700 ||
    realpathSync(path) !== path
  ) {
    throw new Error("broker state root is unsafe");
  }
}

function readReceipt(stateRoot, profileConfig, requireLive = true) {
  assertPrivateDirectory(stateRoot);
  const path = join(stateRoot, "broker.json");
  const receipt = JSON.parse(privateSnapshot(path).bytes.toString("utf8"));
  const config = privateSnapshot(profileConfig);
  if (
    !exactKeys(receipt, [
      "schema",
      "pid",
      "startTicks",
      "sourceSha256",
      "profileConfigSha256",
      "nativeSocket",
      "controlSocket",
      "webSocketAddress",
      "webSocketPort",
    ]) ||
    receipt.schema !== "agent-browser.extension-broker-ready.v1" ||
    !Number.isSafeInteger(receipt.pid) ||
    receipt.pid <= 0 ||
    typeof receipt.startTicks !== "string" ||
    !/^[0-9]+$/.test(receipt.startTicks) ||
    !/^[0-9a-f]{64}$/.test(receipt.sourceSha256) ||
    !/^[0-9a-f]{64}$/.test(receipt.profileConfigSha256) ||
    receipt.sourceSha256 !== sha256(readFileSync(brokerPath)) ||
    receipt.profileConfigSha256 !== sha256(config.bytes) ||
    receipt.nativeSocket !== join(stateRoot, "native.sock") ||
    receipt.controlSocket !== join(stateRoot, "control.sock") ||
    receipt.webSocketAddress !== "127.0.0.1" ||
    !Number.isSafeInteger(receipt.webSocketPort) ||
    receipt.webSocketPort < 1 ||
    receipt.webSocketPort > 65535 ||
    (requireLive && processStartTicks(receipt.pid) !== receipt.startTicks)
  ) {
    throw new Error("broker receipt identity is invalid");
  }
  return receipt;
}

function sameStat(a, b) {
  return ["dev", "ino", "mode", "uid", "nlink", "size", "mtimeNs", "ctimeNs"]
    .every((key) => a[key] === b[key]);
}

function privateSnapshot(path, maxBytes = 64 * 1024) {
  const named = assertPrivateFile(path, maxBytes);
  if (named.nlink !== 1n) throw new Error("broker authority file is aliased");
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = fstatSync(fd, { bigint: true });
    if (!sameStat(named, opened)) throw new Error("broker authority changed");
    const buffer = Buffer.alloc(maxBytes + 1);
    const count = readSync(fd, buffer, 0, buffer.length, 0);
    if (BigInt(count) !== opened.size || !sameStat(opened, fstatSync(fd, { bigint: true })) ||
        !sameStat(opened, lstatSync(path, { bigint: true }))) {
      throw new Error("broker authority changed");
    }
    return { path, stat: opened, bytes: buffer.subarray(0, count) };
  } finally { closeSync(fd); }
}

function assertUnchanged(snapshot) {
  const current = privateSnapshot(snapshot.path);
  if (!sameStat(snapshot.stat, current.stat) || !snapshot.bytes.equals(current.bytes)) {
    throw new Error("broker authority changed before retirement");
  }
}

function assertFormerOwnerGone(receipt) {
  let current;
  try { current = processStartTicks(receipt.pid); }
  catch (error) {
    if (error?.code === "ENOENT" || error?.code === "ESRCH") return;
    throw error;
  }
  if (current === receipt.startTicks) throw new Error("broker lock still has a live owner");
  // Regression: node tests/agent-browser-supervisor-recovery.mjs
  // R48: an unrelated Codex reused the PID. Birth mismatch permits orphan
  // recovery, never termination of the replacement. A broker-shaped replacement
  // or unreadable/racing process remains ambiguous and must veto retirement.
  const command = readFileSync(`/proc/${receipt.pid}/cmdline`).toString().split("\0");
  if (!command[0] || command.some((arg) => arg === brokerPath || arg === realpathSync(brokerPath)) ||
      processStartTicks(receipt.pid) !== current) {
    throw new Error("broker replacement owner is ambiguous");
  }
}

function assertNoBoundUnixEndpoint(paths) {
  const rows = readFileSync("/proc/net/unix", "utf8").split("\n").slice(1);
  if (rows.some((row) => paths.includes(row.match(/^(?:\S+\s+){7}(.*)$/)?.[1]))) {
    throw new Error("broker endpoint is still bound");
  }
}

async function assertEndpointAbsent(options) {
  await new Promise((resolveAbsent, rejectAbsent) => {
    const socket = net.createConnection(options);
    let finished = false;
    const finish = (error) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      socket.destroy();
      if (error) rejectAbsent(error); else resolveAbsent();
    };
    const timer = setTimeout(() => finish(new Error("broker endpoint absence is unknown")), 250);
    socket.once("connect", () => finish(new Error("broker endpoint is serving")));
    socket.once("error", (error) => finish(
      ["ENOENT", "ECONNREFUSED"].includes(error.code) ? null : error));
  });
}

async function retireDeadState(stateRoot, profileConfig) {
  assertPrivateDirectory(stateRoot);
  const directory = lstatSync(stateRoot, { bigint: true });
  const names = ["native.sock", "control.sock", "broker.json", "broker.lock"];
  const lockPath = join(stateRoot, "broker.lock");
  let lock;
  try { lock = privateSnapshot(lockPath, 64); }
  catch (error) {
    if (error?.code !== "ENOENT") throw error;
    // Missing authority allows only an entirely fresh root. Otherwise the
    // broker's startup socket cleanup could remove another serving endpoint.
    for (const name of names) {
      try { lstatSync(join(stateRoot, name)); }
      catch (missing) { if (missing?.code === "ENOENT") continue; throw missing; }
      throw new Error("broker state has no lock authority");
    }
    return;
  }
  const receiptSnapshot = privateSnapshot(join(stateRoot, "broker.json"));
  const configSnapshot = privateSnapshot(profileConfig);
  const receipt = readReceipt(stateRoot, profileConfig, false);
  const pidText = lock.bytes.toString("utf8").trim();
  if (!/^[1-9][0-9]{0,9}$/.test(pidText) || Number(pidText) !== receipt.pid) {
    throw new Error("stale broker receipt and lock disagree");
  }
  assertFormerOwnerGone(receipt);
  const sockets = [];
  for (const name of names.slice(0, 2)) {
    const path = join(stateRoot, name);
    try {
      const stat = lstatSync(path, { bigint: true });
      if (!stat.isSocket() || Number(stat.uid) !== process.getuid() || stat.nlink !== 1n) {
        throw new Error("stale broker socket is unsafe");
      }
      sockets.push({ path, stat });
    } catch (error) { if (error?.code !== "ENOENT") throw error; }
  }
  const paths = names.slice(0, 2).map((name) => join(stateRoot, name));
  assertNoBoundUnixEndpoint(paths);
  await Promise.all([
    ...paths.map((path) => assertEndpointAbsent({ path })),
    assertEndpointAbsent({ host: receipt.webSocketAddress, port: receipt.webSocketPort }),
  ]);
  // Validate the entire deletion set before touching any member; retain the
  // broker lock until last so normal broker startup cannot race socket cleanup.
  assertPrivateDirectory(stateRoot);
  const finalDirectory = lstatSync(stateRoot, { bigint: true });
  if (directory.dev !== finalDirectory.dev || directory.ino !== finalDirectory.ino) {
    throw new Error("broker root changed before retirement");
  }
  for (const snapshot of [lock, receiptSnapshot, configSnapshot]) assertUnchanged(snapshot);
  readReceipt(stateRoot, profileConfig, false);
  assertFormerOwnerGone(receipt);
  assertNoBoundUnixEndpoint(paths);
  for (const path of paths) {
    const before = sockets.find((item) => item.path === path);
    try {
      const current = lstatSync(path, { bigint: true });
      if (!before || !sameStat(before.stat, current)) throw new Error("broker socket changed");
    } catch (error) {
      if (error?.code !== "ENOENT" || before) throw error;
    }
  }
  for (const socket of sockets) unlinkSync(socket.path);
  unlinkSync(receiptSnapshot.path);
  unlinkSync(lock.path);
}

export async function requireExtensionBroker({ stateRoot, profileConfig }) {
  // Foreground is a one-shot action on retained authority, never a bootstrap.
  const receipt = readReceipt(resolve(stateRoot), resolve(profileConfig));
  const health = await requestExtensionControl(receipt.controlSocket, { op: "health" }, 500);
  if (health.pid !== receipt.pid || health.sourceSha256 !== receipt.sourceSha256) {
    throw new Error("broker health identity changed");
  }
  return receipt;
}

export async function ensureExtensionBroker({ stateRoot, profileConfig }) {
  stateRoot = resolve(stateRoot);
  profileConfig = resolve(profileConfig);
  try { return await requireExtensionBroker({ stateRoot, profileConfig }); } catch {}
  // Existing shared wrapper admission is separate: serialize only this root's
  // recovery/bootstrap. The stable flock inode survives crashes without stale
  // lock stealing and prevents two supervisors from retiring each other's state.
  // Nonblocking flock attempts let an earlier caller in this same event loop
  // finish its asynchronous endpoint checks and release the recovery lock.
  let recoveryLock;
  for (let attempt = 0; attempt < 250; attempt++) {
    try {
      recoveryLock = acquireAdmissionLock({ root: stateRoot, exclusive: true, waitSeconds: 0 });
      break;
    } catch (error) {
      if (error?.code !== "ADMISSION_BUSY" || attempt === 249) throw error;
      await new Promise((resolveWait) => setTimeout(resolveWait, 20));
    }
  }
  try {
    try { return await requireExtensionBroker({ stateRoot, profileConfig }); } catch {}
    await retireDeadState(stateRoot, profileConfig);
  assertPrivateFile(profileConfig);
  const child = spawn(
    process.execPath,
    [brokerPath, "--state-root", stateRoot, "--profile-config", profileConfig],
    {
      detached: true,
      stdio: "ignore",
      env: {
        HOME: process.env.HOME,
        USER: process.env.USER,
        LOGNAME: process.env.LOGNAME,
        PATH: "/usr/bin:/bin",
        LANG: "C.UTF-8",
        LC_ALL: "C.UTF-8",
      },
    },
  );
  child.unref();
  for (let count = 0; count < 100; count += 1) {
    await new Promise((resolveWait) => setTimeout(resolveWait, 20));
    try {
      const receipt = readReceipt(stateRoot, profileConfig);
      await requestExtensionControl(receipt.controlSocket, { op: "health" }, 500);
      return receipt;
    } catch {}
  }
  throw new Error("extension broker did not become ready");
  } finally { closeSync(recoveryLock); }
}
