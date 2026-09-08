import { spawn } from "node:child_process";
import {
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

function readReceipt(stateRoot, profileConfig) {
  assertPrivateDirectory(stateRoot);
  const path = join(stateRoot, "broker.json");
  assertPrivateFile(path);
  assertPrivateFile(profileConfig);
  const receipt = JSON.parse(readFileSync(path, "utf8"));
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
    !/^[0-9]+$/.test(receipt.startTicks) ||
    !/^[0-9a-f]{64}$/.test(receipt.sourceSha256) ||
    !/^[0-9a-f]{64}$/.test(receipt.profileConfigSha256) ||
    receipt.sourceSha256 !== sha256(readFileSync(brokerPath)) ||
    receipt.profileConfigSha256 !== sha256(readFileSync(profileConfig)) ||
    receipt.nativeSocket !== join(stateRoot, "native.sock") ||
    receipt.controlSocket !== join(stateRoot, "control.sock") ||
    receipt.webSocketAddress !== "127.0.0.1" ||
    !Number.isSafeInteger(receipt.webSocketPort) ||
    receipt.webSocketPort < 1 ||
    receipt.webSocketPort > 65535 ||
    processStartTicks(receipt.pid) !== receipt.startTicks
  ) {
    throw new Error("broker receipt identity is invalid");
  }
  return receipt;
}

function retireDeadState(stateRoot) {
  assertPrivateDirectory(stateRoot);
  const lockPath = join(stateRoot, "broker.lock");
  assertPrivateFile(lockPath, 64);
  const pidText = readFileSync(lockPath, "utf8").trim();
  if (!/^[1-9][0-9]{0,9}$/.test(pidText)) {
    throw new Error("stale broker lock is invalid");
  }
  try {
    processStartTicks(Number(pidText));
    throw new Error("broker lock still has a live owner");
  } catch (error) {
    if (error?.code !== "ENOENT" && error?.code !== "ESRCH") throw error;
  }
  for (const name of ["native.sock", "control.sock"]) {
    const path = join(stateRoot, name);
    try {
      const stat = lstatSync(path, { bigint: true });
      if (!stat.isSocket() || Number(stat.uid) !== process.getuid()) {
        throw new Error("stale broker socket is unsafe");
      }
      unlinkSync(path);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
  for (const name of ["broker.json", "broker.lock"]) {
    const path = join(stateRoot, name);
    try {
      assertPrivateFile(path);
      unlinkSync(path);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
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
  try {
    return await requireExtensionBroker({ stateRoot, profileConfig });
  } catch (firstError) {
    try {
      retireDeadState(stateRoot);
    } catch (retireError) {
      if (retireError?.code !== "ENOENT") throw firstError;
    }
  }
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
}
