#!/usr/bin/node

// The MV3 extension is the only Chrome owner. This broker never discovers
// browser targets: it exposes one page-scoped WebSocket per exact extension-
// owned tab so the action engine cannot escape into user or extension targets.
import {
  chmodSync,
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocket, WebSocketServer } from "ws";
import { ownerIdentityStatus, ownerNamespace, ownerSession, validateOwnerIdentity, observeProcessIdentity } from "./agent-browser-owner.js";
import {
  CONTROL_SCHEMA,
  EXTENSION_SCHEMA,
  MAX_CDP_MESSAGE_BYTES,
  MAX_CONTROL_MESSAGE_BYTES,
  MAX_EXTENSION_TO_HOST_MESSAGE_BYTES,
  MAX_HOST_TO_EXTENSION_MESSAGE_BYTES,
  PROFILE_CONFIG_SCHEMA,
  boundedError,
  canonicalJson,
  exactKeys,
  isAccount,
  isHex64,
  isProfileDirectory,
  isSession,
  opaqueId,
  sha256,
  validateExtensionHello,
  validateNativeTransportHello,
  validatePageCdpMethod,
  validateProfileConfig,
} from "./agent-browser-extension-protocol.js";

const scriptPath = realpathSync(fileURLToPath(import.meta.url));
const DEFAULT_STATE_ROOT = `/tmp/agent-browser-extension-${process.getuid()}`;
const DEFAULT_PROFILE_CONFIG = join(
  os.homedir(),
  ".config",
  "agent-browser",
  "extension-profiles.json",
);
const MAX_SESSIONS = 16;
const MAX_UNBOUND_PEERS = 64;
const REQUEST_TIMEOUT_MS = 15_000;
export const BROKER_LAUNCH_DEADLINE_MS = 15_000;
export const BROKER_RETIRE_DEADLINE_MS = 15_000;
const TIMED_OUT_REQUEST_TTL_MS = 60_000;
const MAX_TIMED_OUT_REQUESTS = 128;
const EXTENSION_TAB_HANDLE = /^tab_[a-f0-9]{64}$/;
const EXTENSION_WINDOW_HANDLE = /^window_[a-f0-9]{64}$/;
const RECOVERED_TAB_IDS = Symbol("validated inventory tab IDs");

function isExtensionHandle(value, pattern) {
  return typeof value === "string" && pattern.test(value);
}

function isTabHandle(value) {
  return (
    (Number.isSafeInteger(value) && value >= 0) ||
    isExtensionHandle(value, EXTENSION_TAB_HANDLE)
  );
}

function processStartTicks(pid = process.pid) {
  const raw = readFileSync(`/proc/${pid}/stat`, "utf8").trim();
  const close = raw.lastIndexOf(")");
  if (close < 0) throw new Error("process identity is unavailable");
  const fields = raw.slice(close + 2).split(" ");
  const value = fields[19];
  if (!/^[0-9]+$/.test(value ?? "")) throw new Error("process identity is invalid");
  return value;
}

function fail(message, code = 70) {
  process.stderr.write(`agent-browser-extension-broker: ${message}\n`);
  process.exit(code);
}

function parseArgs(argv) {
  const result = {
    stateRoot: DEFAULT_STATE_ROOT,
    profileConfig: DEFAULT_PROFILE_CONFIG,
    json: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--state-root") result.stateRoot = argv[++index];
    else if (arg === "--profile-config") result.profileConfig = argv[++index];
    else if (arg === "--json") result.json = true;
    else fail("invalid arguments", 64);
  }
  if (
    !isAbsolute(result.stateRoot) ||
    resolve(result.stateRoot) !== result.stateRoot ||
    !isAbsolute(result.profileConfig) ||
    resolve(result.profileConfig) !== result.profileConfig
  ) {
    fail("paths must be exact absolute paths", 64);
  }
  return result;
}

function assertSecureDirectory(path) {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  chmodSync(path, 0o700);
  const named = lstatSync(path, { bigint: true });
  if (
    named.isSymbolicLink() ||
    !named.isDirectory() ||
    Number(named.uid) !== process.getuid() ||
    Number(named.mode & 0o777n) !== 0o700 ||
    realpathSync(path) !== path
  ) {
    fail("state directory is unsafe");
  }
}

function removeOwnedSocket(path) {
  try {
    const stat = lstatSync(path, { bigint: true });
    if (!stat.isSocket() || Number(stat.uid) !== process.getuid()) {
      fail("refusing to replace an unsafe socket path");
    }
    unlinkSync(path);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}

function readConfig(path) {
  try {
    const stat = lstatSync(path, { bigint: true });
    if (
      stat.isSymbolicLink() ||
      !stat.isFile() ||
      Number(stat.uid) !== process.getuid() ||
      Number(stat.mode & 0o077n) !== 0 ||
      stat.size > 64n * 1024n
    ) {
      fail("profile configuration is unsafe");
    }
    const value = JSON.parse(readFileSync(path, "utf8"));
    if (!validateProfileConfig(value)) fail("profile configuration is invalid");
    return value;
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    return null;
  }
}

function writePrivateJson(path, value) {
  assertSecureDirectory(dirname(path));
  const temp = `${path}.${process.pid}.${opaqueId()}.tmp`;
  const fd = openSync(
    temp,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    writeFileSync(fd, `${canonicalJson(value)}\n`, "utf8");
  } finally {
    closeSync(fd);
  }
  renameSync(temp, path);
}

function writeConfig(path, config) {
  if (!validateProfileConfig(config)) fail("refusing invalid profile configuration");
  writePrivateJson(path, config);
}

class NativeFrameReader {
  constructor(onMessage, onFailure) {
    this.buffer = Buffer.alloc(0);
    this.onMessage = onMessage;
    this.onFailure = onFailure;
    this.failed = false;
  }

  push(chunk) {
    if (this.failed || !Buffer.isBuffer(chunk)) return;
    if (
      this.buffer.length + chunk.length >
      MAX_EXTENSION_TO_HOST_MESSAGE_BYTES + 4
    ) {
      this.failed = true;
      this.onFailure("native message buffer exceeded");
      return;
    }
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (this.buffer.length >= 4) {
      const length = this.buffer.readUInt32LE(0);
      if (length === 0 || length > MAX_EXTENSION_TO_HOST_MESSAGE_BYTES) {
        this.failed = true;
        this.onFailure("native message length is invalid");
        return;
      }
      if (this.buffer.length < length + 4) return;
      const payload = this.buffer.subarray(4, length + 4);
      this.buffer = this.buffer.subarray(length + 4);
      let value;
      try {
        value = JSON.parse(payload.toString("utf8"));
      } catch {
        this.failed = true;
        this.onFailure("native message JSON is invalid");
        return;
      }
      this.onMessage(value);
    }
  }
}

function encodeNative(value) {
  // Broker output ultimately becomes native-host stdout into Chrome, so this
  // direction remains at the smaller host-to-extension limit.
  const payload = Buffer.from(canonicalJson(value), "utf8");
  if (
    payload.length === 0 ||
    payload.length > MAX_HOST_TO_EXTENSION_MESSAGE_BYTES
  ) {
    throw new Error("native response is oversized");
  }
  const frame = Buffer.allocUnsafe(payload.length + 4);
  frame.writeUInt32LE(payload.length, 0);
  payload.copy(frame, 4);
  return frame;
}

export class ExtensionPeer {
  constructor(broker, socket) {
    this.broker = broker;
    this.socket = socket;
    this.origin = null;
    this.profile = null;
    this.profileKey = null;
    this.epoch = null;
    this.enrollmentId = null;
    this.enrollmentChallenge = null;
    this.stage = "transport";
    this.pending = new Map();
    this.timedOutRequests = new Map();
    this.closed = false;
    this.reader = new NativeFrameReader(
      (value) => this.onMessage(value),
      () => this.close("native-frame-invalid"),
    );
    socket.on("data", (chunk) => this.reader.push(chunk));
    socket.once("error", () => this.close("native-socket-error"));
    socket.once("close", () => this.close("native-socket-closed"));
    socket.once("end", () => this.close("native-socket-eof"));
  }

  send(value) {
    if (this.closed) throw new Error("extension connection is closed");
    this.socket.write(encodeNative(value));
  }

  onMessage(value) {
    if (this.stage === "transport") {
      if (!validateNativeTransportHello(value))
        return this.close("transport-envelope-invalid");
      if (value.origin !== this.broker.config?.extensionOrigin)
        return this.close("transport-origin-mismatch");
      this.origin = value.origin;
      this.stage = "extension";
      return;
    }
    if (this.stage === "extension") {
      if (!validateExtensionHello(value))
        return this.close("extension-hello-invalid");
      this.profileKey = value.profileKey;
      this.epoch = value.connectionEpoch;
      const profile = this.broker.findProfile(value.profileKey);
      if (!profile) {
        this.stage = "unbound";
        if (!this.broker.registerUnboundPeer(this)) {
          return this.close("unbound-capacity");
        }
        this.broker.recordPeerFailure("unbound", "profile-unbound");
        return;
      }
      this.activate(profile);
      return;
    }
    if (this.stage === "unbound") {
      if (
        value &&
        exactKeys(value, [
          "schema",
          "type",
          "profileKey",
          "connectionEpoch",
          "enrollmentId",
        ]) &&
        value.schema === EXTENSION_SCHEMA &&
        value.type === "enrollment-action-observed" &&
        value.profileKey === this.profileKey &&
        value.connectionEpoch === this.epoch &&
        (value.enrollmentId === "" || isHex64(value.enrollmentId))
      ) {
        this.broker.recordEnrollmentAction(this, value.enrollmentId);
        return;
      }
      if (
        !value ||
        !exactKeys(value, [
          "schema",
          "type",
          "profileKey",
          "connectionEpoch",
          "enrollmentId",
          "challenge",
        ]) ||
        value.schema !== EXTENSION_SCHEMA ||
        value.type !== "enrollment-intent" ||
        value.profileKey !== this.profileKey ||
        value.connectionEpoch !== this.epoch ||
        value.enrollmentId !== this.enrollmentId ||
        value.challenge !== this.enrollmentChallenge ||
        !isHex64(value.enrollmentId) ||
        !isHex64(value.challenge)
      ) {
        return this.close("enrollment-intent-invalid");
      }
      let profile;
      try {
        profile = this.broker.bindProfileFromUserGesture(
          this,
          value.enrollmentId,
        );
      } catch {
        return this.close("enrollment-write-failed");
      }
      if (!profile) {
        this.broker.refreshUnboundPeer(this);
        return;
      }
      this.activate(profile);
      return;
    }
    if (this.stage !== "ready" || !value || typeof value !== "object") {
      return this.close();
    }
    if (value.type === "response") {
      if (
        value.schema !== EXTENSION_SCHEMA ||
        !isHex64(value.id) ||
        typeof value.ok !== "boolean"
      ) {
        return this.close();
      }
      const pending = this.pending.get(value.id);
      if (!pending) {
        this.pruneTimedOutRequests();
        const timedOut = this.timedOutRequests.get(value.id);
        if (!timedOut) return this.close("unknown-extension-response");
        this.timedOutRequests.delete(value.id);
        if (timedOut.onLate) {
          void Promise.resolve(timedOut.onLate(value)).catch(() => undefined);
        }
        return;
      }
      this.pending.delete(value.id);
      clearTimeout(pending.timer);
      if (value.ok) pending.resolve(value.result ?? {});
      else {
        const error = new Error(value.error?.message ?? "extension request failed");
        if (typeof value.error?.code === "string") error.bridgeCode = value.error.code;
        pending.reject(error);
      }
      return;
    }
    if (value.type === "event") {
      this.broker.extensionEvent(this, value);
      return;
    }
    this.close();
  }

  issueEnrollmentChallenge(enrollmentId) {
    if (this.closed || this.stage !== "unbound") return;
    this.enrollmentId = enrollmentId;
    this.enrollmentChallenge = opaqueId();
    this.send({
      schema: EXTENSION_SCHEMA,
      type: "enrollment-required",
      profileKey: this.profileKey,
      connectionEpoch: this.epoch,
      enrollmentId: this.enrollmentId,
      challenge: this.enrollmentChallenge,
    });
  }

  cancelEnrollment(enrollmentId) {
    if (
      this.closed ||
      this.stage !== "unbound" ||
      this.enrollmentId !== enrollmentId
    ) {
      return;
    }
    this.enrollmentId = null;
    this.enrollmentChallenge = null;
    this.send({
      schema: EXTENSION_SCHEMA,
      type: "enrollment-cancelled",
      profileKey: this.profileKey,
      connectionEpoch: this.epoch,
      enrollmentId,
    });
  }

  activate(profile) {
    this.broker.unregisterUnboundPeer(this);
    this.profile = profile;
    this.profileKey = profile.profileKey;
    this.enrollmentId = null;
    this.enrollmentChallenge = null;
    this.stage = "ready";
    this.broker.registerPeer(this);
    this.send({
      schema: EXTENSION_SCHEMA,
      type: "ready",
      profileKey: profile.profileKey,
      connectionEpoch: this.epoch,
    });
  }

  pruneTimedOutRequests(now = Date.now()) {
    for (const [id, tombstone] of this.timedOutRequests) {
      if (tombstone.expiresAt > now) continue;
      this.timedOutRequests.delete(id);
    }
    while (this.timedOutRequests.size > MAX_TIMED_OUT_REQUESTS) {
      this.timedOutRequests.delete(this.timedOutRequests.keys().next().value);
    }
  }

  rememberTimedOutRequest(id, onLate) {
    this.pruneTimedOutRequests();
    // WHY: a Chrome promise may answer after our bounded caller deadline. Keep
    // only that exact peer/epoch request ID long enough to classify its late
    // response; accepting arbitrary unknown IDs would hide protocol drift.
    this.timedOutRequests.set(id, {
      expiresAt: Date.now() + TIMED_OUT_REQUEST_TTL_MS,
      onLate,
    });
    this.pruneTimedOutRequests();
  }

  request(op, args, timeout = REQUEST_TIMEOUT_MS, options = {}) {
    if (this.stage !== "ready") return Promise.reject(new Error("profile offline"));
    const id = opaqueId();
    return new Promise((resolveRequest, rejectRequest) => {
      const timer = setTimeout(() => {
        if (!this.pending.delete(id)) return;
        this.rememberTimedOutRequest(id, options.onLate);
        rejectRequest(
          Object.assign(new Error("extension request timed out"), {
            bridgeCode: "EXTENSION_TIMEOUT",
          }),
        );
      }, timeout);
      timer.unref?.();
      this.pending.set(id, { resolve: resolveRequest, reject: rejectRequest, timer });
      const request = {
        schema: EXTENSION_SCHEMA,
        type: "request",
        id,
        profileKey: this.profile.profileKey,
        connectionEpoch: this.epoch,
        op,
        args,
      };
      if (Number.isSafeInteger(options.deadlineAt)) {
        request.deadlineAt = options.deadlineAt;
      }
      try {
        this.send(request);
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        rejectRequest(error);
      }
    });
  }

  close(reason = "peer-closed") {
    if (this.closed) return;
    this.closed = true;
    if (
      this.stage === "transport" ||
      this.stage === "extension" ||
      this.stage === "unbound"
    ) {
      this.broker.recordPeerFailure(this.stage, reason);
    }
    this.stage = "closed";
    this.socket.destroy();
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error("extension connection closed"));
    }
    this.pending.clear();
    this.timedOutRequests.clear();
    this.broker.unregisterPeer(this);
  }
}

export class Broker {
  constructor(args) {
    this.args = args;
    this.config = readConfig(args.profileConfig);
    this.pendingEnrollment = null;
    this.enrollmentTimer = null;
    this.peersByAccount = new Map();
    this.unboundPeersByKey = new Map();
    this.sessions = new Map();
    this.ownerRecords = new Map();
    this.ownerRetirements = new Map();
    this.ownerSweepTimer = null;
    this.loadOwnerRecords();
    this.endpoints = new Map();
    this.consumedGrants = new Map();
    this.pendingSessions = new Set();
    this.capacityRecoveries = new Map();
    this.currentTabClaimTurns = new Map();
    this.focusHandoff = null;
    this.nativeServer = null;
    this.controlServer = null;
    this.httpServer = null;
    this.wsServer = new WebSocketServer({ noServer: true, perMessageDeflate: false });
    this.stopping = false;
    this.startTicks = processStartTicks();
  }

  ownerRecordPath() {
    return join(this.args.stateRoot, "owner-sessions.v1.json");
  }

  validOwnerRecord(record) {
    return exactKeys(record, ["session", "agentOwner", "aliasHash", "account", "currentTab", "profileHash"]) &&
      validateOwnerIdentity(record.agentOwner) && record.agentOwner.uid === process.getuid() &&
      isHex64(record.aliasHash) && record.session === ownerSession(record.agentOwner, record.aliasHash) &&
      isAccount(record.account) && typeof record.currentTab === "boolean" && isHex64(record.profileHash);
  }

  loadOwnerRecords() {
    let fd;
    try {
      fd = openSync(this.ownerRecordPath(), constants.O_RDONLY | constants.O_NOFOLLOW);
      const stat = fstatSync(fd);
      if (!stat.isFile() || stat.uid !== process.getuid() || (stat.mode & 0o777) !== 0o600 ||
          stat.nlink !== 1 || stat.size > 64 * 1024) throw new Error("owner ledger is unsafe");
      const value = JSON.parse(readFileSync(fd, "utf8"));
      if (!exactKeys(value, ["schema", "records"]) || value.schema !== "agent-browser.owner-sessions.v1" ||
          !Array.isArray(value.records) || value.records.length > MAX_SESSIONS ||
          !value.records.every((record) => this.validOwnerRecord(record)) ||
          new Set(value.records.map((record) => record.session)).size !== value.records.length) {
        throw new Error("owner ledger is invalid");
      }
      this.ownerRecords = new Map(value.records.map((record) => [record.session, record]));
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
  }

  persistOwnerRecords() {
    // WHY: broker memory/socket lifetime is shorter than agent/tab lifetime.
    // Persist only owner birth + opaque alias/profile bindings, before launch;
    // never endpoint/cleanup credentials, URLs, or browser/profile state.
    writePrivateJson(this.ownerRecordPath(), {
      schema: "agent-browser.owner-sessions.v1",
      records: [...this.ownerRecords.values()],
    });
  }

  matchOwnerRecord(grant, profileKey) {
    const record = this.ownerRecords.get(grant.session);
    if (record && (record.account !== grant.account || record.currentTab !== grant.currentTab ||
        record.profileHash !== sha256(profileKey) || record.aliasHash !== grant.aliasHash ||
        ownerNamespace(record.agentOwner) !== ownerNamespace(grant.agentOwner))) {
      throw Object.assign(new Error("session owner changed"), { bridgeCode: "SESSION_CONFLICT" });
    }
    return record;
  }

  rememberOwner(grant, profileKey) {
    const prior = this.matchOwnerRecord(grant, profileKey);
    if (prior) return prior;
    if (this.ownerRecords.size >= MAX_SESSIONS) {
      throw Object.assign(new Error("owner ledger capacity is full"), { bridgeCode: "CAPACITY_BUSY" });
    }
    const record = {
      session: grant.session, agentOwner: grant.agentOwner, aliasHash: grant.aliasHash,
      account: grant.account, currentTab: grant.currentTab, profileHash: sha256(profileKey),
    };
    this.ownerRecords.set(record.session, record);
    try { this.persistOwnerRecords(); } catch (error) {
      this.ownerRecords.delete(record.session);
      throw error;
    }
    return record;
  }

  forgetOwner(session) {
    if (this.focusHandoff?.session.name === session) void this.cancelFocusHandoff(this.focusHandoff);
    const record = this.ownerRecords.get(session);
    if (!record) return;
    this.ownerRecords.delete(session);
    try { this.persistOwnerRecords(); } catch (error) {
      this.ownerRecords.set(session, record);
      throw error;
    }
  }

  async reapDeadOwners() {
    if (this.stopping) return;
    await this.reapCommands();
    const work = [];
    for (const record of this.ownerRecords.values()) {
      if (this.pendingSessions.has(record.session) || this.ownerRetirements.has(record.session) ||
          ownerIdentityStatus(record.agentOwner) !== "dead") continue;
      const session = this.sessions.get(record.session);
      if (session) this.retireSessionLedger(session, "agent process exited");
      const peer = this.peersByAccount.get(record.account);
      // Offline is not absence. Retain the exact record for this peer's return.
      if (!peer || peer.closed || peer.stage !== "ready" ||
          sha256(peer.profile.profileKey) !== record.profileHash) continue;
      work.push(this.retireDeadOwner(record).catch(() => undefined));
    }
    await Promise.all(work);
  }

  async retireDeadOwner(record) {
    const prior = this.ownerRetirements.get(record.session);
    if (prior) return prior;
    if (this.pendingSessions.has(record.session)) return;
    const retirement = this.retireOwnedSession(record, true);
    this.ownerRetirements.set(record.session, retirement);
    try { return await retirement; } finally { this.ownerRetirements.delete(record.session); }
  }

  findProfile(profileKey) {
    return this.config?.profiles.find((item) => item.profileKey === profileKey) ?? null;
  }

  activeEnrollment() {
    const pending = this.pendingEnrollment;
    if (!pending) return null;
    if (pending.expiresAt <= Date.now()) {
      this.clearPendingEnrollment(pending.enrollmentId);
      return null;
    }
    return pending;
  }

  beginEnrollment(details, lifetimeMs) {
    const pending = {
      ...details,
      enrollmentId: opaqueId(),
      expiresAt: Date.now() + lifetimeMs,
    };
    this.pendingEnrollment = pending;
    this.enrollmentTimer = setTimeout(() => {
      this.clearPendingEnrollment(pending.enrollmentId);
    }, lifetimeMs);
    this.enrollmentTimer.unref?.();
    for (const peer of this.unboundPeersByKey.values()) {
      peer.issueEnrollmentChallenge(pending.enrollmentId);
    }
    return pending;
  }

  clearPendingEnrollment(enrollmentId) {
    const pending = this.pendingEnrollment;
    if (!pending || pending.enrollmentId !== enrollmentId) return false;
    if (this.enrollmentTimer) clearTimeout(this.enrollmentTimer);
    this.enrollmentTimer = null;
    this.pendingEnrollment = null;
    for (const peer of this.unboundPeersByKey.values()) {
      peer.cancelEnrollment(enrollmentId);
    }
    return true;
  }

  refreshUnboundPeer(peer) {
    const pending = this.activeEnrollment();
    if (pending) peer.issueEnrollmentChallenge(pending.enrollmentId);
    else if (peer.enrollmentId) peer.cancelEnrollment(peer.enrollmentId);
  }

  registerUnboundPeer(peer) {
    const old = this.unboundPeersByKey.get(peer.profileKey);
    if (!old && this.unboundPeersByKey.size >= MAX_UNBOUND_PEERS) return false;
    this.unboundPeersByKey.set(peer.profileKey, peer);
    if (old && old !== peer) old.close("unbound-peer-replaced");
    this.refreshUnboundPeer(peer);
    return true;
  }

  unregisterUnboundPeer(peer) {
    if (this.unboundPeersByKey.get(peer.profileKey) === peer) {
      this.unboundPeersByKey.delete(peer.profileKey);
    }
  }

  bindProfileFromUserGesture(peer, enrollmentId) {
    const pending = this.activeEnrollment();
    if (!pending || pending.enrollmentId !== enrollmentId) return null;
    if (!this.config) return null;
    if (
      peer.stage !== "unbound" ||
      this.unboundPeersByKey.get(peer.profileKey) !== peer ||
      peer.enrollmentId !== enrollmentId ||
      this.findProfile(peer.profileKey)
    ) {
      return null;
    }
    let retainedProfiles = this.config.profiles;
    if (pending.replaceProfileKey) {
      const replaced = this.config.profiles.find(
        (item) =>
          item.account === pending.account &&
          item.profileDirectory === pending.profileDirectory &&
          item.profileKey === pending.replaceProfileKey,
      );
      if (
        !replaced ||
        this.peersByAccount.has(pending.account) ||
        [...this.sessions.values()].some((session) => session.account === pending.account)
      ) {
        return null;
      }
      retainedProfiles = this.config.profiles.filter((item) => item !== replaced);
    } else if (
      this.config.profiles.some(
        (item) =>
          item.account === pending.account ||
          item.profileDirectory === pending.profileDirectory,
      )
    ) {
      return null;
    }
    const profile = {
      account: pending.account,
      profileDirectory: pending.profileDirectory,
      profileKey: peer.profileKey,
    };
    const next = {
      schema: PROFILE_CONFIG_SCHEMA,
      extensionOrigin: this.config.extensionOrigin,
      profiles: [...retainedProfiles, profile].sort((a, b) =>
        a.account.localeCompare(b.account),
      ),
    };
    writeConfig(this.args.profileConfig, next);
    this.config = next;
    this.clearPendingEnrollment(enrollmentId);
    if (this.httpServer?.listening) this.publishReceipt();
    return profile;
  }

  readyReceipt() {
    return {
      schema: "agent-browser.extension-broker-ready.v1",
      pid: process.pid,
      startTicks: this.startTicks,
      sourceSha256: sha256(readFileSync(scriptPath)),
      profileConfigSha256: sha256(readFileSync(this.args.profileConfig)),
      nativeSocket: this.nativePath,
      controlSocket: this.controlPath,
      webSocketAddress: "127.0.0.1",
      webSocketPort: this.httpServer.address().port,
    };
  }

  publishReceipt() {
    const receipt = this.readyReceipt();
    writePrivateJson(join(this.args.stateRoot, "broker.json"), receipt);
    return receipt;
  }

  registerPeer(peer) {
    const old = this.peersByAccount.get(peer.profile.account);
    if (old && old !== peer) old.close();
    this.peersByAccount.set(peer.profile.account, peer);
    // Let the hello handler send its ready response before cleanup requests.
    queueMicrotask(() => { void this.reapDeadOwners(); });
  }

  recordPeerFailure(stage, reason) {
    const safeStage =
      stage === "transport" || stage === "extension" || stage === "unbound"
      ? stage
      : "unknown";
    const safeReason = /^[a-z][a-z0-9-]{2,63}$/.test(reason)
      ? reason
      : "peer-failure";
    try {
      // WHY: Chrome reports every early native-host termination as the same
      // generic error. This private receipt distinguishes launch/transport
      // failure from broker rejection without recording profile keys, origins,
      // messages, tabs, or any Chrome/profile secret state.
      writePrivateJson(join(this.args.stateRoot, "native-peer-failure.json"), {
        schema: "agent-browser.extension-peer-failure.v1",
        brokerPid: process.pid,
        brokerStartTicks: this.startTicks,
        observedAt: Date.now(),
        stage: safeStage,
        reason: safeReason,
      });
    } catch {
      // Diagnostics must never take down the broker or alter peer lifecycle.
    }
  }

  recordEnrollmentAction(peer, enrollmentId) {
    const now = Date.now();
    const pending =
      this.pendingEnrollment?.expiresAt > now ? this.pendingEnrollment : null;
    try {
      // WHY: Chrome UI can report a successful extension-row activation even
      // when the MV3 worker never receives action.onClicked. This private,
      // key-free receipt distinguishes that browser boundary from a missing or
      // stale enrollment challenge without exposing profile identity.
      writePrivateJson(join(this.args.stateRoot, "enrollment-action.json"), {
        schema: "agent-browser.enrollment-action-observed.v1",
        brokerPid: process.pid,
        brokerStartTicks: this.startTicks,
        observedAt: Date.now(),
        stage: peer.stage,
        pending: Boolean(pending),
        enrollmentMatches: Boolean(
          pending &&
            enrollmentId === pending.enrollmentId &&
            peer.enrollmentId === pending.enrollmentId,
        ),
        challengeIssued: isHex64(peer.enrollmentChallenge),
      });
    } catch {
      // Diagnostics must never change enrollment or peer lifecycle.
    }
  }

  unregisterPeer(peer) {
    if (this.focusHandoff?.peer === peer) void this.cancelFocusHandoff(this.focusHandoff);
    this.unregisterUnboundPeer(peer);
    if (peer.profile && this.peersByAccount.get(peer.profile.account) === peer) {
      this.peersByAccount.delete(peer.profile.account);
    }
    for (const session of this.sessions.values()) {
      if (session.profileKey !== peer.profile?.profileKey || session.epoch !== peer.epoch) continue;
      session.offline = true;
      if (session.ws) {
        session.ws.close(1012, "profile connection restarted");
        session.ws = null;
      }
    }
  }

  retireSessionLedger(session, reason) {
    if (this.sessions.get(session.name) !== session) return false;
    if (this.focusHandoff?.session === session) void this.cancelFocusHandoff(this.focusHandoff);
    if (session.ws) {
      session.ws.close(1001, reason);
      session.ws = null;
    }
    this.endpoints.delete(session.endpointToken);
    this.sessions.delete(session.name);
    session.cleanup = "";
    return true;
  }

  async reconcileRevokedRoot(peer, session, tabIds) {
    try {
      await peer.request("session.close", {
        session: session.name,
        tabIds,
      });
      // The old root can finish retirement after the same owner has reopened
      // its alias. That callback must not erase the new launch's death record.
      if (!this.sessions.has(session.name) && !this.pendingSessions.has(session.name)) {
        this.forgetOwner(session.name);
      }
      if (peer.stage === "ready") {
        void peer.request("window.cleanup", {}).catch(() => undefined);
      }
    } catch {
      // The root event is terminal locally. A disconnected extension will
      // inventory any retained descendants on its next exact epoch.
    }
  }

  extensionEvent(peer, value) {
    if (
      value.schema !== EXTENSION_SCHEMA ||
      value.profileKey !== peer.profile.profileKey ||
      value.connectionEpoch !== peer.epoch ||
      !isTabHandle(value.tabId) ||
      typeof value.method !== "string" ||
      !value.params ||
      typeof value.params !== "object"
    ) {
      peer.close();
      return;
    }
    if (value.method === "focus.cancelled") {
      if (!exactKeys(value.params, ["session", "handoffToken"]) ||
          !isSession(value.params.session) || !isHex64(value.params.handoffToken)) {
        peer.close();
        return;
      }
      const handoff = this.focusHandoff;
      if (handoff && handoff.peer === peer && handoff.epoch === value.connectionEpoch &&
          handoff.tabId === value.tabId && handoff.session.name === value.params.session &&
          handoff.token === value.params.handoffToken) void this.cancelFocusHandoff(handoff);
      return; // A delayed old-token event grants no authority over a new lease.
    }
    if (value.method === "AgentBrowser.tabAdopted") {
      const owners = [...this.sessions.values()].filter(
        (session) =>
          session.profileKey === peer.profile.profileKey &&
          session.epoch === peer.epoch &&
          session.tabIds.has(value.params.openerTabId),
      );
      if (
        !exactKeys(value.params, ["tabId", "openerTabId"]) ||
        value.params.tabId !== value.tabId ||
        !isTabHandle(value.params.openerTabId) ||
        owners.length !== 1
      ) {
        peer.close();
        return;
      }
      // WHY: descendants are owned only through Chrome's exact opener edge,
      // reported by the extension that created the opaque handle. Retaining
      // that edge lets close remove every task-created popup without target
      // discovery or authority over unrelated tabs.
      owners[0].tabIds.add(value.tabId);
      return;
    }
    if (value.method === "AgentBrowser.tabRevoked") {
      if (
        !exactKeys(value.params, ["reason"]) ||
        typeof value.params.reason !== "string" ||
        !/^[a-z][a-z0-9_]{2,63}$/.test(value.params.reason)
      ) {
        peer.close();
        return;
      }
      const owners = [...this.sessions.values()].filter(
        (session) =>
          session.profileKey === peer.profile.profileKey &&
          session.epoch === peer.epoch &&
          session.tabIds.has(value.tabId),
      );
      if (owners.length === 0) return;
      if (owners.length !== 1) {
        peer.close();
        return;
      }
      const owner = owners[0];
      if (owner.rootTabId !== value.tabId) {
        owner.tabIds.delete(value.tabId);
        return;
      }
      const tabIds = [...owner.tabIds].sort((a, b) =>
        String(a).localeCompare(String(b)),
      );
      // WHY: chrome.debugger.onDetach is terminal for this exact root. Merely
      // deleting its handle left a live endpoint/session that could only return
      // Page command failures; retire that capability now, while preserving
      // every other session and asking the extension to remove exact remnants.
      if (this.retireSessionLedger(owner, "root tab revoked")) {
        void this.reconcileRevokedRoot(peer, owner, tabIds);
      }
      return;
    }
    if (!validatePageCdpMethod(value.method)) return;
    for (const session of this.sessions.values()) {
      if (
        session.profileKey === peer.profile.profileKey &&
        session.epoch === peer.epoch &&
        session.rootTabId === value.tabId &&
        session.ws?.readyState === WebSocket.OPEN
      ) {
        session.ws.send(canonicalJson({ method: value.method, params: value.params }));
      }
    }
  }

  consumeGrant(grant) {
    if (
      !exactKeys(grant, [
        "session",
        "agentOwner",
        "aliasHash",
        "account",
        "currentTab",
        "issuedAt",
        "expiresAt",
        "nonce",
      ]) ||
      !isSession(grant.session) ||
      !validateOwnerIdentity(grant.agentOwner) ||
      grant.agentOwner.uid !== process.getuid() ||
      !isHex64(grant.aliasHash) ||
      grant.session !== ownerSession(grant.agentOwner, grant.aliasHash) ||
      ownerIdentityStatus(grant.agentOwner) !== "live" ||
      !isAccount(grant.account) ||
      typeof grant.currentTab !== "boolean" ||
      !Number.isSafeInteger(grant.issuedAt) ||
      !Number.isSafeInteger(grant.expiresAt) ||
      !isHex64(grant.nonce) ||
      grant.issuedAt > Date.now() + 5_000 ||
      grant.expiresAt <= Date.now() ||
      grant.expiresAt > grant.issuedAt + 30_000 ||
      this.consumedGrants.has(grant.nonce)
    ) {
      throw Object.assign(new Error("provider grant is invalid"), {
        bridgeCode: "GRANT_REJECTED",
      });
    }
    this.consumedGrants.set(grant.nonce, grant.expiresAt);
    for (const [nonce, expiry] of this.consumedGrants) {
      if (expiry <= Date.now()) this.consumedGrants.delete(nonce);
    }
    return grant;
  }

  validateInventorySession(value) {
    if (
      !value ||
      !exactKeys(value, [
        "session",
        "currentTab",
        "rootTabId",
        "tabIds",
        "windowId",
        "ownedWindow",
        "claimedCurrentTab",
      ]) ||
      !isSession(value.session) ||
      !isTabHandle(value.currentTab) ||
      !isTabHandle(value.rootTabId) ||
      !Array.isArray(value.tabIds) ||
      value.tabIds.length < 1 ||
      value.tabIds.length > 64 ||
      value.tabIds.some((item) => !isTabHandle(item)) ||
      new Set(value.tabIds).size !== value.tabIds.length ||
      !value.tabIds.includes(value.rootTabId) ||
      (!Number.isSafeInteger(value.windowId) &&
        !isExtensionHandle(value.windowId, EXTENSION_WINDOW_HANDLE)) ||
      typeof value.ownedWindow !== "boolean" ||
      typeof value.claimedCurrentTab !== "boolean"
    ) {
      throw Object.assign(new Error("extension ownership inventory is invalid"), {
        bridgeCode: "RECOVERY_REJECTED",
      });
    }
    return value;
  }

  launchTimeoutError() {
    return Object.assign(new Error("extension launch deadline elapsed"), {
      bridgeCode: "LAUNCH_TIMEOUT",
    });
  }

  remainingLaunchTime(deadlineAt) {
    const remaining = deadlineAt - Date.now();
    if (remaining <= 0) throw this.launchTimeoutError();
    return Math.min(REQUEST_TIMEOUT_MS, remaining);
  }

  async requestDuringLaunch(peer, op, args, deadlineAt, options = {}) {
    const timeout = this.remainingLaunchTime(deadlineAt);
    try {
      options.onDispatch?.();
      const result = await peer.request(op, args, timeout, {
        deadlineAt,
        onLate: options.onLate,
      });
      if (Date.now() >= deadlineAt) {
        if (options.onLate) {
          void Promise.resolve(options.onLate({ ok: true, result })).catch(
            () => undefined,
          );
        }
        throw this.launchTimeoutError();
      }
      return result;
    } catch (error) {
      if (error?.bridgeCode === "EXTENSION_TIMEOUT") {
        throw this.launchTimeoutError();
      }
      throw error;
    }
  }

  async performCurrentTabClaim(peer, session, deadlineAt, onLate, onCreate) {
    const focus = await this.requestDuringLaunch(
      peer,
      "focus.snapshot",
      {},
      deadlineAt,
    );
    if (
      !focus ||
      !exactKeys(focus, ["claimable"]) ||
      typeof focus.claimable !== "boolean"
    ) {
      throw Object.assign(new Error("focused-tab proof is invalid"), {
        bridgeCode: "FOCUS_PROOF_INVALID",
      });
    }
    if (!focus.claimable) {
      throw Object.assign(new Error("no focused user tab is claimable"), {
        bridgeCode: "NO_FOCUSED_USER_TAB",
      });
    }
    return this.requestDuringLaunch(
      peer,
      "tab.claim-active",
      { session },
      deadlineAt,
      { onLate, onDispatch: onCreate },
    );
  }

  async claimCurrentTab(peer, session, deadlineAt, onLate, onCreate) {
    const profileKey = peer.profile.profileKey;
    const previous = this.currentTabClaimTurns.get(profileKey) ?? Promise.resolve();
    let releaseTurn;
    const ownedTurn = new Promise((resolveTurn) => {
      releaseTurn = resolveTurn;
    });
    // Chain this turn behind its predecessor even if this caller times out while
    // waiting. Otherwise releasing a timed-out middle waiter could let a later
    // claim overtake the still-running focus/claim pair ahead of it.
    const turn = previous.then(() => ownedTurn);
    this.currentTabClaimTurns.set(profileKey, turn);
    try {
      // WHY: The worker's focus proof is profile-global and one-shot. Calling
      // tab.claim-active without its producer caused FOCUS_PROOF_REQUIRED, while
      // interleaved pairs could let one session consume another's proof. Serialize
      // only snapshot + claim for this profile; ordinary page work stays parallel.
      await this.waitDuringLaunch(previous, deadlineAt);
      return await this.performCurrentTabClaim(peer, session, deadlineAt, onLate, onCreate);
    } finally {
      releaseTurn();
      if (this.currentTabClaimTurns.get(profileKey) === turn) {
        void turn.then(() => {
          if (this.currentTabClaimTurns.get(profileKey) === turn) {
            this.currentTabClaimTurns.delete(profileKey);
          }
        });
      }
    }
  }

  retireTimeoutError() {
    return Object.assign(new Error("extension retirement deadline elapsed"), {
      bridgeCode: "RETIRE_TIMEOUT",
    });
  }

  async requestDuringRetire(peer, op, args, deadlineAt) {
    const remaining = deadlineAt - Date.now();
    if (remaining <= 0) throw this.retireTimeoutError();
    try {
      const result = await peer.request(
        op,
        args,
        Math.min(REQUEST_TIMEOUT_MS, remaining),
        { deadlineAt },
      );
      if (Date.now() >= deadlineAt) throw this.retireTimeoutError();
      return result;
    } catch (error) {
      if (error?.bridgeCode === "EXTENSION_TIMEOUT") {
        throw this.retireTimeoutError();
      }
      throw error;
    }
  }

  async waitDuringLaunch(promise, deadlineAt) {
    const timeout = this.remainingLaunchTime(deadlineAt);
    let timer;
    try {
      const result = await Promise.race([
        promise,
        new Promise((_, rejectWait) => {
          timer = setTimeout(() => rejectWait(this.launchTimeoutError()), timeout);
          timer.unref?.();
        }),
      ]);
      if (Date.now() >= deadlineAt) throw this.launchTimeoutError();
      return result;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  validLaunchDescriptor(result) {
    return Boolean(
      result &&
        ((Number.isSafeInteger(result.tabId) && result.tabId >= 0) ||
          isExtensionHandle(result.tabId, EXTENSION_TAB_HANDLE)) &&
        ((Number.isSafeInteger(result.windowId) && result.windowId >= 0) ||
          isExtensionHandle(result.windowId, EXTENSION_WINDOW_HANDLE)) &&
        typeof result.ownedWindow === "boolean" &&
        (result.sharedUserTab === undefined ||
          result.ownedWindow === false && isExtensionHandle(result.sharedUserTab, EXTENSION_TAB_HANDLE)),
    );
  }

  async reconcileLateLaunch(peer, sessionName, response) {
    if (!response.ok || !this.validLaunchDescriptor(response.result)) return;
    await new Promise((resolveTurn) => setImmediate(resolveTurn));
    if (peer.closed || peer.stage !== "ready") return;
    const active = this.sessions.get(sessionName);
    if (
      active &&
      active.profileKey === peer.profile.profileKey &&
      active.epoch === peer.epoch &&
      active.rootTabId === response.result.tabId
    ) {
      return;
    }
    if (active || this.pendingSessions.has(sessionName)) return;
    try {
      const inventory = await peer.request("state.inventory", {});
      if (
        !inventory ||
        !exactKeys(inventory, ["sessions"]) ||
        !Array.isArray(inventory.sessions)
      ) {
        return;
      }
      const retained = inventory.sessions
        .map((item) => {
          try {
            return this.validateInventorySession(item);
          } catch {
            return null;
          }
        })
        .find(
          (item) =>
            item?.session === sessionName &&
            item.rootTabId === response.result.tabId,
        );
      if (
        !retained ||
        this.sessions.has(sessionName) ||
        this.pendingSessions.has(sessionName)
      ) {
        return;
      }
      // WHY: this handles rolling upgrade from a worker that predates request
      // deadlines. A launch response that missed the caller can otherwise
      // retain an invisible root; inventory supplies the exact descendant set
      // required for non-destructive session.close.
      await peer.request("session.close", {
        session: sessionName,
        tabIds: retained.tabIds,
      });
      if (!this.sessions.has(sessionName) && !this.pendingSessions.has(sessionName)) {
        this.forgetOwner(sessionName);
      }
      if (peer.stage === "ready") {
        void peer.request("window.cleanup", {}).catch(() => undefined);
      }
    } catch {
      // New workers self-retire expired launches. Old-worker reconciliation is
      // bounded best effort and must not disconnect unrelated sessions.
    }
  }

  async performCapacityRecovery(
    peer,
    requestedSession,
    retireOrphans = true,
    deadlineAt,
    allowRequestedRebind = true,
  ) {
    const inventory = await this.requestDuringLaunch(
      peer,
      "state.inventory",
      {},
      deadlineAt,
    );
    if (
      !inventory ||
      !exactKeys(inventory, ["sessions"]) ||
      !Array.isArray(inventory.sessions) ||
      inventory.sessions.length > MAX_SESSIONS
    ) {
      throw Object.assign(new Error("extension ownership inventory is invalid"), {
        bridgeCode: "RECOVERY_REJECTED",
      });
    }
    const items = inventory.sessions.map((item) => this.validateInventorySession(item));
    if (new Set(items.map((item) => item.session)).size !== items.length) {
      throw Object.assign(new Error("extension ownership inventory is ambiguous"), {
        bridgeCode: "RECOVERY_REJECTED",
      });
    }
    let requestedResult = null;
    for (const item of items) {
      const known = this.sessions.get(item.session);
      if (known) {
        if (known.profileKey !== peer.profile.profileKey) {
          throw Object.assign(new Error("session ownership inventory conflicts"), {
            bridgeCode: "SESSION_CONFLICT",
          });
        }
        continue;
      }
      if (!retireOrphans && item.session !== requestedSession) continue;
      if (this.pendingSessions.has(item.session) && item.session !== requestedSession) continue;
      const record = this.ownerRecords.get(item.session);
      // WHY: an unknown inventory entry may belong to a live legacy owner.
      // Extension retention alone authorizes neither adoption nor cleanup.
      if (!record || record.profileHash !== sha256(peer.profile.profileKey)) continue;
      if (item.session === requestedSession) {
        if (!allowRequestedRebind) continue;
      } else {
        if (ownerIdentityStatus(record.agentOwner) !== "dead") continue;
        await this.waitDuringLaunch(this.retireDeadOwner(record), deadlineAt);
        continue;
      }
      const rebound = await this.requestDuringLaunch(
        peer,
        "session.rebind",
        {
          session: item.session,
          rootTabId: item.rootTabId,
          tabIds: item.tabIds,
        },
        deadlineAt,
      );
      if (
        !rebound ||
        rebound.tabId !== item.rootTabId ||
        rebound.windowId !== item.windowId ||
        rebound.ownedWindow !== item.ownedWindow
      ) {
        throw Object.assign(new Error("orphan ownership could not be rebound"), {
          bridgeCode: "RECOVERY_REJECTED",
        });
      }
      if (item.session === requestedSession) {
        // WHY: the extension may retain this exact task root across broker
        // turnover. Rebinding it is the successful launch result; retrying
        // tab.create would reject the already-owned session as stale.
        requestedResult = { ...rebound, [RECOVERED_TAB_IDS]: item.tabIds };
        continue;
      }
    }
    return requestedResult;
  }

  async recoverExtensionCapacity(
    peer,
    requestedSession,
    retireOrphans = true,
    deadlineAt,
    allowRequestedRebind = true,
  ) {
    const account = peer.profile.account;
    while (this.capacityRecoveries.has(account)) {
      try {
        await this.waitDuringLaunch(
          this.capacityRecoveries.get(account),
          deadlineAt,
        );
      } catch (error) {
        if (error?.bridgeCode === "LAUNCH_TIMEOUT") throw error;
        // The next caller must make its own exact inventory decision.
      }
    }
    const recovery = this.performCapacityRecovery(
      peer,
      requestedSession,
      retireOrphans,
      deadlineAt,
      allowRequestedRebind,
    );
    this.capacityRecoveries.set(account, recovery);
    try {
      return await recovery;
    } finally {
      if (this.capacityRecoveries.get(account) === recovery) {
        this.capacityRecoveries.delete(account);
      }
    }
  }

  async launch(grant, resumeRetained = false) {
    const deadlineAt = Date.now() + BROKER_LAUNCH_DEADLINE_MS;
    this.consumeGrant(grant);
    const profile = this.config?.profiles.find((item) => item.account === grant.account);
    if (!profile) {
      throw Object.assign(new Error("profile is not enrolled"), {
        bridgeCode: "PROFILE_NOT_ENROLLED",
      });
    }
    const peer = this.peersByAccount.get(grant.account);
    if (!peer || peer.closed) {
      const error = Object.assign(new Error("profile extension is offline"), {
        bridgeCode: "PROFILE_OFFLINE",
        profileDirectory: profile.profileDirectory,
      });
      throw error;
    }
    const prior = this.sessions.get(grant.session);
    const priorOwner = this.matchOwnerRecord(grant, peer.profile.profileKey);
    if (this.ownerRetirements.has(grant.session) || (prior && !priorOwner)) {
      throw Object.assign(new Error("session owner is unavailable"), { bridgeCode: "SESSION_CONFLICT" });
    }
    if (prior) {
      if (
        ownerNamespace(prior.agentOwner) !== ownerNamespace(grant.agentOwner) ||
        prior.account !== grant.account ||
        prior.currentTab !== grant.currentTab ||
        prior.profileKey !== peer.profile.profileKey
      ) {
        throw Object.assign(new Error("session identity changed"), {
          bridgeCode: "SESSION_CONFLICT",
        });
      }
      if (prior.epoch !== peer.epoch || prior.offline) {
        const rebound = await this.requestDuringLaunch(
          peer,
          "session.rebind",
          {
            session: prior.name,
            rootTabId: prior.rootTabId,
            tabIds: [...prior.tabIds].sort((a, b) => a - b),
          },
          deadlineAt,
        );
        if (
          !rebound ||
          rebound.tabId !== prior.rootTabId ||
          rebound.windowId !== prior.windowId ||
          rebound.ownedWindow !== prior.ownedWindow
        ) {
          throw Object.assign(new Error("session ownership could not be rebound"), {
            bridgeCode: "SESSION_REBIND_REJECTED",
          });
        }
        prior.epoch = peer.epoch;
        prior.sharedUserTab = rebound.sharedUserTab;
      }
      prior.offline = false;
      return { cdpUrl: prior.cdpUrl, cleanup: prior.cleanup };
    }
    if (this.pendingSessions.has(grant.session)) {
      throw Object.assign(new Error("session launch is already pending"), {
        bridgeCode: "SESSION_BUSY",
      });
    }
    if (this.sessions.size + this.pendingSessions.size >= MAX_SESSIONS) {
      throw Object.assign(new Error("session capacity is full"), {
        bridgeCode: "CAPACITY_BUSY",
      });
    }
    this.pendingSessions.add(grant.session);
    let result;
    let reservation;
    let creationDispatched = false;
    const onCreate = () => { creationDispatched = true; };
    try {
      if (!priorOwner) {
        // Before recording new authority, disprove an existing unowned exact
        // name. Otherwise a rejected first rebind could persist an owner and
        // silently adopt that legacy tab on its next invocation.
        const items = await this.inventoryForRetire(peer, deadlineAt);
        if (items.some((item) => item.session === grant.session)) {
          throw Object.assign(new Error("session owner is unknown"), { bridgeCode: "SESSION_CONFLICT" });
        }
      }
      reservation = this.rememberOwner(grant, peer.profile.profileKey);
      const lateResult = (response) =>
        this.reconcileLateLaunch(peer, grant.session, response);
      const launchTab = () =>
        grant.currentTab
          ? this.claimCurrentTab(
              peer,
              grant.session,
              deadlineAt,
              lateResult,
              onCreate,
            )
          : this.requestDuringLaunch(
              peer,
              "tab.create",
              { session: grant.session, url: "about:blank" },
              deadlineAt,
              { onLate: lateResult, onDispatch: onCreate },
            );
      try {
        if (priorOwner && resumeRetained) {
          // Persisted authority resumes only its exact retained root. Requiring
          // foreground for an ordinary continuation would hijack the user's
          // later choice; creating a replacement would defeat pin-tab.
          result = await this.recoverExtensionCapacity(peer, grant.session, false,
            deadlineAt, true);
          if (!result) throw Object.assign(new Error("retained root is gone"), { bridgeCode: "RECOVERY_REJECTED" });
        } else {
          result = await launchTab();
        }
      } catch (error) {
        if (error?.bridgeCode === "SESSION_LIMIT_REACHED") {
          const recovered = await this.recoverExtensionCapacity(
            peer,
            grant.session,
            true,
            deadlineAt,
            Boolean(priorOwner),
          );
          // A claim attempt consumes the worker's proof even when allocation is
          // capped, so launchTab must acquire a fresh snapshot before this retry.
          result = recovered ?? (await launchTab());
        } else if (error?.bridgeCode === "REBIND_REQUIRED") {
          result = await this.recoverExtensionCapacity(
            peer,
            grant.session,
            false,
            deadlineAt,
            Boolean(priorOwner),
          );
          if (!result) {
            throw Object.assign(new Error("retained session is missing from inventory"), {
              bridgeCode: "RECOVERY_REJECTED",
            });
          }
        } else {
          throw error;
        }
      }
    } catch (error) {
      // WHY: sixteen rejected focus snapshots used to consume every owner
      // slot without ever claiming a tab. Only this launch's new reservation
      // may be released before a creation/claim dispatch. Once dispatched,
      // generic errors/timeouts prove no absence: keep ownership for exact
      // late-result cleanup, explicit retirement, or confirmed owner death.
      if (!priorOwner && reservation && !creationDispatched &&
          this.ownerRecords.get(grant.session) === reservation &&
          !this.sessions.has(grant.session)) {
        this.forgetOwner(grant.session);
      }
      throw error;
    } finally {
      this.pendingSessions.delete(grant.session);
    }
    if (!this.validLaunchDescriptor(result)) {
      throw Object.assign(new Error("extension returned an invalid tab handle"), {
        bridgeCode: "TAB_HANDLE_INVALID",
      });
    }
    if (Date.now() >= deadlineAt) {
      void this.reconcileLateLaunch(peer, grant.session, {
        ok: true,
        result,
      });
      throw this.launchTimeoutError();
    }
    const endpointToken = opaqueId();
    const cleanup = opaqueId();
    const cdpUrl = `ws://127.0.0.1:${this.httpServer.address().port}/page/${endpointToken}`;
    const session = {
      name: grant.session,
      agentOwner: grant.agentOwner,
      account: grant.account,
      currentTab: grant.currentTab,
      profileKey: peer.profile.profileKey,
      epoch: peer.epoch,
      rootTabId: result.tabId,
      sharedUserTab: result.sharedUserTab,
      windowId: result.windowId,
      ownedWindow: result.ownedWindow,
      // Only validated inventory, never a native response's invented field,
      // may restore descendants after broker restart.
      tabIds: new Set(result[RECOVERED_TAB_IDS] ?? [result.tabId]),
      endpointToken,
      cdpUrl,
      cleanup,
      ws: null,
      offline: false,
    };
    this.sessions.set(session.name, session);
    this.endpoints.set(endpointToken, session);
    return { cdpUrl, cleanup };
  }

  async inventoryForRetire(peer, deadlineAt) {
    const inventory = await this.requestDuringRetire(
      peer,
      "state.inventory",
      {},
      deadlineAt,
    );
    if (
      !inventory ||
      !exactKeys(inventory, ["sessions"]) ||
      !Array.isArray(inventory.sessions) ||
      inventory.sessions.length > MAX_SESSIONS
    ) {
      throw Object.assign(new Error("extension ownership inventory is invalid"), {
        bridgeCode: "RECOVERY_REJECTED",
      });
    }
    const items = inventory.sessions.map((item) =>
      this.validateInventorySession(item),
    );
    if (new Set(items.map((item) => item.session)).size !== items.length) {
      throw Object.assign(new Error("extension ownership inventory is ambiguous"), {
        bridgeCode: "RECOVERY_REJECTED",
      });
    }
    return items;
  }

  async retire(grant) {
    this.consumeGrant(grant);
    if (this.pendingSessions.has(grant.session) || this.ownerRetirements.has(grant.session)) {
      throw Object.assign(new Error("session operation is pending"), { bridgeCode: "SESSION_BUSY" });
    }
    const retirement = this.retireOwnedSession(grant);
    this.ownerRetirements.set(grant.session, retirement);
    try { return await retirement; } finally { this.ownerRetirements.delete(grant.session); }
  }

  async retireOwnedSession(grant, requireDead = false) {
    const deadlineAt = Date.now() + BROKER_RETIRE_DEADLINE_MS;
    const profile = this.config?.profiles.find(
      (item) => item.account === grant.account,
    );
    if (!profile) {
      throw Object.assign(new Error("profile is not enrolled"), {
        bridgeCode: "PROFILE_NOT_ENROLLED",
      });
    }
    const peer = this.peersByAccount.get(grant.account);
    if (!peer || peer.closed) {
      throw Object.assign(new Error("profile extension is offline"), {
        bridgeCode: "PROFILE_OFFLINE",
        profileDirectory: profile.profileDirectory,
      });
    }
    const record = this.matchOwnerRecord(grant, peer.profile.profileKey);
    if (!record) {
      // A fresh close cannot adopt a legacy retained name as its authority.
      const items = await this.inventoryForRetire(peer, deadlineAt);
      if (items.some((item) => item.session === grant.session) || this.sessions.has(grant.session)) {
        throw Object.assign(new Error("session owner is unknown"), { bridgeCode: "SESSION_CONFLICT" });
      }
      return { status: "already-retired" };
    }
    const checkDeath = () => {
      if (requireDead && ownerIdentityStatus(record.agentOwner) !== "dead") {
        throw Object.assign(new Error("owner death is unconfirmed"), { bridgeCode: "OWNER_AMBIGUOUS" });
      }
    };
    checkDeath();
    const known = this.sessions.get(grant.session);
    if (
      known &&
      (known.account !== grant.account ||
        known.currentTab !== grant.currentTab ||
        known.profileKey !== peer.profile.profileKey)
    ) {
      throw Object.assign(new Error("session identity changed"), {
        bridgeCode: "SESSION_CONFLICT",
      });
    }

    if (known && known.epoch === peer.epoch && !known.offline) {
      checkDeath();
      await this.requestDuringRetire(
        peer,
        "session.close",
        {
          session: known.name,
          tabIds: [...known.tabIds].sort((a, b) =>
            String(a).localeCompare(String(b)),
          ),
        },
        deadlineAt,
      );
    } else {
      const items = await this.inventoryForRetire(peer, deadlineAt);
      const retained = items.find((item) => item.session === grant.session);
      if (!retained) {
        if (known) this.retireSessionLedger(known, "session already retired");
        this.forgetOwner(grant.session);
        if (peer.stage === "ready") {
          void peer.request("window.cleanup", {}).catch(() => undefined);
        }
        return { status: "already-retired" };
      }
      if (
        retained.claimedCurrentTab !== grant.currentTab ||
        (known && known.rootTabId !== retained.rootTabId)
      ) {
        throw Object.assign(new Error("session identity changed"), {
          bridgeCode: "SESSION_CONFLICT",
        });
      }
      checkDeath();
      const rebound = await this.requestDuringRetire(
        peer,
        "session.rebind",
        {
          session: retained.session,
          rootTabId: retained.rootTabId,
          tabIds: retained.tabIds,
        },
        deadlineAt,
      );
      if (
        !rebound ||
        rebound.tabId !== retained.rootTabId ||
        rebound.windowId !== retained.windowId ||
        rebound.ownedWindow !== retained.ownedWindow
      ) {
        throw Object.assign(new Error("session ownership could not be rebound"), {
          bridgeCode: "RECOVERY_REJECTED",
        });
      }
      checkDeath();
      await this.requestDuringRetire(
        peer,
        "session.close",
        {
          session: retained.session,
          tabIds: retained.tabIds,
        },
        deadlineAt,
      );
    }

    // WHY: wrapper close may run after the donor daemon disappeared, so its
    // authority is a fresh one-use identity grant rather than a daemon-held
    // cleanup token. Inventory/rebind is limited to that exact session; an
    // absent record is idempotent success and unrelated retained sessions stay.
    if (known) this.retireSessionLedger(known, "session retired");
    this.forgetOwner(grant.session);
    if (peer.stage === "ready") {
      void peer.request("window.cleanup", {}).catch(() => undefined);
    }
    return { status: "retired" };
  }

  async closeSession(cleanup) {
    const session = [...this.sessions.values()].find((item) => item.cleanup === cleanup);
    if (!session) {
      throw Object.assign(new Error("cleanup receipt is stale"), {
        bridgeCode: "CLEANUP_REJECTED",
      });
    }
    const ownerRecord = this.ownerRecords.get(session.name);
    const peer = this.peersByAccount.get(session.account);
    const exactPeer = peer && peer.epoch === session.epoch ? peer : null;
    if (exactPeer) {
      await exactPeer.request("session.close", {
        session: session.name,
        tabIds: [...session.tabIds].sort((a, b) => a - b),
      });
      // WHY: root revocation can retire this object and reopen the same alias
      // before its old cleanup acknowledgment arrives. Alias equality cannot
      // authorize deleting that replacement's session or owner record.
      if (this.sessions.get(session.name) === session &&
          this.ownerRecords.get(session.name) === ownerRecord) {
        this.forgetOwner(session.name);
      }
    }
    if (session.ws) session.ws.close(1000, "session closed");
    this.endpoints.delete(session.endpointToken);
    if (this.sessions.get(session.name) === session) this.sessions.delete(session.name);
    session.cleanup = "";
    if (exactPeer?.stage === "ready") {
      // WHY: Chrome may destroy the profile's native port while removing its
      // last owned window. The authoritative session ledger must already be
      // retired, and cleanup success must not depend on receiving that final
      // response from a port whose own operation can terminate it.
      void exactPeer.request("window.cleanup", {}).catch(() => undefined);
    }
    return { status: exactPeer ? "closed" : "retired-offline" };
  }

  commandMaps() {
    this.commands ??= new Map();
    this.commandGroups ??= new Map();
  }

  retainedFocusOwner(grant) {
    const session = this.sessions.get(grant.session);
    const peer = this.peersByAccount.get(grant.account);
    // A foreground request must not create, recover, adopt or change a target.
    // A new owner reusing the alias cannot inherit this owner's invitation.
    if (!session || !peer || peer.closed || peer.stage !== "ready" || session.offline ||
        session.epoch !== peer.epoch || session.account !== grant.account ||
        session.currentTab !== grant.currentTab || session.profileKey !== peer.profile.profileKey ||
        ownerNamespace(session.agentOwner) !== ownerNamespace(grant.agentOwner) ||
        !this.matchOwnerRecord(grant, peer.profile.profileKey) ||
        this.ownerRetirements.has(grant.session) || this.pendingSessions.has(grant.session)) {
      throw Object.assign(new Error("retained foreground owner is unavailable"), { bridgeCode: "SESSION_CONFLICT" });
    }
    this.commandMaps();
    const group = session.profileKey + "/" + (session.sharedUserTab || session.rootTabId);
    if (this.commandGroups.has(group)) {
      throw Object.assign(new Error("target command is active"), { bridgeCode: "TARGET_BUSY" });
    }
    return { session, peer };
  }

  focusHandoffCurrent(handoff) {
    const { session, peer } = handoff;
    return this.focusHandoff === handoff && !handoff.cancelled &&
      this.sessions.get(session.name) === session &&
      this.ownerRecords.get(session.name) === handoff.ownerRecord &&
      this.peersByAccount.get(session.account) === peer && !peer.closed && peer.stage === "ready" &&
      !session.offline && peer.epoch === handoff.epoch && session.epoch === handoff.epoch &&
      session.rootTabId === handoff.tabId && session.windowId === handoff.windowId &&
      ownerNamespace(session.agentOwner) === handoff.ownerNamespace &&
      ownerIdentityStatus(session.agentOwner) === "live";
  }

  focusTargetArgs(handoff) {
    return { session: handoff.session.name, tabId: handoff.tabId, windowId: handoff.windowId,
      handoffToken: handoff.token };
  }

  nativeFocusArgs(handoff) {
    return { handoffToken: handoff.token, session: handoff.session.name, tabId: handoff.tabId };
  }

  async focusRequest(handoff, op, args = {}, timeoutMs = 2000) {
    handoff.trace ??= [];
    const step = { op, started: Date.now(), stage: "owner-before" };
    handoff.trace.push(step);
    try {
    if (!this.focusHandoffCurrent(handoff) || Date.now() >= handoff.deadlineAt)
      throw Object.assign(new Error("focus owner changed"), { bridgeCode: "FOREGROUND_NOT_CONFIRMED" });
    const deadlineAt = Math.min(handoff.deadlineAt, Date.now() + timeoutMs);
    step.stage = "request";
    let result = await handoff.peer.request(op, op.startsWith("native.focus.") ? this.nativeFocusArgs(handoff) : args,
      Math.max(1, deadlineAt - Date.now()), { deadlineAt });
    step.stage = "owner-after";
    if (op.startsWith("native.focus.") && exactKeys(result, ["status", "nativeReason"]) &&
        typeof result.nativeReason === "string" && /^[A-Z_]{1,64}$/.test(result.nativeReason)) {
      step.nativeReason = result.nativeReason;
      result = { status: result.status };
    }
    if (typeof result?.status === "string" && /^[a-z-]{1,40}$/.test(result.status)) step.status = result.status;
    if (op === "tab.foreground") step.confirmed = result?.active === true && result?.focused === true;
    if (!this.focusHandoffCurrent(handoff) || Date.now() >= deadlineAt)
      throw Object.assign(new Error("focus owner changed"), { bridgeCode: "FOREGROUND_NOT_CONFIRMED" });
    step.stage = "received";
    return result;
    } catch (error) {
      step.errorCode = /^[A-Z_]{1,64}$/.test(error?.bridgeCode) ? error.bridgeCode : "UNCLASSIFIED";
      throw error;
    } finally {
      step.ended = Date.now();
      // Bounded explicit-handoff diagnostics only, never page/identity data.
      try { writePrivateJson(join(this.args.stateRoot, "focus-handoff-last.json"), { steps: handoff.trace.slice(-12) }); }
      catch { /* An observation failure cannot change a focus operation. */ }
    }
  }

  focusStatus(value, allowed) {
    if (!value || !exactKeys(value, ["status"]) || !allowed.includes(value.status))
      throw Object.assign(new Error("focus response is invalid"), { bridgeCode: "FOREGROUND_NOT_CONFIRMED" });
    return value.status;
  }

  async cancelFocusHandoff(handoff) {
    if (!handoff) return;
    if (handoff.cancellation) return handoff.cancellation;
    handoff.cancelled = true;
    handoff.cancellation = (async () => {
      try {
        // Cancellation never focuses. Keep global admission occupied until both
        // cancellations settle, so an old reply cannot cancel a newer handoff.
        if (!handoff.peer.closed && handoff.peer.epoch === handoff.epoch) {
          const deadlineAt = Date.now() + 2000;
          await Promise.allSettled([
            handoff.peer.request("native.focus.cancel", this.nativeFocusArgs(handoff), 2000, { deadlineAt }),
            handoff.peer.request("tab.foreground.cancel", this.focusTargetArgs(handoff), 2000, { deadlineAt }),
          ]);
        }
      } finally {
        if (this.focusHandoff === handoff) this.focusHandoff = null;
      }
    })();
    return handoff.cancellation;
  }

  async foreground(grant, inputBoundary) {
    if (!["password", "two-factor", "hardware-key", "captcha", "file-picker",
          "recovery", "account-authority"].includes(inputBoundary)) {
      throw Object.assign(new Error("genuine user input is required"), { bridgeCode: "INPUT_BOUNDARY_REQUIRED" });
    }
    this.consumeGrant(grant);
    const { session, peer } = this.retainedFocusOwner(grant);
    if (this.focusHandoff)
      throw Object.assign(new Error("a focus handoff is already active"), { bridgeCode: "FOCUS_HANDOFF_BUSY" });
    const handoff = { session, peer, epoch: peer.epoch, token: opaqueId(), tabId: session.rootTabId,
      windowId: session.windowId, ownerRecord: this.ownerRecords.get(session.name),
      ownerNamespace: ownerNamespace(session.agentOwner), phase: "entering", cancelled: false,
      deadlineAt: Math.min(grant.expiresAt, Date.now() + REQUEST_TIMEOUT_MS) };
    // WHY: a short foreground call did not observe the password/2FA interval.
    // One global owner/epoch-bound lease joins native app focus with Chrome's
    // retained tab latch; a snapshot or a same-alias caller cannot release it.
    this.focusHandoff = handoff;
    try {
      this.focusStatus(await this.focusRequest(handoff, "native.focus.begin"), ["captured"]);
    // The worker atomically reserves the physical target before its first await.
    // This closes the race with a native command arriving after the above check;
    // no profile-wide ordinary-command lock or short-lived CLI lease is used.
    const observed = await this.focusRequest(handoff, "tab.foreground", {
      session: session.name, tabId: session.rootTabId, windowId: session.windowId,
      currentTab: grant.currentTab, inputBoundary, handoffToken: handoff.token,
    }, REQUEST_TIMEOUT_MS);
    if (this.sessions.get(session.name) !== session || this.peersByAccount.get(session.account) !== peer ||
        peer.closed || peer.epoch !== session.epoch || ownerIdentityStatus(session.agentOwner) !== "live" ||
        !exactKeys(observed, ["tabId", "windowId", "active", "focused"]) ||
        observed.tabId !== session.rootTabId || observed.windowId !== session.windowId ||
        observed.active !== true || observed.focused !== true) {
      throw Object.assign(new Error("foreground was not confirmed"), { bridgeCode: "FOREGROUND_NOT_CONFIRMED" });
    }
    this.focusStatus(await this.focusRequest(handoff, "native.focus.commit"), ["armed"]);
    // Native HWND capture alone cannot identify a Chrome tab. Re-observe the
    // exact owned tab/window after commit, with both lifetime latches active.
    this.focusStatus(await this.focusRequest(handoff, "tab.foreground.check",
      this.focusTargetArgs(handoff)), ["unchanged"]);
    handoff.phase = "held";
    return observed;
    } catch (error) {
      await this.cancelFocusHandoff(handoff);
      throw error;
    }
  }

  async background(grant) {
    this.consumeGrant(grant);
    const { session, peer } = this.retainedFocusOwner(grant);
    const handoff = this.focusHandoff;
    if (!handoff) return { status: "no-handoff" };
    if (handoff.session !== session || handoff.peer !== peer ||
        handoff.ownerNamespace !== ownerNamespace(grant.agentOwner))
      throw Object.assign(new Error("focus handoff belongs to another owner"), { bridgeCode: "SESSION_CONFLICT" });
    if (handoff.phase !== "held")
      throw Object.assign(new Error("focus handoff is pending"), { bridgeCode: "TARGET_BUSY" });
    handoff.phase = "releasing";
    handoff.deadlineAt = Math.min(grant.expiresAt, Date.now() + REQUEST_TIMEOUT_MS);
    let releaseIssued = false;
    // WHY: the literal trace returned to the previous app while this wrapper
    // said "denied". Preserve the upstream stage/status, not a guessed OS cause.
    // One bounded local record; no identities, handles, URLs or capability data.
    const trace = { at: Date.now(), steps: [] };
    const observe = async (op, args, allowed) => {
      trace.stage = op;
      const value = await this.focusRequest(handoff, op, args);
      trace.steps.push({ op, at: Date.now(), status: allowed.includes(value?.status) ? value.status : "invalid" });
      return this.focusStatus(value, allowed);
    };
    try {
      const native = await observe("native.focus.check", {},
        ["unchanged", "cancelled", "unavailable", "busy"]);
      if (native !== "unchanged") return { status: native === "cancelled" ? "cancelled" : "denied" };
      const chrome = await observe("tab.foreground.check",
        this.focusTargetArgs(handoff), ["unchanged", "cancelled"]);
      if (chrome !== "unchanged") return { status: "cancelled" };
      const restoredTab = await observe("tab.background",
        this.focusTargetArgs(handoff), ["returned", "already-current", "cancelled"]);
      if (restoredTab === "cancelled") return { status: "cancelled" };
      const prepared = await observe("native.focus.release", {},
        ["prepared", "already-current", "cancelled", "unavailable", "unconfirmed"]);
      if (prepared !== "prepared") return { status: prepared === "unavailable" ? "denied" : prepared };
      // Chrome already owns foreground permission; the native owner has just
      // proved its next-visible-window selection equals the saved prior app.
      releaseIssued = true;
      const released = await observe("window.background", this.focusTargetArgs(handoff),
        ["released", "cancelled"]);
      if (released === "cancelled") return { status: "cancelled" };
      const status = await observe("native.focus.finish-release", {},
        ["returned", "cancelled", "unconfirmed"]);
      return { status };
    } catch (error) {
      trace.errorCode = /^[A-Z_]{1,64}$/.test(error?.bridgeCode) ? error.bridgeCode : "UNCLASSIFIED";
      // No retry and no success inferred from timeout/API acknowledgment.
      return { status: releaseIssued ? "unconfirmed" : handoff.cancelled ? "cancelled" : "denied" };
    } finally {
      trace.cancelled = handoff.cancelled === true;
      trace.releaseIssued = releaseIssued;
      try { writePrivateJson(join(this.args.stateRoot, "focus-return-last.json"), trace); }
      catch { /* Diagnostics must never alter ownership or a focus action. */ }
      await this.cancelFocusHandoff(handoff);
    }
  }

  daemonIdentity(sessionName, pid) {
    if (!isSession(sessionName) || !Number.isSafeInteger(pid) || pid <= 1)
      throw Object.assign(new Error("daemon identity is invalid"), { bridgeCode: "CONTROL_REJECTED" });
    const base = join(`/tmp/ab36-${process.getuid()}`, "namespaces", "p", "run");
    const path = join(base, sessionName + ".pid");
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== process.getuid() ||
        stat.size > 32 || Number(readFileSync(path, "utf8").trim()) !== pid)
      throw Object.assign(new Error("daemon identity is unavailable"), { bridgeCode: "CONTROL_REJECTED" });
    const identity = observeProcessIdentity(pid);
    // PID-file text is a rendezvous hint, not process authority. Require that
    // this actual process owns the exact named daemon's listening Unix socket.
    const fds = readdirSync(`/proc/${pid}/fd`);
    if (fds.length > 512) throw new Error("daemon descriptor observation is ambiguous");
    const inodes = new Set();
    for (const fd of fds) {
      try {
        const match = /^socket:\[([0-9]+)\]$/.exec(readlinkSync(`/proc/${pid}/fd/${fd}`));
        if (match) inodes.add(match[1]);
      } catch { /* a concurrently closed descriptor grants no ownership */ }
    }
    const unix = readFileSync(`/proc/${pid}/net/unix`, "utf8");
    if (unix.length > 1024 * 1024 || !unix.split("\n").some((line) => {
      const fields = line.trim().split(/\s+/);
      return fields[7] === join(base, sessionName + ".sock") && fields[4] === "0001" &&
        (Number.parseInt(fields[3], 16) & 0x10000) !== 0 && inodes.has(fields[6]);
    }) || ownerIdentityStatus(identity) !== "live")
      throw Object.assign(new Error("daemon socket owner changed"), { bridgeCode: "CONTROL_REJECTED" });
    return identity;
  }

  async beginCommand(grant, daemonPid) {
    this.commandMaps();
    const daemon = this.daemonIdentity(grant?.session, daemonPid);
    const owner = this.ownerRecords.get(grant?.session);
    // A warm continuation may omit --current-tab; it may resume only its own
    // retained participant. Keeping the flag is also continuation: the operator
    // requires it on every command, including after the user minimizes Chrome.
    // Only a new participant's initial claim consumes fresh foreground proof.
    const effective = owner && !grant.currentTab ? { ...grant, currentTab: owner.currentTab } : grant;
    const capability = await this.launch(effective, true);
    const session = this.sessions.get(grant.session);
    session.commandRequired = true;
    const peer = this.peersByAccount.get(session.account);
    const group = session.profileKey + "/" + (session.sharedUserTab || session.rootTabId);
    await this.reapCommands();
    while (this.commandGroups.has(group)) await this.commandGroups.get(group).done;
    if (this.sessions.get(session.name) !== session || peer.epoch !== session.epoch ||
        ownerIdentityStatus(session.agentOwner) !== "live" || ownerIdentityStatus(daemon) !== "live")
      throw Object.assign(new Error("command owner changed"), { bridgeCode: "SESSION_CONFLICT" });
    let release;
    const command = {
      id: opaqueId(), group, session, peer, epoch: session.epoch, daemon,
      done: new Promise((resolveDone) => { release = resolveDone; }),
      release: () => release(), completed: false, reconciling: false,
    };
    this.commands.set(command.id, command);
    this.commandGroups.set(group, command);
    try {
      const ready = await peer.request("command.begin", {
        session: session.name, tabId: session.rootTabId, command: command.id,
      });
      if (!exactKeys(ready, ["command"]) || ready.command !== command.id)
        throw Object.assign(new Error("command fence was not acknowledged"), { bridgeCode: "CONTROL_REJECTED" });
    } catch (error) {
      // No browser command is issued until begin acknowledges. A lost begin
      // ack is not cancellation: fence and reconcile this exact generation.
      command.completed = true;
      await this.reconcileCommand(command).catch(() => undefined);
      throw error;
    }
    return { ...capability, command: command.id };
  }

  authorizedCommand(session, id) {
    const command = this.commands?.get(id);
    return command && !command.completed && command.session === session &&
      this.commandGroups.get(command.group) === command && command.epoch === session.epoch &&
      this.sessions.get(session.name) === session ? command : null;
  }

  forgetCommand(command) {
    if (this.commands.get(command.id) !== command) return;
    this.commands.delete(command.id);
    if (this.commandGroups.get(command.group) === command) this.commandGroups.delete(command.group);
    command.release();
  }

  async reconcileCommand(command) {
    if (command.reconciling || this.commands.get(command.id) !== command) return;
    command.reconciling = true;
    try {
      const peer = this.peersByAccount.get(command.session.account);
      if (peer !== command.peer || peer?.closed || peer?.epoch !== command.epoch ||
          this.sessions.get(command.session.name) !== command.session) {
        // Old endpoints and old extension epochs cannot dispatch another frame.
        this.forgetCommand(command);
        return;
      }
      const ended = await peer.request("command.end", {
        session: command.session.name, tabId: command.session.rootTabId, command: command.id,
      });
      if (!exactKeys(ended, ["completed"]) || ended.completed !== true)
        throw Object.assign(new Error("command completion was not acknowledged"), { bridgeCode: "CONTROL_REJECTED" });
      this.forgetCommand(command);
    } finally { command.reconciling = false; }
  }

  async completeCommand(id, daemonPid) {
    this.commandMaps();
    const command = this.commands.get(id);
    if (!command || command.daemon.pid !== daemonPid)
      throw Object.assign(new Error("command identity changed"), { bridgeCode: "CONTROL_REJECTED" });
    // WHY: only the daemon executing the entire transaction produces completion.
    // CLI exit and caller timeouts never release a live daemon's command.
    command.completed = true;
    await this.reconcileCommand(command);
    return { completed: true };
  }

  async reapCommands() {
    this.commandMaps();
    for (const command of [...this.commands.values()]) {
      if (this.sessions.get(command.session.name) !== command.session) command.completed = true;
      const peer = this.peersByAccount.get(command.session.account);
      if (peer !== command.peer || peer?.closed || peer?.epoch !== command.epoch)
        command.completed = true;
      if (ownerIdentityStatus(command.daemon) === "dead") command.completed = true;
      if (command.completed) await this.reconcileCommand(command).catch(() => undefined);
    }
  }

  async handleControl(request) {
    if (!request || request.schema !== CONTROL_SCHEMA || !isHex64(request.id)) {
      throw Object.assign(new Error("control request is invalid"), {
        bridgeCode: "CONTROL_REJECTED",
      });
    }
    if (request.op === "health" && exactKeys(request, ["schema", "id", "op"])) {
      return {
        status: "ready",
        pid: process.pid,
        sourceSha256: sha256(readFileSync(scriptPath)),
        connectedProfiles: [...this.peersByAccount.keys()].sort(),
        sessions: this.sessions.size,
        capacity: MAX_SESSIONS,
      };
    }
    if (
      request.op === "enroll.begin" &&
      exactKeys(request, ["schema", "id", "op", "account", "profileDirectory"])
    ) {
      if (
        !this.config ||
        !isAccount(request.account) ||
        !isProfileDirectory(request.profileDirectory) ||
        this.activeEnrollment() ||
        this.config.profiles.some(
          (item) =>
            item.account === request.account ||
            item.profileDirectory === request.profileDirectory,
        )
      ) {
        throw Object.assign(new Error("profile enrollment is invalid"), {
          bridgeCode: "ENROLLMENT_REJECTED",
        });
      }
      const pending = this.beginEnrollment({
        account: request.account,
        profileDirectory: request.profileDirectory,
      }, 30_000);
      return {
        status: "waiting",
        enrollmentId: pending.enrollmentId,
        expiresAt: pending.expiresAt,
      };
    }
    if (
      request.op === "enroll.replace.begin" &&
      exactKeys(request, ["schema", "id", "op", "account", "profileDirectory"])
    ) {
      const existing = this.config?.profiles.find(
        (item) =>
          item.account === request.account &&
          item.profileDirectory === request.profileDirectory,
      );
      if (
        !existing ||
        !isAccount(request.account) ||
        !isProfileDirectory(request.profileDirectory) ||
        this.activeEnrollment() ||
        this.peersByAccount.has(request.account) ||
        [...this.sessions.values()].some((session) => session.account === request.account)
      ) {
        throw Object.assign(new Error("profile replacement enrollment is invalid"), {
          bridgeCode: "ENROLLMENT_REJECTED",
        });
      }
      // WHY: Chrome native messaging identifies every MV3 profile worker with
      // the same extension origin and parent-window 0. Therefore an unknown
      // hello can never select a profile. Only a Chrome action click inside the
      // intended profile may bind its exact persistent key to this one pending
      // offline account/directory; timing and connection order carry no trust.
      const pending = this.beginEnrollment({
        account: request.account,
        profileDirectory: request.profileDirectory,
        replaceProfileKey: existing.profileKey,
      }, 65_000);
      return {
        status: "waiting",
        enrollmentId: pending.enrollmentId,
        expiresAt: pending.expiresAt,
      };
    }
    if (
      request.op === "enroll.cancel" &&
      exactKeys(request, ["schema", "id", "op", "enrollmentId"]) &&
      isHex64(request.enrollmentId) &&
      this.clearPendingEnrollment(request.enrollmentId)
    ) {
      return { status: "cancelled" };
    }
    if (request.op === "launch" && exactKeys(request, ["schema", "id", "op", "grant"])) {
      return this.launch(request.grant);
    }
    if (request.op === "foreground" &&
        exactKeys(request, ["schema", "id", "op", "grant", "inputBoundary"])) {
      return this.foreground(request.grant, request.inputBoundary);
    }
    if (request.op === "background" && exactKeys(request, ["schema", "id", "op", "grant"]))
      return this.background(request.grant);
    if (request.op === "command.begin" &&
        exactKeys(request, ["schema", "id", "op", "grant", "daemonPid"]))
      return this.beginCommand(request.grant, request.daemonPid);
    if (request.op === "command.end" &&
        exactKeys(request, ["schema", "id", "op", "command", "daemonPid"]) && isHex64(request.command))
      return this.completeCommand(request.command, request.daemonPid);
    if (request.op === "retire" && exactKeys(request, ["schema", "id", "op", "grant"])) {
      return this.retire(request.grant);
    }
    if (request.op === "close" && exactKeys(request, ["schema", "id", "op", "cleanup"])) {
      if (!isHex64(request.cleanup)) {
        throw Object.assign(new Error("cleanup receipt is invalid"), {
          bridgeCode: "CLEANUP_REJECTED",
        });
      }
      return this.closeSession(request.cleanup);
    }
    throw Object.assign(new Error("control operation is unsupported"), {
      bridgeCode: "CONTROL_REJECTED",
    });
  }

  handleControlSocket(socket) {
    let bytes = 0;
    let text = "";
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      socket.end(`${canonicalJson(value)}\n`);
    };
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => {
      if (settled) return;
      bytes += Buffer.byteLength(chunk);
      if (bytes > MAX_CONTROL_MESSAGE_BYTES || text.includes("\n")) {
        finish({
          schema: CONTROL_SCHEMA,
          id: "0".repeat(64),
          ok: false,
          error: boundedError("CONTROL_REJECTED", "control framing is invalid"),
        });
        return;
      }
      text += chunk;
      const newline = text.indexOf("\n");
      if (newline < 0) return;
      if (newline !== text.length - 1) {
        finish({
          schema: CONTROL_SCHEMA,
          id: "0".repeat(64),
          ok: false,
          error: boundedError("CONTROL_REJECTED", "control framing is invalid"),
        });
        return;
      }
      let request;
      try {
        request = JSON.parse(text.slice(0, -1));
      } catch {
        finish({
          schema: CONTROL_SCHEMA,
          id: "0".repeat(64),
          ok: false,
          error: boundedError("CONTROL_REJECTED", "control JSON is invalid"),
        });
        return;
      }
      Promise.resolve(this.handleControl(request)).then(
        (result) => finish({ schema: CONTROL_SCHEMA, id: request.id, ok: true, result }),
        (error) => {
          const response = {
            schema: CONTROL_SCHEMA,
            id: isHex64(request?.id) ? request.id : "0".repeat(64),
            ok: false,
            error: boundedError(error?.bridgeCode ?? "BRIDGE_FAILED", error?.message),
          };
          if (error?.profileDirectory) response.profileDirectory = error.profileDirectory;
          finish(response);
        },
      );
    });
    socket.once("error", () => socket.destroy());
    socket.once("end", () => {
      if (!settled) socket.destroy();
    });
  }

  traceInput(session, method, params) {
    // WHY: Chrome can acknowledge mouse input without delivering any DOM event.
    // Opt-in, exact-session, bounded wire evidence distinguishes that boundary
    // from a donor that never sent press/release. Never record page text, URLs,
    // credentials, Runtime expressions, or arbitrary CDP bodies.
    if (!["Input.dispatchMouseEvent", "DOM.getBoxModel"].includes(method)) return null;
    try {
      const opt = join(this.args.stateRoot, "input-diagnostic-session");
      const stat = lstatSync(opt);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== process.getuid() ||
          (stat.mode & 0o077) !== 0 || stat.size > 129 ||
          readFileSync(opt, "utf8").trim() !== session.name) return null;
      const safe = {};
      for (const key of ["x", "y", "buttons", "clickCount", "backendNodeId"])
        if (Number.isFinite(params[key])) safe[key] = params[key];
      if (["mouseMoved", "mousePressed", "mouseReleased", "mouseWheel"].includes(params.type))
        safe.type = params.type;
      if (["left", "right", "middle", "none", "back", "forward"].includes(params.button))
        safe.button = params.button;
      const item = { method, params: safe, startedAt: Date.now(), status: "sent" };
      this.inputDiagnostics ??= [];
      this.inputDiagnostics.push(item);
      this.inputDiagnostics = this.inputDiagnostics.slice(-24);
      this.flushInputTrace();
      return item;
    } catch { return null; }
  }

  flushInputTrace() {
    try {
      writePrivateJson(join(this.args.stateRoot, "input-diagnostic.json"), {
        schema: "agent-browser.input-diagnostic.v1", brokerPid: process.pid,
        records: this.inputDiagnostics,
      });
    } catch { /* Diagnostic failure must not alter browser delivery. */ }
  }

  handleWs(ws, session) {
    if (session.ws && session.ws !== ws) session.ws.close(1012, "session reconnected");
    session.ws = ws;
    ws.on("message", async (raw, isBinary) => {
      if (isBinary || raw.length > MAX_CDP_MESSAGE_BYTES) return ws.close(1008, "invalid CDP frame");
      let request;
      try {
        request = JSON.parse(raw.toString("utf8"));
      } catch {
        return ws.close(1008, "invalid CDP JSON");
      }
      const generation = request?.agentBrowserCommand;
      if (generation !== undefined) delete request.agentBrowserCommand;
      if (session.sharedUserTab || session.commandRequired || generation !== undefined) {
        if (!this.authorizedCommand(session, generation) || session.ws !== ws) {
          ws.send(canonicalJson({ id: request?.id ?? 0, error: { code: -32000, message: "COMMAND_FENCED" } }));
          return;
        }
      }
      const hasParams = Object.prototype.hasOwnProperty.call(request ?? {}, "params");
      const params = hasParams ? request.params : {};
      const directPageLivenessProbe =
        request?.method === "Browser.getVersion" &&
        params &&
        typeof params === "object" &&
        !Array.isArray(params) &&
        Object.keys(params).length === 0;
      if (
        (!exactKeys(request, ["id", "method"]) &&
          !exactKeys(request, ["id", "method", "params"])) ||
        !Number.isSafeInteger(request.id) ||
        request.id < 1 ||
        (!validatePageCdpMethod(request.method) && !directPageLivenessProbe) ||
        !params ||
        typeof params !== "object" ||
        Array.isArray(params)
      ) {
        ws.send(
          canonicalJson({
            id: Number.isSafeInteger(request?.id) ? request.id : 0,
            error: { code: -32601, message: "Method is outside the page capability" },
          }),
        );
        return;
      }
      const peer = this.peersByAccount.get(session.account);
      if (!peer || peer.epoch !== session.epoch) {
        ws.send(canonicalJson({ id: request.id, error: { code: -32000, message: "Profile offline" } }));
        return;
      }
      const trace = this.traceInput(session, request.method, params);
      try {
        // WHY: v0.36.0 probes every connection with Browser.getVersion even
        // when its provider declared directPage. Granting Browser.* would
        // escape the owned tab. Prove this exact page is responsive instead,
        // then return the empty success value that the donor uses only as a
        // boolean liveness signal.
        const method = directPageLivenessProbe
          ? "Page.getFrameTree"
          : request.method;
        const result = await peer.request("cdp.send", {
          session: session.name,
          tabId: session.rootTabId,
          method,
          // CDP commands with no parameters are valid without a `params`
          // member; the pinned donor emits Page/Runtime/Network.enable this
          // way. Normalizing only that omitted member preserves the strict
          // page-capability envelope without rejecting the real engine.
          params,
          ...(generation === undefined ? {} : { command: generation }),
        });
        if (trace) {
          trace.elapsedMs = Date.now() - trace.startedAt;
          trace.status = "acknowledged";
          if (request.method === "DOM.getBoxModel" &&
              Array.isArray(result?.model?.content) && result.model.content.length === 8 &&
              result.model.content.every(Number.isFinite)) trace.contentQuad = result.model.content;
          this.flushInputTrace();
        }
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(
            canonicalJson({
              id: request.id,
              result: directPageLivenessProbe ? {} : result,
            }),
          );
        }
      } catch (error) {
        if (trace) {
          trace.elapsedMs = Date.now() - trace.startedAt;
          trace.status = boundedError(error?.bridgeCode).code;
          this.flushInputTrace();
        }
        if (ws.readyState === WebSocket.OPEN) {
          // WHY: hiding CDP_METHOD_DENIED behind a generic page error made
          // transport rejection look like a stale ref or a Google UI failure.
          // Forward only the bounded machine code, never page/error contents.
          const reason = boundedError(error?.bridgeCode).code;
          ws.send(canonicalJson({ id: request.id, error: { code: -32000, message: `Page command failed (${reason})` } }));
        }
      }
    });
    ws.once("close", () => {
      if (session.ws === ws) session.ws = null;
    });
  }

  async start() {
    assertSecureDirectory(this.args.stateRoot);
    if (!this.config) fail("profile configuration is missing");
    const lockPath = join(this.args.stateRoot, "broker.lock");
    let lockFd;
    try {
      lockFd = openSync(lockPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
      writeFileSync(lockFd, `${process.pid}\n`, "utf8");
    } catch (error) {
      if (error?.code === "EEXIST") fail("another broker owns the state root", 69);
      throw error;
    } finally {
      if (lockFd !== undefined) closeSync(lockFd);
    }
    this.lockPath = lockPath;
    this.nativePath = join(this.args.stateRoot, "native.sock");
    this.controlPath = join(this.args.stateRoot, "control.sock");
    removeOwnedSocket(this.nativePath);
    removeOwnedSocket(this.controlPath);
    this.nativeServer = net.createServer((socket) => new ExtensionPeer(this, socket));
    this.controlServer = net.createServer((socket) => this.handleControlSocket(socket));
    this.httpServer = http.createServer((_, response) => {
      response.writeHead(404, { "content-type": "text/plain" });
      response.end("not found\n");
    });
    this.httpServer.on("upgrade", (request, socket, head) => {
      const match = request.url?.match(/^\/page\/([0-9a-f]{64})$/);
      const session = match ? this.endpoints.get(match[1]) : null;
      if (!session || session.offline || request.headers.host !== `127.0.0.1:${this.httpServer.address().port}`) {
        socket.destroy();
        return;
      }
      this.wsServer.handleUpgrade(request, socket, head, (ws) => this.handleWs(ws, session));
    });
    await Promise.all([
      new Promise((resolveListen, rejectListen) => {
        this.nativeServer.once("error", rejectListen);
        this.nativeServer.listen(this.nativePath, resolveListen);
      }),
      new Promise((resolveListen, rejectListen) => {
        this.controlServer.once("error", rejectListen);
        this.controlServer.listen(this.controlPath, resolveListen);
      }),
      new Promise((resolveListen, rejectListen) => {
        this.httpServer.once("error", rejectListen);
        this.httpServer.listen(0, "127.0.0.1", resolveListen);
      }),
    ]);
    chmodSync(this.nativePath, 0o600);
    chmodSync(this.controlPath, 0o600);
    const receipt = this.publishReceipt();
    // This observes process birth/death; elapsed idle time grants no authority.
    this.ownerSweepTimer = setInterval(() => { void this.reapDeadOwners(); }, 1_000);
    this.ownerSweepTimer.unref();
    void this.reapDeadOwners();
    if (this.args.json) process.stdout.write(`${canonicalJson(receipt)}\n`);
  }

  stop() {
    if (this.stopping) return;
    this.stopping = true;
    clearInterval(this.ownerSweepTimer);
    if (this.pendingEnrollment) {
      this.clearPendingEnrollment(this.pendingEnrollment.enrollmentId);
    }
    for (const peer of [
      ...this.peersByAccount.values(),
      ...this.unboundPeersByKey.values(),
    ]) {
      peer.close();
    }
    for (const session of this.sessions.values()) session.ws?.close(1001, "broker stopped");
    this.nativeServer?.close();
    this.controlServer?.close();
    this.httpServer?.close();
    this.wsServer.close();
    try {
      rmSync(join(this.args.stateRoot, "broker.json"));
    } catch {}
    for (const path of [this.nativePath, this.controlPath, this.lockPath]) {
      try {
        unlinkSync(path);
      } catch {}
    }
  }
}

const entryPath = process.argv[1] ? realpathSync(process.argv[1]) : "";
if (entryPath === scriptPath) {
  const broker = new Broker(parseArgs(process.argv.slice(2)));
  process.on("SIGTERM", () => broker.stop());
  process.on("SIGINT", () => broker.stop());
  await broker.start();
}
