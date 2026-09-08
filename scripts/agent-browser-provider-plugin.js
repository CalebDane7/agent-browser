#!/usr/bin/env node

import { randomBytes } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { lstat, open, unlink, writeFile } from "node:fs/promises";
import net from "node:net";
import { isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { TextDecoder } from "node:util";
import { ownerSession, validateOwnerIdentity } from "./agent-browser-owner.js";

export const PLUGIN_PROTOCOL = "agent-browser.plugin.v1";
export const PLUGIN_CAPABILITY = "browser.provider";
export const CONTROL_SCHEMA = "agent-browser.extension-control.v1";
export const PROVIDER_NAME = "private-cws";
export const MAX_MESSAGE_BYTES = 64 * 1024;
export const PROVIDER_FAILURE_SCHEMA = "agent-browser.provider-failure.v2";

const MAX_GRANT_BYTES = 8 * 1024;
// Keep transport ownership past the broker's complete 15 s launch budget so
// the provider never abandons a request that can still commit a page session.
export const PROVIDER_CONTROL_TIMEOUT_MS = 20_000;
const FUTURE_CLOCK_SKEW_MS = 5_000;
const SESSION_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
const OPAQUE_PATTERN = /^[a-f0-9]{64}$/;
const UTF8 = new TextDecoder("utf-8", { fatal: true });

class ProviderFailure extends Error {
  constructor(code, diagnostic = code) {
    super(code);
    this.name = "ProviderFailure";
    this.code = code;
    this.diagnostic = diagnostic;
  }
}

function reject(code, diagnostic) {
  throw new ProviderFailure(code, diagnostic);
}

function isRecord(value) {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

function requireExactKeys(value, expected, code) {
  if (!isRecord(value)) reject(code);
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (
    actual.length !== wanted.length ||
    actual.some((key, index) => key !== wanted[index])
  ) {
    reject(code);
  }
}

function canonicalValue(value) {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (!isRecord(value)) return value;
  const sorted = {};
  for (const key of Object.keys(value).sort()) {
    sorted[key] = canonicalValue(value[key]);
  }
  return sorted;
}

export function canonicalJson(value) {
  return JSON.stringify(canonicalValue(value));
}

function decodeJson(bytes, code) {
  let text;
  try {
    text = UTF8.decode(bytes);
  } catch {
    reject(code);
  }
  try {
    return JSON.parse(text);
  } catch {
    reject(code);
  }
}

function takeRequiredPath(name, code) {
  const value = process.env[name];
  delete process.env[name];
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    Buffer.byteLength(value, "utf8") > 4_096 ||
    value.includes("\0") ||
    !isAbsolute(value)
  ) {
    reject(code);
  }
  return value;
}

function sameFile(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

function sameOpenState(left, right) {
  return (
    sameFile(left, right) &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs &&
    left.ctimeMs === right.ctimeMs
  );
}

export function validateGrant(value, expectedSession, now = Date.now()) {
  requireExactKeys(
    value,
    ["session", "agentOwner", "aliasHash", "account", "currentTab", "issuedAt", "expiresAt", "nonce"],
    "grant_invalid",
  );
  if (!validateOwnerIdentity(value.agentOwner) ||
      value.agentOwner.uid !== process.getuid() ||
      typeof value.aliasHash !== "string" || !OPAQUE_PATTERN.test(value.aliasHash) ||
      value.session !== ownerSession(value.agentOwner, value.aliasHash)) {
    reject("grant_invalid");
  }
  if (
    typeof value.session !== "string" ||
    !SESSION_PATTERN.test(value.session) ||
    value.session !== expectedSession
  ) {
    reject("grant_invalid");
  }
  if (
    typeof value.account !== "string" ||
    value.account !== value.account.trim() ||
    Buffer.byteLength(value.account, "utf8") > 320 ||
    /[\u0000-\u001f\u007f]/.test(value.account)
  ) {
    reject("grant_invalid");
  }
  if (typeof value.currentTab !== "boolean") reject("grant_invalid");
  if (
    !Number.isSafeInteger(value.issuedAt) ||
    !Number.isSafeInteger(value.expiresAt) ||
    value.issuedAt > now + FUTURE_CLOCK_SKEW_MS ||
    value.expiresAt <= now ||
    value.expiresAt <= value.issuedAt
  ) {
    reject("grant_expired");
  }
  if (typeof value.nonce !== "string" || !OPAQUE_PATTERN.test(value.nonce)) {
    reject("grant_invalid");
  }

  return {
    session: value.session,
    agentOwner: value.agentOwner,
    aliasHash: value.aliasHash,
    account: value.account,
    currentTab: value.currentTab,
    issuedAt: value.issuedAt,
    expiresAt: value.expiresAt,
    nonce: value.nonce,
  };
}

export async function consumeGrant(grantPath, expectedSession, now = Date.now()) {
  let initial;
  try {
    initial = await lstat(grantPath);
  } catch {
    reject("grant_unavailable");
  }
  const uid = typeof process.getuid === "function" ? process.getuid() : null;
  if (
    !initial.isFile() ||
    initial.isSymbolicLink() ||
    (initial.mode & 0o7777) !== 0o600 ||
    initial.nlink !== 1 ||
    (uid !== null && initial.uid !== uid) ||
    initial.size <= 0 ||
    initial.size > MAX_GRANT_BYTES
  ) {
    reject("grant_insecure");
  }

  let handle;
  let bytes;
  try {
    handle = await open(
      grantPath,
      fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0),
    );
    const beforeRead = await handle.stat();
    if (!sameOpenState(initial, beforeRead)) reject("grant_changed");
    bytes = await handle.readFile();
    const afterRead = await handle.stat();
    if (
      bytes.length !== beforeRead.size ||
      !sameOpenState(beforeRead, afterRead)
    ) {
      reject("grant_changed");
    }
  } catch (error) {
    if (error instanceof ProviderFailure) throw error;
    reject("grant_unavailable");
  } finally {
    await handle?.close().catch(() => {});
  }

  // WHY: consuming the only link before control-socket contact prevents a
  // failed or replayed launch from retaining reusable grant authority.
  let beforeUnlink;
  try {
    beforeUnlink = await lstat(grantPath);
  } catch {
    reject("grant_changed");
  }
  if (!sameOpenState(initial, beforeUnlink)) reject("grant_changed");
  try {
    await unlink(grantPath);
  } catch {
    reject("grant_unavailable");
  }

  return validateGrant(decodeJson(bytes, "grant_invalid"), expectedSession, now);
}

function validateLaunchRequest(request) {
  requireExactKeys(
    request,
    ["provider", "session", "launchOptions"],
    "launch_request_invalid",
  );
  if (request.provider !== PROVIDER_NAME) reject("provider_mismatch");
  if (typeof request.session !== "string" || !SESSION_PATTERN.test(request.session)) {
    reject("session_invalid");
  }
  requireExactKeys(
    request.launchOptions,
    ["headed", "engine", "userAgent", "colorScheme"],
    "launch_options_unsupported",
  );
  if (
    request.launchOptions.headed !== false ||
    request.launchOptions.engine !== "chrome" ||
    request.launchOptions.userAgent !== null ||
    request.launchOptions.colorScheme !== null
  ) {
    reject("launch_options_unsupported");
  }
  return request.session;
}

function validateOuterPayload(value) {
  requireExactKeys(
    value,
    ["protocol", "type", "capability", "request"],
    "plugin_request_invalid",
  );
  if (value.protocol !== PLUGIN_PROTOCOL) reject("protocol_unsupported");
  if (value.capability !== PLUGIN_CAPABILITY) reject("capability_unsupported");
  if (value.type !== "browser.launch" && value.type !== "browser.close") {
    reject("operation_unsupported");
  }
  return value;
}

async function validateControlSocket(controlPath) {
  let info;
  try {
    info = await lstat(controlPath);
  } catch {
    reject("control_unavailable");
  }
  const uid = typeof process.getuid === "function" ? process.getuid() : null;
  if (!info.isSocket() || (uid !== null && info.uid !== uid)) {
    reject("control_insecure");
  }
}

function parseControlLine(bytes) {
  if (
    bytes.length === 0 ||
    bytes.length > MAX_MESSAGE_BYTES ||
    bytes[bytes.length - 1] !== 0x0a ||
    bytes.indexOf(0x0a) !== bytes.length - 1 ||
    (bytes.length > 1 && bytes[bytes.length - 2] === 0x0d)
  ) {
    reject("control_response_invalid");
  }
  return decodeJson(bytes.subarray(0, bytes.length - 1), "control_response_invalid");
}

export async function exchangeControl(controlPath, request) {
  await validateControlSocket(controlPath);
  const wire = Buffer.from(`${canonicalJson(request)}\n`, "utf8");
  if (wire.length > MAX_MESSAGE_BYTES) reject("control_request_too_large");

  const responseBytes = await new Promise((resolvePromise, rejectPromise) => {
    let total = 0;
    const chunks = [];
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      if (error) rejectPromise(error);
      else resolvePromise(value);
    };
    const socket = net.createConnection({ path: controlPath });
    socket.setTimeout(PROVIDER_CONTROL_TIMEOUT_MS);
    // WHY: launch can wait on an asynchronous extension round trip. The real
    // broker destroys an unsettled control connection when the client sends
    // EOF, so keep the write side open until the broker returns and closes it.
    socket.once("connect", () => socket.write(wire));
    socket.on("data", (chunk) => {
      total += chunk.length;
      if (total > MAX_MESSAGE_BYTES) {
        socket.destroy(new ProviderFailure("control_response_too_large"));
        return;
      }
      chunks.push(chunk);
    });
    socket.once("timeout", () => {
      socket.destroy(new ProviderFailure("control_timeout"));
    });
    socket.once("error", (error) => finish(error));
    socket.once("close", (hadError) => {
      if (!hadError) finish(null, Buffer.concat(chunks, total));
    });
  }).catch((error) => {
    if (error instanceof ProviderFailure) throw error;
    reject("control_unavailable");
  });

  return parseControlLine(responseBytes);
}

function validateControlResult(response, id) {
  if (
    !isRecord(response) ||
    response.schema !== CONTROL_SCHEMA ||
    response.id !== id ||
    typeof response.ok !== "boolean"
  ) {
    reject("control_response_invalid");
  }
  if (response.ok === false) {
    const failureKeys = Object.hasOwn(response, "profileDirectory")
      ? ["schema", "id", "ok", "error", "profileDirectory"]
      : ["schema", "id", "ok", "error"];
    requireExactKeys(
      response,
      failureKeys,
      "control_response_invalid",
    );
    requireExactKeys(
      response.error,
      ["code", "message"],
      "control_response_invalid",
    );
    if (
      typeof response.error.code !== "string" ||
      !/^[A-Z][A-Z0-9_]{2,63}$/.test(response.error.code) ||
      typeof response.error.message !== "string" ||
      response.error.message.length > 240 ||
      /[\u0000-\u001f\u007f-\u009f]/.test(response.error.message) ||
      (Object.hasOwn(response, "profileDirectory") &&
        (typeof response.profileDirectory !== "string" ||
          !/^(?:Default|Profile|Profile [1-9][0-9]{0,3})$/.test(
            response.profileDirectory,
          )))
    ) {
      reject("control_response_invalid");
    }
    // WHY: the donor reduces every provider rejection to success=false and
    // discards provider stderr. Keep the public plugin error stable, but carry
    // the broker's already-bounded code into the wrapper's private one-shot
    // diagnostic so one literal failure identifies its owning boundary.
    reject("control_rejected", `control_rejected:${response.error.code}`);
  }
  // WHY: the broker owns this envelope and nests every successful operation
  // under result. Flattening launch fields made the fake green while the real
  // broker response was rejected before the donor could reach its page.
  requireExactKeys(
    response,
    ["schema", "id", "ok", "result"],
    "control_response_invalid",
  );
  if (!isRecord(response.result)) reject("control_response_invalid");
  return response.result;
}

function validateCapabilityUrl(raw) {
  if (typeof raw !== "string" || Buffer.byteLength(raw, "utf8") > 1_024) {
    reject("control_response_invalid");
  }
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    reject("control_response_invalid");
  }
  const pathMatch = /^\/page\/([a-f0-9]{64})$/.exec(parsed.pathname);
  if (
    parsed.protocol !== "ws:" ||
    parsed.hostname !== "127.0.0.1" ||
    parsed.port === "" ||
    Number(parsed.port) < 1 ||
    Number(parsed.port) > 65_535 ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.search !== "" ||
    parsed.hash !== "" ||
    !pathMatch ||
    parsed.href !== raw
  ) {
    reject("control_response_invalid");
  }
  return raw;
}

function validateCleanup(value) {
  if (typeof value !== "string" || !OPAQUE_PATTERN.test(value)) {
    reject("cleanup_invalid");
  }
  return value;
}

function newRequestId() {
  return randomBytes(32).toString("hex");
}

async function handleLaunch(request) {
  const session = validateLaunchRequest(request);
  const grantPath = takeRequiredPath(
    "AGENT_BROWSER_PROVIDER_GRANT_PATH",
    "grant_unavailable",
  );
  const controlPath = takeRequiredPath(
    "AGENT_BROWSER_EXTENSION_CONTROL_SOCKET",
    "control_unavailable",
  );
  const grant = await consumeGrant(grantPath, session);
  const id = newRequestId();
  const response = await exchangeControl(controlPath, {
    schema: CONTROL_SCHEMA,
    id,
    op: "launch",
    grant,
  });
  const result = validateControlResult(response, id);
  requireExactKeys(
    result,
    ["cdpUrl", "cleanup"],
    "control_response_invalid",
  );
  const cdpUrl = validateCapabilityUrl(result.cdpUrl);
  const cleanup = validateCleanup(result.cleanup);
  // WHY: v0.36.0's ordinary CDP path discovers Target.* across the browser.
  // This capability names one page, so directPage must remain true.
  return {
    protocol: PLUGIN_PROTOCOL,
    success: true,
    browser: { cdpUrl, directPage: true, cleanup },
  };
}

async function handleClose(request) {
  const cleanup = validateCleanup(request);
  const controlPath = takeRequiredPath(
    "AGENT_BROWSER_EXTENSION_CONTROL_SOCKET",
    "control_unavailable",
  );
  const id = newRequestId();
  const response = await exchangeControl(controlPath, {
    schema: CONTROL_SCHEMA,
    id,
    op: "close",
    cleanup,
  });
  const result = validateControlResult(response, id);
  requireExactKeys(
    result,
    ["status"],
    "control_response_invalid",
  );
  if (result.status !== "closed" && result.status !== "retired-offline") {
    reject("control_response_invalid");
  }
  return { protocol: PLUGIN_PROTOCOL, success: true };
}

export async function handlePluginPayload(value) {
  const payload = validateOuterPayload(value);
  if (payload.type === "browser.launch") return handleLaunch(payload.request);
  return handleClose(payload.request);
}

async function readStdin() {
  const chunks = [];
  let total = 0;
  for await (const chunk of process.stdin) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += bytes.length;
    if (total > MAX_MESSAGE_BYTES) reject("plugin_request_too_large");
    chunks.push(bytes);
  }
  if (total === 0) reject("plugin_request_invalid");
  return decodeJson(Buffer.concat(chunks, total), "plugin_request_invalid");
}

function publicError(error) {
  return error instanceof ProviderFailure ? error.code : "provider_internal_error";
}

function takeDiagnosticPath() {
  const value = process.env.AGENT_BROWSER_PROVIDER_DIAGNOSTIC_PATH;
  delete process.env.AGENT_BROWSER_PROVIDER_DIAGNOSTIC_PATH;
  if (value === undefined) return null;
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    Buffer.byteLength(value, "utf8") > 4_096 ||
    value.includes("\0") ||
    !isAbsolute(value) ||
    resolve(value) !== value
  ) {
    reject("diagnostic_path_invalid");
  }
  return value;
}

async function writeDiagnostic(path, error) {
  if (path === null) return;
  const brokerMatch =
    error instanceof ProviderFailure
      ? /^control_rejected:([A-Z][A-Z0-9_]{2,63})$/.exec(error.diagnostic)
      : null;
  const scope = brokerMatch ? "broker" : "provider";
  const code = brokerMatch
    ? brokerMatch[1]
    : error instanceof ProviderFailure && /^[a-z][a-z0-9_]{2,63}$/.test(error.code)
      ? error.code
      : "provider_internal_error";
  await writeFile(
    path,
    `${canonicalJson({ schema: PROVIDER_FAILURE_SCHEMA, scope, code })}\n`,
    { flag: "wx", mode: 0o600 },
  );
}

async function main() {
  let diagnosticPath = null;
  let response;
  try {
    diagnosticPath = takeDiagnosticPath();
    response = await handlePluginPayload(await readStdin());
  } catch (error) {
    await writeDiagnostic(diagnosticPath, error).catch(() => undefined);
    response = {
      protocol: PLUGIN_PROTOCOL,
      success: false,
      error: publicError(error),
    };
  }
  process.stdout.write(canonicalJson(response));
}

const entryPath = process.argv[1] ? resolve(process.argv[1]) : "";
if (entryPath && fileURLToPath(import.meta.url) === entryPath) {
  await main();
}
