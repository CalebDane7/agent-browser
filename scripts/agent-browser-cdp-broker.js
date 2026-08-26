#!/usr/bin/env node

// One physical browser WebSocket is shared by bounded, independently authenticated
// raw-CDP clients. Each client gets a private flat browser-target session, which is
// the ownership boundary for root events, child sessions, and request IDs.
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { basename, dirname, isAbsolute, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);
const { WebSocket, WebSocketServer } = require("ws");

export const PRODUCER_CONTRACT_SCHEMA =
  "agent-browser.cdp-producer-contract.v3";
export const PRODUCER_REVISION = "agent-browser.cdp-broker.v3";
export const HEALTH_SCHEMA = "agent-browser.cdp-broker-health.v1";
export const UPSTREAM_AUTHORITY_SCHEMA =
  "agent-browser.cdp-upstream-authority.v1";
export const CLIENT_LEASES_SCHEMA = "agent-browser.cdp-client-leases.v2";
export const CLIENT_LEASE_SCHEMA = "agent-browser.cdp-client-lease.v2";

const SOURCE_PATH = realpathSync(fileURLToPath(import.meta.url));
const SOURCE_SHA256 = createHash("sha256")
  .update(readFileSync(SOURCE_PATH))
  .digest("hex");
const EXEC_PATH = realpathSync(process.execPath);

const LOOPBACK_HOST = "127.0.0.1";
const CLOSE_UPSTREAM_LOST = 1011;
const CLOSE_POLICY = 1008;
const CLOSE_OVERLOADED = 1013;
const UPSTREAM_LOST_REASON = "upstream lost; consent/reconnect required";
const CLIENT_SESSION_REASON = "client browser session unavailable";
const LEASE_ID_PATTERN = /^[A-Za-z0-9_-]{16,64}$/;
const CAPABILITY_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const TOKEN_DIGEST_PATTERN = /^[0-9a-f]{64}$/;
const GENERATION_PATTERN = /^[0-9a-f]{64}$/;
const TARGET_ID_PATTERN = /^[A-Za-z0-9._:-]{1,256}$/;
const METHOD_PATTERN = /^[A-Za-z][A-Za-z0-9]*\.[A-Za-z][A-Za-z0-9]*$/;
const SESSION_ID_PATTERN = /^[^\u0000-\u001f\u007f]{1,512}$/;
const ALLOWED_REQUEST_KEYS = new Set(["id", "method", "params", "sessionId"]);

export const DENIED_METHODS = Object.freeze([
  "Browser.addPrivacySandboxEnrollmentOverride",
  "Browser.cancelDownload",
  "Browser.close",
  "Browser.crash",
  "Browser.crashGpuProcess",
  "Browser.executeBrowserCommand",
  "Browser.grantPermissions",
  "Browser.resetPermissions",
  "Browser.setContentsSize",
  "Browser.setDockTile",
  "Browser.setDownloadBehavior",
  "Browser.setGlobalPrivacyControl",
  "Browser.setPermission",
  "Browser.setWindowBounds",
  "Page.crash",
  "Target.activateTarget",
  "Target.attachToBrowserTarget",
  "Target.autoAttachRelated",
  "Target.createBrowserContext",
  "Target.createTarget",
  "Target.disposeBrowserContext",
  "Target.exposeDevToolsProtocol",
  "Target.getBrowserContexts",
  "Target.openDevTools",
  "Target.sendMessageToTarget",
  "Target.setAutoAttach",
  "Target.setRemoteLocations",
]);

const SAFE_TASK_BROWSER_METHODS = new Set(["Browser.getVersion"]);
const TASK_TARGET_METHODS = new Set([
  "Target.attachToTarget",
  "Target.closeTarget",
  "Target.detachFromTarget",
  "Target.getTargetInfo",
  "Target.getTargets",
  "Target.setDiscoverTargets",
]);
const PAGE_TARGET_FILTER = Object.freeze([
  Object.freeze({ type: "page", exclude: false }),
  Object.freeze({ exclude: true }),
]);
const TAB_TARGET_FILTER = Object.freeze([
  Object.freeze({ type: "tab", exclude: false }),
  Object.freeze({ exclude: true }),
]);

const DEFAULT_LIMITS = Object.freeze({
  maxClients: 16,
  maxFrameBytes: 16 * 1024 * 1024,
  maxHeaderBytes: 8 * 1024,
  maxHeaders: 32,
  maxPendingPerClient: 128,
  maxPendingTotal: 1024,
  maxSessionsPerClient: 128,
  maxTabInventoryTargets: 256,
  maxQueuedFramesPerClient: 32,
  maxQueuedBytesPerClient: 2 * 1024 * 1024,
  maxBufferedBytesPerSocket: 32 * 1024 * 1024,
  maxMessagesPerSecond: 512,
  upstreamConnectTimeoutMs: 10_000,
  upstreamResponseTimeoutMs: 120_000,
  closeGraceMs: 500,
  leaseSweepMs: 250,
  maxLeaseTtlMs: 60 * 60 * 1000,
  maxLeaseClockSkewMs: 5000,
});
const UPSTREAM_AUTHORITY_MAX_TTL_MS = DEFAULT_LIMITS.maxLeaseTtlMs;
const UPSTREAM_AUTHORITY_CLOCK_SKEW_MS = DEFAULT_LIMITS.maxLeaseClockSkewMs;

const LIMIT_RANGES = Object.freeze({
  maxClients: [1, 128],
  maxFrameBytes: [1024, 64 * 1024 * 1024],
  maxHeaderBytes: [1024, 64 * 1024],
  maxHeaders: [8, 128],
  maxPendingPerClient: [1, 4096],
  maxPendingTotal: [1, 65_536],
  maxSessionsPerClient: [2, 4096],
  maxTabInventoryTargets: [1, 4096],
  maxQueuedFramesPerClient: [1, 1024],
  maxQueuedBytesPerClient: [1024, 64 * 1024 * 1024],
  maxBufferedBytesPerSocket: [1024, 128 * 1024 * 1024],
  maxMessagesPerSecond: [1, 100_000],
  upstreamConnectTimeoutMs: [100, 120_000],
  upstreamResponseTimeoutMs: [100, 600_000],
  closeGraceMs: [10, 10_000],
  leaseSweepMs: [25, 60_000],
  maxLeaseTtlMs: [1000, 24 * 60 * 60 * 1000],
  maxLeaseClockSkewMs: [0, 60_000],
});

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasExactKeys(value, keys) {
  if (!isPlainObject(value)) return false;
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return (
    actual.length === expected.length &&
    actual.every((key, index) => key === expected[index])
  );
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (isPlainObject(value)) {
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

function normalizeTargetId(value) {
  if (typeof value !== "string" || !TARGET_ID_PATTERN.test(value)) {
    throw new Error("client lease target authority is invalid");
  }
  return value;
}

function normalizeWindowId(value) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error("client lease window authority is invalid");
  }
  return value;
}

function normalizeDescendantPolicy(value) {
  if (
    !hasExactKeys(value, ["mode", "allowAttach", "allowCloseEphemeral"]) ||
    value.mode !== "same-context-opener-tree" ||
    typeof value.allowAttach !== "boolean" ||
    typeof value.allowCloseEphemeral !== "boolean"
  ) {
    throw new Error("client lease descendant policy is invalid");
  }
  return Object.freeze({
    mode: value.mode,
    allowAttach: value.allowAttach,
    allowCloseEphemeral: value.allowCloseEphemeral,
  });
}

function normalizeLeaseCapability(value) {
  if (!isPlainObject(value) || typeof value.kind !== "string") {
    throw new Error("client lease capability is invalid");
  }
  if (
    value.kind === "controller-inventory" ||
    value.kind === "controller-tab-inventory"
  ) {
    if (!hasExactKeys(value, ["kind"]))
      throw new Error("client lease capability is invalid");
    return Object.freeze({ kind: value.kind });
  }
  if (value.kind === "controller-tab-discovery") {
    if (
      !hasExactKeys(value, [
        "kind",
        "tabTargetId",
        "browserContextId",
        "expectedTabActive",
      ]) ||
      typeof value.expectedTabActive !== "boolean"
    ) {
      throw new Error("client lease capability is invalid");
    }
    return Object.freeze({
      kind: value.kind,
      tabTargetId: normalizeTargetId(value.tabTargetId),
      browserContextId: normalizeTargetId(value.browserContextId),
      expectedTabActive: value.expectedTabActive,
    });
  }
  if (
    value.kind === "controller-tab-inspector" ||
    value.kind === "controller-tab-focus"
  ) {
    const keys = [
      "kind",
      "tabTargetId",
      "browserContextId",
      "windowId",
      "pageTargetId",
      "expectedTabActive",
    ];
    if (value.kind === "controller-tab-focus") {
      keys.push("workspaceTabTargetIds");
    }
    if (!hasExactKeys(value, keys))
      throw new Error("client lease capability is invalid");
    const capability = {
      kind: value.kind,
      tabTargetId: normalizeTargetId(value.tabTargetId),
      browserContextId: normalizeTargetId(value.browserContextId),
      windowId: normalizeWindowId(value.windowId),
      pageTargetId: normalizeTargetId(value.pageTargetId),
      expectedTabActive: value.expectedTabActive,
    };
    if (typeof capability.expectedTabActive !== "boolean") {
      throw new Error("client lease tab activity authority is invalid");
    }
    if (value.kind === "controller-tab-focus") {
      if (
        !Array.isArray(value.workspaceTabTargetIds) ||
        value.workspaceTabTargetIds.length !== 1 ||
        value.workspaceTabTargetIds[0] !== capability.tabTargetId
      ) {
        throw new Error("client lease workspace tab authority is invalid");
      }
      capability.workspaceTabTargetIds = Object.freeze([
        capability.tabTargetId,
      ]);
    }
    return Object.freeze(capability);
  }
  const policyKeys = [
    "kind",
    "rootTargetId",
    "browserContextId",
    "targetKind",
    "descendantPolicy",
  ];
  if (value.kind === "task") {
    if (!hasExactKeys(value, policyKeys))
      throw new Error("client lease capability is invalid");
  } else if (value.kind === "controller-cleanup") {
    if (!hasExactKeys(value, [...policyKeys, "targetIds"]))
      throw new Error("client lease capability is invalid");
    if (
      !Array.isArray(value.targetIds) ||
      value.targetIds.length === 0 ||
      value.targetIds.length > 128
    ) {
      throw new Error("client lease cleanup targets are invalid");
    }
  } else {
    throw new Error("client lease capability is invalid");
  }
  const capability = {
    kind: value.kind,
    rootTargetId: normalizeTargetId(value.rootTargetId),
    browserContextId: normalizeTargetId(value.browserContextId),
    targetKind: value.targetKind,
    descendantPolicy: normalizeDescendantPolicy(value.descendantPolicy),
  };
  if (capability.targetKind !== "page") {
    throw new Error("client lease target kind is invalid");
  }
  if (value.kind === "controller-cleanup") {
    const targetIds = value.targetIds.map(normalizeTargetId);
    if (new Set(targetIds).size !== targetIds.length) {
      throw new Error("client lease cleanup targets are invalid");
    }
    capability.targetIds = Object.freeze(targetIds);
  }
  return Object.freeze(capability);
}

function sha256(value) {
  return createHash("sha256").update(value).digest();
}

function sameDigest(left, right) {
  return (
    Buffer.isBuffer(left) &&
    Buffer.isBuffer(right) &&
    left.length === right.length &&
    timingSafeEqual(left, right)
  );
}

function normalizeLimits(overrides = {}) {
  if (!isPlainObject(overrides)) throw new Error("broker limits are invalid");
  const unknown = Object.keys(overrides).filter(
    (key) => !(key in DEFAULT_LIMITS),
  );
  if (unknown.length > 0) throw new Error("broker limits are invalid");
  const limits = { ...DEFAULT_LIMITS, ...overrides };
  for (const [key, [minimum, maximum]] of Object.entries(LIMIT_RANGES)) {
    if (
      !Number.isSafeInteger(limits[key]) ||
      limits[key] < minimum ||
      limits[key] > maximum
    ) {
      throw new Error("broker limits are invalid");
    }
  }
  if (limits.maxPendingPerClient > limits.maxPendingTotal) {
    throw new Error("broker limits are invalid");
  }
  if (limits.maxQueuedBytesPerClient > limits.maxBufferedBytesPerSocket) {
    throw new Error("broker limits are invalid");
  }
  return Object.freeze(limits);
}

function normalizeUpstreamUrl(value) {
  if (typeof value !== "string" || value.length > 2048) {
    throw new Error("upstream browser authority is invalid");
  }
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("upstream browser authority is invalid");
  }
  const loopback =
    parsed.hostname === "127.0.0.1" ||
    parsed.hostname === "localhost" ||
    parsed.hostname === "[::1]";
  if (
    !["ws:", "wss:"].includes(parsed.protocol) ||
    !loopback ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash ||
    !parsed.pathname.startsWith("/devtools/browser/")
  ) {
    throw new Error("upstream browser authority is invalid");
  }
  return parsed.toString();
}

function normalizeCanonicalUpstreamAuthorityUrl(value) {
  const normalized = normalizeUpstreamUrl(value);
  const parsed = new URL(normalized);
  const port = Number(parsed.port);
  if (
    value !== normalized ||
    parsed.protocol !== "ws:" ||
    parsed.hostname !== LOOPBACK_HOST ||
    !Number.isSafeInteger(port) ||
    port < 1 ||
    port > 65_535 ||
    !/^\/devtools\/browser\/[A-Za-z0-9._-]{1,256}$/.test(parsed.pathname)
  ) {
    throw new Error("upstream browser authority is invalid");
  }
  return normalized;
}

function normalizeUpstreamAuthorityWindow(
  issuedAtMs,
  expiresAtMs,
  now = Date.now(),
) {
  if (
    !Number.isSafeInteger(issuedAtMs) ||
    !Number.isSafeInteger(expiresAtMs) ||
    issuedAtMs <= 0 ||
    issuedAtMs > now + UPSTREAM_AUTHORITY_CLOCK_SKEW_MS ||
    expiresAtMs <= now ||
    expiresAtMs <= issuedAtMs ||
    expiresAtMs - issuedAtMs > UPSTREAM_AUTHORITY_MAX_TTL_MS
  ) {
    throw new Error("upstream browser authority is invalid");
  }
}

function normalizeOptionalAuthorityPath(value) {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string" || !isAbsolute(value)) {
    throw new Error("authority identity path is invalid");
  }
  const resolved = realpathSync(value);
  if (resolved !== value) throw new Error("authority identity path is invalid");
  return resolved;
}

function parseCanonicalTimestamp(value) {
  if (typeof value !== "string" || value.length > 32) {
    throw new Error("client lease timestamp is invalid");
  }
  const milliseconds = Date.parse(value);
  if (
    !Number.isFinite(milliseconds) ||
    new Date(milliseconds).toISOString() !== value
  ) {
    throw new Error("client lease timestamp is invalid");
  }
  return milliseconds;
}

function normalizeLeaseWindow(issuedAt, expiresAt, limits, now = Date.now()) {
  const issuedAtMs = parseCanonicalTimestamp(issuedAt);
  const expiresAtMs = parseCanonicalTimestamp(expiresAt);
  if (
    issuedAtMs > now + limits.maxLeaseClockSkewMs ||
    expiresAtMs <= issuedAtMs ||
    expiresAtMs - issuedAtMs > limits.maxLeaseTtlMs
  ) {
    throw new Error("client lease validity window is invalid");
  }
  return { issuedAtMs, expiresAtMs };
}

function normalizeGeneration(value, label) {
  if (typeof value !== "string" || !GENERATION_PATTERN.test(value)) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}

function deriveTransportGeneration(
  brokerGeneration,
  browserGeneration,
  consentGeneration,
) {
  return createHash("sha256")
    .update("agent-browser.cdp-transport-generation.v1\0", "utf8")
    .update(brokerGeneration, "utf8")
    .update("\0", "utf8")
    .update(browserGeneration, "utf8")
    .update("\0", "utf8")
    .update(consentGeneration, "utf8")
    .digest("hex");
}

export function deriveClientAuthorization({
  transportGeneration,
  leaseId,
  token,
}) {
  normalizeGeneration(transportGeneration, "transport generation");
  if (
    !LEASE_ID_PATTERN.test(leaseId) ||
    !CAPABILITY_TOKEN_PATTERN.test(token)
  ) {
    throw new Error("client lease capability is invalid");
  }
  return `Bearer ${transportGeneration}.${leaseId}.${token}`;
}

export function buildClientLeaseCapability({
  transportGeneration,
  leaseId,
  token,
  issuedAt,
  expiresAt,
  capability,
}) {
  normalizeLeaseWindow(
    issuedAt,
    expiresAt,
    {
      maxLeaseClockSkewMs: LIMIT_RANGES.maxLeaseClockSkewMs[1],
      maxLeaseTtlMs: LIMIT_RANGES.maxLeaseTtlMs[1],
    },
    Date.now(),
  );
  const normalizedCapability = normalizeLeaseCapability(capability);
  return Object.freeze({
    schema: CLIENT_LEASE_SCHEMA,
    transportGeneration,
    leaseId,
    authorization: deriveClientAuthorization({
      transportGeneration,
      leaseId,
      token,
    }),
    issuedAt,
    expiresAt,
    capability: normalizedCapability,
  });
}

function normalizeClientLeases(
  leases,
  limits,
  transportGeneration,
  now = Date.now(),
) {
  if (!Array.isArray(leases) || leases.length > limits.maxClients * 4) {
    throw new Error("client leases are invalid");
  }
  const normalized = new Map();
  for (const lease of leases) {
    if (
      !hasExactKeys(lease, [
        "leaseId",
        "tokenSha256",
        "issuedAt",
        "expiresAt",
        "capability",
      ]) ||
      !LEASE_ID_PATTERN.test(lease.leaseId) ||
      !TOKEN_DIGEST_PATTERN.test(lease.tokenSha256) ||
      normalized.has(lease.leaseId)
    ) {
      throw new Error("client lease is invalid");
    }
    const capability = normalizeLeaseCapability(lease.capability);
    const { issuedAtMs, expiresAtMs } = normalizeLeaseWindow(
      lease.issuedAt,
      lease.expiresAt,
      limits,
      now,
    );
    const authority = {
      transportGeneration,
      leaseId: lease.leaseId,
      tokenSha256: lease.tokenSha256,
      issuedAt: lease.issuedAt,
      expiresAt: lease.expiresAt,
      capability,
    };
    normalized.set(
      lease.leaseId,
      Object.freeze({
        leaseId: lease.leaseId,
        transportGeneration,
        tokenDigest: Buffer.from(lease.tokenSha256, "hex"),
        authorityDigest: sha256(Buffer.from(canonicalJson(authority), "utf8")),
        issuedAt: lease.issuedAt,
        issuedAtMs,
        expiresAt: lease.expiresAt,
        expiresAtMs,
        capability,
      }),
    );
  }
  return normalized;
}

function readSecureFile(path, maxBytes) {
  if (!isAbsolute(path)) throw new Error("secure authority file is invalid");
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
    const uidMatches =
      typeof process.getuid !== "function" ||
      Number(info.uid) === process.getuid();
    if (
      !info.isFile() ||
      info.nlink !== 1n ||
      info.size <= 0n ||
      info.size > BigInt(maxBytes) ||
      mode !== 0o600 ||
      !uidMatches
    ) {
      throw new Error("secure authority file is invalid");
    }
    return readFileSync(fd);
  } catch {
    throw new Error("secure authority file is unavailable");
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function parseSecureJson(path, maxBytes) {
  const raw = readSecureFile(path, maxBytes);
  try {
    return JSON.parse(raw.toString("utf8"));
  } catch {
    throw new Error("secure authority file is invalid");
  }
}

export function readUpstreamAuthorityFile(path) {
  const value = parseSecureJson(path, 8192);
  if (
    !hasExactKeys(value, [
      "schema",
      "browserGeneration",
      "consentGeneration",
      "browserWebSocketUrl",
      "browserWebSocketUrlSha256",
      "issuedAtMs",
      "expiresAtMs",
    ]) ||
    value.schema !== UPSTREAM_AUTHORITY_SCHEMA
  ) {
    throw new Error("upstream browser authority is invalid");
  }
  const upstreamUrl = normalizeCanonicalUpstreamAuthorityUrl(
    value.browserWebSocketUrl,
  );
  if (
    !TOKEN_DIGEST_PATTERN.test(value.browserWebSocketUrlSha256) ||
    !sameDigest(
      sha256(Buffer.from(upstreamUrl, "utf8")),
      Buffer.from(value.browserWebSocketUrlSha256, "hex"),
    )
  ) {
    throw new Error("upstream browser authority is invalid");
  }
  normalizeUpstreamAuthorityWindow(value.issuedAtMs, value.expiresAtMs);
  return Object.freeze({
    upstreamUrl,
    browserGeneration: normalizeGeneration(
      value.browserGeneration,
      "browser generation",
    ),
    consentGeneration: normalizeGeneration(
      value.consentGeneration,
      "consent generation",
    ),
  });
}

export function readClientLeasesFile(path, limits = DEFAULT_LIMITS) {
  const normalizedLimits = normalizeLimits(
    limits === DEFAULT_LIMITS ? {} : limits,
  );
  const value = parseSecureJson(path, 64 * 1024);
  if (
    !hasExactKeys(value, ["schema", "leases"]) ||
    value.schema !== CLIENT_LEASES_SCHEMA
  ) {
    throw new Error("client leases are invalid");
  }
  return value.leases.map((lease) => ({ ...lease }));
}

function isLoopbackAddress(address) {
  return (
    address === "127.0.0.1" ||
    address === "::1" ||
    address === "::ffff:127.0.0.1"
  );
}

function closeWebSocket(ws, code, reason, graceMs) {
  if (ws.readyState === WebSocket.CLOSED) return;
  if (ws.readyState === WebSocket.CONNECTING) {
    ws.terminate();
    return;
  }
  try {
    ws.close(code, reason);
  } catch {
    ws.terminate();
    return;
  }
  const timer = setTimeout(() => {
    if (ws.readyState !== WebSocket.CLOSED) ws.terminate();
  }, graceMs);
  timer.unref?.();
}

function rejectUpgrade(socket, statusCode, statusText) {
  const body = `${statusText}\n`;
  try {
    socket.write(
      `HTTP/1.1 ${statusCode} ${statusText}\r\n` +
        "Connection: close\r\n" +
        "Content-Type: text/plain; charset=utf-8\r\n" +
        `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n` +
        body,
    );
  } finally {
    socket.destroy();
  }
}

function validateDownstreamRequest(value) {
  if (
    !isPlainObject(value) ||
    Object.keys(value).some((key) => !ALLOWED_REQUEST_KEYS.has(key)) ||
    !Number.isSafeInteger(value.id) ||
    value.id < 0 ||
    typeof value.method !== "string" ||
    value.method.length > 128 ||
    !METHOD_PATTERN.test(value.method) ||
    ("params" in value && !isPlainObject(value.params)) ||
    ("sessionId" in value && !SESSION_ID_PATTERN.test(value.sessionId))
  ) {
    throw new Error("malformed downstream CDP frame");
  }
  return value;
}

function validateUpstreamMessage(value) {
  if (!isPlainObject(value)) throw new Error("malformed upstream CDP frame");
  if ("id" in value) {
    const hasResult = Object.prototype.hasOwnProperty.call(value, "result");
    const hasError = Object.prototype.hasOwnProperty.call(value, "error");
    if (
      !Number.isSafeInteger(value.id) ||
      value.id < 0 ||
      hasResult === hasError ||
      (hasError && !isPlainObject(value.error)) ||
      ("sessionId" in value && !SESSION_ID_PATTERN.test(value.sessionId))
    ) {
      throw new Error("malformed upstream CDP response");
    }
    return "response";
  }
  if (
    typeof value.method !== "string" ||
    value.method.length > 128 ||
    !METHOD_PATTERN.test(value.method) ||
    ("params" in value && !isPlainObject(value.params)) ||
    ("sessionId" in value && !SESSION_ID_PATTERN.test(value.sessionId))
  ) {
    throw new Error("malformed upstream CDP event");
  }
  return "event";
}

function publicLimits(limits) {
  return Object.freeze({
    maxClients: limits.maxClients,
    maxFrameBytes: limits.maxFrameBytes,
    maxHeaderBytes: limits.maxHeaderBytes,
    maxHeaders: limits.maxHeaders,
    maxPendingPerClient: limits.maxPendingPerClient,
    maxPendingTotal: limits.maxPendingTotal,
    maxInternalPending: limits.maxClients + 1,
    maxDetachedSessionTombstones: limits.maxClients * 2,
    maxSessionsPerClient: limits.maxSessionsPerClient,
    maxTabInventoryTargets: limits.maxTabInventoryTargets,
    maxQueuedFramesPerClient: limits.maxQueuedFramesPerClient,
    maxQueuedBytesPerClient: limits.maxQueuedBytesPerClient,
    maxBufferedBytesPerSocket: limits.maxBufferedBytesPerSocket,
    maxMessagesPerSecond: limits.maxMessagesPerSecond,
    upstreamResponseTimeoutMs: limits.upstreamResponseTimeoutMs,
    maxLeaseTtlMs: limits.maxLeaseTtlMs,
    maxLeaseClockSkewMs: limits.maxLeaseClockSkewMs,
  });
}

export class CdpBroker {
  constructor({
    upstreamUrl,
    browserGeneration,
    consentGeneration,
    clientLeases,
    upstreamAuthorityPath = null,
    clientLeasesPath = null,
    listenPort = 0,
    limits = {},
  }) {
    this.limits = normalizeLimits(limits);
    this.upstreamUrl = normalizeUpstreamUrl(upstreamUrl);
    this.upstreamAuthorityPath = normalizeOptionalAuthorityPath(
      upstreamAuthorityPath,
    );
    this.clientLeasesPath = normalizeOptionalAuthorityPath(clientLeasesPath);
    this.browserGeneration = normalizeGeneration(
      browserGeneration,
      "browser generation",
    );
    this.consentGeneration = normalizeGeneration(
      consentGeneration,
      "consent generation",
    );
    if (
      !Number.isSafeInteger(listenPort) ||
      listenPort < 0 ||
      listenPort > 65_535
    ) {
      throw new Error("broker listen port is invalid");
    }
    this.listenPort = listenPort;
    this.brokerGeneration = randomBytes(32).toString("hex");
    this.transportGeneration = deriveTransportGeneration(
      this.brokerGeneration,
      this.browserGeneration,
      this.consentGeneration,
    );
    this.startedAt = new Date().toISOString();
    this.startedAtMs = Date.now();
    this.processInstance = createHash("sha256")
      .update(PRODUCER_REVISION, "utf8")
      .update("\0", "utf8")
      .update(String(process.pid), "utf8")
      .update("\0", "utf8")
      .update(this.startedAt, "utf8")
      .update("\0", "utf8")
      .update(this.brokerGeneration, "utf8")
      .digest("hex");
    this.clientLeases = normalizeClientLeases(
      clientLeases,
      this.limits,
      this.transportGeneration,
    );
    this.state = "new";
    this.lossReason = null;
    this.upstreamConnectionAttempts = 0;
    this.nextUpstreamId = 1;
    this.clientPendingTotal = 0;
    this.internalPendingCount = 0;
    this.clients = new Map();
    this.activeLeases = new Map();
    this.reservedLeases = new Set();
    this.activeTaskRoots = new Map();
    this.reservedTaskRoots = new Map();
    this.protectedRootIds = new Set();
    this.nextClientInstance = 1;
    this.sessionOwners = new Map();
    this.pending = new Map();
    this.rootAttachQueue = [];
    this.activeRootAttach = null;
    this.detachingRootSessions = new Map();
    this.detachedClientSessions = new Map();
    this.targetGraph = new Map();
    this.targetSequence = 0;
    this.targetRefreshInFlight = false;
    this.upstream = null;
    this.httpServer = null;
    this.wss = null;
    this.leaseSweepTimer = null;
    this._rememberProtectedRoots(this.clientLeases);
  }

  async start() {
    if (this.state !== "new") throw new Error("broker already started");
    this.state = "connecting";
    try {
      await this._connectUpstreamOnce();
      this.state = "ready";
      await this._primeTargetGraph();
      await this._listenLoopback();
    } catch {
      await this.stop();
      throw new Error("CDP broker startup failed");
    }
    this.state = "ready";
    this.leaseSweepTimer = setInterval(
      () => this._sweepExpiredLeases(),
      this.limits.leaseSweepMs,
    );
    this.leaseSweepTimer.unref?.();
    return this;
  }

  async _connectUpstreamOnce() {
    this.upstreamConnectionAttempts += 1;
    const ws = new WebSocket(this.upstreamUrl, {
      followRedirects: false,
      handshakeTimeout: this.limits.upstreamConnectTimeoutMs,
      maxPayload: this.limits.maxFrameBytes,
      perMessageDeflate: false,
    });
    this.upstream = ws;
    await new Promise((resolve, reject) => {
      let settled = false;
      const finish = (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        ws.off("open", onOpen);
        ws.off("error", onFailure);
        ws.off("close", onFailure);
        if (error) reject(error);
        else resolve();
      };
      const onOpen = () => finish();
      const onFailure = () => finish(new Error("upstream unavailable"));
      const timer = setTimeout(onFailure, this.limits.upstreamConnectTimeoutMs);
      timer.unref?.();
      ws.once("open", onOpen);
      ws.once("error", onFailure);
      ws.once("close", onFailure);
    });
    ws.on("message", (data, isBinary) =>
      this._handleUpstreamFrame(data, isBinary),
    );
    ws.on("error", () => this._loseUpstream("upstream_error"));
    ws.on("close", () => this._loseUpstream("upstream_closed"));
  }

  async _primeTargetGraph() {
    await this._sendInternalCommand("Target.setDiscoverTargets", {
      discover: true,
      filter: PAGE_TARGET_FILTER,
    });
    const result = await this._sendInternalCommand("Target.getTargets", {
      filter: PAGE_TARGET_FILTER,
    });
    if (!Array.isArray(result?.targetInfos)) {
      this._loseUpstream("upstream_malformed");
      throw new Error("upstream target inventory is invalid");
    }
    for (const targetInfo of result.targetInfos) {
      if (!this._recordTargetInfo(targetInfo, false)) {
        throw new Error("upstream target inventory is invalid");
      }
    }
  }

  _sendInternalCommand(method, params) {
    if (this.internalPendingCount >= this.limits.maxClients + 1) {
      this._loseUpstream("internal_pending_overflow");
      return Promise.reject(new Error("internal CDP request limit reached"));
    }
    const upstreamId = this._allocateUpstreamId();
    if (upstreamId === null)
      return Promise.reject(new Error("upstream request IDs exhausted"));
    const payload = JSON.stringify({ id: upstreamId, method, params });
    if (!this._canSendUpstream(payload)) {
      this._loseUpstream("upstream_internal_send_failed");
      return Promise.reject(new Error("upstream unavailable"));
    }
    return new Promise((resolve, reject) => {
      this.internalPendingCount += 1;
      this.pending.set(
        upstreamId,
        this._makePending({ kind: "startup", resolve, reject }),
      );
      this._sendUpstreamPayload(payload);
    });
  }

  async _listenLoopback() {
    const server = createServer(
      { maxHeaderSize: this.limits.maxHeaderBytes, requireHostHeader: true },
      (request, response) => this._handleHttpRequest(request, response),
    );
    server.maxHeadersCount = this.limits.maxHeaders;
    server.headersTimeout = 5000;
    server.requestTimeout = 5000;
    server.keepAliveTimeout = 1000;
    const wss = new WebSocketServer({
      clientTracking: false,
      maxPayload: this.limits.maxFrameBytes,
      noServer: true,
      perMessageDeflate: false,
    });
    this.httpServer = server;
    this.wss = wss;
    server.on("upgrade", (request, socket, head) =>
      this._handleUpgrade(request, socket, head),
    );
    server.on("clientError", (_error, socket) => socket.destroy());
    await new Promise((resolve, reject) => {
      const onError = () => reject(new Error("loopback listener unavailable"));
      server.once("error", onError);
      server.listen(
        { host: LOOPBACK_HOST, port: this.listenPort, exclusive: true },
        () => {
          server.off("error", onError);
          resolve();
        },
      );
    });
    const address = server.address();
    if (
      !address ||
      typeof address === "string" ||
      address.address !== LOOPBACK_HOST
    ) {
      throw new Error("loopback listener binding is invalid");
    }
    this.listenPort = address.port;
  }

  _routePath(kind) {
    return `/${kind}/${this.transportGeneration}`;
  }

  _authenticate(request) {
    if (!isLoopbackAddress(request.socket.remoteAddress)) return null;
    if (request.rawHeaders.length / 2 > this.limits.maxHeaders) return null;
    const authorization = request.headers.authorization;
    if (typeof authorization !== "string" || Array.isArray(authorization))
      return null;
    const match =
      /^Bearer ([0-9a-f]{64})\.([A-Za-z0-9_-]{16,64})\.([A-Za-z0-9_-]{43})$/.exec(
        authorization,
      );
    if (!match) return null;
    const [, presentedGeneration, leaseId, token] = match;
    if (!CAPABILITY_TOKEN_PATTERN.test(token)) return null;
    const lease = this.clientLeases.get(leaseId);
    const generationMatches = sameDigest(
      sha256(Buffer.from(presentedGeneration, "utf8")),
      sha256(Buffer.from(this.transportGeneration, "utf8")),
    );
    const candidate = sha256(Buffer.from(token, "utf8"));
    const expected = lease?.tokenDigest ?? Buffer.alloc(candidate.length);
    const matches = sameDigest(candidate, expected);
    if (
      !generationMatches ||
      !matches ||
      !lease ||
      lease.expiresAtMs <= Date.now()
    )
      return null;
    return lease;
  }

  _handleHttpRequest(request, response) {
    response.setHeader("Connection", "close");
    response.setHeader("Cache-Control", "no-store");
    if (
      request.method !== "GET" ||
      request.url !== this._routePath("healthz") ||
      !isLoopbackAddress(request.socket.remoteAddress)
    ) {
      response.writeHead(404).end("Not Found\n");
      return;
    }
    if (!this._authenticate(request)) {
      response.writeHead(401).end("Unauthorized\n");
      return;
    }
    const payload = `${JSON.stringify(this.getHealth())}\n`;
    if (Buffer.byteLength(payload) > 8192) {
      response.writeHead(500).end("Unavailable\n");
      return;
    }
    response.setHeader("Content-Type", "application/json; charset=utf-8");
    response.writeHead(200).end(payload);
  }

  _handleUpgrade(request, socket, head) {
    socket.on("error", () => {});
    if (
      request.url !== this._routePath("cdp") ||
      request.headers.origin !== undefined ||
      !isLoopbackAddress(request.socket.remoteAddress)
    ) {
      rejectUpgrade(socket, 404, "Not Found");
      return;
    }
    if (
      this.state !== "ready" ||
      this.upstream?.readyState !== WebSocket.OPEN
    ) {
      rejectUpgrade(socket, 503, "Consent Reconnect Required");
      return;
    }
    const lease = this._authenticate(request);
    if (!lease || !this._leaseCurrentlyValid(lease)) {
      rejectUpgrade(socket, 401, "Unauthorized");
      return;
    }
    const taskCapability =
      lease.capability.kind === "task" ? lease.capability : null;
    const taskRootId = taskCapability?.rootTargetId ?? null;
    if (
      this.clients.size >= this.limits.maxClients ||
      this.activeLeases.has(lease.leaseId) ||
      this.reservedLeases.has(lease.leaseId) ||
      (taskCapability && this._taskClaimConflicts(taskCapability))
    ) {
      rejectUpgrade(socket, 429, "Client Lease Unavailable");
      return;
    }
    this.reservedLeases.add(lease.leaseId);
    if (taskRootId) this.reservedTaskRoots.set(taskRootId, taskCapability);
    try {
      this.wss.handleUpgrade(request, socket, head, (ws) => {
        this.reservedLeases.delete(lease.leaseId);
        if (taskRootId) this.reservedTaskRoots.delete(taskRootId);
        this._acceptClient(ws, lease);
      });
    } catch {
      this.reservedLeases.delete(lease.leaseId);
      if (taskRootId) this.reservedTaskRoots.delete(taskRootId);
      socket.destroy();
    }
  }

  _acceptClient(ws, lease) {
    const client = {
      ws,
      leaseId: lease.leaseId,
      authorityDigest: Buffer.from(lease.authorityDigest),
      capability: lease.capability,
      instance: this.nextClientInstance++,
      activationSequence: this.targetSequence,
      state: "initializing",
      rootSessionId: null,
      pendingCount: 0,
      sessionCount: 0,
      inboundQueue: [],
      inboundQueuedBytes: 0,
      outboundQueue: [],
      outboundQueuedBytes: 0,
      rateWindowStartedMs: Date.now(),
      rateWindowCount: 0,
      discoveryEnabled: false,
      visibleTargets: new Set(),
      tabSessionId: null,
      pageSessionId: null,
      focusProbe: {
        phase: "preflight",
        preTarget: false,
        preWindow: false,
        postTarget: false,
        postWindow: false,
      },
      tabDiscovery: {
        phase: "needs-tab",
        windowId: null,
        pageTargetId: null,
        pageTimer: null,
        expectedDetachSessionId: null,
      },
    };
    this.clients.set(ws, client);
    this.activeLeases.set(lease.leaseId, client);
    if (lease.capability.kind === "task") {
      this.activeTaskRoots.set(lease.capability.rootTargetId, client);
    }
    ws.on("message", (data, isBinary) =>
      this._handleClientFrame(client, data, isBinary),
    );
    ws.on("error", () =>
      this._closeClient(client, CLOSE_POLICY, "client transport error"),
    );
    ws.on("close", () => this._cleanupClient(client));
    this.rootAttachQueue.push(client);
    this._pumpRootAttach();
  }

  _handleClientFrame(client, data, isBinary) {
    if (client.state === "closed") return;
    const now = Date.now();
    if (now - client.rateWindowStartedMs >= 1000) {
      client.rateWindowStartedMs = now;
      client.rateWindowCount = 0;
    }
    client.rateWindowCount += 1;
    if (client.rateWindowCount > this.limits.maxMessagesPerSecond) {
      this._closeClient(client, CLOSE_POLICY, "message rate exceeded");
      return;
    }
    if (isBinary || data.length > this.limits.maxFrameBytes) {
      this._closeClient(client, 1003, "text CDP frames required");
      return;
    }
    let request;
    try {
      request = validateDownstreamRequest(JSON.parse(data.toString("utf8")));
    } catch {
      this._closeClient(client, CLOSE_POLICY, "malformed CDP frame");
      return;
    }
    if (client.state === "initializing") {
      if (
        client.inboundQueue.length >= this.limits.maxQueuedFramesPerClient ||
        client.inboundQueuedBytes + data.length >
          this.limits.maxQueuedBytesPerClient
      ) {
        this._closeClient(
          client,
          CLOSE_OVERLOADED,
          "client initialization queue exceeded",
        );
        return;
      }
      client.inboundQueue.push(request);
      client.inboundQueuedBytes += data.length;
      return;
    }
    this._processClientRequest(client, request);
  }

  _processClientRequest(client, request) {
    if (client.state !== "ready" || this.state !== "ready") return;
    const activeLease = this.clientLeases.get(client.leaseId);
    if (
      !activeLease ||
      activeLease.expiresAtMs <= Date.now() ||
      !sameDigest(activeLease.authorityDigest, client.authorityDigest) ||
      !this._leaseCurrentlyValid(activeLease)
    ) {
      this._closeClient(
        client,
        CLOSE_POLICY,
        "client lease expired or revoked",
      );
      return;
    }
    let targetSessionId = client.rootSessionId;
    if (request.sessionId !== undefined) {
      const owner = this.sessionOwners.get(request.sessionId);
      if (!owner || owner.client !== client || owner.kind === "root") {
        this._closeClient(client, CLOSE_POLICY, "session ownership violation");
        return;
      }
      targetSessionId = request.sessionId;
    }
    if (!this._applyClientPolicy(client, request)) return;
    let detachedSessionId = null;
    if (request.method === "Target.detachFromTarget") {
      detachedSessionId = request.params?.sessionId;
      const owner =
        typeof detachedSessionId === "string"
          ? this.sessionOwners.get(detachedSessionId)
          : null;
      if (!owner || owner.client !== client || owner.kind === "root") {
        this._closeClient(client, CLOSE_POLICY, "session ownership violation");
        return;
      }
    }
    if (
      client.pendingCount >= this.limits.maxPendingPerClient ||
      this.clientPendingTotal >= this.limits.maxPendingTotal
    ) {
      this._sendLocalError(
        client,
        request,
        -32002,
        "broker pending request limit reached",
      );
      return;
    }
    const upstreamId = this._allocateUpstreamId();
    if (upstreamId === null) return;
    const upstreamRequest = {
      id: upstreamId,
      method: request.method,
      params: request.params ?? {},
      sessionId: targetSessionId,
    };
    const payload = JSON.stringify(upstreamRequest);
    if (!this._canSendUpstream(payload)) {
      this._sendLocalError(
        client,
        request,
        -32002,
        "broker upstream queue limit reached",
      );
      return;
    }
    client.pendingCount += 1;
    this.clientPendingTotal += 1;
    const pending = this._makePending({
      kind: "client",
      client,
      clientId: request.id,
      clientSessionId: request.sessionId,
      method: request.method,
      detachedSessionId,
      attachedTargetId:
        request.method === "Target.attachToTarget"
          ? request.params?.targetId
          : null,
      attachedSessionKind:
        request.method === "Target.attachToTarget" &&
        ["controller-tab-inspector", "controller-tab-discovery"].includes(
          client.capability.kind,
        )
          ? "tab"
          : "child",
      policyStage: request._brokerPolicy ?? null,
    });
    this.pending.set(upstreamId, pending);
    this._commitClientPolicyRequest(client, pending.policyStage);
    this._sendUpstreamPayload(payload);
  }

  _applyClientPolicy(client, request) {
    const capability = client.capability;
    if (capability.kind === "controller-inventory") {
      if (request.sessionId !== undefined)
        return this._denyRequest(client, request);
      if (request.method === "Target.getTargets") {
        if (!hasExactKeys(request.params ?? {}, []))
          return this._denyRequest(client, request);
        this._sendLocalResult(client, request, {
          targetInfos: this._visibleTargetInfos(client),
        });
        return false;
      }
      if (request.method === "Target.getTargetInfo") {
        return this._handleLocalTargetInfo(client, request, true);
      }
      if (request.method === "Target.setDiscoverTargets") {
        return this._handleLocalDiscovery(client, request);
      }
      return this._denyRequest(client, request);
    }
    if (capability.kind === "controller-tab-inventory") {
      if (
        client.pendingCount !== 0 ||
        request.sessionId !== undefined ||
        request.method !== "Target.getTargets" ||
        !hasExactKeys(request.params ?? {}, [])
      ) {
        return this._denyRequest(client, request);
      }
      request.params = { filter: TAB_TARGET_FILTER };
      request._brokerPolicy = "tab-inventory";
      return true;
    }
    if (capability.kind === "controller-tab-discovery") {
      return this._applyControllerTabDiscoveryPolicy(client, request);
    }
    if (
      capability.kind === "controller-tab-inspector" ||
      capability.kind === "controller-tab-focus"
    ) {
      return this._applyControllerTabPolicy(client, request);
    }
    if (capability.kind === "controller-cleanup") {
      if (
        request.sessionId !== undefined ||
        request.method !== "Target.closeTarget" ||
        !hasExactKeys(request.params ?? {}, ["targetId"]) ||
        !this._cleanupCanClose(capability, request.params.targetId)
      ) {
        return this._denyRequest(client, request);
      }
      return true;
    }
    if (capability.kind !== "task") return this._denyRequest(client, request);

    if (DENIED_METHODS.includes(request.method)) {
      return this._denyRequest(client, request);
    }

    if (request.method.startsWith("Browser.")) {
      if (
        request.sessionId !== undefined ||
        !SAFE_TASK_BROWSER_METHODS.has(request.method) ||
        !hasExactKeys(request.params ?? {}, [])
      ) {
        return this._denyRequest(client, request);
      }
      return true;
    }
    if (request.method.startsWith("Target.")) {
      if (
        request.sessionId !== undefined ||
        !TASK_TARGET_METHODS.has(request.method)
      ) {
        return this._denyRequest(client, request);
      }
      if (request.method === "Target.getTargets") {
        if (!hasExactKeys(request.params ?? {}, []))
          return this._denyRequest(client, request);
        this._sendLocalResult(client, request, {
          targetInfos: this._visibleTargetInfos(client),
        });
        return false;
      }
      if (request.method === "Target.getTargetInfo") {
        return this._handleLocalTargetInfo(client, request, false);
      }
      if (request.method === "Target.setDiscoverTargets") {
        return this._handleLocalDiscovery(client, request);
      }
      if (request.method === "Target.attachToTarget") {
        const targetId = request.params?.targetId;
        const target = this._taskTarget(capability, targetId);
        if (
          !hasExactKeys(request.params ?? {}, ["targetId", "flatten"]) ||
          request.params.flatten !== true ||
          !target ||
          (target.kind === "descendant" &&
            !capability.descendantPolicy.allowAttach)
        ) {
          return this._denyRequest(client, request);
        }
      }
      if (request.method === "Target.closeTarget") {
        if (
          !hasExactKeys(request.params ?? {}, ["targetId"]) ||
          !this._taskCanClose(client, request.params.targetId)
        ) {
          return this._denyRequest(client, request);
        }
      }
      if (
        request.method === "Target.detachFromTarget" &&
        !hasExactKeys(request.params ?? {}, ["sessionId"])
      ) {
        return this._denyRequest(client, request);
      }
      return true;
    }
    if (request.sessionId === undefined)
      return this._denyRequest(client, request);
    return true;
  }

  _applyControllerTabDiscoveryPolicy(client, request) {
    const capability = client.capability;
    const discovery = client.tabDiscovery;
    if (client.pendingCount !== 0) return this._denyRequest(client, request);
    const exactTabTarget = (method) =>
      request.sessionId === undefined &&
      request.method === method &&
      hasExactKeys(request.params ?? {}, ["targetId"]) &&
      request.params.targetId === capability.tabTargetId;
    if (
      discovery.phase === "needs-tab" &&
      exactTabTarget("Target.getTargetInfo")
    ) {
      request._brokerPolicy = "discovery-tab";
      return true;
    }
    if (
      discovery.phase === "needs-window" &&
      exactTabTarget("Browser.getWindowForTarget")
    ) {
      request._brokerPolicy = "discovery-window";
      return true;
    }
    if (
      discovery.phase === "needs-attach" &&
      request.sessionId === undefined &&
      request.method === "Target.attachToTarget" &&
      hasExactKeys(request.params ?? {}, ["targetId", "flatten"]) &&
      request.params.targetId === capability.tabTargetId &&
      request.params.flatten === true
    ) {
      request._brokerPolicy = "discovery-attach-tab";
      return true;
    }
    if (
      ["needs-autoattach", "needs-stop-autoattach"].includes(discovery.phase) &&
      request.sessionId === client.tabSessionId &&
      request.method === "Target.setAutoAttach" &&
      hasExactKeys(request.params ?? {}, [
        "autoAttach",
        "waitForDebuggerOnStart",
        "flatten",
      ]) &&
      request.params.autoAttach === (discovery.phase === "needs-autoattach") &&
      request.params.waitForDebuggerOnStart === false &&
      request.params.flatten === true
    ) {
      // Tab-target auto-attach uses Chromium's exact three-field shape. A
      // page filter is a browser-session shape, and nonempty filters are also
      // invalid when disabling auto-attach; the broker still validates that
      // the one resulting child is the exact page owned by this tab/context.
      request._brokerPolicy =
        discovery.phase === "needs-autoattach"
          ? "discovery-autoattach-page"
          : "discovery-stop-autoattach";
      return true;
    }
    const expectedDetachSessionId =
      discovery.phase === "needs-detach-page"
        ? client.pageSessionId
        : discovery.phase === "needs-detach-tab"
          ? client.tabSessionId
          : null;
    if (
      expectedDetachSessionId &&
      request.sessionId === undefined &&
      request.method === "Target.detachFromTarget" &&
      hasExactKeys(request.params ?? {}, ["sessionId"]) &&
      request.params.sessionId === expectedDetachSessionId
    ) {
      request._brokerPolicy =
        discovery.phase === "needs-detach-page"
          ? "discovery-detach-page"
          : "discovery-detach-tab";
      return true;
    }
    return this._denyRequest(client, request);
  }

  _applyControllerTabPolicy(client, request) {
    const capability = client.capability;
    if (client.pendingCount !== 0) return this._denyRequest(client, request);
    const exactTabTarget = (method) =>
      request.sessionId === undefined &&
      request.method === method &&
      hasExactKeys(request.params ?? {}, ["targetId"]) &&
      request.params.targetId === capability.tabTargetId;

    if (capability.kind === "controller-tab-focus") {
      const probe = client.focusProbe;
      if (probe.phase === "preflight") {
        if (exactTabTarget("Target.getTargetInfo") && !probe.preTarget) {
          request._brokerPolicy = "focus-pre-target";
          return true;
        }
        if (exactTabTarget("Browser.getWindowForTarget") && !probe.preWindow) {
          request._brokerPolicy = "focus-pre-window";
          return true;
        }
        if (
          exactTabTarget("Target.activateTarget") &&
          probe.preTarget === true &&
          probe.preWindow === true
        ) {
          request._brokerPolicy = "focus-activate";
          return true;
        }
      }
      if (probe.phase === "postflight") {
        if (exactTabTarget("Target.getTargetInfo") && !probe.postTarget) {
          request._brokerPolicy = "focus-post-target";
          return true;
        }
        if (exactTabTarget("Browser.getWindowForTarget") && !probe.postWindow) {
          request._brokerPolicy = "focus-post-window";
          return true;
        }
      }
      return this._denyRequest(client, request);
    }

    if (request.sessionId === undefined) {
      if (exactTabTarget("Target.getTargetInfo")) {
        request._brokerPolicy = "inspect-target";
        return true;
      }
      if (exactTabTarget("Browser.getWindowForTarget")) {
        request._brokerPolicy = "inspect-window";
        return true;
      }
      if (
        request.method === "Target.attachToTarget" &&
        client.tabSessionId === null &&
        hasExactKeys(request.params ?? {}, ["targetId", "flatten"]) &&
        request.params.targetId === capability.tabTargetId &&
        request.params.flatten === true
      ) {
        request._brokerPolicy = "inspect-attach-tab";
        return true;
      }
      if (
        request.method === "Target.detachFromTarget" &&
        hasExactKeys(request.params ?? {}, ["sessionId"])
      ) {
        const owner = this.sessionOwners.get(request.params.sessionId);
        if (
          owner?.client === client &&
          ["tab", "tab_page"].includes(owner.kind)
        ) {
          request._brokerPolicy = "inspect-detach";
          return true;
        }
      }
      return this._denyRequest(client, request);
    }

    const envelope = this.sessionOwners.get(request.sessionId);
    if (
      envelope?.client !== client ||
      envelope.kind !== "tab" ||
      request.method !== "Target.setAutoAttach" ||
      !hasExactKeys(request.params ?? {}, [
        "autoAttach",
        "waitForDebuggerOnStart",
        "flatten",
      ]) ||
      typeof request.params.autoAttach !== "boolean" ||
      request.params.waitForDebuggerOnStart !== false ||
      request.params.flatten !== true
    ) {
      return this._denyRequest(client, request);
    }
    request._brokerPolicy = request.params.autoAttach
      ? "inspect-autoattach-page"
      : "inspect-stop-autoattach";
    return true;
  }

  _commitClientPolicyRequest(client, stage) {
    if (stage?.startsWith("discovery-")) {
      const discovery = client.tabDiscovery;
      if (stage === "discovery-tab") discovery.phase = "tab-pending";
      else if (stage === "discovery-window") {
        discovery.phase = "window-pending";
      } else if (stage === "discovery-attach-tab") {
        discovery.phase = "attaching-tab";
      } else if (stage === "discovery-autoattach-page") {
        discovery.phase = "enabling-autoattach";
      } else if (stage === "discovery-stop-autoattach") {
        discovery.phase = "disabling-autoattach";
        // Chromium tears down sessions created by auto-attach when it is
        // disabled. Bind that automatic cleanup to the one exact page session;
        // a detach of any other session still fails closed.
        discovery.expectedDetachSessionId = client.pageSessionId;
      } else if (stage === "discovery-detach-page") {
        discovery.phase = "detaching-page";
        discovery.expectedDetachSessionId = client.pageSessionId;
      } else if (stage === "discovery-detach-tab") {
        discovery.phase = "detaching-tab";
        discovery.expectedDetachSessionId = client.tabSessionId;
      }
      return;
    }
    if (!stage?.startsWith("focus-")) return;
    const probe = client.focusProbe;
    if (stage === "focus-pre-target") probe.preTarget = "pending";
    else if (stage === "focus-pre-window") probe.preWindow = "pending";
    else if (stage === "focus-activate") probe.phase = "activating";
    else if (stage === "focus-post-target") probe.postTarget = "pending";
    else if (stage === "focus-post-window") probe.postWindow = "pending";
  }

  _denyRequest(client, request) {
    this._sendLocalError(
      client,
      request,
      -32000,
      "CDP method or target denied by broker policy",
    );
    return false;
  }

  _sendLocalResult(client, request, result) {
    const response = { id: request.id, result };
    if (request.sessionId !== undefined) response.sessionId = request.sessionId;
    this._deliverClient(client, response);
  }

  _handleLocalTargetInfo(client, request, inventory) {
    if (!hasExactKeys(request.params ?? {}, ["targetId"])) {
      return this._denyRequest(client, request);
    }
    const record = this.targetGraph.get(request.params.targetId);
    if (
      !record ||
      (!inventory && !this._targetVisibleToClient(client, record.info.targetId))
    ) {
      return this._denyRequest(client, request);
    }
    this._sendLocalResult(client, request, { targetInfo: record.info });
    return false;
  }

  _handleLocalDiscovery(client, request) {
    if (
      !hasExactKeys(request.params ?? {}, ["discover"]) ||
      typeof request.params.discover !== "boolean"
    ) {
      return this._denyRequest(client, request);
    }
    client.discoveryEnabled = request.params.discover;
    client.visibleTargets.clear();
    this._sendLocalResult(client, request, {});
    if (client.discoveryEnabled) {
      queueMicrotask(() => {
        for (const targetInfo of this._visibleTargetInfos(client)) {
          if (client.state !== "ready" || !client.discoveryEnabled) break;
          client.visibleTargets.add(targetInfo.targetId);
          this._deliverClient(client, {
            method: "Target.targetCreated",
            params: { targetInfo },
          });
        }
      });
    }
    return false;
  }

  _sendLocalError(client, request, code, message) {
    const response = { id: request.id, error: { code, message } };
    if (request.sessionId !== undefined) response.sessionId = request.sessionId;
    this._deliverClient(client, response);
  }

  _allocateUpstreamId() {
    if (this.nextUpstreamId > Number.MAX_SAFE_INTEGER) {
      this._loseUpstream("request_id_exhausted");
      return null;
    }
    return this.nextUpstreamId++;
  }

  _makePending(value) {
    const pending = { ...value, timer: null };
    pending.timer = setTimeout(
      () => this._loseUpstream("upstream_response_timeout"),
      this.limits.upstreamResponseTimeoutMs,
    );
    pending.timer.unref?.();
    return pending;
  }

  _canSendUpstream(payload) {
    return (
      this.state === "ready" &&
      this.upstream?.readyState === WebSocket.OPEN &&
      Buffer.byteLength(payload) <= this.limits.maxFrameBytes &&
      this.upstream.bufferedAmount + Buffer.byteLength(payload) <=
        this.limits.maxBufferedBytesPerSocket
    );
  }

  _sendUpstreamPayload(payload) {
    if (!this._canSendUpstream(payload)) {
      this._loseUpstream("upstream_send_after_loss");
      return false;
    }
    try {
      this.upstream.send(
        payload,
        { binary: false, compress: false },
        (error) => {
          if (error) this._loseUpstream("upstream_send_failed");
        },
      );
    } catch {
      this._loseUpstream("upstream_send_failed");
      return false;
    }
    return true;
  }

  _pumpRootAttach() {
    if (this.activeRootAttach || this.state !== "ready") return;
    let client;
    while (this.rootAttachQueue.length > 0) {
      const candidate = this.rootAttachQueue.shift();
      if (candidate.state === "initializing") {
        client = candidate;
        break;
      }
    }
    if (!client) return;
    if (this.internalPendingCount >= this.limits.maxClients + 1) {
      this._loseUpstream("internal_pending_overflow");
      return;
    }
    const upstreamId = this._allocateUpstreamId();
    if (upstreamId === null) return;
    const payload = JSON.stringify({
      id: upstreamId,
      method: "Target.attachToBrowserTarget",
      params: {},
    });
    if (!this._canSendUpstream(payload)) {
      this._closeClient(client, CLOSE_OVERLOADED, CLIENT_SESSION_REASON);
      queueMicrotask(() => this._pumpRootAttach());
      return;
    }
    const pending = this._makePending({
      kind: "root_attach",
      client,
      provisionalRootSessionId: null,
    });
    this.internalPendingCount += 1;
    this.activeRootAttach = { upstreamId, pending };
    this.pending.set(upstreamId, pending);
    this._sendUpstreamPayload(payload);
  }

  _sendInternalDetach(client, rootSessionId) {
    if (
      this.state !== "ready" ||
      this.upstream?.readyState !== WebSocket.OPEN
    ) {
      this._dropClientSessions(client);
      return;
    }
    if (this.internalPendingCount >= this.limits.maxClients + 1) {
      this._loseUpstream("internal_pending_overflow");
      return;
    }
    const upstreamId = this._allocateUpstreamId();
    if (upstreamId === null) return;
    const payload = JSON.stringify({
      id: upstreamId,
      method: "Target.detachFromTarget",
      params: { sessionId: rootSessionId },
    });
    if (!this._canSendUpstream(payload)) {
      this._loseUpstream("upstream_cleanup_failed");
      return;
    }
    if (
      !this.detachingRootSessions.has(rootSessionId) &&
      this.detachingRootSessions.size + this.detachedClientSessions.size >=
        this.limits.maxClients * 2
    ) {
      this._loseUpstream("upstream_cleanup_overflow");
      return;
    }
    const tombstoneTimer = setTimeout(
      () => this.detachingRootSessions.delete(rootSessionId),
      this.limits.closeGraceMs * 2,
    );
    tombstoneTimer.unref?.();
    this.detachingRootSessions.set(rootSessionId, tombstoneTimer);
    this.internalPendingCount += 1;
    this.pending.set(
      upstreamId,
      this._makePending({ kind: "internal_detach", client }),
    );
    this._sendUpstreamPayload(payload);
  }

  _handleUpstreamFrame(data, isBinary) {
    if (
      this.state === "stopping" ||
      this.state === "stopped" ||
      this.state === "upstream_lost"
    )
      return;
    if (isBinary || data.length > this.limits.maxFrameBytes) {
      this._loseUpstream("upstream_malformed");
      return;
    }
    let message;
    let kind;
    try {
      message = JSON.parse(data.toString("utf8"));
      kind = validateUpstreamMessage(message);
    } catch {
      this._loseUpstream("upstream_malformed");
      return;
    }
    if (kind === "response") this._handleUpstreamResponse(message);
    else this._handleUpstreamEvent(message);
  }

  _handleUpstreamResponse(message) {
    const pending = this.pending.get(message.id);
    if (!pending) {
      this._loseUpstream("upstream_protocol_desync");
      return;
    }
    this.pending.delete(message.id);
    clearTimeout(pending.timer);
    if (pending.kind !== "client") {
      this.internalPendingCount = Math.max(0, this.internalPendingCount - 1);
    }
    if (pending.kind === "startup") {
      if (message.error) {
        pending.reject(new Error("upstream internal CDP command failed"));
      } else {
        pending.resolve(message.result ?? {});
      }
      return;
    }
    if (pending.kind === "root_attach") {
      this.activeRootAttach = null;
      this._finishRootAttach(pending, message);
      this._pumpRootAttach();
      return;
    }
    if (pending.kind === "internal_detach") {
      this._dropClientSessions(pending.client);
      return;
    }
    const client = pending.client;
    client.pendingCount = Math.max(0, client.pendingCount - 1);
    this.clientPendingTotal = Math.max(0, this.clientPendingTotal - 1);
    if (client.state === "closed") return;
    if (message.sessionId !== undefined) {
      const owner = this.sessionOwners.get(message.sessionId);
      if (!owner || owner.client !== client) {
        this._loseUpstream("upstream_protocol_desync");
        return;
      }
    }
    if (!this._validateControllerResponse(client, pending, message)) return;
    if (
      !message.error &&
      ["Target.attachToTarget", "Target.attachToBrowserTarget"].includes(
        pending.method,
      )
    ) {
      const sessionId = message.result?.sessionId;
      if (
        !SESSION_ID_PATTERN.test(sessionId) ||
        !this._assignSession(
          client,
          sessionId,
          pending.attachedSessionKind,
          pending.attachedTargetId,
        )
      )
        return;
    }
    if (!message.error && pending.detachedSessionId) {
      this._removeSession(client, pending.detachedSessionId, true);
      if (
        client.state === "closed" ||
        !this._completeTabDiscoveryDetachResponse(client, pending.policyStage)
      ) {
        return;
      }
    }
    const response = { ...message, id: pending.clientId };
    if (response.sessionId === client.rootSessionId) delete response.sessionId;
    this._deliverClient(client, response);
  }

  _freshTabInfo(value, capability = null, expectedTabActive = null) {
    if (
      !isPlainObject(value) ||
      value.type !== "tab" ||
      !TARGET_ID_PATTERN.test(value.targetId) ||
      !TARGET_ID_PATTERN.test(value.browserContextId) ||
      !isPlainObject(value.embedderData) ||
      typeof value.embedderData.tabActive !== "boolean"
    ) {
      return null;
    }
    if (
      capability &&
      (value.targetId !== capability.tabTargetId ||
        value.browserContextId !== capability.browserContextId ||
        (expectedTabActive !== null &&
          value.embedderData.tabActive !== expectedTabActive))
    ) {
      return null;
    }
    return value;
  }

  _inventoryTabInfo(value) {
    if (
      !isPlainObject(value) ||
      value.type !== "tab" ||
      !TARGET_ID_PATTERN.test(value.targetId) ||
      ("browserContextId" in value &&
        !TARGET_ID_PATTERN.test(value.browserContextId)) ||
      ("embedderData" in value && !isPlainObject(value.embedderData)) ||
      (isPlainObject(value.embedderData) &&
        "tabActive" in value.embedderData &&
        typeof value.embedderData.tabActive !== "boolean")
    ) {
      return null;
    }
    return this._freshTabInfo(value) ? "eligible" : "ineligible";
  }

  _validateControllerResponse(client, pending, message) {
    const stage = pending.policyStage;
    if (!stage) return true;
    if (message.error) {
      this._closeClient(client, CLOSE_POLICY, "controller probe failed");
      return false;
    }
    if (stage.startsWith("discovery-")) {
      return this._validateTabDiscoveryResponse(client, stage, message);
    }
    if (stage === "tab-inventory") {
      const targetInfos = message.result?.targetInfos;
      const classified = Array.isArray(targetInfos)
        ? targetInfos.map((info) => this._inventoryTabInfo(info))
        : [];
      if (
        !Array.isArray(targetInfos) ||
        targetInfos.length > this.limits.maxTabInventoryTargets ||
        classified.some((kind) => kind === null) ||
        new Set(targetInfos.map((info) => info.targetId)).size !==
          targetInfos.length
      ) {
        this._closeClient(client, CLOSE_POLICY, "fresh tab inventory invalid");
        return false;
      }
      // CDP makes browserContextId and embedderData optional. Chrome can expose
      // WebContents-level `tab` wrappers that are not members of a browser tab
      // strip, so keep them unknown/ineligible instead of invalidating the whole
      // inventory. Only fully evidenced UI tabs reach controller selection.
      message.result.targetInfos = targetInfos.filter(
        (_info, index) => classified[index] === "eligible",
      );
      return true;
    }
    const capability = client.capability;
    if (
      ["inspect-target", "focus-pre-target", "focus-post-target"].includes(
        stage,
      )
    ) {
      const expectedTabActive =
        stage === "focus-post-target" ? true : capability.expectedTabActive;
      const info = this._freshTabInfo(
        message.result?.targetInfo,
        capability,
        expectedTabActive,
      );
      if (
        !info ||
        (stage === "focus-post-target" && !info.embedderData.tabActive)
      ) {
        this._closeClient(
          client,
          CLOSE_POLICY,
          "fresh tab target proof failed",
        );
        return false;
      }
      if (stage === "focus-pre-target") client.focusProbe.preTarget = true;
      if (stage === "focus-post-target") client.focusProbe.postTarget = true;
    }
    if (
      ["inspect-window", "focus-pre-window", "focus-post-window"].includes(
        stage,
      )
    ) {
      if (message.result?.windowId !== capability.windowId) {
        this._closeClient(
          client,
          CLOSE_POLICY,
          "fresh tab window proof failed",
        );
        return false;
      }
      if (stage === "focus-pre-window") client.focusProbe.preWindow = true;
      if (stage === "focus-post-window") client.focusProbe.postWindow = true;
    }
    if (stage === "focus-activate") {
      client.focusProbe.phase = "postflight";
    } else if (
      client.focusProbe.phase === "postflight" &&
      client.focusProbe.postTarget === true &&
      client.focusProbe.postWindow === true
    ) {
      client.focusProbe.phase = "complete";
    }
    return true;
  }

  _validateTabDiscoveryResponse(client, stage, message) {
    const discovery = client.tabDiscovery;
    const capability = client.capability;
    if (stage === "discovery-tab") {
      if (
        !hasExactKeys(message.result, ["targetInfo"]) ||
        !this._freshTabInfo(
          message.result?.targetInfo,
          capability,
          capability.expectedTabActive,
        )
      ) {
        this._closeClient(client, CLOSE_POLICY, "fresh tab discovery failed");
        return false;
      }
      discovery.phase = "needs-window";
    } else if (stage === "discovery-window") {
      const windowId = message.result?.windowId;
      if (
        !isPlainObject(message.result) ||
        !Number.isSafeInteger(windowId) ||
        windowId < 0
      ) {
        this._closeClient(
          client,
          CLOSE_POLICY,
          "fresh tab window discovery failed",
        );
        return false;
      }
      discovery.windowId = windowId;
      message.result = { windowId };
      discovery.phase = "needs-attach";
    } else if (stage === "discovery-attach-tab") {
      const sessionId = message.result?.sessionId;
      if (
        !hasExactKeys(message.result, ["sessionId"]) ||
        !SESSION_ID_PATTERN.test(sessionId) ||
        (client.tabSessionId !== null && client.tabSessionId !== sessionId)
      ) {
        this._closeClient(client, CLOSE_POLICY, "tab discovery attach failed");
        return false;
      }
      discovery.phase = "needs-autoattach";
    } else if (stage === "discovery-autoattach-page") {
      if (!hasExactKeys(message.result, [])) {
        this._closeClient(
          client,
          CLOSE_POLICY,
          "tab discovery auto-attach failed",
        );
        return false;
      }
      if (client.pageSessionId) {
        discovery.phase = "needs-stop-autoattach";
      } else {
        discovery.phase = "awaiting-page";
        this._startDiscoveryPageTimer(client);
      }
    } else if (stage === "discovery-stop-autoattach") {
      if (
        !hasExactKeys(message.result, []) ||
        !discovery.pageTargetId ||
        !["disabling-autoattach", "awaiting-stop-response"].includes(
          discovery.phase,
        )
      ) {
        this._closeClient(
          client,
          CLOSE_POLICY,
          "tab discovery page unavailable",
        );
        return false;
      }
      if (discovery.phase === "awaiting-stop-response") {
        if (
          client.pageSessionId !== null ||
          discovery.expectedDetachSessionId !== null
        ) {
          this._closeClient(
            client,
            CLOSE_POLICY,
            "tab discovery page detach proof failed",
          );
          return false;
        }
        discovery.phase = "needs-detach-tab";
      } else {
        if (
          !client.pageSessionId ||
          discovery.expectedDetachSessionId !== client.pageSessionId
        ) {
          this._closeClient(
            client,
            CLOSE_POLICY,
            "tab discovery page detach proof failed",
          );
          return false;
        }
        discovery.phase = "awaiting-page-auto-detach";
      }
    } else if (stage === "discovery-detach-page") {
      if (!hasExactKeys(message.result, [])) {
        this._closeClient(client, CLOSE_POLICY, "tab discovery detach failed");
        return false;
      }
    } else if (stage === "discovery-detach-tab") {
      if (!hasExactKeys(message.result, [])) {
        this._closeClient(client, CLOSE_POLICY, "tab discovery detach failed");
        return false;
      }
    }
    return true;
  }

  _completeTabDiscoveryDetachResponse(client, stage) {
    if (!stage?.startsWith("discovery-detach-")) return true;
    const discovery = client.tabDiscovery;
    if (stage === "discovery-detach-page") {
      if (client.pageSessionId !== null) {
        this._closeClient(client, CLOSE_POLICY, "tab discovery detach failed");
        return false;
      }
      discovery.phase = "needs-detach-tab";
      return true;
    }
    if (client.pageSessionId !== null || client.tabSessionId !== null) {
      this._closeClient(client, CLOSE_POLICY, "tab discovery detach failed");
      return false;
    }
    discovery.phase = "complete";
    return true;
  }

  _startDiscoveryPageTimer(client) {
    const discovery = client.tabDiscovery;
    if (discovery.pageTimer) clearTimeout(discovery.pageTimer);
    discovery.pageTimer = setTimeout(() => {
      discovery.pageTimer = null;
      if (client.state !== "closed" && discovery.phase === "awaiting-page") {
        this._closeClient(
          client,
          CLOSE_POLICY,
          "tab discovery page not observed",
        );
      }
    }, this.limits.upstreamResponseTimeoutMs);
    discovery.pageTimer.unref?.();
  }

  _observeDiscoveredPage(client, targetInfo) {
    const discovery = client.tabDiscovery;
    if (
      !isPlainObject(targetInfo) ||
      targetInfo.type !== "page" ||
      !TARGET_ID_PATTERN.test(targetInfo.targetId) ||
      targetInfo.browserContextId !== client.capability.browserContextId ||
      discovery.pageTargetId !== null ||
      !["enabling-autoattach", "awaiting-page"].includes(discovery.phase)
    ) {
      this._closeClient(
        client,
        CLOSE_POLICY,
        "tab discovery page binding failed",
      );
      return false;
    }
    discovery.pageTargetId = targetInfo.targetId;
    if (discovery.pageTimer) clearTimeout(discovery.pageTimer);
    discovery.pageTimer = null;
    if (discovery.phase === "awaiting-page") {
      discovery.phase = "needs-stop-autoattach";
    }
    return true;
  }

  _finishRootAttach(pending, message) {
    const client = pending.client;
    const sessionId = message.result?.sessionId;
    if (
      message.error ||
      !SESSION_ID_PATTERN.test(sessionId) ||
      (pending.provisionalRootSessionId &&
        pending.provisionalRootSessionId !== sessionId) ||
      !this._assignSession(client, sessionId, "root")
    ) {
      this._closeClient(client, CLOSE_POLICY, CLIENT_SESSION_REASON);
      return;
    }
    client.rootSessionId = sessionId;
    if (client.state === "closed") {
      this._sendInternalDetach(client, sessionId);
      return;
    }
    client.state = "ready";
    const outbound = client.outboundQueue.splice(0);
    client.outboundQueuedBytes = 0;
    for (const event of outbound) {
      if (client.state !== "ready") break;
      this._sendClientObject(client, event);
    }
    const inbound = client.inboundQueue.splice(0);
    client.inboundQueuedBytes = 0;
    for (const request of inbound) {
      if (client.state !== "ready") break;
      this._processClientRequest(client, request);
    }
  }

  _normalizeTargetInfo(value) {
    if (
      !isPlainObject(value) ||
      !TARGET_ID_PATTERN.test(value.targetId) ||
      value.type !== "page" ||
      (value.browserContextId !== undefined &&
        !TARGET_ID_PATTERN.test(value.browserContextId)) ||
      (value.openerId !== undefined &&
        !TARGET_ID_PATTERN.test(value.openerId)) ||
      (value.url !== undefined && typeof value.url !== "string") ||
      (value.title !== undefined && typeof value.title !== "string")
    ) {
      return null;
    }
    return Object.freeze({ ...value });
  }

  _recordTargetInfo(
    targetInfo,
    publish = true,
    eventMethod = "Target.targetCreated",
  ) {
    const info = this._normalizeTargetInfo(targetInfo);
    if (!info) {
      this._loseUpstream("upstream_malformed");
      return false;
    }
    const previous = this.targetGraph.get(info.targetId);
    const sequence = previous?.sequence ?? ++this.targetSequence;
    const record = {
      info,
      sequence,
      provenance: previous?.provenance ?? null,
    };
    this.targetGraph.set(info.targetId, record);
    if (!previous && publish) {
      const owners = [...this.activeTaskRoots.values()].filter((client) => {
        const target = this._taskTarget(client.capability, info.targetId);
        return (
          client.state !== "closed" &&
          sequence > client.activationSequence &&
          target?.kind === "descendant"
        );
      });
      if (owners.length > 1) {
        this._loseUpstream("target_authority_ambiguous");
        return false;
      }
      if (owners.length === 1) {
        const owner = owners[0];
        record.provenance = Object.freeze({
          kind: "task-ephemeral",
          rootTargetId: owner.capability.rootTargetId,
          browserContextId: owner.capability.browserContextId,
          clientInstance: owner.instance,
          createdSequence: sequence,
        });
      }
    }
    if (publish) this._publishTargetGraphChange(info, eventMethod);
    return true;
  }

  _publishTargetGraphChange(info = null, eventMethod = null) {
    for (const client of this.clients.values()) {
      if (!client.discoveryEnabled || client.state === "closed") continue;
      const changedWasVisible = info
        ? client.visibleTargets.has(info.targetId)
        : false;
      const visible = this._visibleTargetInfos(client);
      const nextVisible = new Set(visible.map((target) => target.targetId));
      for (const targetInfo of visible) {
        if (client.visibleTargets.has(targetInfo.targetId)) continue;
        client.visibleTargets.add(targetInfo.targetId);
        this._deliverClient(client, {
          method: "Target.targetCreated",
          params: { targetInfo },
        });
      }
      if (
        info &&
        changedWasVisible &&
        nextVisible.has(info.targetId) &&
        eventMethod === "Target.targetInfoChanged"
      ) {
        this._deliverClient(client, {
          method: eventMethod,
          params: { targetInfo: info },
        });
      }
      for (const targetId of [...client.visibleTargets]) {
        if (nextVisible.has(targetId)) continue;
        client.visibleTargets.delete(targetId);
        this._deliverClient(client, {
          method: "Target.targetDestroyed",
          params: { targetId },
        });
      }
    }
  }

  _recordTargetDestroyed(targetId, params) {
    if (!TARGET_ID_PATTERN.test(targetId)) {
      this._loseUpstream("upstream_malformed");
      return;
    }
    const removed = new Set([targetId]);
    let changed = true;
    while (changed) {
      changed = false;
      for (const [candidateId, { info }] of this.targetGraph) {
        if (!removed.has(candidateId) && removed.has(info.openerId)) {
          removed.add(candidateId);
          changed = true;
        }
      }
    }
    for (const client of this.clients.values()) {
      if (!client.discoveryEnabled) continue;
      for (const removedId of removed) {
        if (!client.visibleTargets.delete(removedId)) continue;
        this._deliverClient(client, {
          method: "Target.targetDestroyed",
          params:
            removedId === targetId
              ? { ...params, targetId }
              : { targetId: removedId },
        });
      }
    }
    for (const removedId of removed) this.targetGraph.delete(removedId);
    for (const client of [...this.clients.values()]) {
      if (
        (client.capability.kind === "task" &&
          removed.has(client.capability.rootTargetId)) ||
        (["controller-tab-inspector", "controller-tab-focus"].includes(
          client.capability.kind,
        ) &&
          removed.has(client.capability.pageTargetId)) ||
        (client.capability.kind === "controller-tab-discovery" &&
          client.tabDiscovery.pageTargetId !== null &&
          removed.has(client.tabDiscovery.pageTargetId))
      ) {
        this._closeClient(client, CLOSE_POLICY, "target authority unavailable");
      }
    }
    if (removed.size > 1) this._scheduleTargetRefresh();
  }

  _scheduleTargetRefresh() {
    if (this.targetRefreshInFlight || this.state !== "ready") return;
    this.targetRefreshInFlight = true;
    queueMicrotask(async () => {
      try {
        const result = await this._sendInternalCommand("Target.getTargets", {
          filter: PAGE_TARGET_FILTER,
        });
        if (!Array.isArray(result?.targetInfos)) {
          throw new Error("upstream target inventory is invalid");
        }
        for (const targetInfo of result.targetInfos) {
          if (!this._recordTargetInfo(targetInfo, false)) {
            throw new Error("upstream target inventory is invalid");
          }
        }
        this._publishTargetGraphChange();
        this._sweepExpiredLeases();
      } catch {
        if (this.state === "ready") this._loseUpstream("target_refresh_failed");
      } finally {
        this.targetRefreshInFlight = false;
      }
    });
  }

  _taskTarget(capability, targetId) {
    if (!TARGET_ID_PATTERN.test(targetId)) return null;
    const record = this.targetGraph.get(targetId);
    if (!record) return null;
    const info = record.info;
    if (targetId === capability.rootTargetId) {
      return info.type === capability.targetKind &&
        info.browserContextId === capability.browserContextId
        ? { kind: "root", record }
        : null;
    }
    if (
      info.type !== "page" ||
      info.browserContextId !== capability.browserContextId
    ) {
      return null;
    }
    const visited = new Set([targetId]);
    let current = info;
    while (current.openerId) {
      if (
        visited.has(current.openerId) ||
        visited.size > this.targetGraph.size
      ) {
        return null;
      }
      if (current.openerId === capability.rootTargetId) {
        const root = this.targetGraph.get(capability.rootTargetId)?.info;
        return root?.type === capability.targetKind &&
          root.browserContextId === capability.browserContextId
          ? { kind: "descendant", record }
          : null;
      }
      visited.add(current.openerId);
      current = this.targetGraph.get(current.openerId)?.info;
      if (!current || current.browserContextId !== capability.browserContextId)
        return null;
    }
    return null;
  }

  _taskClaimConflicts(capability) {
    const others = [
      ...[...this.activeTaskRoots.values()].map((client) => client.capability),
      ...this.reservedTaskRoots.values(),
    ];
    return others.some(
      (other) =>
        this._taskTarget(other, capability.rootTargetId) ||
        this._taskTarget(capability, other.rootTargetId),
    );
  }

  _isProtectedRoot(targetId) {
    return this.protectedRootIds.has(targetId);
  }

  _rememberProtectedRoots(leases) {
    for (const lease of leases.values()) {
      const capability = lease.capability;
      if (["task", "controller-cleanup"].includes(capability.kind)) {
        this.protectedRootIds.add(capability.rootTargetId);
      }
    }
  }

  _taskCanClose(client, targetId) {
    const target = this._taskTarget(client.capability, targetId);
    return Boolean(
      target?.kind === "descendant" &&
      client.capability.descendantPolicy.allowCloseEphemeral &&
      target.record.provenance?.kind === "task-ephemeral" &&
      target.record.provenance.clientInstance === client.instance &&
      target.record.provenance.rootTargetId ===
        client.capability.rootTargetId &&
      !this._isProtectedRoot(targetId),
    );
  }

  _cleanupCanClose(capability, targetId) {
    return Boolean(
      capability.targetIds.includes(targetId) &&
      this._taskTarget(capability, targetId)?.kind === "descendant" &&
      this.targetGraph.get(targetId)?.provenance?.kind === "task-ephemeral" &&
      this.targetGraph.get(targetId)?.provenance?.rootTargetId ===
        capability.rootTargetId &&
      this.targetGraph.get(targetId)?.provenance?.browserContextId ===
        capability.browserContextId &&
      !this._isProtectedRoot(targetId),
    );
  }

  _leaseCurrentlyValid(lease) {
    const capability = lease.capability;
    if (
      [
        "controller-inventory",
        "controller-tab-inventory",
        "controller-tab-discovery",
        "controller-tab-inspector",
        "controller-tab-focus",
      ].includes(capability.kind)
    )
      return true;
    if (!this._taskTarget(capability, capability.rootTargetId)) return false;
    if (capability.kind === "controller-cleanup") {
      return capability.targetIds.every(
        (targetId) =>
          !this.targetGraph.has(targetId) ||
          this._cleanupCanClose(capability, targetId),
      );
    }
    return capability.kind === "task";
  }

  _targetVisibleToClient(client, targetId) {
    if (client.capability.kind === "controller-inventory") {
      return this.targetGraph.has(targetId);
    }
    if (client.capability.kind === "task") {
      return Boolean(this._taskTarget(client.capability, targetId));
    }
    return false;
  }

  _visibleTargetInfos(client) {
    return [...this.targetGraph.values()]
      .filter(({ info }) => this._targetVisibleToClient(client, info.targetId))
      .sort((left, right) => {
        if (client.capability.kind !== "task") {
          return left.sequence - right.sequence;
        }
        return (
          this._taskTargetDepth(client.capability, left.info.targetId) -
            this._taskTargetDepth(client.capability, right.info.targetId) ||
          left.sequence - right.sequence
        );
      })
      .map(({ info }) => info);
  }

  _taskTargetDepth(capability, targetId) {
    if (targetId === capability.rootTargetId) return 0;
    let depth = 1;
    let current = this.targetGraph.get(targetId)?.info;
    const visited = new Set([targetId]);
    while (current?.openerId) {
      if (current.openerId === capability.rootTargetId) return depth;
      if (visited.has(current.openerId)) return Number.MAX_SAFE_INTEGER;
      visited.add(current.openerId);
      current = this.targetGraph.get(current.openerId)?.info;
      depth += 1;
    }
    return Number.MAX_SAFE_INTEGER;
  }

  _handleUpstreamEvent(message) {
    if (
      message.sessionId === undefined &&
      message.method === "Target.targetCreated"
    ) {
      this._recordTargetInfo(message.params?.targetInfo, true);
      return;
    }
    if (
      message.sessionId === undefined &&
      message.method === "Target.targetInfoChanged"
    ) {
      this._recordTargetInfo(
        message.params?.targetInfo,
        true,
        "Target.targetInfoChanged",
      );
      return;
    }
    if (
      message.sessionId === undefined &&
      message.method === "Target.targetDestroyed"
    ) {
      this._recordTargetDestroyed(
        message.params?.targetId,
        message.params ?? {},
      );
      return;
    }
    if (
      message.sessionId === undefined &&
      message.method === "Target.targetCrashed"
    ) {
      const targetId = message.params?.targetId;
      if (!TARGET_ID_PATTERN.test(targetId)) {
        this._loseUpstream("upstream_malformed");
        return;
      }
      for (const client of this.clients.values()) {
        if (client.discoveryEnabled && client.visibleTargets.has(targetId)) {
          this._deliverClient(client, message);
        }
      }
      return;
    }
    if (message.method === "Target.attachedToTarget") {
      this._handleAttachedEvent(message);
      return;
    }
    if (message.method === "Target.detachedFromTarget") {
      this._handleDetachedEvent(message);
      return;
    }
    if (message.method === "Target.receivedMessageFromTarget") {
      const owner = this.sessionOwners.get(message.params?.sessionId);
      if (!owner) {
        this._loseUpstream("upstream_protocol_desync");
        return;
      }
      this._deliverScopedEvent(owner.client, message, message.sessionId);
      return;
    }
    if (message.sessionId !== undefined) {
      const owner = this.sessionOwners.get(message.sessionId);
      if (!owner) {
        this._loseUpstream("upstream_protocol_desync");
        return;
      }
      this._deliverScopedEvent(owner.client, message, message.sessionId);
      return;
    }
    // Browser-root events have no task owner. No lease kind grants ambient
    // browser-global observation, so they are intentionally not forwarded.
  }

  _handleAttachedEvent(message) {
    const attachedSessionId = message.params?.sessionId;
    if (!SESSION_ID_PATTERN.test(attachedSessionId)) {
      this._loseUpstream("upstream_malformed");
      return;
    }
    if (message.sessionId !== undefined) {
      const envelopeOwner = this.sessionOwners.get(message.sessionId);
      const targetId = message.params?.targetInfo?.targetId;
      if (!envelopeOwner) {
        this._loseUpstream("upstream_protocol_desync");
        return;
      }
      const client = envelopeOwner.client;
      let sessionKind = null;
      if (client.capability.kind === "task") {
        const target = this._taskTarget(client.capability, targetId);
        if (
          target &&
          (target.kind !== "descendant" ||
            client.capability.descendantPolicy.allowAttach)
        ) {
          sessionKind = "child";
        }
      } else if (client.capability.kind === "controller-tab-inspector") {
        const targetInfo = message.params?.targetInfo;
        if (
          envelopeOwner.kind === "root" &&
          this._freshTabInfo(
            targetInfo,
            client.capability,
            client.capability.expectedTabActive,
          )
        ) {
          sessionKind = "tab";
        } else if (
          envelopeOwner.kind === "tab" &&
          isPlainObject(targetInfo) &&
          targetInfo.type === "page" &&
          targetInfo.targetId === client.capability.pageTargetId &&
          targetInfo.browserContextId === client.capability.browserContextId &&
          client.pageSessionId === null
        ) {
          sessionKind = "tab_page";
        }
      } else if (client.capability.kind === "controller-tab-discovery") {
        const targetInfo = message.params?.targetInfo;
        if (envelopeOwner.kind === "root") {
          if (
            ["attaching-tab", "needs-autoattach"].includes(
              client.tabDiscovery.phase,
            ) &&
            (client.tabSessionId === null ||
              client.tabSessionId === attachedSessionId) &&
            this._freshTabInfo(
              targetInfo,
              client.capability,
              client.capability.expectedTabActive,
            )
          ) {
            sessionKind = "tab";
          } else {
            this._closeClient(
              client,
              CLOSE_POLICY,
              "fresh tab discovery failed",
            );
            return;
          }
        } else if (envelopeOwner.kind === "tab") {
          if (!this._observeDiscoveredPage(client, targetInfo)) return;
          sessionKind = "tab_page";
        } else {
          this._closeClient(
            client,
            CLOSE_POLICY,
            "tab discovery session binding failed",
          );
          return;
        }
      }
      if (
        !sessionKind ||
        !this._assignSession(client, attachedSessionId, sessionKind, targetId)
      ) {
        this._loseUpstream("upstream_protocol_desync");
        return;
      }
      this._deliverScopedEvent(client, message, message.sessionId);
      return;
    }
    const existing = this.sessionOwners.get(attachedSessionId);
    if (existing?.kind === "root") return;
    const active = this.activeRootAttach?.pending;
    if (
      active &&
      !active.provisionalRootSessionId &&
      message.params?.targetInfo?.type === "browser"
    ) {
      active.provisionalRootSessionId = attachedSessionId;
      this._assignSession(active.client, attachedSessionId, "root");
      return;
    }
    if (existing) {
      this._deliverClient(existing.client, message);
      return;
    }
    this._loseUpstream("upstream_protocol_desync");
  }

  _handleDetachedEvent(message) {
    const detachedSessionId = message.params?.sessionId;
    if (!SESSION_ID_PATTERN.test(detachedSessionId)) {
      this._loseUpstream("upstream_malformed");
      return;
    }
    const detachedOwner = this.sessionOwners.get(detachedSessionId);
    const detachedTombstone =
      this.detachedClientSessions.get(detachedSessionId);
    if (message.sessionId !== undefined) {
      const envelopeOwner = this.sessionOwners.get(message.sessionId);
      if (
        !envelopeOwner ||
        (detachedOwner && detachedOwner.client !== envelopeOwner.client) ||
        (detachedTombstone &&
          detachedTombstone.client !== envelopeOwner.client) ||
        (!detachedOwner && !detachedTombstone)
      ) {
        this._loseUpstream("upstream_protocol_desync");
        return;
      }
      this._deliverScopedEvent(
        envelopeOwner.client,
        message,
        message.sessionId,
      );
      if (detachedOwner) {
        this._removeSession(detachedOwner.client, detachedSessionId);
      } else {
        this._clearDetachedClientSession(detachedSessionId);
      }
      return;
    }
    if (detachedTombstone) {
      this._deliverClient(detachedTombstone.client, message);
      this._clearDetachedClientSession(detachedSessionId);
      return;
    }
    if (!detachedOwner) {
      const tombstone = this.detachingRootSessions.get(detachedSessionId);
      if (tombstone) {
        clearTimeout(tombstone);
        this.detachingRootSessions.delete(detachedSessionId);
        return;
      }
      this._loseUpstream("upstream_protocol_desync");
      return;
    }
    if (detachedOwner.kind === "root") {
      const client = detachedOwner.client;
      const tombstone = this.detachingRootSessions.get(detachedSessionId);
      if (tombstone) clearTimeout(tombstone);
      this.detachingRootSessions.delete(detachedSessionId);
      this._dropClientSessions(client);
      if (client.state !== "closed")
        this._closeClient(client, CLOSE_POLICY, CLIENT_SESSION_REASON);
      return;
    }
    this._deliverClient(detachedOwner.client, message);
    this._removeSession(detachedOwner.client, detachedSessionId);
  }

  _deliverScopedEvent(client, message, envelopeSessionId) {
    if (
      client.capability.kind === "controller-tab-discovery" &&
      !["Target.attachedToTarget", "Target.detachedFromTarget"].includes(
        message.method,
      )
    ) {
      return;
    }
    const event = { ...message };
    if (envelopeSessionId === client.rootSessionId) delete event.sessionId;
    this._deliverClient(client, event);
  }

  _assignSession(client, sessionId, kind, targetId = null) {
    const existing = this.sessionOwners.get(sessionId);
    if (existing) {
      if (
        existing.client !== client ||
        existing.kind !== kind ||
        existing.targetId !== targetId
      ) {
        this._loseUpstream("upstream_protocol_desync");
        return false;
      }
      return true;
    }
    if (client.sessionCount >= this.limits.maxSessionsPerClient) {
      this._closeClient(
        client,
        CLOSE_OVERLOADED,
        "client session limit reached",
      );
      return false;
    }
    this.sessionOwners.set(sessionId, { client, kind, targetId });
    client.sessionCount += 1;
    if (kind === "tab") client.tabSessionId = sessionId;
    if (kind === "tab_page") client.pageSessionId = sessionId;
    return true;
  }

  _rememberDetachedClientSession(client, sessionId) {
    if (this.detachedClientSessions.has(sessionId)) return true;
    if (
      this.detachingRootSessions.size + this.detachedClientSessions.size >=
      this.limits.maxClients * 2
    ) {
      this._loseUpstream("upstream_cleanup_overflow");
      return false;
    }
    const timer = setTimeout(
      () => this.detachedClientSessions.delete(sessionId),
      this.limits.closeGraceMs * 2,
    );
    timer.unref?.();
    this.detachedClientSessions.set(sessionId, { client, timer });
    return true;
  }

  _clearDetachedClientSession(sessionId) {
    const tombstone = this.detachedClientSessions.get(sessionId);
    if (!tombstone) return;
    clearTimeout(tombstone.timer);
    this.detachedClientSessions.delete(sessionId);
  }

  _removeSession(client, sessionId, expectDetachedEvent = false) {
    const owner = this.sessionOwners.get(sessionId);
    if (owner?.client !== client) return;
    const discoveryAutoDetachPhase =
      client.capability.kind === "controller-tab-discovery" &&
      owner.kind === "tab_page" &&
      ["disabling-autoattach", "awaiting-page-auto-detach"].includes(
        client.tabDiscovery.phase,
      )
        ? client.tabDiscovery.phase
        : null;
    if (
      client.capability.kind === "controller-tab-discovery" &&
      ["tab", "tab_page"].includes(owner.kind)
    ) {
      if (client.tabDiscovery.expectedDetachSessionId !== sessionId) {
        this._closeClient(
          client,
          CLOSE_POLICY,
          "tab discovery session discarded",
        );
        return;
      }
      client.tabDiscovery.expectedDetachSessionId = null;
    }
    if (
      expectDetachedEvent &&
      !this._rememberDetachedClientSession(client, sessionId)
    ) {
      return;
    }
    this.sessionOwners.delete(sessionId);
    client.sessionCount = Math.max(0, client.sessionCount - 1);
    if (owner.kind === "tab_page" && client.pageSessionId === sessionId) {
      client.pageSessionId = null;
    }
    if (owner.kind === "tab" && client.tabSessionId === sessionId) {
      client.tabSessionId = null;
      if (client.pageSessionId) {
        const pageSessionId = client.pageSessionId;
        client.pageSessionId = null;
        if (this.sessionOwners.get(pageSessionId)?.client === client) {
          this.sessionOwners.delete(pageSessionId);
          client.sessionCount = Math.max(0, client.sessionCount - 1);
        }
      }
    }
    if (discoveryAutoDetachPhase) {
      client.tabDiscovery.phase =
        discoveryAutoDetachPhase === "disabling-autoattach"
          ? "awaiting-stop-response"
          : "needs-detach-tab";
    }
  }

  _dropClientSessions(client) {
    for (const [sessionId, owner] of this.sessionOwners) {
      if (owner.client === client) this.sessionOwners.delete(sessionId);
    }
    client.sessionCount = 0;
    client.tabSessionId = null;
    client.pageSessionId = null;
  }

  _deliverClient(client, message) {
    if (client.state === "closed") return;
    if (client.state === "initializing") {
      const bytes = Buffer.byteLength(JSON.stringify(message));
      if (
        client.outboundQueue.length >= this.limits.maxQueuedFramesPerClient ||
        client.outboundQueuedBytes + bytes > this.limits.maxQueuedBytesPerClient
      ) {
        this._closeClient(
          client,
          CLOSE_OVERLOADED,
          "client initialization queue exceeded",
        );
        return;
      }
      client.outboundQueue.push(message);
      client.outboundQueuedBytes += bytes;
      return;
    }
    this._sendClientObject(client, message);
  }

  _sendClientObject(client, message) {
    if (client.state !== "ready" || client.ws.readyState !== WebSocket.OPEN)
      return;
    let payload;
    try {
      payload = JSON.stringify(message);
    } catch {
      this._loseUpstream("upstream_malformed");
      return;
    }
    const bytes = Buffer.byteLength(payload);
    if (
      bytes > this.limits.maxFrameBytes ||
      client.ws.bufferedAmount + bytes > this.limits.maxBufferedBytesPerSocket
    ) {
      this._closeClient(
        client,
        CLOSE_OVERLOADED,
        "client output queue exceeded",
      );
      return;
    }
    try {
      client.ws.send(payload, { binary: false, compress: false }, (error) => {
        if (error)
          this._closeClient(client, CLOSE_POLICY, "client transport error");
      });
    } catch {
      this._closeClient(client, CLOSE_POLICY, "client transport error");
    }
  }

  _closeClient(client, code, reason) {
    if (client.state === "closed") return;
    client.state = "closed";
    closeWebSocket(client.ws, code, reason, this.limits.closeGraceMs);
    this._cleanupClient(client);
  }

  _cleanupClient(client) {
    if (this.clients.get(client.ws) !== client) return;
    client.state = "closed";
    this.clients.delete(client.ws);
    if (this.activeLeases.get(client.leaseId) === client)
      this.activeLeases.delete(client.leaseId);
    if (
      client.capability.kind === "task" &&
      this.activeTaskRoots.get(client.capability.rootTargetId) === client
    ) {
      this.activeTaskRoots.delete(client.capability.rootTargetId);
    }
    client.inboundQueue.length = 0;
    client.outboundQueue.length = 0;
    client.inboundQueuedBytes = 0;
    client.outboundQueuedBytes = 0;
    if (client.tabDiscovery.pageTimer) {
      clearTimeout(client.tabDiscovery.pageTimer);
      client.tabDiscovery.pageTimer = null;
    }
    if (client.rootSessionId)
      this._sendInternalDetach(client, client.rootSessionId);
    this._pumpRootAttach();
  }

  _loseUpstream(reason) {
    if (["upstream_lost", "stopping", "stopped"].includes(this.state)) return;
    this.state = "upstream_lost";
    this.lossReason = reason;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      if (pending.kind === "startup") {
        pending.reject(new Error("upstream generation lost"));
      }
    }
    this.pending.clear();
    for (const timer of this.detachingRootSessions.values())
      clearTimeout(timer);
    this.detachingRootSessions.clear();
    for (const { timer } of this.detachedClientSessions.values())
      clearTimeout(timer);
    this.detachedClientSessions.clear();
    this.clientPendingTotal = 0;
    this.internalPendingCount = 0;
    this.activeRootAttach = null;
    this.rootAttachQueue.length = 0;
    for (const client of [...this.clients.values()]) {
      this._closeClient(client, CLOSE_UPSTREAM_LOST, UPSTREAM_LOST_REASON);
    }
    this.sessionOwners.clear();
    this.activeTaskRoots.clear();
    if (this.upstream && this.upstream.readyState !== WebSocket.CLOSED) {
      try {
        this.upstream.terminate();
      } catch {
        // The generation is already lost; there is no reconnect path.
      }
    }
  }

  _sweepExpiredLeases() {
    const now = Date.now();
    for (const client of [...this.clients.values()]) {
      const lease = this.clientLeases.get(client.leaseId);
      if (
        !lease ||
        lease.expiresAtMs <= now ||
        !sameDigest(lease.authorityDigest, client.authorityDigest) ||
        !this._leaseCurrentlyValid(lease)
      ) {
        this._closeClient(
          client,
          CLOSE_POLICY,
          "client lease expired or revoked",
        );
      }
    }
  }

  replaceClientLeases(clientLeases) {
    const next = normalizeClientLeases(
      clientLeases,
      this.limits,
      this.transportGeneration,
    );
    this._rememberProtectedRoots(next);
    this.clientLeases = next;
    this._sweepExpiredLeases();
    return next.size;
  }

  revokeAllClientLeases() {
    this.clientLeases = new Map();
    this._sweepExpiredLeases();
  }

  revalidateUpstreamAuthority({
    upstreamUrl,
    browserGeneration,
    consentGeneration,
  }) {
    const next = [
      normalizeUpstreamUrl(upstreamUrl),
      normalizeGeneration(browserGeneration, "browser generation"),
      normalizeGeneration(consentGeneration, "consent generation"),
    ];
    const current = [
      this.upstreamUrl,
      this.browserGeneration,
      this.consentGeneration,
    ];
    const matches = next.every((value, index) =>
      sameDigest(
        sha256(Buffer.from(value, "utf8")),
        sha256(Buffer.from(current[index], "utf8")),
      ),
    );
    if (!matches) this._loseUpstream("upstream_generation_changed");
    return matches;
  }

  invalidateUpstreamAuthority() {
    this._loseUpstream("upstream_authority_reload_failed");
  }

  getProducerContract() {
    if (!["ready", "upstream_lost"].includes(this.state) || !this.listenPort) {
      throw new Error("broker producer contract is unavailable");
    }
    return Object.freeze({
      schema: PRODUCER_CONTRACT_SCHEMA,
      producerRevision: PRODUCER_REVISION,
      source: Object.freeze({
        path: SOURCE_PATH,
        sha256: SOURCE_SHA256,
      }),
      process: Object.freeze({
        pid: process.pid,
        execPath: EXEC_PATH,
        startedAt: this.startedAt,
        instance: this.processInstance,
      }),
      brokerGeneration: this.brokerGeneration,
      browserGeneration: this.browserGeneration,
      consentGeneration: this.consentGeneration,
      transportGeneration: this.transportGeneration,
      generationScopes: Object.freeze({
        brokerGeneration: "broker-process-only",
        browserGeneration: "controller-attested-chrome-process-only",
        consentGeneration: "controller-attested-user-consent-only",
        transportGeneration:
          "sha256-binding-of-broker-browser-and-consent-generations",
      }),
      issuedAt: this.startedAt,
      transport: "raw-cdp-websocket",
      bind: Object.freeze({
        host: LOOPBACK_HOST,
        port: this.listenPort,
        loopbackOnly: true,
      }),
      cdp: Object.freeze({
        webSocketUrl: `ws://${LOOPBACK_HOST}:${this.listenPort}${this._routePath("cdp")}`,
        authentication: Object.freeze({
          scheme: "Bearer",
          header: "Authorization",
          credentialFormat:
            "<transportGeneration>.<leaseId>.<43-character-base64url-token>",
          tokenAuthority: "controller-minted-opaque-hmac",
          tokenSha256Input:
            "exact-43-character-token-utf8-bytes-only-excluding-bearer-prefix-generation-lease-dots-and-newline",
          tokenSha256Encoding: "lowercase-hex-sha256",
          tokenInUrl: false,
          oneLiveSocketPerLease: true,
          authFile: Object.freeze({
            owner: "controller",
            mode: "0600",
            encoding: "utf8",
            exactLine:
              "Authorization: Bearer <transportGeneration>.<leaseId>.<43-character-base64url-token>\n",
          }),
          leaseSchema: CLIENT_LEASE_SCHEMA,
          leaseFields: Object.freeze([
            "schema",
            "transportGeneration",
            "leaseId",
            "authorization",
            "issuedAt",
            "expiresAt",
            "capability",
          ]),
        }),
      }),
      health: Object.freeze({
        url: `http://${LOOPBACK_HOST}:${this.listenPort}${this._routePath("healthz")}`,
        authentication: "same-client-bearer-lease",
        schema: HEALTH_SCHEMA,
      }),
      upstream: Object.freeze({
        authorityPath: this.upstreamAuthorityPath,
        browserWebSocketUrlSha256: createHash("sha256")
          .update(this.upstreamUrl, "utf8")
          .digest("hex"),
        browserWebSocketConnectionsPerBrokerGeneration: 1,
        originHeader: "omitted",
        automaticReconnect: false,
        lossDisposition: "close-downstream-consent-reconnect-required",
        authorityRevalidation: "SIGHUP-before-client-lease-reload",
      }),
      isolation: Object.freeze({
        clientRoot: "one-flat-browser-target-session-per-client",
        requestIds: "broker-rewritten-and-restored",
        sessionEvents: "owning-client-only",
        targetInventory: "lease-capability-filtered-page-opener-tree",
        controllerTabDiscovery:
          "fresh-exact-tab-window-single-page-binding-no-activation",
        browserGlobalEvents: "dropped-no-ambient-global-event-capability",
        clientDisconnect:
          "detach-client-root-session-only-broker-remains-running",
      }),
      leaseControl: Object.freeze({
        registrySchema: CLIENT_LEASES_SCHEMA,
        registryPath: this.clientLeasesPath,
        registryOwner: "controller",
        registryBrokerAccess: "read-only",
        registryEntryFields: Object.freeze([
          "leaseId",
          "tokenSha256",
          "issuedAt",
          "expiresAt",
          "capability",
        ]),
        reloadSignal: "SIGHUP",
        activeRevocation: true,
        producerContractOwner: "broker",
        producerContractPublication: "atomic-once-per-broker-generation",
      }),
      capabilityKinds: Object.freeze([
        "task",
        "controller-inventory",
        "controller-cleanup",
        "controller-tab-inventory",
        "controller-tab-discovery",
        "controller-tab-inspector",
        "controller-tab-focus",
      ]),
      taskDeniedMethods: DENIED_METHODS,
      limits: publicLimits(this.limits),
    });
  }

  getHealth() {
    const pendingClientCount = [...this.pending.values()].filter(
      (entry) => entry.kind === "client",
    ).length;
    const pendingInternalCount = this.pending.size - pendingClientCount;
    return Object.freeze({
      schema: HEALTH_SCHEMA,
      brokerGeneration: this.brokerGeneration,
      browserGeneration: this.browserGeneration,
      consentGeneration: this.consentGeneration,
      transportGeneration: this.transportGeneration,
      state: this.state,
      reconnectRequired: this.state === "upstream_lost",
      lossReason: this.lossReason,
      uptimeMs: Math.max(0, Date.now() - this.startedAtMs),
      upstreamConnectionAttempts: this.upstreamConnectionAttempts,
      upstreamSocketOpen: this.upstream?.readyState === WebSocket.OPEN,
      clients: this.clients.size,
      sessions: this.sessionOwners.size,
      pendingClientRequests: pendingClientCount,
      pendingInternalRequests: pendingInternalCount,
      configuredClientLeases: this.clientLeases.size,
      limits: publicLimits(this.limits),
    });
  }

  async stop() {
    if (this.state === "stopped") return;
    this.state = "stopping";
    if (this.leaseSweepTimer) clearInterval(this.leaseSweepTimer);
    this.leaseSweepTimer = null;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      if (pending.kind === "startup") {
        pending.reject(new Error("broker stopped"));
      }
    }
    this.pending.clear();
    this.internalPendingCount = 0;
    this.clientPendingTotal = 0;
    for (const timer of this.detachingRootSessions.values())
      clearTimeout(timer);
    this.detachingRootSessions.clear();
    for (const { timer } of this.detachedClientSessions.values())
      clearTimeout(timer);
    this.detachedClientSessions.clear();
    for (const client of [...this.clients.values()]) {
      this._closeClient(client, 1001, "broker stopped");
    }
    this.sessionOwners.clear();
    if (this.upstream && this.upstream.readyState !== WebSocket.CLOSED) {
      try {
        this.upstream.close(1000, "broker stopped");
      } catch {
        this.upstream.terminate();
      }
    }
    if (this.wss) {
      await new Promise((resolve) => this.wss.close(() => resolve()));
    }
    if (this.httpServer?.listening) {
      await new Promise((resolve) => this.httpServer.close(() => resolve()));
    }
    this.state = "stopped";
  }
}

export async function startCdpBroker(options) {
  const broker = new CdpBroker(options);
  await broker.start();
  return broker;
}

export function writeProducerContract(path, contract) {
  if (!isAbsolute(path) || contract?.schema !== PRODUCER_CONTRACT_SCHEMA) {
    throw new Error("producer contract path or value is invalid");
  }
  const parent = dirname(path);
  const parentInfo = lstatSync(parent, { bigint: true });
  const uidMatches =
    typeof process.getuid !== "function" ||
    Number(parentInfo.uid) === process.getuid();
  if (
    !parentInfo.isDirectory() ||
    !uidMatches ||
    (Number(parentInfo.mode & 0o777n) & 0o022) !== 0 ||
    realpathSync(parent) !== parent
  ) {
    throw new Error("producer contract directory is unsafe");
  }
  try {
    const existing = lstatSync(path, { bigint: true });
    const existingUidMatches =
      typeof process.getuid !== "function" ||
      Number(existing.uid) === process.getuid();
    if (
      !existing.isFile() ||
      existing.isSymbolicLink() ||
      existing.nlink !== 1n ||
      Number(existing.mode & 0o777n) !== 0o600 ||
      !existingUidMatches
    ) {
      throw new Error("existing producer contract is unsafe");
    }
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  const payload = `${JSON.stringify(contract)}\n`;
  if (Buffer.byteLength(payload) > 64 * 1024)
    throw new Error("producer contract is too large");
  const temporary = join(
    parent,
    `.${basename(path)}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`,
  );
  let fd;
  try {
    fd = openSync(
      temporary,
      constants.O_CREAT |
        constants.O_EXCL |
        constants.O_WRONLY |
        (constants.O_CLOEXEC ?? 0) |
        (constants.O_NOFOLLOW ?? 0),
      0o600,
    );
    writeFileSync(fd, payload, "utf8");
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    renameSync(temporary, path);
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function parseCli(argv) {
  const values = new Map();
  const allowed = new Set([
    "--upstream-file",
    "--client-leases-file",
    "--contract-file",
    "--port",
  ]);
  for (let index = 0; index < argv.length; index += 2) {
    const option = argv[index];
    const value = argv[index + 1];
    if (
      !allowed.has(option) ||
      values.has(option) ||
      value === undefined ||
      value === ""
    ) {
      throw new Error("invalid broker command line");
    }
    values.set(option, value);
  }
  for (const required of [
    "--upstream-file",
    "--client-leases-file",
    "--contract-file",
  ]) {
    if (!values.has(required)) throw new Error("invalid broker command line");
  }
  const port = values.has("--port") ? Number(values.get("--port")) : 0;
  if (!Number.isSafeInteger(port) || port < 0 || port > 65_535) {
    throw new Error("invalid broker command line");
  }
  return {
    upstreamFile: values.get("--upstream-file"),
    clientLeasesFile: values.get("--client-leases-file"),
    contractFile: values.get("--contract-file"),
    port,
  };
}

async function main() {
  const cli = parseCli(process.argv.slice(2));
  const upstreamAuthority = readUpstreamAuthorityFile(cli.upstreamFile);
  const clientLeases = readClientLeasesFile(cli.clientLeasesFile);
  const broker = await startCdpBroker({
    ...upstreamAuthority,
    clientLeases,
    upstreamAuthorityPath: realpathSync(cli.upstreamFile),
    clientLeasesPath: realpathSync(cli.clientLeasesFile),
    listenPort: cli.port,
  });
  try {
    writeProducerContract(cli.contractFile, broker.getProducerContract());
  } catch {
    await broker.stop();
    throw new Error("producer contract publication failed");
  }
  process.stdout.write(
    `${JSON.stringify({
      schema: "agent-browser.cdp-broker-ready.v1",
      brokerGeneration: broker.brokerGeneration,
      transportGeneration: broker.transportGeneration,
      contractFile: cli.contractFile,
      pid: process.pid,
    })}\n`,
  );

  let reloadInProgress = false;
  process.on("SIGHUP", () => {
    if (reloadInProgress) return;
    reloadInProgress = true;
    try {
      let nextAuthority;
      try {
        nextAuthority = readUpstreamAuthorityFile(cli.upstreamFile);
      } catch {
        broker.invalidateUpstreamAuthority();
        process.stderr.write(
          "upstream authority reload failed; consent reconnect required\n",
        );
        return;
      }
      if (!broker.revalidateUpstreamAuthority(nextAuthority)) return;
      try {
        broker.replaceClientLeases(readClientLeasesFile(cli.clientLeasesFile));
      } catch {
        broker.revokeAllClientLeases();
        process.stderr.write(
          "client lease reload failed; authentication disabled\n",
        );
      }
    } catch {
      broker.invalidateUpstreamAuthority();
      process.stderr.write("broker authority reload failed\n");
    } finally {
      reloadInProgress = false;
    }
  });
  const stop = async () => {
    await broker.stop();
    process.exit(0);
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
}

const isMain =
  process.argv[1] &&
  pathToFileURL(realpathSync(process.argv[1])).href === import.meta.url;
if (isMain) {
  main().catch(() => {
    process.stderr.write("CDP broker failed\n");
    process.exitCode = 1;
  });
}
