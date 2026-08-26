#!/usr/bin/node

// WHY: the frozen native CLI cannot encode expectPopup. This client sends one
// command only after the exact WSL daemon, socket, source graph, and capability
// are bound. The embedded schema and graph fingerprints keep production bound
// to the reviewed engine/daemon bytes.
import { createHash, randomBytes } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  statSync,
} from "node:fs";
import net from "node:net";
import { isAbsolute, join, normalize, relative } from "node:path";

const EX_USAGE = 64;
const EX_UNAVAILABLE = 69;
const EX_SOFTWARE = 70;
const MAX_RESPONSE_BYTES = 64 * 1024;
const MAX_IDENTITY_BYTES = 8192;
const MAX_MANIFEST_BYTES = 64 * 1024;
const EXPECTED_MANIFEST_SCHEMA = "agent-browser-canonical-dist.v1";
const EXPECTED_MANIFEST_SHA256 =
  "c70aa3a02b1fc00910e378b417739bfe42ac784726d130c2245c22c859bce194";
const EXPECTED_GRAPH_SHA256 =
  "4e3ba63ddd1a71f1e2996fdeea8a873453417c55bc2f1e1d5a1f236ecc5aedcf";
const EXPECTED_GRAPH_FILES = [
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
];

function stableJson(value) {
  if (Array.isArray(value)) return value.map(stableJson);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, stableJson(value[key])]),
    );
  }
  return value;
}

function canonicalJson(value) {
  return JSON.stringify(stableJson(value));
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function sanitize(value) {
  let text = String(value ?? "");
  text = text
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
    .trim();
  return text.slice(0, 1200);
}

function fail(message, code = 1, json = false) {
  const safe = sanitize(message) || "browser command failed";
  if (json) {
    process.stdout.write(
      `${JSON.stringify({ success: false, data: null, error: safe })}\n`,
    );
  } else {
    process.stderr.write(`✗ ${safe}\n`);
  }
  process.exit(code);
}

function takeValue(argv, index, option) {
  if (index + 1 >= argv.length || argv[index + 1] === "") {
    fail(`${option} requires a value`, EX_USAGE);
  }
  return argv[index + 1];
}

const argv = process.argv.slice(2);
let socketRoot = "";
let session = "";
let selector = "";
let runtimeRoot = "";
let runtimeVersion = "";
let manifestPath = "";
let timeoutMs = 10_000;
let jsonOutput = false;
let newTab = false;

process.on("uncaughtException", () => {
  fail("daemon identity preflight failed", EX_SOFTWARE, jsonOutput);
});

for (let index = 0; index < argv.length; index += 1) {
  const arg = argv[index];
  switch (arg) {
    case "--socket-root":
      socketRoot = takeValue(argv, index, arg);
      index += 1;
      break;
    case "--session":
      session = takeValue(argv, index, arg);
      index += 1;
      break;
    case "--selector":
      selector = takeValue(argv, index, arg);
      index += 1;
      break;
    case "--runtime-root":
      runtimeRoot = takeValue(argv, index, arg);
      index += 1;
      break;
    case "--runtime-version":
      runtimeVersion = takeValue(argv, index, arg);
      index += 1;
      break;
    case "--manifest-path":
      manifestPath = takeValue(argv, index, arg);
      index += 1;
      break;
    case "--timeout-ms":
      timeoutMs = Number(takeValue(argv, index, arg));
      index += 1;
      break;
    case "--json":
      jsonOutput = true;
      break;
    case "--new-tab":
      newTab = true;
      break;
    default:
      fail("unsupported internal click-client option", EX_USAGE);
  }
}

if (!isAbsolute(socketRoot) || realpathSync(socketRoot) !== socketRoot) {
  fail("socket root is invalid", EX_USAGE, jsonOutput);
}
if (!isAbsolute(runtimeRoot) || realpathSync(runtimeRoot) !== runtimeRoot) {
  fail("runtime root is invalid", EX_USAGE, jsonOutput);
}
if (
  manifestPath !== join(runtimeRoot, "scripts", "canonical-dist.json") ||
  !isAbsolute(manifestPath)
) {
  fail("canonical manifest path is invalid", EX_USAGE, jsonOutput);
}
if (!runtimeVersion || /[\u0000-\u001f\u007f]/.test(runtimeVersion)) {
  fail("runtime version is invalid", EX_USAGE, jsonOutput);
}
if (!/^[A-Za-z0-9_-]+$/.test(session)) {
  fail("session name is invalid", EX_USAGE, jsonOutput);
}
if (!selector || /[\u0000\r\n]/.test(selector)) {
  fail("click selector is invalid", EX_USAGE, jsonOutput);
}
if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 120_000) {
  fail("command timeout is invalid", EX_USAGE, jsonOutput);
}

const currentUid = process.getuid();

function readOwnedFile(path, maxBytes, requiredMode, allowPublicRead = false) {
  let fd;
  try {
    fd = openSync(
      path,
      constants.O_RDONLY | constants.O_CLOEXEC | constants.O_NOFOLLOW,
    );
    const info = fstatSync(fd, { bigint: true });
    const mode = Number(info.mode & 0o777n);
    if (
      !info.isFile() ||
      info.nlink !== 1n ||
      info.size <= 0n ||
      info.size > BigInt(maxBytes) ||
      (requiredMode !== null && mode !== requiredMode) ||
      (!allowPublicRead && (mode & 0o077) !== 0) ||
      Number(info.uid) !== currentUid
    ) {
      throw new Error("unsafe file");
    }
    return { raw: readFileSync(fd), info };
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

let rootInfo;
try {
  rootInfo = lstatSync(socketRoot);
} catch {
  fail("daemon identity preflight failed", EX_SOFTWARE, jsonOutput);
}
if (
  rootInfo.isSymbolicLink() ||
  !rootInfo.isDirectory() ||
  (rootInfo.mode & 0o777) !== 0o700 ||
  rootInfo.uid !== currentUid
) {
  fail("daemon identity preflight failed", EX_SOFTWARE, jsonOutput);
}

const pidPath = join(socketRoot, `${session}.pid`);
let pidText;
try {
  pidText = readOwnedFile(pidPath, 32, 0o600).raw.toString("utf8").trim();
} catch {
  fail("daemon identity preflight failed", EX_SOFTWARE, jsonOutput);
}
if (!/^[1-9][0-9]*$/.test(pidText)) {
  fail("daemon identity preflight failed", EX_SOFTWARE, jsonOutput);
}
const daemonPid = Number(pidText);
try {
  process.kill(daemonPid, 0);
} catch {
  fail("daemon identity preflight failed", EX_SOFTWARE, jsonOutput);
}

const socketPath = join(socketRoot, `${session}.sock`);
let initialSocketInfo;
try {
  initialSocketInfo = lstatSync(socketPath, { bigint: true });
} catch {
  fail("daemon identity preflight failed", EX_SOFTWARE, jsonOutput);
}
if (
  initialSocketInfo.isSymbolicLink() ||
  !initialSocketInfo.isSocket() ||
  Number(initialSocketInfo.uid) !== currentUid
) {
  fail("daemon identity preflight failed", EX_SOFTWARE, jsonOutput);
}

function processStartTicks(pid) {
  const raw = readFileSync(`/proc/${pid}/stat`, "utf8");
  const commEnd = raw.lastIndexOf(")");
  if (commEnd < 0) throw new Error("invalid proc stat");
  const fields = raw
    .slice(commEnd + 2)
    .trim()
    .split(/\s+/);
  if (!/^[0-9]+$/.test(fields[19] ?? "")) {
    throw new Error("invalid start ticks");
  }
  return fields[19];
}

function processCommandExecutes(pid, sourcePath) {
  const raw = readFileSync(`/proc/${pid}/cmdline`);
  if (raw.length === 0 || raw.length > 64 * 1024) return false;
  const args = raw.toString("utf8").split("\0").filter(Boolean);
  if (args.length < 2 || !isAbsolute(args[1])) return false;
  try {
    if (args[1] === "/proc/self/fd/3") {
      const launched = statSync(`/proc/${pid}/fd/3`, { bigint: true });
      const expected = statSync(sourcePath, { bigint: true });
      return (
        launched.isFile() &&
        launched.dev === expected.dev &&
        launched.ino === expected.ino &&
        launched.size === expected.size
      );
    }
    return realpathSync(args[1]) === sourcePath;
  } catch {
    return false;
  }
}

function readProcBounded(path, maxBytes) {
  const fd = openSync(path, constants.O_RDONLY | constants.O_CLOEXEC);
  const chunks = [];
  let total = 0;
  try {
    for (;;) {
      const chunk = Buffer.alloc(Math.min(16 * 1024, maxBytes + 1 - total));
      const count = readSync(fd, chunk, 0, chunk.length, null);
      if (count === 0) break;
      total += count;
      if (total > maxBytes) throw new Error("proc evidence exceeded limit");
      chunks.push(chunk.subarray(0, count));
    }
    return Buffer.concat(chunks);
  } finally {
    closeSync(fd);
  }
}

function processOwnsSocket(pid, expectedSocketPath) {
  const socketInodes = new Set();
  const table = readProcBounded("/proc/net/unix", 1024 * 1024).toString("utf8");
  for (const line of table.split("\n").slice(1)) {
    const fields = line.trim().split(/\s+/);
    if (
      fields.length >= 8 &&
      fields.slice(7).join(" ") === expectedSocketPath
    ) {
      if (/^[0-9]+$/.test(fields[6])) socketInodes.add(fields[6]);
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
}

function exactKeys(value, expected) {
  return (
    value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).sort().join("\0") === [...expected].sort().join("\0")
  );
}

function validateCanonicalGraph() {
  const manifestFile = readOwnedFile(
    manifestPath,
    MAX_MANIFEST_BYTES,
    null,
    true,
  );
  let manifest;
  try {
    manifest = JSON.parse(manifestFile.raw.toString("utf8"));
  } catch {
    throw new Error("invalid canonical manifest");
  }
  if (
    !exactKeys(manifest, ["schema", "authority", "algorithm", "files"]) ||
    manifest.schema !== EXPECTED_MANIFEST_SCHEMA ||
    sha256(manifestFile.raw) !== EXPECTED_MANIFEST_SHA256 ||
    manifest.authority !== "tracked-dist-js" ||
    manifest.algorithm !== "sha256" ||
    !manifest.files ||
    typeof manifest.files !== "object" ||
    Array.isArray(manifest.files) ||
    canonicalJson(Object.keys(manifest.files)) !==
      canonicalJson(EXPECTED_GRAPH_FILES)
  ) {
    throw new Error("invalid canonical manifest");
  }

  const graph = createHash("sha256");
  for (const expectedPath of EXPECTED_GRAPH_FILES) {
    const expectedHash = manifest.files[expectedPath];
    if (!/^[0-9a-f]{64}$/.test(expectedHash)) {
      throw new Error("invalid canonical graph entry");
    }
    const resolved = join(runtimeRoot, expectedPath);
    if (
      normalize(resolved) !== resolved ||
      relative(runtimeRoot, resolved).startsWith("..")
    ) {
      throw new Error("invalid canonical graph path");
    }
    const file = readOwnedFile(resolved, 4 * 1024 * 1024, null, true);
    if (sha256(file.raw) !== expectedHash) {
      throw new Error("canonical graph mismatch");
    }
    graph.update(expectedPath, "utf8");
    graph.update("\0", "utf8");
    graph.update(expectedHash, "ascii");
    graph.update("\n", "utf8");
  }
  const graphSha256 = graph.digest("hex");
  if (graphSha256 !== EXPECTED_GRAPH_SHA256) {
    throw new Error("untrusted canonical graph fingerprint");
  }
  return { manifestSha256: sha256(manifestFile.raw), graphSha256 };
}

function validateDaemonIdentity() {
  const identityPath = join(socketRoot, `${session}.daemon-identity`);
  const raw = readOwnedFile(identityPath, MAX_IDENTITY_BYTES, 0o600).raw;
  if (
    raw.length === 0 ||
    raw[raw.length - 1] !== 0x0a ||
    raw.subarray(0, raw.length - 1).includes(0x0a)
  ) {
    throw new Error("invalid identity record");
  }
  const text = new TextDecoder("utf-8", { fatal: true }).decode(
    raw.subarray(0, raw.length - 1),
  );
  const fields = text.split("\t");
  if (fields.length !== 21 || fields.some((field) => !field)) {
    throw new Error("invalid identity fields");
  }
  const [
    schema,
    receiptRuntimeVersion,
    protocol,
    capabilities,
    receiptSession,
    receiptPid,
    startTicks,
    uid,
    processExeDev,
    processExeIno,
    receiptSocketRoot,
    socketKind,
    socketEndpoint,
    socketDev,
    socketIno,
    receiptRuntimeRoot,
    canonicalManifestSha256,
    verifiedGraphSha256,
    daemonSourceDev,
    daemonSourceIno,
    daemonSourceSize,
  ] = fields;

  const processExe = statSync(`/proc/${daemonPid}/exe`, { bigint: true });
  const currentSocket = lstatSync(socketPath, { bigint: true });
  const daemonSourcePath = realpathSync(join(runtimeRoot, "dist", "daemon.js"));
  const daemonSource = lstatSync(daemonSourcePath, { bigint: true });
  const graph = validateCanonicalGraph();

  if (
    schema !== "agent-browser-daemon-identity-v2" ||
    receiptRuntimeVersion !== runtimeVersion ||
    protocol !== "jsonl-command-v1" ||
    capabilities !== "click-expect-popup-v1" ||
    receiptSession !== session ||
    receiptPid !== pidText ||
    startTicks !== processStartTicks(daemonPid) ||
    uid !== String(currentUid) ||
    processExeDev !== processExe.dev.toString() ||
    processExeIno !== processExe.ino.toString() ||
    receiptSocketRoot !== socketRoot ||
    socketKind !== "unix" ||
    socketEndpoint !== socketPath ||
    socketDev !== initialSocketInfo.dev.toString() ||
    socketIno !== initialSocketInfo.ino.toString() ||
    currentSocket.dev !== initialSocketInfo.dev ||
    currentSocket.ino !== initialSocketInfo.ino ||
    receiptRuntimeRoot !== runtimeRoot ||
    canonicalManifestSha256 !== graph.manifestSha256 ||
    verifiedGraphSha256 !== graph.graphSha256 ||
    daemonSource.isSymbolicLink() ||
    !daemonSource.isFile() ||
    daemonSourceDev !== daemonSource.dev.toString() ||
    daemonSourceIno !== daemonSource.ino.toString() ||
    daemonSourceSize !== daemonSource.size.toString() ||
    !processCommandExecutes(daemonPid, daemonSourcePath) ||
    !processOwnsSocket(daemonPid, socketPath)
  ) {
    throw new Error("identity mismatch");
  }
}

const id = `wrapper-${randomBytes(12).toString("hex")}`;
const command = {
  id,
  action: "click",
  selector,
  ...(newTab ? { newTab: true } : {}),
  expectPopup: true,
};

const socket = net.createConnection({ path: socketPath });
let responseBuffer = Buffer.alloc(0);
let settled = false;
const timer = setTimeout(() => {
  if (settled) return;
  settled = true;
  socket.destroy();
  fail("browser command timed out", 1, jsonOutput);
}, timeoutMs + 2_000);

function finishError(message, code = 1) {
  if (settled) return;
  settled = true;
  clearTimeout(timer);
  socket.destroy();
  fail(message, code, jsonOutput);
}

socket.on("connect", () => {
  try {
    validateDaemonIdentity();
    const currentSocket = lstatSync(socketPath, { bigint: true });
    if (
      currentSocket.dev !== initialSocketInfo.dev ||
      currentSocket.ino !== initialSocketInfo.ino ||
      !processOwnsSocket(daemonPid, socketPath)
    ) {
      throw new Error("socket producer changed");
    }
  } catch {
    finishError("daemon identity preflight failed", EX_SOFTWARE);
    return;
  }
  socket.write(`${JSON.stringify(command)}\n`);
});

socket.on("data", (chunk) => {
  if (settled) return;
  responseBuffer = Buffer.concat([responseBuffer, chunk]);
  if (responseBuffer.length > MAX_RESPONSE_BYTES) {
    finishError("browser response exceeded the safe limit");
    return;
  }
  const newline = responseBuffer.indexOf(0x0a);
  if (newline >= 0) {
    if (newline !== responseBuffer.length - 1) {
      finishError("browser returned an invalid response envelope");
      return;
    }
    renderCompleteResponse();
  }
});

function renderCompleteResponse() {
  if (
    responseBuffer.length === 0 ||
    responseBuffer.at(-1) !== 0x0a ||
    responseBuffer.subarray(0, -1).includes(0x0a)
  ) {
    finishError("browser returned an invalid response envelope");
    return;
  }

  let response;
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(
      responseBuffer.subarray(0, -1),
    );
    response = JSON.parse(text);
  } catch {
    finishError("browser returned an invalid response");
    return;
  }
  if (
    !response ||
    typeof response !== "object" ||
    Array.isArray(response) ||
    response.id !== id ||
    typeof response.success !== "boolean"
  ) {
    finishError("browser returned a mismatched response");
    return;
  }
  if (
    response.success &&
    (!response.data ||
      typeof response.data !== "object" ||
      Array.isArray(response.data) ||
      response.data.popupTracking !== "event-armed-v1")
  ) {
    finishError("browser did not acknowledge atomic popup tracking");
    return;
  }

  settled = true;
  clearTimeout(timer);
  socket.destroy();
  if (!response.success) {
    fail(
      typeof response.error === "string" && response.error
        ? response.error
        : "browser click failed",
      1,
      jsonOutput,
    );
  }
  if (jsonOutput) {
    process.stdout.write(
      `${JSON.stringify({ success: true, data: stableJson(response.data), error: null })}\n`,
    );
  } else {
    process.stdout.write("✓ Done [popupTracking=event-armed-v1]\n");
  }
}

socket.on("error", () => {
  finishError("browser session connection failed", EX_UNAVAILABLE);
});

socket.on("end", () => {
  if (!settled) renderCompleteResponse();
});
