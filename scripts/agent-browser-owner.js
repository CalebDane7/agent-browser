import { createHash } from "node:crypto";
import { closeSync, openSync, readSync, readlinkSync } from "node:fs";
import { basename, join } from "node:path";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const TICKS = /^(0|[1-9][0-9]{0,19})$/;
const DEAD_STATES = new Set(["Z", "X", "x"]);
const AGENTS = new Set(["codex", "claude", "gemini"]);
const OWNER_KEYS = ["pid", "startTicks", "bootId", "uid", "agentKind", "threadId", "rootThreadId"];

function failure(code) {
  return Object.assign(new Error(code), { code });
}

function boundedRead(path, limit) {
  const fd = openSync(path, "r");
  try {
    const data = Buffer.alloc(limit + 1);
    let length = 0;
    while (length <= limit) {
      const count = readSync(fd, data, length, data.length - length, null);
      if (count === 0) break;
      length += count;
    }
    if (length > limit) throw failure("OWNER_PROC_DATA_INVALID");
    return data.subarray(0, length).toString("utf8");
  } finally {
    closeSync(fd);
  }
}

function bootIdentity(procRoot) {
  const value = boundedRead(join(procRoot, "sys/kernel/random/boot_id"), 128).trim();
  if (!UUID.test(value)) throw failure("OWNER_PROC_DATA_INVALID");
  return value;
}

function processStat(procRoot, pid) {
  const raw = boundedRead(join(procRoot, String(pid), "stat"), 4096).trim();
  const end = raw.lastIndexOf(")");
  const fields = raw.slice(end + 2).split(/\s+/);
  if (!raw.startsWith(String(pid) + " (") || end < 0 ||
      !/^[A-Za-z]$/.test(fields[0] || "") || !/^[0-9]+$/.test(fields[1] || "") ||
      !TICKS.test(fields[19] || "")) throw failure("OWNER_PROC_DATA_INVALID");
  const parentPid = Number(fields[1]);
  if (!Number.isSafeInteger(parentPid)) throw failure("OWNER_PROC_DATA_INVALID");
  return { pid, parentPid, state: fields[0], startTicks: fields[19] };
}

function processUid(procRoot, pid) {
  const status = boundedRead(join(procRoot, String(pid), "status"), 16384);
  const match = /^Uid:\s+([0-9]+)\s+([0-9]+)\s+([0-9]+)\s+([0-9]+)\s*$/m.exec(status);
  if (!match || !Number.isSafeInteger(Number(match[1]))) {
    throw failure("OWNER_PROC_DATA_INVALID");
  }
  return Number(match[1]);
}

function executable(procRoot, pid) {
  const value = readlinkSync(join(procRoot, String(pid), "exe"));
  if (value.length > 4096 || !value.startsWith("/")) {
    throw failure("OWNER_PROC_DATA_INVALID");
  }
  return value;
}

function optionalIdentifier(env, key) {
  const value = env[key];
  if (value === undefined) return null;
  if (typeof value !== "string" || !UUID.test(value)) {
    throw failure("OWNER_METADATA_INVALID");
  }
  return value;
}

export function validateOwnerIdentity(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      Object.keys(value).length !== OWNER_KEYS.length ||
      !OWNER_KEYS.every((key) => Object.hasOwn(value, key))) return false;
  return Number.isSafeInteger(value.pid) && value.pid > 1 &&
    Number.isSafeInteger(value.uid) && value.uid >= 0 &&
    typeof value.startTicks === "string" && TICKS.test(value.startTicks) &&
    typeof value.bootId === "string" && UUID.test(value.bootId) &&
    (AGENTS.has(value.agentKind) || value.agentKind === "caller") &&
    [value.threadId, value.rootThreadId].every((id) =>
      id === null || typeof id === "string" && UUID.test(id)) &&
    (value.agentKind === "codex" || value.threadId === null && value.rootThreadId === null);
}

// ppid/procRoot are internal observation/fixture seams, never environment PID overrides.
export function resolveInvokingOwner({
  env = process.env, ppid = process.ppid, procRoot = "/proc",
} = {}) {
  if (!Number.isSafeInteger(ppid) || ppid <= 1) {
    throw failure("OWNER_ANCESTRY_UNAVAILABLE");
  }
  const uid = process.getuid();
  const bootId = bootIdentity(procRoot);
  let pid = ppid;
  let selected;
  let agentKind = "caller";
  const seen = new Set();
  for (let depth = 0; pid > 1; depth += 1) {
    if (depth >= 32 || seen.has(pid)) throw failure("OWNER_ANCESTRY_UNAVAILABLE");
    seen.add(pid);
    const stat = processStat(procRoot, pid);
    const actualUid = processUid(procRoot, pid);
    if (actualUid !== uid) break;
    const exe = executable(procRoot, pid);
    if (DEAD_STATES.has(stat.state)) throw failure("OWNER_IDENTITY_CHANGED");
    const observed = { ...stat, uid: actualUid, executable: exe };
    if (!selected) selected = observed;
    const kind = basename(exe).toLowerCase().replace(/\.exe$/, "");
    if (AGENTS.has(kind)) {
      selected = observed;
      agentKind = kind;
      break;
    }
    pid = stat.parentPid;
  }
  if (!selected) throw failure("OWNER_ANCESTRY_UNAVAILABLE");
  const current = processStat(procRoot, selected.pid);
  if (current.startTicks !== selected.startTicks ||
      current.parentPid !== selected.parentPid || DEAD_STATES.has(current.state) ||
      processUid(procRoot, selected.pid) !== uid ||
      executable(procRoot, selected.pid) !== selected.executable ||
      bootIdentity(procRoot) !== bootId) throw failure("OWNER_IDENTITY_CHANGED");

  // WHY: real Codex parent/child tools share one OS process but receive different
  // CODEX_THREAD_ID values. Tool shells change each call; CODEX_SESSION_ID is the
  // shared root. Neither an ID nor thread completion proves process life/death.
  // Read only these two fields, before launcher env-i. Missing metadata remains
  // explicit null: callers must preserve a known thread namespace across scrubbing.
  return {
    pid: selected.pid, startTicks: selected.startTicks, bootId, uid, agentKind,
    threadId: agentKind === "codex" ? optionalIdentifier(env, "CODEX_THREAD_ID") : null,
    rootThreadId: agentKind === "codex" ? optionalIdentifier(env, "CODEX_SESSION_ID") : null,
  };
}

export function ownerNamespace(owner) {
  if (!validateOwnerIdentity(owner)) throw failure("OWNER_IDENTITY_INVALID");
  // Root membership is retained for separately authorized delegation, not a
  // replacement for the exact child namespace or authority to impersonate it.
  return createHash("sha256").update(JSON.stringify([
    owner.uid, owner.pid, owner.startTicks, owner.bootId, owner.agentKind, owner.threadId,
  ])).digest("hex").slice(0, 32);
}

export function ownerSession(owner, aliasHash) {
  if (!/^[a-f0-9]{64}$/.test(aliasHash ?? "")) throw failure("OWNER_ALIAS_INVALID");
  // Keep the donor socket name bounded while binding both real owner and alias.
  return "s" + createHash("sha256").update(ownerNamespace(owner) + ":" + aliasHash)
    .digest("hex").slice(0, 32);
}

export function ownerIdentityStatus(owner, { procRoot = "/proc" } = {}) {
  if (!validateOwnerIdentity(owner)) return "ambiguous";
  // Missing /proc or boot identity is failed observation, never disappearance.
  let observedBoot;
  try { observedBoot = bootIdentity(procRoot); } catch { return "ambiguous"; }
  if (observedBoot !== owner.bootId) return "dead";
  try {
    const before = processStat(procRoot, owner.pid);
    if (before.startTicks !== owner.startTicks || DEAD_STATES.has(before.state)) return "dead";
    if (processUid(procRoot, owner.pid) !== owner.uid) return "ambiguous";
    const after = processStat(procRoot, owner.pid);
    if (after.startTicks !== owner.startTicks || DEAD_STATES.has(after.state) ||
        bootIdentity(procRoot) !== owner.bootId) return "dead";
    return "live";
  } catch (error) {
    // WHY: the legacy boolean "is live" branch treated permission/parse failures
    // as death. Only independently confirmed disappearance/birth change permits
    // cleanup; every other failed observation preserves the owner's resources.
    if (error?.code === "ENOENT" || error?.code === "ESRCH") {
      try {
        const current = processStat(procRoot, owner.pid);
        if (current.startTicks !== owner.startTicks || DEAD_STATES.has(current.state)) return "dead";
      } catch (retryError) {
        if (retryError?.code === "ENOENT" || retryError?.code === "ESRCH") {
          try {
            if (bootIdentity(procRoot) === observedBoot) return "dead";
          } catch {}
        }
      }
    }
    return "ambiguous";
  }
}

// Internal process-birth observation, not an environment/PID authority override.
// The broker separately binds this PID to the exact session's daemon pidfile.
export function observeProcessIdentity(pid, { procRoot = "/proc" } = {}) {
  if (!Number.isSafeInteger(pid) || pid <= 1) throw failure("OWNER_IDENTITY_INVALID");
  const stat = processStat(procRoot, pid);
  const identity = {
    pid, startTicks: stat.startTicks, bootId: bootIdentity(procRoot),
    uid: processUid(procRoot, pid), agentKind: "caller", threadId: null, rootThreadId: null,
  };
  if (identity.uid !== process.getuid() || ownerIdentityStatus(identity, { procRoot }) !== "live")
    throw failure("OWNER_IDENTITY_CHANGED");
  return identity;
}
