import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

const sourceRoot = resolve(".");
const graphFiles = [
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

let fixtureRoot;
let fixtureRepo;
let wrapper;
let stateRoot;
let controllerRoot;
let controls;
let tracePath;
let snapshotPath;
let nativeHome;
let port;
let transportProcess;
let endpointId;
let brokerToken;
let currentAuthority;

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, stable(value[key])]),
    );
  }
  return value;
}

function canonical(value) {
  return JSON.stringify(stable(value));
}

function graphFingerprint(files) {
  const graph = createHash("sha256");
  for (const path of graphFiles) {
    graph.update(path, "utf8");
    graph.update("\0", "utf8");
    graph.update(files[path], "ascii");
    graph.update("\n", "utf8");
  }
  return graph.digest("hex");
}

function executable(path, body) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, body, "utf8");
  chmodSync(path, 0o755);
  return path;
}

function patchExact(text, before, after) {
  expect(text, `fixture patch missing: ${before}`).toContain(before);
  return text.replace(before, after);
}

async function unusedPort() {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const selected = server.address().port;
      server.close(() => resolvePort(selected));
    });
  });
}

function waitFor(path, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(path)) return;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
  }
  throw new Error(`fixture did not become ready: ${path}`);
}

function waitUntil(predicate, label, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
  }
  throw new Error(`fixture did not reach ${label}`);
}

function control(name, value = "") {
  writeFileSync(join(controls, name), String(value), "utf8");
}

function trace() {
  try {
    return readFileSync(tracePath, "utf8");
  } catch {
    return "";
  }
}

function traceCount(needle) {
  return trace().split(needle).length - 1;
}

function hostileEnv(extra = {}) {
  return {
    ...process.env,
    PATH: join(fixtureRoot, "attacker-path"),
    AGENT_BROWSER_WRAPPER_TEST_MODE: "1",
    AGENT_BROWSER_NATIVE_BIN: join(fixtureRoot, "attacker-native"),
    AGENT_BROWSER_START_CHROME_DEBUG_BIN: join(fixtureRoot, "attacker-starter"),
    AGENT_BROWSER_BROWSER_RUNTIME_BIN: join(fixtureRoot, "attacker-controller"),
    AGENT_BROWSER_CHROME_PROFILE_ATTESTATION_PATH: join(
      fixtureRoot,
      "attacker-attestation",
    ),
    AGENT_BROWSER_SOCKET_DIR: join(fixtureRoot, "attacker-sockets"),
    AGENT_BROWSER_SESSION: "attacker-session",
    AGENT_BROWSER_ACCOUNT: "erebora",
    AGENT_BROWSER_STREAM_PORT: "65535",
    AGENT_BROWSER_PROXY: "http://attacker.invalid",
    HTTP_PROXY: "http://attacker.invalid",
    HTTPS_PROXY: "http://attacker.invalid",
    ALL_PROXY: "socks5://attacker.invalid",
    NO_PROXY: "*",
    AGENT_BROWSER_USER_AGENT: "attacker-agent",
    AGENT_BROWSER_ALLOW_FILE_ACCESS: "1",
    AGENT_BROWSER_PROFILE: "/tmp/attacker-profile",
    AGENT_BROWSER_STATE: "/tmp/attacker-state",
    AGENT_BROWSER_EXECUTABLE_PATH: "/tmp/attacker-browser",
    AGENT_BROWSER_EXTENSIONS: "/tmp/attacker-extension",
    AGENT_BROWSER_ARGS: "--attacker",
    AGENT_BROWSER_PROVIDER: "attacker",
    AGENT_BROWSER_AUTO_CONNECT: "1",
    AGENT_BROWSER_CONFIG: "/tmp/attacker-config",
    AGENT_BROWSER_HEADED: "1",
    AGENT_BROWSER_TARGET_RECEIPT: '{"forged":true}',
    AGENT_BROWSER_TARGET_CLAIM_PATH: "/tmp/forged-claim",
    AGENT_BROWSER_BROKER_AUTHORIZATION: "Bearer FORGED",
    AGENT_BROWSER_BROKER_ENDPOINT: "http://127.0.0.1:1",
    AGENT_BROWSER_ATTACH_EXISTING_URL:
      "https://user:pass@example.invalid/?token=secret#fragment",
    NODE_OPTIONS: "--no-warnings",
    ...extra,
  };
}

function run(args, extraEnv = {}, cwd = undefined) {
  return spawnSync(wrapper, args, {
    encoding: "utf8",
    env: hostileEnv(extraEnv),
    ...(cwd ? { cwd } : {}),
    timeout: 10_000,
  });
}

function workspaceInvocation(args, authority = currentAuthority) {
  if (!authority) throw new Error("fixture workspace authority is unavailable");
  const sessionIndex = args.indexOf("--session");
  const session = sessionIndex >= 0 ? args[sessionIndex + 1] : "";
  const accountIndex = args.indexOf("--account");
  const account =
    accountIndex >= 0 &&
    String(args[accountIndex + 1]).toLowerCase() === "erebora"
      ? "erebora"
      : "caleb";
  const commands = new Set([
    "open",
    "navigate",
    "snapshot",
    "click",
    "eval",
    "screenshot",
  ]);
  const commandIndex = args.findIndex((value) => commands.has(value));
  if (!session || commandIndex < 0)
    throw new Error("fixture invocation is invalid");
  const lease = pendingLease(session, authority, account);
  return {
    args: [
      ...args.slice(0, commandIndex),
      "--target-lease",
      lease.path,
      ...args.slice(commandIndex),
    ],
    lease,
  };
}

function runWorkspace(
  args,
  extraEnv = {},
  cwd = undefined,
  authority = currentAuthority,
) {
  if (!authority) throw new Error("fixture workspace authority is unavailable");
  return run(args, extraEnv, cwd);
}

function endpointDirectory() {
  return join(controllerRoot, "endpoints", endpointId);
}

function fixtureBrowserGeneration(chrome) {
  return sha256(
    Buffer.from(
      canonical({
        pid: chrome.pid,
        startedAtUtc: chrome.startedAtUtc,
        executablePath: chrome.executablePath,
        executableSha256: chrome.executableSha256,
        version: chrome.version,
        userDataRoot: chrome.userDataRoot,
      }),
    ),
  );
}

function writeAttestation(overrides = {}) {
  const browserStart = `${new Date(Date.now() - 10_000)
    .toISOString()
    .slice(0, -1)}0000Z`;
  const browserPid = transportProcess.pid + 1000;
  const chromeProof = {
    observation: "windows-tcp-cim-file-version-devtools-active-port",
    pid: browserPid,
    startedAtUtc: browserStart,
    executablePath:
      "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    executableSha256: "d".repeat(64),
    version: "Chrome/151.0.0.0",
    userDataRoot:
      "C:\\Users\\Kaleeb\\AppData\\Local\\Google\\Chrome\\User Data",
    listener: { address: "127.0.0.1", port: 9222, owningPid: browserPid },
    browserGeneration: "0".repeat(64),
  };
  chromeProof.browserGeneration = fixtureBrowserGeneration(chromeProof);
  const brokerGeneration = "b".repeat(64);
  const transportGeneration = "f".repeat(64);
  const consentGeneration = "c".repeat(64);
  const producerContractPath = join(
    endpointDirectory(),
    "broker-authority",
    "producer-contract.json",
  );
  const producerContractSha256 = sha256("fixture-broker-producer-v1");
  const snapshot = {
    schema: "agent-browser.transport-proof-state.v1",
    observedAtMs: Date.now(),
    maxAgeMs: 5000,
    helperRevision: "fixture-helper-v2",
    chrome: chromeProof,
    portproxy: {
      observation: "netsh-portproxy-cim-net-ip-address",
      pid: browserPid + 1,
      startedAtUtc: `${new Date(Date.now() - 20_000)
        .toISOString()
        .slice(0, -1)}0000Z`,
      executablePath: "C:\\Windows\\System32\\svchost.exe",
      service: "iphlpsvc",
      listen: { address: "172.29.48.1", port: 9222 },
      connect: { address: "127.0.0.1", port: 9222 },
      adapter: {
        interfaceIndex: 42,
        name: "vEthernet (WSL)",
        description: "Hyper-V Virtual Ethernet Adapter",
        address: "172.29.48.1",
        prefixLength: 20,
        networkCategory: null,
        scope: "wsl-hyper-v-internal",
      },
    },
    socat: {
      observation: "proc-ss",
      pid: transportProcess.pid + 2,
      startTicks: "100",
      executablePath: "/usr/bin/socat",
      executableSha256: "e".repeat(64),
      listen: { address: "127.0.0.1", port: 9222 },
      connect: { address: "172.29.48.1", port: 9222 },
    },
    broker: {
      observation: "immutable-contract-proc-ss-authenticated-health",
      pid: transportProcess.pid,
      startTicks: "200",
      executablePath: "/fixture/raw-cdp-broker",
      sourcePath: "/fixture/raw-cdp-broker.js",
      sourceSha256: "1".repeat(64),
      listen: { address: "127.0.0.1", port },
      brokerGeneration,
      browserGeneration: chromeProof.browserGeneration,
      consentGeneration,
      transportGeneration,
      producerContractPath,
      producerContractSha256,
    },
  };
  mkdirSync(dirname(snapshotPath), { recursive: true, mode: 0o700 });
  writeFileSync(snapshotPath, JSON.stringify(snapshot), { mode: 0o600 });
  chmodSync(snapshotPath, 0o600);
  const attestation = {
    schema: "agent-browser.supported-existing-transport-attestation.v1",
    ok: true,
    status: "attested",
    controllerEndpointId: endpointId,
    browserGeneration: chromeProof.browserGeneration,
    brokerGeneration,
    consentGeneration,
    transportGeneration,
    brokerCdpWebSocketUrl: `ws://127.0.0.1:${port}/cdp/${transportGeneration}`,
    brokerHealthUrl: `http://127.0.0.1:${port}/healthz/${transportGeneration}`,
    brokerProducerContractPath: producerContractPath,
    brokerProducerContractSha256: producerContractSha256,
    transportProofStatePath: snapshotPath,
    transportProofStateSha256: sha256(readFileSync(snapshotPath)),
    transportProofObservedAtMs: snapshot.observedAtMs,
    ...overrides,
  };
  const authDirectory = join(endpointDirectory(), "broker-auth");
  mkdirSync(authDirectory, { recursive: true, mode: 0o700 });
  for (
    let current = authDirectory;
    current.startsWith(controllerRoot) && current !== dirname(controllerRoot);
    current = dirname(current)
  ) {
    chmodSync(current, 0o700);
    if (current === controllerRoot) break;
  }
  writeFileSync(
    join(controls, "attestation.json"),
    JSON.stringify(attestation),
    {
      mode: 0o600,
    },
  );
  writeFileSync(
    join(controls, "health.json"),
    JSON.stringify({
      schema: "agent-browser.cdp-broker-health.v1",
      brokerGeneration: attestation.brokerGeneration,
      browserGeneration: attestation.browserGeneration,
      consentGeneration: attestation.consentGeneration,
      transportGeneration: attestation.transportGeneration,
      state: "ready",
      reconnectRequired: false,
      lossReason: null,
      uptimeMs: 1000,
      upstreamConnectionAttempts: 1,
      upstreamSocketOpen: true,
      clients: 1,
      sessions: 1,
      pendingClientRequests: 0,
      pendingInternalRequests: 0,
      configuredClientLeases: 1,
      limits: Object.fromEntries(
        [
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
        ].map((key) => [key, 100]),
      ),
    }),
    "utf8",
  );
  currentAuthority = {
    attestation,
    browserGeneration: attestation.browserGeneration,
    transportGeneration: attestation.transportGeneration,
  };
  return currentAuthority;
}

function refreshTransportProof() {
  const snapshot = JSON.parse(readFileSync(snapshotPath, "utf8"));
  snapshot.observedAtMs = Date.now();
  writeFileSync(snapshotPath, JSON.stringify(snapshot), { mode: 0o600 });
  chmodSync(snapshotPath, 0o600);
  const attestationPath = join(controls, "attestation.json");
  const attestation = JSON.parse(readFileSync(attestationPath, "utf8"));
  attestation.transportProofStateSha256 = sha256(readFileSync(snapshotPath));
  attestation.transportProofObservedAtMs = snapshot.observedAtMs;
  writeFileSync(attestationPath, JSON.stringify(attestation), { mode: 0o600 });
  if (currentAuthority) currentAuthority.attestation = attestation;
}

function binding(session = "task") {
  return readFileSync(join(stateRoot, `session-${session}.account`), "utf8");
}

function grantForeground(session) {
  const acquired = run(["--session", session, "foreground"]);
  if (acquired.status !== 0) {
    throw new Error(`foreground acquisition failed: ${acquired.stderr}`);
  }
  const path = join(stateRoot, `session-${session}.focus-lease`);
  const focus = JSON.parse(readFileSync(path, "utf8"));
  return { focus, path };
}

function pendingLease(
  session,
  authority,
  account = "caleb",
  nonce = randomNonce(),
  leaseKind = "registered-workspace",
) {
  const profile = account === "erebora" ? "Profile 1" : "Default";
  const accountEmail =
    account === "erebora"
      ? "ereboracrew@gmail.com"
      : "calebdanemusic@gmail.com";
  const pending = join(endpointDirectory(), "target-leases", "pending");
  const consumedLeases = join(endpointDirectory(), "target-leases", "consumed");
  const metadataRoot = join(
    endpointDirectory(),
    "target-leases",
    "controller-metadata",
  );
  const daemonConsumed = join(
    endpointDirectory(),
    "target-leases",
    "daemon-consumed",
  );
  for (const path of [
    join(endpointDirectory(), "target-leases"),
    pending,
    consumedLeases,
    metadataRoot,
    daemonConsumed,
  ]) {
    mkdirSync(path, { recursive: true, mode: 0o700 });
    chmodSync(path, 0o700);
  }
  const now = Date.now();
  const brokerAuthorizationLeaseId = sha256(`broker-auth:${nonce}`);
  const brokerAuthorizationPath = join(
    endpointDirectory(),
    "broker-auth",
    `${brokerAuthorizationLeaseId}.authorization`,
  );
  const authorization = `Authorization: Bearer ${authority.transportGeneration}.${brokerAuthorizationLeaseId}.${brokerToken}\n`;
  mkdirSync(dirname(brokerAuthorizationPath), { recursive: true, mode: 0o700 });
  chmodSync(dirname(brokerAuthorizationPath), 0o700);
  writeFileSync(brokerAuthorizationPath, authorization, { mode: 0o600 });
  chmodSync(brokerAuthorizationPath, 0o600);
  const profileBinding =
    account === "erebora" ? "e".repeat(64) : "a".repeat(64);
  const persistentWorkspace = [
    "registered-workspace",
    "persistent-workspace",
  ].includes(leaseKind);
  const claimKind = persistentWorkspace
    ? "persistent-workspace"
    : "user-adopted";
  const targetKind = persistentWorkspace
    ? "agent-workspace"
    : "user-collaboration";
  const receipt = {
    schema: "agent-browser.target-lease.v1",
    session,
    targetId: "fixture-target-id",
    targetKind,
    browserContextId: `fixture-context-${account}`,
    profileBinding,
    profileDirectory: profile,
    accountEmail,
    browserGeneration: authority.browserGeneration,
    transportGeneration: authority.transportGeneration,
    leaseId: brokerAuthorizationLeaseId,
    workspaceMarkerUrl: persistentWorkspace
      ? `about:blank#agent-browser-workspace-${profileBinding}`
      : null,
    nonce,
    issuedAt: now - 100,
    expiresAt: now + 20_000,
  };
  const envelope = {
    schema: "agent-browser.target-claim-envelope.v2",
    receipt,
  };
  const metadata = {
    schema: "agent-browser.target-receipt-metadata.v1",
    receipt,
    port: 9222,
    runtimeFingerprint: sha256(`runtime:${nonce}`),
    browserGeneration: authority.browserGeneration,
    transportGeneration: authority.transportGeneration,
    provenanceKey: sha256(`provenance:${nonce}`),
    controllerIdentity: sha256("fixture-controller"),
    claimKind,
    account,
    profileDirectory: profile,
    browserContextId: `fixture-context-${account}`,
    profileBinding,
    brokerLeaseId: brokerAuthorizationLeaseId,
    brokerAuthFilePath: brokerAuthorizationPath,
    brokerAuthFileSha256: sha256(Buffer.from(authorization)),
    brokerCdpWebSocketUrl: `ws://127.0.0.1:${port}/cdp/${authority.transportGeneration}`,
    brokerHealthUrl: `http://127.0.0.1:${port}/healthz/${authority.transportGeneration}`,
    consentGeneration: authority.attestation.consentGeneration,
    brokerProducerContractSha256: sha256("fixture-broker-producer-v1"),
    brokerCapabilityExpiresAt: new Date(now + 60 * 60_000).toISOString(),
  };
  const path = join(pending, `${nonce}.json`);
  const metadataPath = join(metadataRoot, `${nonce}.json`);
  writeFileSync(path, JSON.stringify(envelope), { mode: 0o600 });
  chmodSync(path, 0o600);
  writeFileSync(metadataPath, JSON.stringify(metadata), { mode: 0o600 });
  chmodSync(metadataPath, 0o600);
  const lease = {
    receipt,
    browserGeneration: receipt.browserGeneration,
    brokerGeneration: authority.attestation.brokerGeneration,
    transportGeneration: receipt.transportGeneration,
    account,
    profile,
    accountEmail,
    browserContextId: receipt.browserContextId,
    targetKind,
    profileBinding,
    leaseKind: claimKind,
    brokerAuthorizationLeaseId,
    brokerAuthorizationPath,
    brokerAuthorizationSha256: metadata.brokerAuthFileSha256,
  };
  return {
    path,
    metadataPath,
    receipt,
    envelope,
    metadata,
    lease,
    nonce,
    authorization,
  };
}

let nonceCounter = 0;
function randomNonce() {
  nonceCounter += 1;
  return nonceCounter.toString(16).padStart(64, "0");
}

function transportServerSource() {
  return `#!/usr/bin/node
import http from "node:http";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
const controls = ${JSON.stringify(controls)};
const trace = ${JSON.stringify(tracePath)};
const ready = ${JSON.stringify(join(fixtureRoot, "transport.ready"))};
const brokerAuthRoot = ${JSON.stringify(join(endpointDirectory(), "broker-auth"))};
const port = ${port};
const server = http.createServer((request, response) => {
  appendFileSync(trace, "transport=" + request.url + "\\n");
  response.setHeader("content-type", "application/json");
  response.setHeader("cache-control", "no-store");
  const auth = request.headers.authorization || "";
  const match = auth.match(/^Bearer [0-9a-f]{64}\\.([0-9a-f]{64})\\.[A-Za-z0-9_-]{43}$/);
  let expected = "";
  try {
    expected = readFileSync(join(brokerAuthRoot, (match?.[1] || "invalid") + ".authorization"), "utf8")
      .trim()
      .slice("Authorization: ".length);
  } catch {}
  if (!match || auth !== expected) {
    response.statusCode = 401;
    response.end("{}");
  } else if (request.url === "/healthz/" + ${JSON.stringify("f".repeat(64))}) {
    response.end(readFileSync(controls + "/health.json", "utf8"));
  } else {
    response.statusCode = 404;
    response.end("{}");
  }
});
server.listen(port, "127.0.0.1", () => writeFileSync(ready, String(process.pid)));
process.on("SIGTERM", () => server.close(() => process.exit(0)));
`;
}

function daemonSource() {
  return `#!/usr/bin/node
import { createHash } from "node:crypto";
import { appendFileSync, chmodSync, existsSync, lstatSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import net from "node:net";
import { dirname, join } from "node:path";
const socketRoot = process.env.AGENT_BROWSER_SOCKET_DIR;
const session = process.env.AGENT_BROWSER_SESSION;
const manifestPath = process.env.AGENT_BROWSER_CANONICAL_DIST_MANIFEST;
const trace = ${JSON.stringify(tracePath)};
const controls = ${JSON.stringify(controls)};
const socketPath = join(socketRoot, session + ".sock");
const pidPath = join(socketRoot, session + ".pid");
const identityPath = join(socketRoot, session + ".daemon-identity");
const sourcePath = realpathSync(process.argv[1]);
const sha = (value) => createHash("sha256").update(value).digest("hex");
const wait = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const canonical = (value) => {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  return "{" + Object.keys(value).sort().map((key) => JSON.stringify(key) + ":" + canonical(value[key])).join(",") + "}";
};
const receiptRaw = process.env.AGENT_BROWSER_TARGET_RECEIPT || "";
const claimPath = process.env.AGENT_BROWSER_TARGET_CLAIM_PATH || "";
const brokerAuthorization = process.env.AGENT_BROWSER_BROKER_AUTHORIZATION || "";
const forbiddenPrivateEnv = [
  "AGENT_BROWSER_BROKER_AUTHORIZATION_LEASE_ID",
  "AGENT_BROWSER_BROKER_AUTHORIZATION_PATH",
  "AGENT_BROWSER_BROKER_AUTHORIZATION_SHA256",
  "AGENT_BROWSER_TARGET_ACCOUNT",
  "AGENT_BROWSER_TARGET_PROFILE",
  "AGENT_BROWSER_TARGET_PROFILE_BINDING",
  "AGENT_BROWSER_TARGET_BROWSER_CONTEXT_ID",
  "AGENT_BROWSER_TARGET_LEASE_KIND",
];
let receipt;
let envelope;
try {
  receipt = JSON.parse(receiptRaw);
  envelope = JSON.parse(readFileSync(claimPath, "utf8"));
} catch {
  process.exit(73);
}
const receiptKeys = [
  "accountEmail", "browserContextId", "browserGeneration", "expiresAt", "issuedAt",
  "leaseId", "nonce", "profileBinding", "profileDirectory", "schema", "session",
  "targetId", "targetKind", "transportGeneration", "workspaceMarkerUrl",
].sort();
const authMatch = brokerAuthorization.match(/^Bearer ([0-9a-f]{64})\.([0-9a-f]{64})\.([A-Za-z0-9_-]{43})$/);
const receiptNow = Date.now();
if (
  Object.keys(receipt).sort().join("\\0") !== receiptKeys.join("\\0") ||
  receipt.schema !== "agent-browser.target-lease.v1" ||
  receipt.session !== session ||
  !["agent-workspace", "user-collaboration"].includes(receipt.targetKind) ||
  !receipt.browserContextId ||
  !/^[0-9a-f]{64}$/.test(receipt.profileBinding) ||
  !/^[0-9a-f]{64}$/.test(receipt.browserGeneration) ||
  !/^[0-9a-f]{64}$/.test(receipt.transportGeneration) ||
  !/^[0-9a-f]{64}$/.test(receipt.leaseId) ||
  !Number.isSafeInteger(receipt.issuedAt) ||
  !Number.isSafeInteger(receipt.expiresAt) ||
  receipt.issuedAt > receiptNow + 5000 ||
  receipt.expiresAt <= receiptNow ||
  receipt.expiresAt - receipt.issuedAt > 30_000 ||
  Object.keys(envelope).sort().join("\\0") !== "receipt\\0schema" ||
  envelope.schema !== "agent-browser.target-claim-envelope.v2" ||
  canonical(envelope.receipt) !== canonical(receipt) ||
  claimPath !== join(dirname(dirname(claimPath)), "consumed", receipt.nonce + ".json") ||
  !authMatch || authMatch[1] !== receipt.transportGeneration || authMatch[2] !== receipt.leaseId ||
  forbiddenPrivateEnv.some((name) => process.env[name] !== undefined)
) {
  process.exit(73);
}
const brokerAuthorizationSha256 = sha(brokerAuthorization);
delete process.env.AGENT_BROWSER_BROKER_AUTHORIZATION;
delete process.env.AGENT_BROWSER_TARGET_RECEIPT;
delete process.env.AGENT_BROWSER_TARGET_CLAIM_PATH;
appendFileSync(trace, "daemon-contract=accepted\\n");
function startTicks(pid) {
  const raw = readFileSync("/proc/" + pid + "/stat", "utf8");
  return raw.slice(raw.lastIndexOf(")") + 2).trim().split(/\\s+/)[19];
}
function cleanup() {
  for (const path of [socketPath, pidPath, identityPath]) {
    try { rmSync(path); } catch {}
  }
}
cleanup();
const server = net.createServer((connection) => {
  let buffer = "";
  connection.on("data", (chunk) => {
    buffer += chunk.toString("utf8");
    const newline = buffer.indexOf("\\n");
    if (newline < 0) return;
    const request = JSON.parse(buffer.slice(0, newline));
    appendFileSync(trace, "popup-request=" + JSON.stringify(request) + "\\n");
    let response;
    if (request.selector === "@error") {
      response = { id: request.id, success: false, error: "\\u001b[31mAuthorization: Bearer POPSECRET https://user:pass@example.test/p?q=TOKEN#fragment\\u001b[0m" };
    } else if (request.selector === "@unacked") {
      response = { id: request.id, success: true, data: { clicked: true } };
    } else {
      response = { id: request.id, success: true, data: { clicked: true, popupTracking: "event-armed-v1" } };
    }
    connection.write(JSON.stringify(response) + "\\n");
  });
});
server.listen(socketPath, () => {
  writeFileSync(pidPath, String(process.pid) + "\\n", { mode: 0o600 });
  chmodSync(pidPath, 0o600);
  const identityDelayPath = join(controls, "daemon-identity-delay-ms");
  if (existsSync(identityDelayPath)) {
    const delayMs = Number(readFileSync(identityDelayPath, "utf8"));
    if (Number.isInteger(delayMs) && delayMs > 0 && delayMs <= 1000) wait(delayMs);
  }
  const manifestRaw = readFileSync(manifestPath);
  if (sha(manifestRaw) !== process.env.AGENT_BROWSER_EXPECTED_CANONICAL_DIST_MANIFEST_SHA256) process.exit(72);
  const manifest = JSON.parse(manifestRaw.toString("utf8"));
  const graph = createHash("sha256");
  for (const path of Object.keys(manifest.files)) {
    graph.update(path, "utf8");
    graph.update("\\0", "utf8");
    graph.update(manifest.files[path], "ascii");
    graph.update("\\n", "utf8");
  }
  const processExe = statSync("/proc/" + process.pid + "/exe", { bigint: true });
  const socket = lstatSync(socketPath, { bigint: true });
  const source = lstatSync(sourcePath, { bigint: true });
  const fields = [
    "agent-browser-daemon-identity-v2",
    "0.13.0",
    "jsonl-command-v1",
    "click-expect-popup-v1",
    session,
    String(process.pid),
    startTicks(process.pid),
    String(process.getuid()),
    processExe.dev.toString(),
    processExe.ino.toString(),
    socketRoot,
    "unix",
    socketPath,
    socket.dev.toString(),
    socket.ino.toString(),
    ${JSON.stringify(fixtureRepo)},
    sha(manifestRaw),
    graph.digest("hex"),
    source.dev.toString(),
    source.ino.toString(),
    source.size.toString(),
  ];
  writeFileSync(identityPath, fields.join("\\t") + "\\n", { mode: 0o600 });
  chmodSync(identityPath, 0o600);
  appendFileSync(trace, "daemon-transport=" + JSON.stringify({
    webSocketUrl: process.env.AGENT_BROWSER_BROKER_WEBSOCKET_URL || "",
    brokerGeneration: process.env.AGENT_BROWSER_BROKER_GENERATION || "",
    browserGeneration: process.env.AGENT_BROWSER_BROWSER_GENERATION || "",
    transportGeneration: process.env.AGENT_BROWSER_TRANSPORT_GENERATION || "",
    authorizationHeaderSha256: brokerAuthorizationSha256,
    authorizationLeaseId: process.env.AGENT_BROWSER_BROKER_AUTHORIZATION_LEASE_ID || "",
    authorizationPath: process.env.AGENT_BROWSER_BROKER_AUTHORIZATION_PATH || "",
    authorizationSha256: process.env.AGENT_BROWSER_BROKER_AUTHORIZATION_SHA256 || "",
    targetAccount: process.env.AGENT_BROWSER_TARGET_ACCOUNT || "",
    targetProfile: process.env.AGENT_BROWSER_TARGET_PROFILE || "",
    profileBinding: process.env.AGENT_BROWSER_TARGET_PROFILE_BINDING || "",
    browserContextId: process.env.AGENT_BROWSER_TARGET_BROWSER_CONTEXT_ID || "",
    targetLeaseKind: process.env.AGENT_BROWSER_TARGET_LEASE_KIND || "",
    claim: claimPath,
    secretDeleted: process.env.AGENT_BROWSER_BROKER_AUTHORIZATION === undefined,
    receiptDeleted: process.env.AGENT_BROWSER_TARGET_RECEIPT === undefined,
    claimDeleted: process.env.AGENT_BROWSER_TARGET_CLAIM_PATH === undefined,
  }) + "\\n");
  appendFileSync(trace, "daemon-start=" + session + "\\n");
});
let stopping = false;
function stop() {
  if (stopping) return;
  stopping = true;
  const delayPath = join(controls, "daemon-stop-delay-ms");
  if (existsSync(delayPath)) {
    const delayMs = Number(readFileSync(delayPath, "utf8"));
    if (Number.isInteger(delayMs) && delayMs > 0 && delayMs <= 5000) wait(delayMs);
  }
  server.close(() => { cleanup(); process.exit(0); });
}
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
`;
}

function nativeHelperSource() {
  return `#!/usr/bin/node
import { createHash } from "node:crypto";
import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
const rawArgs = process.argv.slice(2);
const configIndex = rawArgs.indexOf("--config");
const configPath = configIndex >= 0 ? rawArgs[configIndex + 1] : "";
let config = "";
try { config = readFileSync(configPath, "utf8"); } catch {}
const args = configIndex >= 0
  ? rawArgs.filter((_, index) => index !== configIndex && index !== configIndex + 1)
  : rawArgs;
const stateRoot = ${JSON.stringify(stateRoot)};
const controls = ${JSON.stringify(controls)};
const trace = ${JSON.stringify(tracePath)};
const wait = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
appendFileSync(trace, "native=" + JSON.stringify({
  args,
  configPath,
  config,
  home: process.env.HOME || "",
  cwd: process.cwd(),
  email: process.env.AGENT_BROWSER_CHROME_PROFILE_EMAIL || "",
  profile: process.env.AGENT_BROWSER_CHROME_PROFILE_DIRECTORY || "",
  socket: process.env.AGENT_BROWSER_SOCKET_DIR || "",
  forgedNative: process.env.AGENT_BROWSER_NATIVE_BIN || "",
  testMode: process.env.AGENT_BROWSER_WRAPPER_TEST_MODE || "",
  proxy: process.env.AGENT_BROWSER_PROXY || "",
  attach: process.env.AGENT_BROWSER_ATTACH_EXISTING_URL || "",
  receipt: process.env.AGENT_BROWSER_TARGET_RECEIPT || "",
  claim: process.env.AGENT_BROWSER_TARGET_CLAIM_PATH || "",
  authorizationHeaderSha256: createHash("sha256").update(process.env.AGENT_BROWSER_BROKER_AUTHORIZATION || "").digest("hex"),
  authorizationLeaseId: process.env.AGENT_BROWSER_BROKER_AUTHORIZATION_LEASE_ID || "",
  authorizationPath: process.env.AGENT_BROWSER_BROKER_AUTHORIZATION_PATH || "",
  authorizationSha256: process.env.AGENT_BROWSER_BROKER_AUTHORIZATION_SHA256 || "",
  sessionName: process.env.AGENT_BROWSER_SESSION_NAME || "",
}) + "\\n");
if (args.length === 1 && args[0] === "--version") {
  process.stdout.write("agent-browser 0.13.0\\n");
  process.exit(0);
}
const sessionIndex = args.indexOf("--session");
const session = sessionIndex >= 0 ? args[sessionIndex + 1] : "";
const command = sessionIndex >= 0 ? args[sessionIndex + 2] : "";
const socketPath = join(stateRoot, session + ".sock");
const pidPath = join(stateRoot, session + ".pid");
const identityPath = join(stateRoot, session + ".daemon-identity");
if (command === "close") {
  if (existsSync(pidPath)) {
    const pid = Number(readFileSync(pidPath, "utf8").trim());
    try { process.kill(pid, "SIGTERM"); } catch {}
    for (let i = 0; i < 100 && existsSync(socketPath); i += 1) wait(10);
  }
  appendFileSync(trace, "native-close=" + session + "\\n");
  process.exit(0);
}
const statusPath = join(controls, "native-status");
const status = existsSync(statusPath) ? Number(readFileSync(statusPath, "utf8")) : 0;
if (status) process.exit(status);
if (!(existsSync(socketPath) && existsSync(pidPath) && existsSync(identityPath))) {
  appendFileSync(trace, "native-before-daemon-attestation=" + session + "\\n");
  process.exit(71);
}
const claim = process.env.AGENT_BROWSER_TARGET_CLAIM_PATH || "";
if (claim) {
  const publicReceipt = JSON.parse(process.env.AGENT_BROWSER_TARGET_RECEIPT);
  const targetDir = join(dirname(dirname(claim)), "daemon-consumed", publicReceipt.nonce);
  mkdirSync(targetDir, { mode: 0o700 });
  chmodSync(targetDir, 0o700);
  const tombstone = join(targetDir, "receipt.json");
  renameSync(claim, tombstone);
  chmodSync(tombstone, 0o600);
}
if (existsSync(join(controls, "cache-write-failure"))) {
  const cache = join(stateRoot, "supported-existing-transport.receipt");
  mkdirSync(cache, { mode: 0o700 });
  chmodSync(cache, 0o700);
}
process.exit(0);
`;
}

function controllerHelperSource() {
  return `#!/usr/bin/node
import { createHash, randomBytes } from "node:crypto";
import { appendFileSync, chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
const args = process.argv.slice(2);
const trace = ${JSON.stringify(tracePath)};
const controls = ${JSON.stringify(controls)};
const stateRoot = ${JSON.stringify(stateRoot)};
const value = (name) => args[args.indexOf(name) + 1];
const wait = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
appendFileSync(trace, "controller=" + JSON.stringify(args) + "\\n");
if (args[0] === "ensure-supported-existing-transport") {
  const nextFailurePath = join(controls, "next-ensure-failure.json");
  if (existsSync(nextFailurePath)) {
    const diagnostic = readFileSync(nextFailurePath, "utf8");
    rmSync(nextFailurePath);
    process.stderr.write(diagnostic);
    process.exit(1);
  }
  const injectedStatusPath = join(controls, "controller-injected-status");
  if (existsSync(injectedStatusPath)) {
    const stdoutPath = join(controls, "controller-injected-stdout");
    const stderrPath = join(controls, "controller-injected-stderr");
    if (existsSync(stdoutPath)) process.stdout.write(readFileSync(stdoutPath, "utf8"));
    if (existsSync(stderrPath)) process.stderr.write(readFileSync(stderrPath, "utf8"));
    process.exit(Number(readFileSync(injectedStatusPath, "utf8")));
  }
  const errorPath = join(controls, "controller-error");
  if (existsSync(errorPath)) {
    process.stderr.write(readFileSync(errorPath, "utf8"));
    process.exit(7);
  }
  const statePath = join(controls, "transport-state");
  if (existsSync(statePath)) {
    process.stdout.write(JSON.stringify({
      schema: "agent-browser.supported-existing-transport-attestation.v1",
      ok: false,
      status: readFileSync(statePath, "utf8").trim(),
      reason: "fixture diagnostic",
    }) + "\\n");
    process.exit(0);
  }
  const attestationPath = join(controls, "attestation.json");
  if (!existsSync(attestationPath)) process.exit(4);
  if (existsSync(join(controls, "refresh-transport-proof-on-ensure"))) {
    const proofPath = ${JSON.stringify(snapshotPath)};
    const snapshot = JSON.parse(readFileSync(proofPath, "utf8"));
    snapshot.observedAtMs = Date.now();
    writeFileSync(proofPath, JSON.stringify(snapshot), { mode: 0o600 });
    chmodSync(proofPath, 0o600);
    const attestation = JSON.parse(readFileSync(attestationPath, "utf8"));
    attestation.transportProofStateSha256 = createHash("sha256")
      .update(readFileSync(proofPath))
      .digest("hex");
    attestation.transportProofObservedAtMs = snapshot.observedAtMs;
    writeFileSync(attestationPath, JSON.stringify(attestation), { mode: 0o600 });
    chmodSync(attestationPath, 0o600);
  }
  process.stdout.write(readFileSync(attestationPath, "utf8") + "\\n");
  process.exit(0);
}
if (args[0] === "acquire-registered-workspace-target-lease") {
  if (existsSync(join(controls, "workspace-missing"))) process.exit(7);
  const account = value("--account");
  const workspaceLeasePath = join(controls, "workspace-lease-" + account + ".json");
  if (existsSync(workspaceLeasePath)) {
    const existing = JSON.parse(readFileSync(workspaceLeasePath, "utf8"));
    const sameSession = existing.session === value("--session");
    if (
      sameSession &&
      existsSync(join(controls, "workspace-recovery-namespace-race"))
    ) {
      const racedFocusPath = join(
        stateRoot,
        "session-" + value("--session") + ".focus-lease",
      );
      writeFileSync(racedFocusPath, "raced\\n", { mode: 0o600 });
      chmodSync(racedFocusPath, 0o600);
    }
    process.stderr.write(JSON.stringify({
      ok: false,
      status: sameSession ? "workspace_lease_recovery_required" : "workspace_leased",
      reason: sameSession
        ? "This session already holds the persistent workspace lease"
        : "Persistent workspace already has an exclusive session lease",
    }) + "\\n");
    process.exit(1);
  }
  const requestedTtlMs = Number(value("--ttl-ms"));
  if (requestedTtlMs !== 30_000) process.exit(64);
  const delayPath = join(controls, "workspace-acquire-delay-ms");
  if (existsSync(delayPath)) wait(Number(readFileSync(delayPath, "utf8")));
  const attestation = JSON.parse(readFileSync(join(controls, "attestation.json"), "utf8"));
  const nonce = randomBytes(32).toString("hex");
  const authorizationLeaseId = randomBytes(32).toString("hex");
  const endpoint = ${JSON.stringify(endpointDirectory())};
  const authPath = join(endpoint, "broker-auth", authorizationLeaseId + ".authorization");
  const hmac = readFileSync(join(controls, "broker-token"), "utf8").trim();
  const authorization = "Authorization: Bearer " + attestation.transportGeneration + "." + authorizationLeaseId + "." + hmac + "\\n";
  mkdirSync(dirname(authPath), { recursive: true, mode: 0o700 });
  chmodSync(dirname(authPath), 0o700);
  writeFileSync(authPath, authorization, { mode: 0o600 });
  chmodSync(authPath, 0o600);
  const path = join(endpoint, "target-leases", "pending", nonce + ".json");
  for (const directory of [
    dirname(path),
    join(endpoint, "target-leases", "consumed"),
    join(endpoint, "target-leases", "controller-metadata"),
    join(endpoint, "target-leases", "daemon-consumed"),
  ]) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    chmodSync(directory, 0o700);
  }
  const now = Date.now();
  const receiptAgePath = join(controls, "workspace-receipt-issued-age-ms");
  const receiptAgeMs = existsSync(receiptAgePath)
    ? Number(readFileSync(receiptAgePath, "utf8"))
    : 100;
  const issuedAt = now - receiptAgeMs;
  const profile = account === "erebora" ? "Profile 1" : "Default";
  const accountEmail = account === "erebora" ? "ereboracrew@gmail.com" : "calebdanemusic@gmail.com";
  const profileBinding = account === "erebora" ? "e".repeat(64) : "a".repeat(64);
  const receipt = {
    schema: "agent-browser.target-lease.v1",
    session: value("--session"),
    targetId: "fixture-workspace-" + account,
    targetKind: "agent-workspace",
    browserContextId: "fixture-context-" + account,
    profileBinding,
    profileDirectory: profile,
    accountEmail,
    browserGeneration: attestation.browserGeneration,
    transportGeneration: attestation.transportGeneration,
    leaseId: authorizationLeaseId,
    workspaceMarkerUrl: "about:blank#agent-browser-workspace-" + profileBinding,
    nonce,
    issuedAt,
    expiresAt: issuedAt + requestedTtlMs,
  };
  const envelope = {
    schema: "agent-browser.target-claim-envelope.v2",
    receipt,
  };
  const metadata = {
    schema: "agent-browser.target-receipt-metadata.v1",
    receipt,
    port: 9222,
    runtimeFingerprint: createHash("sha256").update("runtime:" + nonce).digest("hex"),
    browserGeneration: attestation.browserGeneration,
    transportGeneration: attestation.transportGeneration,
    provenanceKey: createHash("sha256").update("provenance:" + nonce).digest("hex"),
    controllerIdentity: createHash("sha256").update("fixture-controller").digest("hex"),
    claimKind: "persistent-workspace",
    account,
    profileDirectory: profile,
    browserContextId: "fixture-context-" + account,
    profileBinding,
    brokerLeaseId: authorizationLeaseId,
    brokerAuthFilePath: authPath,
    brokerAuthFileSha256: createHash("sha256").update(authorization).digest("hex"),
    brokerCdpWebSocketUrl: attestation.brokerCdpWebSocketUrl,
    brokerHealthUrl: attestation.brokerHealthUrl,
    consentGeneration: attestation.consentGeneration,
    brokerProducerContractSha256: createHash("sha256").update("fixture-broker-producer-v1").digest("hex"),
    brokerCapabilityExpiresAt: new Date(now + 60 * 60_000).toISOString(),
  };
  writeFileSync(path, JSON.stringify(envelope), { mode: 0o600 });
  chmodSync(path, 0o600);
  const metadataPath = join(
    endpoint,
    "target-leases",
    "controller-metadata",
    nonce + ".json",
  );
  writeFileSync(metadataPath, JSON.stringify(metadata), { mode: 0o600 });
  chmodSync(metadataPath, 0o600);
  const markerId = profileBinding;
  writeFileSync(workspaceLeasePath, JSON.stringify({
    session: value("--session"),
    account,
    profileDirectory: profile,
    profileEmail: accountEmail,
    targetId: receipt.targetId,
    tabTargetId: "fixture-tab-" + account,
    windowId: account === "erebora" ? 2 : 1,
    browserContextId: receipt.browserContextId,
    profileDiscriminatorKind: "profile-directory",
    profileBinding,
    browserGeneration: receipt.browserGeneration,
    transportGeneration: receipt.transportGeneration,
    markerId,
    markerUrl: "about:blank#agent-browser-workspace-" + markerId,
    receiptNonce: nonce,
    brokerAuthFilePath: authPath,
    pendingPath: path,
    metadataPath,
  }), { mode: 0o600 });
  chmodSync(workspaceLeasePath, 0o600);
  const postAcquireFailurePath = join(controls, "post-acquire-transport-failure.json");
  if (existsSync(postAcquireFailurePath)) {
    writeFileSync(
      join(controls, "next-ensure-failure.json"),
      readFileSync(postAcquireFailurePath),
      { mode: 0o600 },
    );
    rmSync(postAcquireFailurePath);
  }
  process.stdout.write(JSON.stringify({
    schema: "agent-browser.target-lease-location.v1",
    ok: true,
    status: "issued",
    controllerEndpointId: ${JSON.stringify(endpointId)},
    path,
    metadataPath,
    receipt,
    brokerAuthFilePath: authPath,
    brokerAuthFileSha256: metadata.brokerAuthFileSha256,
    brokerCdpWebSocketUrl: metadata.brokerCdpWebSocketUrl,
    brokerHealthUrl: metadata.brokerHealthUrl,
    consentGeneration: metadata.consentGeneration,
    brokerProducerContractSha256: metadata.brokerProducerContractSha256,
    brokerCapabilityExpiresAt: metadata.brokerCapabilityExpiresAt,
    activate: false,
  }) + "\\n");
  process.exit(0);
}
if (args[0] === "release-workspace") {
  const account = value("--account");
  const leasePath = join(controls, "workspace-lease-" + account + ".json");
  if (!existsSync(leasePath)) {
    process.stderr.write(JSON.stringify({
      ok: false,
      status: "workspace_not_leased",
      reason: "Fixture workspace lease is absent",
    }) + "\\n");
    process.exit(1);
  }
  const lease = JSON.parse(readFileSync(leasePath, "utf8"));
  if (lease.session !== value("--session")) {
    process.stderr.write(JSON.stringify({
      ok: false,
      status: "workspace_lease_conflict",
      reason: "Workspace lease belongs to another exact session",
    }) + "\\n");
    process.exit(1);
  }
  const busyPath = join(controls, "release-workspace-busy-count");
  const busyCount = existsSync(busyPath)
    ? Number(readFileSync(busyPath, "utf8"))
    : 0;
  if (Number.isSafeInteger(busyCount) && busyCount > 0) {
    writeFileSync(busyPath, String(busyCount - 1));
    process.stderr.write(JSON.stringify({
      ok: false,
      status: "workspace_release_busy",
      reason: "Fixture exact workspace release is transiently busy",
    }) + "\\n");
    process.exit(1);
  }
  for (const path of [
    lease.pendingPath,
    lease.metadataPath,
    lease.brokerAuthFilePath,
  ]) {
    try { rmSync(path); } catch {}
  }
  rmSync(leasePath);
  process.stdout.write(JSON.stringify({
    ok: true,
    status: "released",
    session: lease.session,
    account: lease.account,
    profileDirectory: lease.profileDirectory,
    profileEmail: lease.profileEmail,
    targetId: lease.targetId,
    tabTargetId: lease.tabTargetId,
    windowId: lease.windowId,
    browserContextId: lease.browserContextId,
    profileDiscriminatorKind: lease.profileDiscriminatorKind,
    profileBinding: lease.profileBinding,
    browserGeneration: lease.browserGeneration,
    transportGeneration: lease.transportGeneration,
    markerId: lease.markerId,
    markerUrl: lease.markerUrl,
    targetPreserved: true,
    brokerPreserved: true,
  }) + "\\n");
  process.exit(0);
}
if (args[0] === "consume-target-receipt") {
  if (existsSync(join(controls, "consume-error"))) process.exit(7);
  const path = value("--path");
  const envelope = JSON.parse(readFileSync(path, "utf8"));
  const consumed = join(dirname(dirname(path)), "consumed", envelope.receipt.nonce + ".json");
  mkdirSync(dirname(consumed), { recursive: true, mode: 0o700 });
  renameSync(path, consumed);
  const delayPath = join(controls, "consume-delay-ms");
  if (existsSync(delayPath)) wait(Number(readFileSync(delayPath, "utf8")));
  process.stdout.write(JSON.stringify(envelope.receipt) + "\\n");
  process.exit(0);
}
if (args[0] === "register-session") {
  if (existsSync(join(controls, "registration-error"))) process.exit(7);
  const delayPath = join(controls, "registration-delay-ms");
  if (existsSync(delayPath)) wait(Number(readFileSync(delayPath, "utf8")));
  const daemonPid = Number(value("--pid"));
  const socket = lstatSync(value("--socket"), { bigint: true });
  const daemonStat = readFileSync("/proc/" + daemonPid + "/stat", "utf8");
  const daemonStartTicks = daemonStat.slice(daemonStat.lastIndexOf(")") + 2).trim().split(/\\s+/)[19];
  const registration = {
    ok: true,
    status: "registered",
    session: value("--session"),
    targetId: value("--target-id"),
    targetKind: value("--target-kind"),
    account: value("--account"),
    profileDirectory: value("--profile-directory"),
    profileEmail: value("--profile-email"),
    browserContextId: value("--browser-context-id"),
    profileBinding: value("--profile-binding"),
    browserGeneration: value("--browser-generation"),
    transportGeneration: value("--transport-generation"),
    receiptNonce: value("--receipt-nonce"),
    daemonPid,
    daemonStartTicks,
    socketDev: socket.dev.toString(),
    socketIno: socket.ino.toString(),
    brokerLeaseId: value("--broker-lease-id"),
    brokerAuthFilePath: value("--broker-auth-file-path"),
    brokerAuthFileSha256: value("--broker-auth-file-sha256"),
    brokerCdpWebSocketUrl: value("--broker-cdp-websocket-url"),
    brokerHealthUrl: value("--broker-health-url"),
    consentGeneration: value("--consent-generation"),
    brokerProducerContractSha256: value("--broker-producer-contract-sha256"),
    brokerCapabilityExpiresAt: value("--broker-capability-expires-at"),
  };
  writeFileSync(join(controls, "registration.json"), JSON.stringify(registration));
  process.stdout.write(JSON.stringify(registration) + "\\n");
  process.exit(0);
}
if (args[0] === "proof-state") {
  const registration = JSON.parse(readFileSync(join(controls, "registration.json"), "utf8"));
  const delayPath = join(controls, "proof-delay-ms");
  if (existsSync(delayPath)) wait(Number(readFileSync(delayPath, "utf8")));
  const attestationPath = join(controls, "attestation.json");
  if (existsSync(join(controls, "refresh-transport-proof-on-proof"))) {
    const proofPath = ${JSON.stringify(snapshotPath)};
    const snapshot = JSON.parse(readFileSync(proofPath, "utf8"));
    const agePath = join(controls, "proof-observed-age-ms");
    const observedAgeMs = existsSync(agePath)
      ? Number(readFileSync(agePath, "utf8"))
      : 0;
    snapshot.observedAtMs = Date.now() - observedAgeMs;
    const brokerOverridesPath = join(controls, "proof-broker-overrides.json");
    if (existsSync(brokerOverridesPath)) {
      Object.assign(
        snapshot.broker,
        JSON.parse(readFileSync(brokerOverridesPath, "utf8")),
      );
    }
    writeFileSync(proofPath, JSON.stringify(snapshot), { mode: 0o600 });
    chmodSync(proofPath, 0o600);
    const attestation = JSON.parse(readFileSync(attestationPath, "utf8"));
    attestation.transportProofStateSha256 = createHash("sha256")
      .update(readFileSync(proofPath))
      .digest("hex");
    attestation.transportProofObservedAtMs = snapshot.observedAtMs;
    writeFileSync(attestationPath, JSON.stringify(attestation), { mode: 0o600 });
    chmodSync(attestationPath, 0o600);
  }
  const attestation = JSON.parse(readFileSync(attestationPath, "utf8"));
  const proof = {
    schema: "agent-browser.session-proof-state.v1",
    ok: true,
    status: "ready",
    session: registration.session,
    targetId: registration.targetId,
    targetKind: registration.targetKind,
    browserContextId: registration.browserContextId,
    profileBinding: registration.profileBinding,
    profileDirectory: registration.profileDirectory,
    accountEmail: registration.profileEmail,
    browserGeneration: registration.browserGeneration,
    transportGeneration: registration.transportGeneration,
    leaseId: registration.brokerLeaseId,
    brokerCdpWebSocketUrl: registration.brokerCdpWebSocketUrl,
    brokerHealthUrl: registration.brokerHealthUrl,
    brokerAuthFilePath: registration.brokerAuthFilePath,
    brokerAuthFileSha256: registration.brokerAuthFileSha256,
    consentGeneration: registration.consentGeneration,
    brokerProducerContractPath: attestation.brokerProducerContractPath,
    brokerProducerContractSha256: registration.brokerProducerContractSha256,
    transportProofStatePath: attestation.transportProofStatePath,
    transportProofStateSha256: attestation.transportProofStateSha256,
    transportProofObservedAtMs: attestation.transportProofObservedAtMs,
    daemonPid: registration.daemonPid,
    daemonStartTicks: registration.daemonStartTicks,
    socketPath: value("--session") ? join(${JSON.stringify(stateRoot)}, value("--session") + ".sock") : "",
    socketDev: registration.socketDev,
    socketIno: registration.socketIno,
    peerPidMatches: true,
  };
  const overridesPath = join(controls, "session-proof-overrides.json");
  if (existsSync(overridesPath)) Object.assign(proof, JSON.parse(readFileSync(overridesPath, "utf8")));
  process.stdout.write(JSON.stringify(proof) + "\\n");
  process.exit(0);
}
if (args[0] === "release-session") {
  const nonce = value("--receipt-nonce");
  const registration = JSON.parse(readFileSync(join(controls, "registration.json"), "utf8"));
  const socketPath = join(${JSON.stringify(stateRoot)}, registration.session + ".sock");
  let exactDaemonAlive = false;
  try {
    process.kill(registration.daemonPid, 0);
    const raw = readFileSync("/proc/" + registration.daemonPid + "/stat", "utf8");
    const fields = raw.slice(raw.lastIndexOf(")") + 2).trim().split(/\\s+/);
    exactDaemonAlive = !["Z", "X", "x"].includes(fields[0]) && fields[19] === registration.daemonStartTicks;
  } catch {}
  if (exactDaemonAlive || existsSync(socketPath)) {
    appendFileSync(trace, "release-session-before-exact-dead=" + registration.session + "\\n");
    process.stderr.write(JSON.stringify({
      ok: false,
      status: "session_still_active",
      reason: "fixture exact daemon/socket remains active",
    }) + "\\n");
    process.exit(1);
  }
  appendFileSync(trace, "release-session-exact-dead=" + registration.session + "\\n");
  const busyPath = join(controls, "release-session-busy-count");
  const busyCount = existsSync(busyPath)
    ? Number(readFileSync(busyPath, "utf8"))
    : 0;
  if (Number.isSafeInteger(busyCount) && busyCount > 0) {
    writeFileSync(busyPath, String(busyCount - 1));
    process.stderr.write(JSON.stringify({
      ok: false,
      status: "session_release_busy",
      reason: "fixture exact release lock is transiently busy",
    }) + "\\n");
    process.exit(1);
  }
  const metadata = JSON.parse(readFileSync(join(${JSON.stringify(endpointDirectory())}, "target-leases", "controller-metadata", nonce + ".json"), "utf8"));
  try { rmSync(metadata.brokerAuthFilePath); } catch {}
  const workspaceLeasePath = join(controls, "workspace-lease-" + metadata.account + ".json");
  if (existsSync(workspaceLeasePath)) {
    const workspaceLease = JSON.parse(readFileSync(workspaceLeasePath, "utf8"));
    if (workspaceLease.receiptNonce === nonce) rmSync(workspaceLeasePath);
  }
  process.stdout.write(JSON.stringify({
    schema: "agent-browser.session-release-result.v1",
    ok: true,
    status: "released",
    session: value("--session"),
    targetId: value("--target-id"),
    targetKind: metadata.receipt.targetKind,
    receiptNonce: nonce,
    descendantsClosed: 0,
    targetPreserved: true,
    workspaceReady: metadata.receipt.targetKind === "agent-workspace" ? true : null,
    brokerCapabilityRevoked: true,
    focusDisposition: "none",
    releasedAt: Date.now(),
  }) + "\\n");
  process.exit(0);
}
if (args[0] === "release-target-lease") {
  const delayPath = join(controls, "release-target-delay-ms");
  if (existsSync(delayPath)) wait(Number(readFileSync(delayPath, "utf8")));
  const nonce = value("--receipt-nonce");
  const metadata = JSON.parse(readFileSync(join(${JSON.stringify(endpointDirectory())}, "target-leases", "controller-metadata", nonce + ".json"), "utf8"));
  try { rmSync(metadata.brokerAuthFilePath); } catch {}
  const workspaceLeasePath = join(controls, "workspace-lease-" + metadata.account + ".json");
  if (existsSync(workspaceLeasePath)) {
    const workspaceLease = JSON.parse(readFileSync(workspaceLeasePath, "utf8"));
    if (workspaceLease.receiptNonce === nonce) rmSync(workspaceLeasePath);
  }
  process.stdout.write(JSON.stringify({
    ok: true,
    status: "aborted",
    session: value("--session"),
    targetId: value("--target-id"),
    targetKind: metadata.receipt.targetKind,
    targetPreserved: true,
    brokerCapabilityRevoked: true,
  }) + "\\n");
  process.exit(0);
}
if (args[0] === "discover-owned-descendants") {
  const delayPath = join(controls, "reconcile-delay-ms");
  if (existsSync(delayPath)) wait(Number(readFileSync(delayPath, "utf8")));
  if (existsSync(join(controls, "reconcile-error"))) process.exit(7);
  const nonce = value("--receipt-nonce");
  const metadata = JSON.parse(readFileSync(join(${JSON.stringify(endpointDirectory())}, "target-leases", "controller-metadata", nonce + ".json"), "utf8"));
  process.stdout.write(JSON.stringify({
    schema: "agent-browser.descendant-reconcile-result.v1",
    ok: true,
    status: "reconciled",
    session: value("--session"),
    rootTargetId: value("--root-target-id"),
    receiptNonce: nonce,
    browserContextId: metadata.browserContextId,
    browserGeneration: metadata.browserGeneration,
    transportGeneration: metadata.transportGeneration,
    discoveredTargetIds: [],
    registeredTargetIds: [],
    truncated: false,
    reconciledAt: Date.now(),
  }) + "\\n");
  process.exit(0);
}
if (args[0] === "acquire-focus") {
  const registration = JSON.parse(readFileSync(join(controls, "registration.json"), "utf8"));
  if (
    registration.session !== value("--session") ||
    registration.targetId !== value("--target-id") ||
    registration.receiptNonce !== value("--receipt-nonce")
  ) process.exit(7);
  const now = Date.now();
  const focus = {
    schema: "agent-browser.focus-acquire-result.v1",
    ok: true,
    status: "foreground",
    session: registration.session,
    targetId: registration.targetId,
    targetKind: registration.targetKind,
    browserContextId: registration.browserContextId,
    profileBinding: registration.profileBinding,
    profileDirectory: registration.profileDirectory,
    accountEmail: registration.profileEmail,
    browserGeneration: registration.browserGeneration,
    transportGeneration: registration.transportGeneration,
    leaseId: registration.brokerLeaseId,
    receiptNonce: registration.receiptNonce,
    daemonPid: registration.daemonPid,
    daemonStartTicks: registration.daemonStartTicks,
    socketPath: join(${JSON.stringify(stateRoot)}, registration.session + ".sock"),
    socketDev: registration.socketDev,
    socketIno: registration.socketIno,
    focusLeaseId: randomBytes(32).toString("hex"),
    leasedTabId: "fixture-tab-" + registration.targetId,
    windowId: 42,
    restorationKind: registration.targetKind === "agent-workspace" ? "workspace-hwnd-only" : "user-tab-and-hwnd",
    priorActiveTabId: registration.targetKind === "agent-workspace" ? null : "fixture-prior-tab",
    priorForegroundWindowHandle: 100,
    foregroundWindowHandle: 200,
    acquiredAt: now,
    deadlineAt: now + 15_000,
  };
  writeFileSync(join(controls, "focus-" + registration.session + ".json"), JSON.stringify(focus));
  if (existsSync(join(controls, "focus-publish-race"))) {
    const foreignPath = join(${JSON.stringify(stateRoot)}, "session-" + registration.session + ".focus-lease");
    writeFileSync(foreignPath, "foreign-focus-owner\\n", { mode: 0o600 });
    chmodSync(foreignPath, 0o600);
  }
  process.stdout.write(JSON.stringify(focus) + "\\n");
  process.exit(0);
}
if (args[0] === "validate-focus-lease") {
  if (existsSync(join(controls, "focus-inactive"))) process.exit(7);
  const session = value("--session");
  const focus = JSON.parse(readFileSync(join(controls, "focus-" + session + ".json"), "utf8"));
  if (focus.focusLeaseId !== value("--focus-lease-id")) process.exit(7);
  process.stdout.write(JSON.stringify({
    schema: "agent-browser.focus-lease-validation.v1",
    ok: true,
    status: "valid",
    session,
    focusLeaseId: focus.focusLeaseId,
    targetId: focus.targetId,
    targetKind: focus.targetKind,
    receiptNonce: focus.receiptNonce,
    browserContextId: focus.browserContextId,
    browserGeneration: focus.browserGeneration,
    transportGeneration: focus.transportGeneration,
    daemonPid: focus.daemonPid,
    daemonStartTicks: focus.daemonStartTicks,
    socketPath: focus.socketPath,
    socketDev: focus.socketDev,
    socketIno: focus.socketIno,
    leasedTabId: focus.leasedTabId,
    windowId: focus.windowId,
    deadlineAt: focus.deadlineAt,
  }) + "\\n");
  process.exit(0);
}
if (args[0] === "release-focus") {
  const delayPath = join(controls, "focus-delay-ms");
  if (existsSync(delayPath)) wait(Number(readFileSync(delayPath, "utf8")));
  const errorPath = join(controls, "focus-error");
  if (existsSync(errorPath)) {
    appendFileSync(trace, "focus-restored-before-error=" + value("--focus-lease-id") + "\\n");
    process.exit(7);
  }
  const session = value("--session");
  const focusPath = join(controls, "focus-" + session + ".json");
  const focus = JSON.parse(readFileSync(focusPath, "utf8"));
  if (focus.focusLeaseId !== value("--focus-lease-id")) process.exit(7);
  rmSync(focusPath);
  appendFileSync(trace, "focus-restored=" + focus.focusLeaseId + "\\n");
  process.stdout.write(JSON.stringify({
    schema: "agent-browser.focus-release-result.v1",
    ok: true,
    status: "background",
    session,
    focusLeaseId: focus.focusLeaseId,
    targetId: focus.targetId,
    receiptNonce: focus.receiptNonce,
    restorationKind: focus.restorationKind,
    focusRestored: true,
    restorationDisposition: "restored",
    releasedAt: Date.now(),
  }) + "\\n");
  process.exit(0);
}
process.stderr.write('{"reason":"unsupported"}\\n');
process.exit(1);
`;
}

async function buildFixture() {
  fixtureRoot = mkdtempSync(join(tmpdir(), "agent-browser-wrapper-security-"));
  fixtureRepo = join(fixtureRoot, "repo");
  stateRoot = join(fixtureRoot, "state");
  controllerRoot = join(fixtureRoot, "controller-state");
  controls = join(fixtureRoot, "controls");
  tracePath = join(fixtureRoot, "trace.log");
  nativeHome = join(fixtureRoot, "native-home");
  port = await unusedPort();
  endpointId = `9222-${sha256("http://127.0.0.1:9222").slice(0, 20)}`;
  snapshotPath = join(
    controllerRoot,
    "endpoints",
    endpointId,
    "profile-attestation",
    "transport-proof-state.v1.json",
  );
  brokerToken = "H".repeat(43);
  currentAuthority = null;
  nonceCounter = 0;
  mkdirSync(join(fixtureRepo, "scripts"), { recursive: true, mode: 0o700 });
  mkdirSync(join(fixtureRepo, "bin"), { recursive: true, mode: 0o700 });
  mkdirSync(join(fixtureRepo, "dist"), { recursive: true, mode: 0o700 });
  mkdirSync(controls, { mode: 0o700 });
  mkdirSync(nativeHome, { mode: 0o700 });
  mkdirSync(join(fixtureRoot, "attacker-path"), { mode: 0o700 });
  writeFileSync(join(controls, "broker-token"), `${brokerToken}\n`, "utf8");

  const daemonPath = join(fixtureRepo, "dist", "daemon.js");
  writeFileSync(daemonPath, daemonSource(), "utf8");
  for (const path of graphFiles) {
    const absolute = join(fixtureRepo, path);
    if (absolute === daemonPath) continue;
    writeFileSync(
      absolute,
      `export const fixture = ${JSON.stringify(path)};\n`,
      "utf8",
    );
  }
  const graph = Object.fromEntries(
    graphFiles.map((path) => [
      path,
      sha256(readFileSync(join(fixtureRepo, path))),
    ]),
  );
  const graphSha256 = graphFingerprint(graph);
  const canonicalDist = {
    schema: "agent-browser-canonical-dist.v1",
    authority: "tracked-dist-js",
    algorithm: "sha256",
    files: graph,
  };
  writeFileSync(
    join(fixtureRepo, "scripts", "canonical-dist.json"),
    `${JSON.stringify(canonicalDist)}\n`,
    "utf8",
  );

  let popupSource = readFileSync(
    join(sourceRoot, "scripts", "agent-browser-daemon-click.js"),
    "utf8",
  );
  popupSource = patchExact(
    popupSource,
    'const EXPECTED_MANIFEST_SHA256 =\n  "c70aa3a02b1fc00910e378b417739bfe42ac784726d130c2245c22c859bce194";',
    `const EXPECTED_MANIFEST_SHA256 = ${JSON.stringify(
      sha256(readFileSync(join(fixtureRepo, "scripts", "canonical-dist.json"))),
    )};`,
  );
  popupSource = patchExact(
    popupSource,
    'const EXPECTED_GRAPH_SHA256 =\n  "4e3ba63ddd1a71f1e2996fdeea8a873453417c55bc2f1e1d5a1f236ecc5aedcf";',
    `const EXPECTED_GRAPH_SHA256 = ${JSON.stringify(graphSha256)};`,
  );
  const popupPath = join(
    fixtureRepo,
    "scripts",
    "agent-browser-daemon-click.js",
  );
  writeFileSync(popupPath, popupSource, "utf8");
  chmodSync(popupPath, 0o755);

  const nativeHelper = executable(
    join(fixtureRoot, "fake-native-helper.js"),
    nativeHelperSource(),
  );
  const nativePath = executable(
    join(fixtureRepo, "bin", "agent-browser-linux-x64"),
    `#!/usr/bin/bash\nexec /usr/bin/node ${JSON.stringify(nativeHelper)} "$@"\n`,
  );
  const nativeRaw = readFileSync(nativePath);
  const nativeManifest = {
    schema: "agent-browser.native-release.v1",
    packageVersion: "0.13.0",
    platform: "linux-x64",
    binary: "bin/agent-browser-linux-x64",
    sha256: sha256(nativeRaw),
    size: nativeRaw.length,
    versionOutput: "agent-browser 0.13.0",
    provenance: {
      status: "accepted-local-binary",
      acceptedBaseline: "fixture",
      sourceReproducible: false,
      limitation:
        "These fixture bytes are accepted input; this manifest does not claim source reproducibility.",
    },
  };
  const nativeManifestPath = join(
    fixtureRepo,
    "scripts",
    "canonical-native-release.json",
  );
  writeFileSync(
    nativeManifestPath,
    `${JSON.stringify(nativeManifest)}\n`,
    "utf8",
  );
  copyFileSync(
    join(sourceRoot, "scripts", "canonical-wrapper-config.json"),
    join(fixtureRepo, "scripts", "canonical-wrapper-config.json"),
  );
  copyFileSync(
    join(sourceRoot, "scripts", "agent-browser-cdp-broker.js"),
    join(fixtureRepo, "scripts", "agent-browser-cdp-broker.js"),
  );

  const controllerHelper = executable(
    join(fixtureRoot, "fake-controller-helper.js"),
    controllerHelperSource(),
  );
  const controller = executable(
    join(fixtureRoot, "pinned-controller"),
    `#!/usr/bin/bash\nexec /usr/bin/node ${JSON.stringify(controllerHelper)} "$@"\n`,
  );
  for (const attacker of [
    "attacker-native",
    "attacker-starter",
    "attacker-controller",
  ]) {
    executable(
      join(fixtureRoot, attacker),
      `#!/usr/bin/bash\n/usr/bin/printf '${attacker}-called\\n' >> ${JSON.stringify(tracePath)}\nexit 0\n`,
    );
  }

  writeFileSync(
    join(fixtureRepo, "package.json"),
    JSON.stringify({
      name: "agent-browser",
      version: "0.13.0",
      type: "module",
    }),
    "utf8",
  );
  copyFileSync(
    join(sourceRoot, "scripts", "agent-browser-real-chrome"),
    join(fixtureRepo, "scripts", "agent-browser-real-chrome"),
  );
  chmodSync(join(fixtureRepo, "scripts", "agent-browser-real-chrome"), 0o755);

  let mainSource = readFileSync(
    join(sourceRoot, "scripts", "agent-browser-wrapper.js"),
    "utf8",
  );
  mainSource = patchExact(
    mainSource,
    'const SOCKET_ROOT = "/tmp/agent-browser-raw";',
    `const SOCKET_ROOT = ${JSON.stringify(stateRoot)};`,
  );
  mainSource = patchExact(
    mainSource,
    'const FIXED_CONTROLLER_BIN = "/home/cabule/.ai-controller/bin/browser-runtime";',
    `const FIXED_CONTROLLER_BIN = ${JSON.stringify(controller)};`,
  );
  mainSource = patchExact(
    mainSource,
    'const FIXED_CONTROLLER_SHA256 =\n  "c1865f356acc304ba54a2698a5bf50aca2252c6a648561eae3cf7215e34cda12";',
    `const FIXED_CONTROLLER_SHA256 = ${JSON.stringify(sha256(readFileSync(controller)))};`,
  );
  mainSource = patchExact(
    mainSource,
    'const FIXED_CONTROLLER_STATE_ROOT = "";',
    `const FIXED_CONTROLLER_STATE_ROOT = ${JSON.stringify(controllerRoot)};`,
  );
  mainSource = patchExact(
    mainSource,
    'const ACCEPTED_TRANSPORT_HELPER_REVISIONS = Object.freeze([\n  "agent-browser.transport-proof-helper.wsl-stable.v2",\n]);',
    'const ACCEPTED_TRANSPORT_HELPER_REVISIONS = Object.freeze(["fixture-helper-v2"]);',
  );
  mainSource = patchExact(
    mainSource,
    'const EXPECTED_NATIVE_MANIFEST_SHA256 =\n  "e04a9d1a92b1b00325f3483673bf860a15d0be8efe634164e3583ba56890a915";',
    `const EXPECTED_NATIVE_MANIFEST_SHA256 = ${JSON.stringify(sha256(readFileSync(nativeManifestPath)))};`,
  );
  mainSource = patchExact(
    mainSource,
    'const EXPECTED_NATIVE_SHA256 =\n  "a34421a9f7c3e498ce30f6dec4780e53488de5e01f330f2f2abcf8e79a6955f4";',
    `const EXPECTED_NATIVE_SHA256 = ${JSON.stringify(sha256(nativeRaw))};`,
  );
  mainSource = patchExact(
    mainSource,
    'const EXPECTED_NATIVE_EXECUTION = "elf";',
    'const EXPECTED_NATIVE_EXECUTION = "fixture-script";',
  );
  mainSource = patchExact(
    mainSource,
    'const EXPECTED_CANONICAL_DIST_SHA256 =\n  "c70aa3a02b1fc00910e378b417739bfe42ac784726d130c2245c22c859bce194";',
    `const EXPECTED_CANONICAL_DIST_SHA256 =\n  ${JSON.stringify(
      sha256(readFileSync(join(fixtureRepo, "scripts", "canonical-dist.json"))),
    )};`,
  );
  mainSource = patchExact(
    mainSource,
    'const EXPECTED_CANONICAL_GRAPH_SHA256 =\n  "4e3ba63ddd1a71f1e2996fdeea8a873453417c55bc2f1e1d5a1f236ecc5aedcf";',
    `const EXPECTED_CANONICAL_GRAPH_SHA256 =\n  ${JSON.stringify(graphSha256)};`,
  );
  mainSource = patchExact(
    mainSource,
    '  HOME: "/home/cabule",',
    `  HOME: ${JSON.stringify(nativeHome)},`,
  );
  mainSource = patchExact(
    mainSource,
    'const EXPECTED_POPUP_CLIENT_SHA256 =\n  "0077709cd495775b8ab1a19eb1918d14499ba9f66db73ba7fde18438d3ae2b19";',
    `const EXPECTED_POPUP_CLIENT_SHA256 = ${JSON.stringify(sha256(Buffer.from(popupSource)))};`,
  );
  writeFileSync(
    join(fixtureRepo, "scripts", "agent-browser-wrapper.js"),
    mainSource,
  );
  chmodSync(join(fixtureRepo, "scripts", "agent-browser-wrapper.js"), 0o755);
  wrapper = join(fixtureRepo, "scripts", "agent-browser-real-chrome");

  const serverPath = executable(
    join(fixtureRoot, "transport-server.js"),
    transportServerSource(),
  );
  transportProcess = spawn("/usr/bin/node", [serverPath], {
    stdio: "ignore",
    env: { HOME: "/home/cabule", PATH: "/usr/bin:/bin", LANG: "C.UTF-8" },
  });
  waitFor(join(fixtureRoot, "transport.ready"));
}

function stopFixtureProcesses() {
  try {
    const rootInfo = lstatSync(stateRoot);
    if (rootInfo.isDirectory() && !rootInfo.isSymbolicLink()) {
      for (const name of readdirSync(stateRoot).filter((entry) =>
        entry.endsWith(".pid"),
      )) {
        try {
          const pid = Number(
            readFileSync(join(stateRoot, name), "utf8").trim(),
          );
          if (Number.isSafeInteger(pid) && pid > 1)
            process.kill(pid, "SIGTERM");
        } catch {}
      }
    }
  } catch {}
  try {
    if (transportProcess?.pid) process.kill(transportProcess.pid, "SIGTERM");
  } catch {}
}

beforeEach(async () => {
  await buildFixture();
});

afterEach(() => {
  stopFixtureProcesses();
  rmSync(fixtureRoot, { recursive: true, force: true });
});

describe("authenticated wrapper security boundaries", () => {
  it("premise: inherited route selectors have no authority; falsifier: an attacker binary, test mode, account, socket, or PATH is observed", () => {
    const result = run(["--version"]);

    expect(result.status).toBe(0);
    expect(result.stdout).toBe("agent-browser 0.13.0\n");
    expect(result.stderr).toBe("");
    expect(trace()).toContain(`"socket":"${stateRoot}"`);
    expect(trace()).toContain('"forgedNative":""');
    expect(trace()).toContain('"testMode":""');
    expect(trace()).toContain('"proxy":""');
    expect(trace()).toContain('"attach":""');
    expect(trace()).not.toContain("attacker-native-called");
    expect(trace()).not.toContain("attacker-controller-called");
    expect(trace()).not.toContain("attacker-starter-called");
    expect(existsSync(join(fixtureRoot, "attacker-sockets"))).toBe(false);
  });

  it("premise: a pinned empty config fd disables user and project defaults; falsifier: either hostile config or session-state fallback reaches native", () => {
    const userConfig = join(nativeHome, ".agent-browser");
    const project = join(fixtureRoot, "hostile-project");
    mkdirSync(userConfig, { recursive: true, mode: 0o700 });
    mkdirSync(project, { mode: 0o700 });
    const hostileConfig = JSON.stringify({
      sessionName: "stolen-account-state",
      provider: "attacker-provider",
      state: "/should/not/load.json",
      autoConnect: true,
    });
    writeFileSync(join(userConfig, "config.json"), hostileConfig, "utf8");
    writeFileSync(join(project, "agent-browser.json"), hostileConfig, "utf8");
    writeAttestation();

    const result = runWorkspace(
      ["--session", "config-safe", "open", "https://example.test"],
      {},
      project,
    );

    expect(result.status, result.stderr).toBe(0);
    const action = trace()
      .split("\n")
      .filter((line) => line.startsWith("native="))
      .map((line) => JSON.parse(line.slice("native=".length)))
      .find((entry) => entry.args.includes("open"));
    expect(action.configPath).toBe("/proc/self/fd/4");
    expect(action.config).toBe("{}\n");
    expect(action.home).toBe(nativeHome);
    expect(action.cwd).toBe(project);
    expect(action.sessionName).toBe("");
    expect(action.args).not.toContain("--state");
    expect(action.args).not.toContain("--provider");
    expect(existsSync(join(nativeHome, ".agent-browser", "sessions"))).toBe(
      false,
    );
  });

  it("premise: a symlinked socket root is immutable attacker state; falsifier: the target is followed, chmodded, or native executes", () => {
    const attackerRoot = join(fixtureRoot, "symlink-target");
    mkdirSync(attackerRoot, { mode: 0o755 });
    chmodSync(attackerRoot, 0o755);
    symlinkSync(attackerRoot, stateRoot, "dir");

    const result = run(["--version"]);

    expect(result.status).not.toBe(0);
    expect(lstatSync(stateRoot).isSymbolicLink()).toBe(true);
    expect(statSync(attackerRoot).mode & 0o777).toBe(0o755);
    expect(trace()).not.toContain("native=");
  });

  it("premise: parsing completes before authority work; falsifier: empty/noncanonical forms create state or touch transport", () => {
    const cases = [
      [],
      [""],
      ["--"],
      ["--session", "", "open", "https://example.test"],
      ["--cdp", "", "--session", "task", "snapshot"],
      ["--session=task", "open", "https://example.test"],
      [`--cdp=${port}`, "--session", "task", "snapshot"],
      ["--json=false", "--session", "task", "snapshot"],
      [
        "--proxy",
        "http://attacker.invalid",
        "--session",
        "task",
        "open",
        "https://example.test",
      ],
      [
        "--target-receipt",
        "/tmp/not-authority.json",
        "--session",
        "task",
        "snapshot",
      ],
    ];

    for (const args of cases) {
      const result = run(args);
      expect(result.status, JSON.stringify(args)).toBe(64);
    }
    expect(existsSync(stateRoot)).toBe(false);
    expect(trace()).toBe("");
  });

  it("premise: saved-profile navigation is HTTP(S)-only; falsifier: an internal, file, data, or script URL reaches state", () => {
    for (const url of [
      "chrome://settings",
      "file:///tmp/private.txt",
      "data:text/html,hello",
      "javascript:alert(1)",
    ]) {
      const result = run(["--session", "scheme", "open", url]);
      expect(result.status, url).toBe(64);
      expect(result.stderr).toContain("only credential-free HTTP(S) URLs");
    }
    expect(existsSync(stateRoot)).toBe(false);
    expect(trace()).toBe("");
  });

  it("premise: missing or stale controller transport authority fails before broker/native use; falsifier: arbitrary evidence reaches either", () => {
    const missingPath = join(
      controllerRoot,
      "endpoints",
      endpointId,
      "target-leases",
      "pending",
      `${"f".repeat(64)}.json`,
    );
    const missing = run([
      "--session",
      "missing",
      "--target-lease",
      missingPath,
      "open",
      "https://example.test",
    ]);
    expect(missing.status).toBe(69);
    expect(missing.stderr).toContain("TRANSPORT_FAILURE");
    const ensureCall = trace()
      .split("\n")
      .find((line) =>
        line.startsWith('controller=["ensure-supported-existing-transport"'),
      );
    expect(JSON.parse(ensureCall.slice("controller=".length))).toEqual([
      "ensure-supported-existing-transport",
      "--broker-source-path",
      join(fixtureRepo, "scripts", "agent-browser-cdp-broker.js"),
      "--session",
      "missing",
      "--json",
    ]);
    expect(trace()).not.toContain("attest-supported-existing-transport");

    writeAttestation({
      user_data_root: "C:\\copied\\profile",
      browser_executable: "C:\\arbitrary\\chrome.exe",
      issued_at: "2020-01-01T00:00:00.000Z",
      expires_at: "2020-01-01T00:01:00.000Z",
    });
    const arbitrary = runWorkspace([
      "--session",
      "arbitrary",
      "open",
      "https://example.test",
    ]);
    expect(arbitrary.status).not.toBe(0);
    expect(trace()).not.toContain("transport=");
    expect(trace()).not.toContain("starter-called");
    expect(trace()).not.toContain("native=");
    expect(trace()).not.toContain("native=");

    writeAttestation();
    const conflated = JSON.parse(readFileSync(snapshotPath, "utf8"));
    conflated.socat.pid = conflated.broker.pid;
    writeFileSync(snapshotPath, JSON.stringify(conflated), { mode: 0o600 });
    const attestationPath = join(controls, "attestation.json");
    const attestation = JSON.parse(readFileSync(attestationPath, "utf8"));
    attestation.transportProofStateSha256 = sha256(readFileSync(snapshotPath));
    writeFileSync(attestationPath, JSON.stringify(attestation), {
      mode: 0o600,
    });
    writeFileSync(tracePath, "", "utf8");
    const ownerConflation = runWorkspace([
      "--session",
      "owner-conflation",
      "open",
      "https://example.test",
    ]);
    expect(ownerConflation.status).toBe(69);
    expect(ownerConflation.stderr).toContain(
      "trusted process snapshot is invalid",
    );
    expect(trace()).not.toContain("health-authorization=");
    expect(trace()).not.toContain("native=");
    expect(trace()).not.toContain("/json");
  });

  it("premise: default Caleb and explicit Erebora are the only account routes; falsifier: inherited account or current-tab authority reaches native", () => {
    writeAttestation();
    const caleb = runWorkspace([
      "--session",
      "caleb-task",
      "open",
      "https://example.test/caleb",
    ]);
    expect(caleb.status).toBe(0);
    expect(binding("caleb-task")).toContain("account=caleb\nprofile=Default");
    expect(trace()).toContain('"email":"calebdanemusic@gmail.com"');
    expect(trace()).toContain('"profile":"Default"');
    expect(trace()).toContain('"attach":""');
    expect(trace()).toContain(
      'controller=["acquire-registered-workspace-target-lease","--session","caleb-task","--account","caleb"',
    );
    const calebAcquire = trace()
      .split("\n")
      .find((line) =>
        line.startsWith(
          'controller=["acquire-registered-workspace-target-lease"',
        ),
      );
    expect(JSON.parse(calebAcquire.slice("controller=".length))).toEqual([
      "acquire-registered-workspace-target-lease",
      "--session",
      "caleb-task",
      "--account",
      "caleb",
      "--ttl-ms",
      "30000",
      "--json",
    ]);
    expect(trace()).toContain('controller=["consume-target-receipt","--path"');
    expect(trace()).toContain('controller=["register-session"');
    expect(trace()).not.toContain('controller=["acquire-focus"');

    control(
      "targets.json",
      JSON.stringify([{ type: "page", url: "https://existing.test" }]),
    );
    writeAttestation();
    const erebora = runWorkspace([
      "--account",
      "erebora",
      "--session",
      "erebora-task",
      "open",
      "https://example.test/erebora",
    ]);
    expect(erebora.status).toBe(0);
    expect(binding("erebora-task")).toContain(
      "account=erebora\nprofile=Profile 1",
    );
    expect(trace()).toContain('"email":"ereboracrew@gmail.com"');
    expect(trace()).toContain('"profile":"Profile 1"');
    expect(trace()).toContain(
      'controller=["acquire-registered-workspace-target-lease","--session","erebora-task","--account","erebora"',
    );
    expect(trace()).not.toContain("/json");
    expect(traceCount('controller=["acquire-focus"')).toBe(0);
  });

  it("premise: healthy registered-workspace lease issuance may exceed five seconds but remains bounded; falsifier: the wrapper kills it before the controller returns", () => {
    writeAttestation();
    control("workspace-acquire-delay-ms", "5200");
    control("refresh-transport-proof-on-ensure", "1");

    const started = performance.now();
    const result = runWorkspace([
      "--session",
      "slow-workspace-acquire",
      "open",
      "https://example.test/slow-acquire",
    ]);
    const elapsed = performance.now() - started;

    expect(result.status, result.stderr).toBe(0);
    expect(elapsed).toBeGreaterThanOrEqual(5000);
    expect(elapsed).toBeLessThan(9500);
    expect(trace()).toContain(
      'controller=["acquire-registered-workspace-target-lease","--session","slow-workspace-acquire","--account","caleb","--ttl-ms","30000","--json"]',
    );
    expect(trace()).not.toContain('controller=["acquire-focus"');
  }, 12_000);

  it("premise: exact session registration may exceed five seconds while the controller re-proves the real profile, target, tab, broker, lease, and daemon; falsifier: the wrapper kills that valid lifecycle transition", () => {
    writeAttestation();
    control("registration-delay-ms", "5200");
    control("refresh-transport-proof-on-proof", "1");

    const started = performance.now();
    const result = runWorkspace([
      "--session",
      "slow-session-registration",
      "open",
      "https://example.test/slow-registration",
    ]);
    const elapsed = performance.now() - started;

    expect(result.status, result.stderr).toBe(0);
    expect(elapsed).toBeGreaterThanOrEqual(5000);
    expect(elapsed).toBeLessThan(9500);
    expect(trace()).toContain('controller=["register-session"');
    expect(trace()).not.toContain('controller=["acquire-focus"');
  }, 12_000);

  it("premise: exact registered-session proof may exceed five seconds but returns one fresh same-owner snapshot; falsifier: the wrapper kills it or enlarges the five-second evidence age", () => {
    writeAttestation();
    control("proof-delay-ms", "5200");
    control("refresh-transport-proof-on-proof", "1");

    const started = performance.now();
    const result = runWorkspace([
      "--session",
      "slow-session-proof",
      "open",
      "https://example.test/slow-proof",
    ]);
    const elapsed = performance.now() - started;

    expect(result.status, result.stderr).toBe(0);
    expect(elapsed).toBeGreaterThanOrEqual(5000);
    expect(elapsed).toBeLessThan(9500);
    expect(trace()).toContain('controller=["proof-state"');
    expect(trace()).not.toContain('controller=["acquire-focus"');
  }, 12_000);

  it("premise: successful fresh bootstrap hands authority directly from native success to controller registration and final proof; falsifier: redundant wrapper transport probes delay local ownership commit", () => {
    writeAttestation();
    const session = "registration-proof-handoff";
    const result = runWorkspace([
      "--session",
      session,
      "open",
      "https://example.test/registration-proof-handoff",
    ]);

    expect(result.status, result.stderr).toBe(0);
    const lines = trace().trim().split("\n");
    const nativeIndex = lines.findIndex((line) => {
      if (!line.startsWith("native=")) return false;
      const invocation = JSON.parse(line.slice("native=".length));
      return invocation.args.includes(session) && invocation.args.includes("open");
    });
    const registerIndex = lines.findIndex((line) =>
      line.startsWith('controller=["register-session"'),
    );
    const proofIndex = lines.findIndex((line) =>
      line.startsWith('controller=["proof-state"'),
    );
    expect(nativeIndex).toBeGreaterThanOrEqual(0);
    expect(registerIndex).toBeGreaterThan(nativeIndex);
    expect(proofIndex).toBeGreaterThan(registerIndex);
    const handoffCommands = lines
      .slice(nativeIndex + 1, proofIndex + 1)
      .filter((line) => line.startsWith("controller="))
      .map((line) => JSON.parse(line.slice("controller=".length))[0]);
    expect(handoffCommands).toEqual(["register-session", "proof-state"]);
    expect(
      existsSync(join(stateRoot, `session-${session}.task-lease`)),
    ).toBe(true);
    expect(existsSync(join(stateRoot, `session-${session}.account`))).toBe(
      true,
    );
  });

  it("premise: exact same-context descendant reconciliation may exceed five seconds while the controller re-proves the live registered root; falsifier: the wrapper kills the canonical reconciliation before it returns", () => {
    writeAttestation();
    control("reconcile-delay-ms", "5200");

    const started = performance.now();
    const result = runWorkspace([
      "--session",
      "slow-descendant-reconcile",
      "open",
      "https://example.test/slow-reconcile",
    ]);
    const elapsed = performance.now() - started;

    expect(result.status, result.stderr).toBe(0);
    expect(elapsed).toBeGreaterThanOrEqual(5000);
    expect(elapsed).toBeLessThan(9500);
    expect(trace()).toContain('controller=["discover-owned-descendants"');
    expect(trace()).not.toContain('controller=["acquire-focus"');
  }, 12_000);

  it("premise: a healthy controller transition can cross the 15-second default age while the exact daemon still enforces the supported 30-second lifetime; falsifier: the wrapper requests the short default, kills consumption, or weakens daemon freshness", () => {
    writeAttestation();
    control("consume-delay-ms", "5200");
    control("workspace-receipt-issued-age-ms", "14000");
    control("refresh-transport-proof-on-proof", "1");

    const started = performance.now();
    const result = runWorkspace([
      "--session",
      "slow-workspace-consume",
      "open",
      "https://example.test/slow-consume",
    ]);
    const elapsed = performance.now() - started;

    expect(result.status, result.stderr).toBe(0);
    expect(elapsed).toBeGreaterThanOrEqual(5000);
    expect(elapsed).toBeLessThan(9500);
    expect(trace()).toContain(
      'controller=["consume-target-receipt","--path"',
    );
    expect(trace()).toContain('"--ttl-ms","30000"');
    expect(trace()).not.toContain('controller=["acquire-focus"');
  }, 12_000);

  it("premise: an expiring bounded broker capability transparently reacquires only the same persistent workspace in the background; falsifier: the target changes, focus is acquired, or stale authority survives", () => {
    writeAttestation();
    const session = "capability-reacquire";
    const first = runWorkspace(["--session", session, "snapshot", "-i"]);
    expect(first.status).toBe(0);
    const taskPath = join(stateRoot, `session-${session}.task-lease`);
    const before = JSON.parse(readFileSync(taskPath, "utf8"));
    const oldPid = before.pid;
    const oldAuthorizationPath = before.brokerAuthorizationPath;
    before.brokerCapabilityExpiresAt = new Date(
      Date.now() + 1_000,
    ).toISOString();
    writeFileSync(taskPath, JSON.stringify(before) + "\n", { mode: 0o600 });
    chmodSync(taskPath, 0o600);
    writeFileSync(tracePath, "", "utf8");

    const second = runWorkspace(["--session", session, "snapshot", "-i"]);
    expect(second.status).toBe(0);
    const after = JSON.parse(readFileSync(taskPath, "utf8"));
    expect(after.schema).toBe("agent-browser.task-lease.v5");
    expect(after.targetId).toBe(before.targetId);
    expect(after.browserContextId).toBe(before.browserContextId);
    expect(after.profileBinding).toBe(before.profileBinding);
    expect(after.pid).not.toBe(oldPid);
    expect(after.brokerAuthorizationLeaseId).not.toBe(
      before.brokerAuthorizationLeaseId,
    );
    expect(existsSync(oldAuthorizationPath)).toBe(false);
    expect(Date.parse(after.brokerCapabilityExpiresAt)).toBeGreaterThan(
      Date.now() + 30 * 60_000,
    );
    const releasedAt = trace().indexOf('controller=["release-session"');
    const reacquiredAt = trace().indexOf(
      'controller=["acquire-registered-workspace-target-lease"',
    );
    expect(releasedAt).toBeGreaterThanOrEqual(0);
    expect(reacquiredAt).toBeGreaterThan(releasedAt);
    expect(trace()).not.toContain('controller=["acquire-focus"');
    expect(trace()).not.toContain("activate");
  });

  it("premise: an expiring explicitly selected user tab is never silently reacquired; falsifier: its daemon, registration, or target ownership changes", () => {
    const authority = writeAttestation();
    const session = "user-capability-expiry";
    const selected = pendingLease(
      session,
      authority,
      "caleb",
      randomNonce(),
      "user-adopted",
    );
    const first = run([
      "--session",
      session,
      "--target-lease",
      selected.path,
      "snapshot",
      "-i",
    ]);
    expect(first.status).toBe(0);
    const taskPath = join(stateRoot, `session-${session}.task-lease`);
    const before = JSON.parse(readFileSync(taskPath, "utf8"));
    before.brokerCapabilityExpiresAt = new Date(
      Date.now() + 1_000,
    ).toISOString();
    writeFileSync(taskPath, JSON.stringify(before) + "\n", { mode: 0o600 });
    chmodSync(taskPath, 0o600);
    writeFileSync(tracePath, "", "utf8");

    const second = run(["--session", session, "snapshot", "-i"]);
    expect(second.status).toBe(69);
    expect(second.stderr).toContain("TARGET_RESELECTION_REQUIRED");
    expect(JSON.parse(readFileSync(taskPath, "utf8")).pid).toBe(before.pid);
    expect(existsSync(`/proc/${before.pid}`)).toBe(true);
    expect(trace()).not.toContain('controller=["release-session"');
    expect(trace()).not.toContain(
      'controller=["acquire-registered-workspace-target-lease"',
    );
    expect(trace()).not.toContain("native=");
  });

  it("premise: the pinned controller stays behind its executable Bash launcher; falsifier: runController selects the Python implementation that Bash cannot execute", () => {
    const wrapperSource = readFileSync(
      join(sourceRoot, "scripts", "agent-browser-wrapper.js"),
      "utf8",
    );
    expect(wrapperSource).toContain(
      'const FIXED_CONTROLLER_BIN = "/home/cabule/.ai-controller/bin/browser-runtime";',
    );
    expect(wrapperSource).toContain(
      '"c1865f356acc304ba54a2698a5bf50aca2252c6a648561eae3cf7215e34cda12";',
    );
    expect(wrapperSource).not.toContain(
      "/home/cabule/.codex/candidates/browser-runtime-repair-20260824/ai-controller/browser_runtime_platform.py",
    );

    writeAttestation();
    const result = runWorkspace([
      "--session",
      "bash-controller-launcher",
      "open",
      "https://example.test",
    ]);
    expect(result.status).toBe(0);
    expect(trace()).toContain(
      'controller=["ensure-supported-existing-transport"',
    );
  });

  it("premise: controller JSON uses one canonical success stream or one canonical failure stream; falsifier: valid failure diagnostics are discarded or ambiguous output is trusted", () => {
    writeAttestation();
    const statusPath = join(controls, "controller-injected-status");
    const stdoutPath = join(controls, "controller-injected-stdout");
    const stderrPath = join(controls, "controller-injected-stderr");
    const setOutcome = ({ status, stdout = "", stderr = "" }) => {
      writeFileSync(statusPath, String(status), "utf8");
      if (stdout) writeFileSync(stdoutPath, stdout, "utf8");
      else rmSync(stdoutPath, { force: true });
      if (stderr) writeFileSync(stderrPath, stderr, "utf8");
      else rmSync(stderrPath, { force: true });
    };
    const invoke = (session) =>
      runWorkspace([
        "--session",
        session,
        "open",
        "https://example.test",
      ]);
    const canonicalFailure = `${JSON.stringify({
      ok: false,
      status: "existing_chrome_not_ready",
      reason: "Existing Chrome is unavailable; token=CONTROLLERSECRET",
    })}\n`;

    setOutcome({ status: 1, stderr: canonicalFailure });
    const failure = invoke("canonical-controller-failure");
    expect(failure.status).toBe(69);
    expect(failure.stdout).toBe("");
    expect(failure.stderr).toContain("existing_chrome_not_ready");
    expect(failure.stderr).toContain("Existing Chrome is unavailable");
    expect(failure.stderr).not.toContain("CONTROLLERSECRET");
    expect(trace()).not.toContain("native=");

    const invalid = [
      {
        name: "mixed-streams",
        status: 1,
        stdout: '{"ok":true}\n',
        stderr: canonicalFailure,
      },
      { name: "other-status", status: 2, stderr: canonicalFailure },
      { name: "malformed", status: 1, stderr: "not-json\n" },
      {
        name: "multiple-lines",
        status: 1,
        stderr: `${canonicalFailure}${canonicalFailure}`,
      },
      {
        name: "oversized",
        status: 1,
        stderr: `${JSON.stringify({
          ok: false,
          status: "oversized_controller_failure",
          reason: "x".repeat(17 * 1024),
        })}\n`,
      },
    ];
    for (const outcome of invalid) {
      setOutcome(outcome);
      const result = invoke(`noncanonical-${outcome.name}`);
      expect(result.status, outcome.name).toBe(69);
      expect(result.stderr, outcome.name).toContain("TRANSPORT_FAILURE");
      expect(result.stderr, outcome.name).not.toContain(
        "existing_chrome_not_ready",
      );
      expect(trace(), outcome.name).not.toContain("native=");
    }

    rmSync(statusPath, { force: true });
    rmSync(stdoutPath, { force: true });
    rmSync(stderrPath, { force: true });
  });

  it("premise: Chrome-owned setup, reconnect, and broker failures are distinct and never auto-attach; falsifier: a diagnostic reaches workspace acquisition, health, or native", () => {
    writeAttestation();
    const cases = [
      ["chrome-setup-consent-required", "CHROME_SETUP_CONSENT_REQUIRED"],
      [
        "chrome-reconnect-consent-required",
        "CHROME_RECONNECT_CONSENT_REQUIRED",
      ],
      ["transport-failure", "TRANSPORT_FAILURE"],
    ];
    for (const [state, diagnostic] of cases) {
      control("transport-state", state);
      writeFileSync(tracePath, "", "utf8");
      const result = run([
        "--session",
        `diagnostic-${state}`,
        "open",
        "https://example.test",
      ]);
      expect(result.status).toBe(69);
      expect(result.stderr).toContain(diagnostic);
      expect(trace()).toContain("ensure-supported-existing-transport");
      expect(trace()).toContain('"--broker-source-path"');
      expect(trace()).not.toContain("attest-supported-existing-transport");
      expect(trace()).not.toContain(
        "acquire-registered-workspace-target-lease",
      );
      expect(trace()).not.toContain("transport=");
      expect(trace()).not.toContain("native=");
    }
  });

  it("premise: a missing registered workspace requires controller reprovision and never creates, activates, focuses, or substitutes a target; falsifier: any browser action runs", () => {
    writeAttestation();
    control("workspace-missing", "1");
    const result = run([
      "--session",
      "missing-workspace",
      "open",
      "https://example.test",
    ]);

    expect(result.status).toBe(69);
    expect(result.stderr).toContain("TARGET_REPROVISION_REQUIRED");
    expect(trace()).toContain(
      'controller=["acquire-registered-workspace-target-lease"',
    );
    expect(trace()).not.toContain('controller=["acquire-focus"');
    expect(trace()).not.toContain("create-target");
    expect(trace()).not.toContain("activate");
    expect(trace()).not.toContain("consume-target-receipt");
    expect(trace()).not.toContain("transport=");
    expect(trace()).not.toContain("native=");
  });

  it("premise: transport reproof failing after workspace issue retires the exact unconsumed same-session lease; falsifier: the primary failure is masked, broker authorization survives, or native work begins", () => {
    writeAttestation();
    control(
      "post-acquire-transport-failure.json",
      `${JSON.stringify({
        ok: false,
        status: "stable_devtools_authority_unavailable",
        reason: "Exact Windows LocalApplicationData authority is unavailable",
      })}\n`,
    );
    const result = run([
      "--session",
      "preclaim-cleanup-red",
      "open",
      "https://example.test",
    ]);

    expect(result.status).toBe(69);
    expect(result.stderr).toContain("stable_devtools_authority_unavailable");
    expect(result.stderr).not.toContain("CLEANUP_INCOMPLETE");
    expect(trace()).toContain(
      'controller=["acquire-registered-workspace-target-lease"',
    );
    expect(trace()).toContain('controller=["release-workspace"');
    expect(trace()).not.toContain('controller=["consume-target-receipt"');
    expect(trace()).not.toContain("native=");
    expect(
      existsSync(join(controls, "workspace-lease-caleb.json")),
    ).toBe(false);
    expect(readdirSync(join(endpointDirectory(), "broker-auth"))).toEqual([]);
  });

  it("premise: a terminal same-session pre-claim lease receives one structured retirement and reacquires the identical persistent workspace; falsifier: a foreign lease is stolen, recovery loops, target identity changes, focus moves, or residue survives close", () => {
    writeAttestation();
    control(
      "post-acquire-transport-failure.json",
      `${JSON.stringify({
        ok: false,
        status: "stable_devtools_authority_unavailable",
        reason: "Exact Windows LocalApplicationData authority is unavailable",
      })}\n`,
    );
    control("release-workspace-busy-count", "1");
    const first = run([
      "--session",
      "preclaim-recovery-red",
      "open",
      "https://example.test",
    ]);

    expect(first.status).toBe(69);
    expect(first.stderr).toContain("stable_devtools_authority_unavailable");
    expect(first.stderr).toContain("CLEANUP_INCOMPLETE");
    expect(first.stderr).toContain("workspace_release_busy");
    expect(existsSync(join(controls, "workspace-lease-caleb.json"))).toBe(
      true,
    );
    expect(readdirSync(join(endpointDirectory(), "broker-auth"))).toHaveLength(
      1,
    );

    const releasesBeforeForeign = traceCount(
      'controller=["release-workspace"',
    );
    const foreign = run([
      "--session",
      "foreign-preclaim-contender",
      "open",
      "https://example.test",
    ]);
    expect(foreign.status).toBe(69);
    expect(foreign.stderr).toContain("workspace_leased");
    expect(traceCount('controller=["release-workspace"')).toBe(
      releasesBeforeForeign,
    );
    expect(existsSync(join(controls, "workspace-lease-caleb.json"))).toBe(
      true,
    );

    const recovered = runWorkspace([
      "--session",
      "preclaim-recovery-red",
      "open",
      "https://example.test",
    ]);
    expect(recovered.status).toBe(0);
    expect(traceCount('controller=["acquire-registered-workspace-target-lease"')).toBe(
      4,
    );
    expect(traceCount('controller=["release-workspace"')).toBe(2);
    expect(trace()).not.toContain('controller=["acquire-focus"');
    expect(trace()).not.toContain("activate");
    expect(readdirSync(join(endpointDirectory(), "broker-auth"))).toHaveLength(
      1,
    );

    const closed = run([
      "--session",
      "preclaim-recovery-red",
      "close",
    ]);
    expect(closed.status).toBe(0);
    expect(existsSync(join(controls, "workspace-lease-caleb.json"))).toBe(
      false,
    );
    expect(readdirSync(join(endpointDirectory(), "broker-auth"))).toEqual([]);
  });

  it("premise: same-session workspace recovery requires the exact bootstrap lock and a still-closed complete local namespace immediately before retirement; falsifier: a raced namespace can release controller ownership", () => {
    writeAttestation();
    control(
      "post-acquire-transport-failure.json",
      `${JSON.stringify({
        ok: false,
        status: "stable_devtools_authority_unavailable",
        reason: "Exact Windows LocalApplicationData authority is unavailable",
      })}\n`,
    );
    control("release-workspace-busy-count", "1");
    const first = run([
      "--session",
      "preclaim-namespace-race",
      "open",
      "https://example.test",
    ]);
    expect(first.status).toBe(69);
    expect(first.stderr).toContain("workspace_release_busy");

    const releasesBeforeRace = traceCount(
      'controller=["release-workspace"',
    );
    control("workspace-recovery-namespace-race", "1");
    const raced = run([
      "--session",
      "preclaim-namespace-race",
      "open",
      "https://example.test",
    ]);

    expect(raced.status).toBe(65);
    expect(raced.stderr).toContain(
      "session namespace changed under exact bootstrap ownership",
    );
    expect(traceCount('controller=["release-workspace"')).toBe(
      releasesBeforeRace,
    );
    expect(
      existsSync(join(controls, "workspace-lease-caleb.json")),
    ).toBe(true);
    expect(readdirSync(join(endpointDirectory(), "broker-auth"))).toHaveLength(
      1,
    );
    expect(
      existsSync(
        join(stateRoot, "session-preclaim-namespace-race.focus-lease"),
      ),
    ).toBe(true);
    expect(trace()).not.toContain('controller=["acquire-focus"');
    expect(trace()).not.toContain("activate");
    expect(trace()).not.toContain("native=");
  });

  it("premise: failed exact session registration waits for a healthy slow abort and rolls back only the task daemon and consumed client lease; falsifier: the original failure is masked, ownership commits, broker stops, or authorization survives", () => {
    writeAttestation();
    control("registration-error", "1");
    control("release-target-delay-ms", "5200");
    const result = run([
      "--session",
      "registration-red",
      "open",
      "https://example.test",
    ]);

    expect(result.status).toBe(69);
    expect(result.stderr).toContain("SESSION_REGISTRATION_FAILED");
    expect(trace()).toContain('controller=["register-session"');
    expect(trace()).toContain("native-close=registration-red");
    expect(trace()).toContain('controller=["release-target-lease"');
    expect(trace()).not.toContain('controller=["release-session"');
    expect(trace()).not.toContain("broker-stop");
    expect(
      existsSync(join(stateRoot, "session-registration-red.account")),
    ).toBe(false);
    expect(
      existsSync(join(stateRoot, "session-registration-red.task-lease")),
    ).toBe(false);
    expect(existsSync(join(stateRoot, "registration-red.sock"))).toBe(false);
    expect(readdirSync(join(endpointDirectory(), "broker-auth"))).toEqual([]);
  }, 12_000);

  it("premise: a post-registration proof failure releases only after the exact delayed daemon/socket is terminal and retries only a canonical transient; falsifier: the proof error is masked, release runs early, residue survives, focus changes, or another session is touched", () => {
    writeAttestation();
    control(
      "session-proof-overrides.json",
      JSON.stringify({ transportProofStateSha256: "9".repeat(64) }),
    );
    control("daemon-stop-delay-ms", "1200");
    control("release-session-busy-count", "1");
    mkdirSync(stateRoot, { mode: 0o700 });
    const neighborBinding = join(
      stateRoot,
      "session-cleanup-neighbor.account",
    );
    const neighborLease = join(
      stateRoot,
      "session-cleanup-neighbor.task-lease",
    );
    const focusMarker = join(controls, "focus-cleanup-neighbor.json");
    writeFileSync(neighborBinding, "neighbor-binding\n", { mode: 0o600 });
    writeFileSync(neighborLease, "neighbor-lease\n", { mode: 0o600 });
    writeFileSync(focusMarker, '{"focus":"unchanged"}\n', { mode: 0o600 });

    const result = runWorkspace([
      "--session",
      "proof-cleanup-red",
      "open",
      "https://example.test",
    ]);

    expect(result.status).toBe(65);
    expect(result.stderr).toContain("trusted controller proof hash mismatched");
    expect(result.stderr).not.toContain("CLEANUP_INCOMPLETE");
    expect(trace()).toContain("native-close=proof-cleanup-red");
    expect(traceCount('controller=["release-session"')).toBe(2);
    expect(traceCount("release-session-exact-dead=proof-cleanup-red")).toBe(2);
    expect(trace()).not.toContain(
      "release-session-before-exact-dead=proof-cleanup-red",
    );
    for (const suffix of ["sock", "pid", "daemon-identity"]) {
      expect(existsSync(join(stateRoot, `proof-cleanup-red.${suffix}`))).toBe(
        false,
      );
    }
    expect(
      existsSync(join(stateRoot, "session-proof-cleanup-red.account")),
    ).toBe(false);
    expect(
      existsSync(join(stateRoot, "session-proof-cleanup-red.task-lease")),
    ).toBe(false);
    expect(readdirSync(join(endpointDirectory(), "broker-auth"))).toEqual([]);
    expect(readFileSync(neighborBinding, "utf8")).toBe("neighbor-binding\n");
    expect(readFileSync(neighborLease, "utf8")).toBe("neighbor-lease\n");
    expect(readFileSync(focusMarker, "utf8")).toBe(
      '{"focus":"unchanged"}\n',
    );
  }, 12_000);

  it("premise: failed-session cleanup is bounded and never hides the primary failure; falsifier: retries are unbounded, cleanup residue is silent, or the proof error is replaced", () => {
    writeAttestation();
    control(
      "session-proof-overrides.json",
      JSON.stringify({ transportProofStateSha256: "9".repeat(64) }),
    );
    control("daemon-stop-delay-ms", "1200");
    control("release-session-busy-count", "99");

    const result = runWorkspace([
      "--session",
      "proof-cleanup-incomplete",
      "open",
      "https://example.test",
    ]);

    expect(result.status).toBe(65);
    const primaryIndex = result.stderr.indexOf(
      "trusted controller proof hash mismatched",
    );
    const cleanupIndex = result.stderr.indexOf("CLEANUP_INCOMPLETE");
    expect(primaryIndex).toBeGreaterThanOrEqual(0);
    expect(cleanupIndex).toBeGreaterThan(primaryIndex);
    expect(result.stderr).toContain("session_release_busy");
    expect(traceCount('controller=["release-session"')).toBe(3);
    expect(
      traceCount("release-session-exact-dead=proof-cleanup-incomplete"),
    ).toBe(3);
    expect(trace()).not.toContain(
      "release-session-before-exact-dead=proof-cleanup-incomplete",
    );
    for (const suffix of ["sock", "pid", "daemon-identity"]) {
      expect(
        existsSync(join(stateRoot, `proof-cleanup-incomplete.${suffix}`)),
      ).toBe(false);
    }
    expect(
      existsSync(
        join(stateRoot, "session-proof-cleanup-incomplete.account"),
      ),
    ).toBe(false);
    expect(
      existsSync(
        join(stateRoot, "session-proof-cleanup-incomplete.task-lease"),
      ),
    ).toBe(false);
    expect(readdirSync(join(endpointDirectory(), "broker-auth"))).toHaveLength(
      1,
    );
  }, 12_000);

  it("premise: post-registration proof renews only the exact proof path monotonically; falsifier: a foreign path, hash, or regressed observation commits task ownership", () => {
    const authority = writeAttestation();
    const cases = [
      {
        override: {
          transportProofStatePath: join(
            endpointDirectory(),
            "profile-attestation",
            "foreign-proof.json",
          ),
        },
        diagnostic: "controller returned a mismatched registered session proof",
      },
      {
        override: { transportProofStateSha256: "9".repeat(64) },
        diagnostic: "trusted controller proof hash mismatched",
      },
      {
        override: {
          transportProofObservedAtMs:
            authority.attestation.transportProofObservedAtMs - 1,
        },
        diagnostic: "controller returned a mismatched registered session proof",
      },
    ];
    for (const [index, testCase] of cases.entries()) {
      const session = `foreign-proof-${index}`;
      control(
        "session-proof-overrides.json",
        JSON.stringify(testCase.override),
      );
      writeFileSync(tracePath, "", "utf8");
      const result = runWorkspace([
        "--session",
        session,
        "open",
        "https://example.test",
      ]);
      expect(result.status).toBe(65);
      expect(result.stderr).toContain(testCase.diagnostic);
      expect(trace()).toContain('controller=["proof-state"');
      expect(trace()).toContain('controller=["release-session"');
      expect(trace()).toContain(`native-close=${session}`);
      expect(existsSync(join(stateRoot, `session-${session}.account`))).toBe(
        false,
      );
      expect(existsSync(join(stateRoot, `session-${session}.task-lease`))).toBe(
        false,
      );
    }
  });

  it("premise: renewed registered-session proof preserves every four-owner byte except observation time and remains five-second fresh; falsifier: a stale or rotated owner commits task ownership", () => {
    const cases = [
      {
        session: "stale-renewed-proof",
        expectedStatus: 69,
        controls: [["proof-delay-ms", "5200"]],
        diagnostic: "trusted process snapshot is invalid",
      },
      {
        session: "rotated-renewed-proof",
        expectedStatus: 65,
        controls: [
          ["refresh-transport-proof-on-proof", "1"],
          [
            "proof-broker-overrides.json",
            JSON.stringify({ brokerGeneration: "7".repeat(64) }),
          ],
        ],
        diagnostic: "registered session transport proof mismatched",
      },
    ];
    for (const testCase of cases) {
      writeAttestation();
      for (const [name, value] of testCase.controls) control(name, value);
      writeFileSync(tracePath, "", "utf8");
      const result = runWorkspace([
        "--session",
        testCase.session,
        "open",
        "https://example.test",
      ]);
      expect(result.status).toBe(testCase.expectedStatus);
      expect(result.stderr).toContain(testCase.diagnostic);
      expect(trace()).toContain('controller=["proof-state"');
      expect(trace()).toContain('controller=["release-session"');
      expect(trace()).toContain(`native-close=${testCase.session}`);
      expect(
        existsSync(join(stateRoot, `session-${testCase.session}.account`)),
      ).toBe(false);
      expect(
        existsSync(join(stateRoot, `session-${testCase.session}.task-lease`)),
      ).toBe(false);
      for (const [name] of testCase.controls) rmSync(join(controls, name));
    }
  }, 12_000);

  it("premise: failed opener-lineage reconciliation is red after ownership commit and preserves evidence; falsifier: it silently succeeds or tears down the session", () => {
    writeAttestation();
    control("reconcile-error", "1");
    const result = run([
      "--session",
      "reconcile-red",
      "open",
      "https://example.test",
    ]);

    expect(result.status).toBe(69);
    expect(result.stderr).toContain("TARGET_RECONCILIATION_REQUIRED");
    expect(trace()).toContain('controller=["register-session"');
    expect(trace()).toContain('controller=["discover-owned-descendants"');
    expect(trace()).not.toContain("native-close=reconcile-red");
    const task = JSON.parse(
      readFileSync(join(stateRoot, "session-reconcile-red.task-lease"), "utf8"),
    );
    expect(existsSync(join(stateRoot, "session-reconcile-red.account"))).toBe(
      true,
    );
    expect(existsSync(join(stateRoot, "reconcile-red.sock"))).toBe(true);
    expect(existsSync(task.brokerAuthorizationPath)).toBe(true);

    rmSync(join(controls, "reconcile-error"));
    expect(run(["--session", "reconcile-red", "close"]).status).toBe(0);
    expect(existsSync(task.brokerAuthorizationPath)).toBe(false);
  });

  it("premise: account binding commits after successful establishment and is rolled back with its invocation; falsifier: failed Erebora poisons later default Caleb", () => {
    writeAttestation();
    control("native-status", "7");
    const failed = runWorkspace([
      "--account",
      "erebora",
      "--session",
      "transaction",
      "open",
      "https://example.test/fail",
    ]);
    expect(failed.status).not.toBe(0);
    expect(existsSync(join(stateRoot, "session-transaction.account"))).toBe(
      false,
    );
    expect(existsSync(join(stateRoot, "session-transaction.task-lease"))).toBe(
      false,
    );
    expect(trace()).toContain("native-close=transaction");

    rmSync(join(controls, "native-status"));
    writeAttestation();
    const recovered = runWorkspace([
      "--session",
      "transaction",
      "open",
      "https://example.test/recovered",
    ]);
    expect(recovered.status).toBe(0);
    expect(binding("transaction")).toContain("account=caleb\nprofile=Default");

    const before = traceCount("native=");
    const conflict = run([
      "--account",
      "erebora",
      "--session",
      "transaction",
      "snapshot",
    ]);
    expect(conflict.status).toBe(65);
    expect(conflict.stderr).toContain("bound to caleb");
    expect(traceCount("native=")).toBe(before);
  });

  it("premise: a final cache-write failure preserves the committed live ownership receipt; falsifier: the daemon becomes unowned or cannot be closed", () => {
    writeAttestation();
    control("cache-write-failure", "1");

    const result = runWorkspace([
      "--session",
      "cache-fault",
      "open",
      "https://example.test",
    ]);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("secure state transaction failed");
    expect(existsSync(join(stateRoot, "session-cache-fault.account"))).toBe(
      true,
    );
    expect(existsSync(join(stateRoot, "session-cache-fault.task-lease"))).toBe(
      true,
    );
    expect(existsSync(join(stateRoot, "cache-fault.sock"))).toBe(true);
    expect(trace()).not.toContain("native-close=cache-fault");

    rmSync(join(controls, "cache-write-failure"));
    rmSync(join(stateRoot, "supported-existing-transport.receipt"), {
      recursive: true,
    });
    expect(run(["--session", "cache-fault", "close"]).status).toBe(0);
  });

  it("premise: native cache skips only the live version launch, never the exact byte hash; falsifier: weak-mode, symlink, or forged replacement passes", () => {
    const first = run(["--version"]);
    const second = run(["--version"]);
    expect(first.status).toBe(0);
    expect(second.status).toBe(0);
    expect(traceCount('"args":["--version"]')).toBe(1);

    const receiptPath = join(stateRoot, "native-revision.receipt");
    chmodSync(receiptPath, 0o644);
    expect(run(["--version"]).status).not.toBe(0);
    chmodSync(receiptPath, 0o600);

    const receiptRaw = readFileSync(receiptPath);
    const receiptTarget = join(fixtureRoot, "receipt-target");
    writeFileSync(receiptTarget, receiptRaw, { mode: 0o600 });
    rmSync(receiptPath);
    symlinkSync(receiptTarget, receiptPath);
    expect(run(["--version"]).status).not.toBe(0);
    rmSync(receiptPath);

    const binaryPath = join(fixtureRepo, "bin", "agent-browser-linux-x64");
    const manifestPath = join(
      fixtureRepo,
      "scripts",
      "canonical-native-release.json",
    );
    const manifestRaw = readFileSync(manifestPath);
    const manifest = JSON.parse(manifestRaw.toString("utf8"));
    const forged = Buffer.alloc(manifest.size, 0x20);
    Buffer.from(
      "#!/usr/bin/bash\n/usr/bin/printf 'agent-browser 0.13.0\\n'\nexit 0\n#",
    ).copy(forged);
    writeFileSync(binaryPath, forged);
    chmodSync(binaryPath, 0o755);
    const info = statSync(binaryPath, { bigint: true });
    const forgedReceipt = {
      schema: "agent-browser.native-revision.v2",
      manifestSha256: sha256(manifestRaw),
      binarySha256: manifest.sha256,
      platform: "linux-x64",
      versionOutput: "agent-browser 0.13.0",
      binaryStat: {
        dev: info.dev.toString(),
        ino: info.ino.toString(),
        size: info.size.toString(),
        mtimeNs: info.mtimeNs.toString(),
        ctimeNs: info.ctimeNs.toString(),
      },
    };
    writeFileSync(receiptPath, `${canonical(forgedReceipt)}\n`, {
      mode: 0o600,
    });
    chmodSync(receiptPath, 0o600);
    const replaced = run(["--version"]);
    expect(replaced.status).toBe(70);
    expect(replaced.stderr).toContain("binary hash mismatched");
  });

  it("premise: concurrent first-use revision handshakes converge on one exact receipt; falsifier: either safe caller loses the race", async () => {
    const invoke = () =>
      new Promise((resolveResult) => {
        const child = spawn(wrapper, ["--version"], {
          env: hostileEnv(),
          stdio: ["ignore", "pipe", "pipe"],
        });
        let stdout = "";
        let stderr = "";
        child.stdout.on("data", (chunk) => {
          stdout += chunk.toString("utf8");
        });
        child.stderr.on("data", (chunk) => {
          stderr += chunk.toString("utf8");
        });
        child.on("close", (status) =>
          resolveResult({ status, stdout, stderr }),
        );
      });

    const results = await Promise.all([invoke(), invoke()]);
    expect(results.map((result) => result.status)).toEqual([0, 0]);
    expect(results.map((result) => result.stdout)).toEqual([
      "agent-browser 0.13.0\n",
      "agent-browser 0.13.0\n",
    ]);
    expect(results.map((result) => result.stderr)).toEqual(["", ""]);
    expect(
      statSync(join(stateRoot, "native-revision.receipt")).mode & 0o777,
    ).toBe(0o600);
  });

  it("premise: secure warm actions remain lightweight; falsifier: fixture p50 exceeds 250 ms without browser launch", () => {
    writeAttestation();
    expect(
      runWorkspace(["--session", "timing", "open", "https://example.test"])
        .status,
    ).toBe(0);
    expect(run(["--session", "timing", "snapshot", "-i"]).status).toBe(0);

    const samples = [];
    for (let index = 0; index < 9; index += 1) {
      const started = performance.now();
      const result = run(["--session", "timing", "snapshot", "-i"]);
      samples.push(performance.now() - started);
      expect(result.status).toBe(0);
    }
    samples.sort((left, right) => left - right);
    const p50 = samples[Math.floor(samples.length / 2)];
    console.info(`WRAPPER_FIXTURE_WARM_ACTION_P50_MS=${p50.toFixed(2)}`);
    expect(p50).toBeLessThan(250);
  });

  it("premise: only a dead, byte-exact bootstrap lock may be recovered; falsifier: a crash permanently blocks a fresh unique session", () => {
    mkdirSync(stateRoot, { mode: 0o700 });
    chmodSync(stateRoot, 0o700);
    const stale = {
      schema: "agent-browser.bootstrap-lock.v1",
      session: "after-crash",
      account: "caleb",
      pid: 2147483647,
      startTicks: "1",
      nonce: "b".repeat(64),
    };
    writeFileSync(
      join(stateRoot, "session-after-crash.bootstrap-lock"),
      `${canonical(stale)}\n`,
      { mode: 0o600 },
    );
    writeAttestation();

    const result = runWorkspace([
      "--session",
      "after-crash",
      "open",
      "https://example.test",
    ]);
    expect(result.status).toBe(0);
    expect(
      existsSync(join(stateRoot, "session-after-crash.bootstrap-lock")),
    ).toBe(false);
    expect(binding("after-crash")).toContain("account=caleb");
  });

  it("premise: the exact daemon PID and socket may precede its identity link; falsifier: the supported listen-callback race rejects the exact child", () => {
    control("daemon-identity-delay-ms", "150");
    writeAttestation();

    const result = runWorkspace([
      "--session",
      "identity-publication-race",
      "open",
      "https://example.test",
    ]);

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(
      existsSync(
        join(stateRoot, "identity-publication-race.daemon-identity"),
      ),
    ).toBe(true);
    expect(trace()).toContain("daemon-start=identity-publication-race");
  });

  it("premise: a target claim is exact, one-use, and tombstoned by the engine; falsifier: pending survives, consumed is reused, or replay reaches native", () => {
    const authority = writeAttestation();
    const claim = pendingLease(
      "handoff",
      authority,
      "caleb",
      "a".repeat(64),
      "user-adopted",
    );
    const attached = run([
      "--session",
      "handoff",
      "--target-lease",
      claim.path,
      "snapshot",
      "-i",
    ]);
    expect(attached.stderr).toBe("");
    expect(attached.status).toBe(0);
    expect(existsSync(claim.path)).toBe(false);
    expect(
      existsSync(
        join(
          endpointDirectory(),
          "target-leases",
          "consumed",
          `${claim.nonce}.json`,
        ),
      ),
    ).toBe(false);
    const tombstone = join(
      endpointDirectory(),
      "target-leases",
      "daemon-consumed",
      claim.nonce,
      "receipt.json",
    );
    expect(JSON.parse(readFileSync(tombstone, "utf8"))).toEqual({
      schema: "agent-browser.target-claim-envelope.v2",
      receipt: claim.receipt,
    });
    expect(
      Object.keys(JSON.parse(readFileSync(tombstone, "utf8"))).sort(),
    ).toEqual(["receipt", "schema"]);
    expect(trace()).toContain('controller=["consume-target-receipt","--path"');
    expect(trace()).toContain('controller=["register-session"');
    expect(trace()).toContain('controller=["discover-owned-descendants"');
    const daemonTransport = trace()
      .split("\n")
      .find((line) => line.startsWith("daemon-transport="));
    const daemonBinding = JSON.parse(
      daemonTransport.slice("daemon-transport=".length),
    );
    expect(daemonBinding.webSocketUrl).toBe(
      `ws://127.0.0.1:${port}/cdp/${authority.transportGeneration}`,
    );
    expect(daemonBinding.browserGeneration).toBe(authority.browserGeneration);
    expect(daemonBinding.transportGeneration).toBe(
      authority.transportGeneration,
    );
    expect(daemonBinding.browserContextId).toBe("");
    expect(daemonBinding.profileBinding).toBe("");
    expect(daemonBinding.targetLeaseKind).toBe("");
    expect(daemonBinding.authorizationLeaseId).toBe("");
    expect(daemonBinding.authorizationPath).toBe("");
    expect(daemonBinding.authorizationSha256).toBe("");
    expect(daemonBinding.secretDeleted).toBe(true);
    expect(daemonBinding.receiptDeleted).toBe(true);
    expect(daemonBinding.claimDeleted).toBe(true);
    expect(daemonBinding.authorizationHeaderSha256).toBe(
      sha256(claim.authorization.slice("Authorization: ".length, -1)),
    );
    expect(trace()).not.toContain(brokerToken);
    const nativeAction = trace()
      .split("\n")
      .find(
        (line) => line.startsWith("native=") && line.includes('"snapshot"'),
      );
    const nativeBinding = JSON.parse(nativeAction.slice("native=".length));
    expect(nativeBinding.receipt).toBe(canonical(claim.receipt));
    expect(nativeBinding.args).toContain(
      `ws://127.0.0.1:${port}/cdp/${authority.transportGeneration}`,
    );
    expect(trace()).toContain(`"${claim.path}"`);
    expect(trace()).not.toContain("acquire-registered-workspace-target-lease");

    expect(run(["--session", "handoff", "close"]).status).toBe(0);
    expect(existsSync(claim.lease.brokerAuthorizationPath)).toBe(false);
    control("trace-reset", "");
    writeFileSync(tracePath, "", "utf8");
    const replay = run([
      "--session",
      "handoff",
      "--target-lease",
      claim.path,
      "snapshot",
    ]);
    expect(replay.status).not.toBe(0);
    expect(replay.stderr).toContain("already consumed");
    expect(trace()).not.toContain("consume-target-receipt");
    expect(trace()).not.toContain('"args":["--cdp"');
  });

  it("premise: a controller path and per-lease authorization are immutable exact capabilities; falsifier: another endpoint, changed header, or caller environment reaches health/consume/native", () => {
    const authority = writeAttestation();
    const wrongEndpointPath = join(
      controllerRoot,
      "endpoints",
      "forged-endpoint",
      "target-leases",
      "pending",
      `${"2".repeat(64)}.json`,
    );
    const wrongEndpoint = run([
      "--session",
      "wrong-endpoint",
      "--target-lease",
      wrongEndpointPath,
      "snapshot",
      "-i",
    ]);
    expect(wrongEndpoint.status).toBe(65);
    expect(wrongEndpoint.stderr).toContain("exact pending authority directory");
    expect(trace()).not.toContain("consume-target-receipt");
    expect(trace()).not.toContain("transport=");
    expect(trace()).not.toContain("native=");

    writeFileSync(tracePath, "", "utf8");
    const lease = pendingLease(
      "changed-auth",
      authority,
      "caleb",
      "3".repeat(64),
      "user-adopted",
    );
    writeFileSync(
      lease.lease.brokerAuthorizationPath,
      lease.authorization.replace(brokerToken, "Z".repeat(43)),
      { mode: 0o600 },
    );
    chmodSync(lease.lease.brokerAuthorizationPath, 0o600);
    const changed = run([
      "--session",
      "changed-auth",
      "--target-lease",
      lease.path,
      "snapshot",
      "-i",
    ]);
    expect(changed.status).toBe(65);
    expect(changed.stderr).toContain("capability hash mismatched");
    expect(`${changed.stdout}${changed.stderr}${trace()}`).not.toContain(
      brokerToken,
    );
    expect(trace()).not.toContain("transport=");
    expect(trace()).not.toContain("consume-target-receipt");
    expect(trace()).not.toContain("native=");

    writeFileSync(tracePath, "", "utf8");
    const expiry = pendingLease(
      "expiry-mismatch",
      authority,
      "caleb",
      "5".repeat(64),
      "user-adopted",
    );
    expiry.metadata.brokerCapabilityExpiresAt = new Date(
      expiry.receipt.expiresAt - 1,
    ).toISOString();
    writeFileSync(expiry.metadataPath, JSON.stringify(expiry.metadata), {
      mode: 0o600,
    });
    chmodSync(expiry.metadataPath, 0o600);
    const expiryMismatch = run([
      "--session",
      "expiry-mismatch",
      "--target-lease",
      expiry.path,
      "snapshot",
      "-i",
    ]);
    expect(expiryMismatch.status).toBe(65);
    expect(expiryMismatch.stderr).toContain(
      "controller target lease binding is invalid",
    );
    expect(trace()).not.toContain("consume-target-receipt");
    expect(trace()).not.toContain("transport=");
    expect(trace()).not.toContain("native=");
  });

  it("premise: upstream loss is a single explicit pre-action transport failure with no replacement lease or retry; falsifier: consume/native runs or health is retried", () => {
    const authority = writeAttestation();
    const lease = pendingLease(
      "upstream-lost",
      authority,
      "caleb",
      "4".repeat(64),
      "user-adopted",
    );
    const healthPath = join(controls, "health.json");
    const health = JSON.parse(readFileSync(healthPath, "utf8"));
    health.state = "upstream_lost";
    health.reconnectRequired = true;
    health.lossReason = "upstream websocket closed";
    health.upstreamSocketOpen = false;
    writeFileSync(healthPath, JSON.stringify(health), "utf8");

    const result = run([
      "--session",
      "upstream-lost",
      "--target-lease",
      lease.path,
      "snapshot",
      "-i",
    ]);

    expect(result.status).toBe(69);
    expect(result.stderr).toContain("TRANSPORT_FAILURE");
    expect(traceCount("transport=/healthz/")).toBe(1);
    expect(trace()).not.toContain("consume-target-receipt");
    expect(trace()).not.toContain("acquire-registered-workspace-target-lease");
    expect(trace()).not.toContain("native=");
    expect(existsSync(lease.path)).toBe(true);
  });

  it("premise: close is local no-op when closed and refuses an unowned live lane; falsifier: native/controller cleanup is sent", () => {
    const absent = run(["--session", "absent", "close"]);
    expect(absent.status).toBe(0);
    expect(existsSync(stateRoot)).toBe(false);
    expect(trace()).toBe("");

    writeAttestation();
    expect(
      runWorkspace(["--session", "unowned", "open", "https://example.test"])
        .status,
    ).toBe(0);
    rmSync(join(stateRoot, "session-unowned.account"));
    rmSync(join(stateRoot, "session-unowned.task-lease"));
    writeFileSync(tracePath, "", "utf8");
    const live = run(["--session", "unowned", "close"]);
    expect(live.status).toBe(65);
    expect(live.stderr).toContain("live session is unowned");
    expect(trace()).toBe("");
  });

  it("premise: an owned crashed daemon can release only its exact stale artifacts and reopen safely; falsifier: proof is discarded, foreign cleanup occurs, or the namespace stays wedged", () => {
    writeAttestation();
    expect(
      runWorkspace(["--session", "crashed", "open", "https://example.test"])
        .status,
    ).toBe(0);
    const pid = Number(
      readFileSync(join(stateRoot, "crashed.pid"), "utf8").trim(),
    );
    process.kill(pid, "SIGKILL");
    waitUntil(() => {
      try {
        process.kill(pid, 0);
        return false;
      } catch {
        return true;
      }
    }, "crashed daemon exit");
    expect(existsSync(join(stateRoot, "crashed.sock"))).toBe(true);
    expect(existsSync(join(stateRoot, "crashed.daemon-identity"))).toBe(true);

    const closed = run(["--session", "crashed", "close"]);
    expect(closed.status, closed.stderr).toBe(0);
    for (const name of [
      "crashed.pid",
      "crashed.sock",
      "crashed.daemon-identity",
      "session-crashed.account",
      "session-crashed.task-lease",
    ]) {
      expect(existsSync(join(stateRoot, name)), name).toBe(false);
    }

    const reopened = runWorkspace([
      "--session",
      "crashed",
      "open",
      "https://example.test/reopened",
    ]);
    expect(reopened.status, reopened.stderr).toBe(0);
  });

  it("premise: foreground is an explicit controller lease with exclusive local publication and exact rollback; falsifier: ordinary/native work focuses, a race overwrites foreign state, or rollback leaves focus active", () => {
    writeAttestation();
    const opened = runWorkspace([
      "--session",
      "focus-control",
      "open",
      "https://example.test",
    ]);
    expect(opened.status, opened.stderr).toBe(0);
    expect(trace()).not.toContain('controller=["acquire-focus"');

    writeFileSync(tracePath, "", "utf8");
    const acquired = run(["--session", "focus-control", "foreground"]);
    expect(acquired.status, acquired.stderr).toBe(0);
    expect(trace()).toContain(
      'controller=["acquire-focus","--session","focus-control","--target-id","fixture-workspace-caleb","--receipt-nonce"',
    );
    expect(trace()).not.toContain("native=");
    const focusPath = join(stateRoot, "session-focus-control.focus-lease");
    const focus = JSON.parse(readFileSync(focusPath, "utf8"));
    expect(focus.schema).toBe("agent-browser.focus-acquire-result.v1");
    expect(focus.targetId).toBe("fixture-workspace-caleb");
    expect(focus.leasedTabId).not.toBe(focus.targetId);
    expect(typeof focus.socketDev).toBe("string");
    expect(typeof focus.socketIno).toBe("string");

    writeFileSync(tracePath, "", "utf8");
    const idempotent = run(["--session", "focus-control", "foreground"]);
    expect(idempotent.status, idempotent.stderr).toBe(0);
    expect(trace()).toContain('controller=["validate-focus-lease"');
    expect(trace()).not.toContain('controller=["acquire-focus"');
    expect(trace()).not.toContain("native=");

    writeFileSync(tracePath, "", "utf8");
    const background = run(["--session", "focus-control", "background"]);
    expect(background.status, background.stderr).toBe(0);
    expect(trace()).toContain(
      `controller=["release-focus","--session","focus-control","--focus-lease-id","${focus.focusLeaseId}","--json"]`,
    );
    expect(trace()).not.toContain("native=");
    expect(existsSync(focusPath)).toBe(false);
    expect(existsSync(join(stateRoot, "focus-control.sock"))).toBe(true);

    control("focus-publish-race", "1");
    writeFileSync(tracePath, "", "utf8");
    const raced = run(["--session", "focus-control", "foreground"]);
    expect(raced.status).toBe(70);
    expect(raced.stderr).toContain("publication raced");
    expect(readFileSync(focusPath, "utf8")).toBe("foreign-focus-owner\n");
    expect(trace()).toContain('controller=["acquire-focus"');
    expect(trace()).toContain('controller=["release-focus"');
    expect(trace()).not.toContain("native=");

    rmSync(join(controls, "focus-publish-race"));
    rmSync(focusPath);
    expect(run(["--session", "focus-control", "close"]).status).toBe(0);
  });

  it("premise: close waits beyond five seconds for controller-owned foreground restoration and preserves a failed lease; falsifier: wrapper kills cleanup, tears down first, or deletes foreign evidence", () => {
    writeAttestation();
    expect(
      run(["--session", "focus-close", "open", "https://example.test"]).status,
    ).toBe(0);
    const granted = grantForeground("focus-close");
    control("focus-delay-ms", "5200");
    control("focus-error", "1");
    writeFileSync(tracePath, "", "utf8");

    const started = performance.now();
    const failed = run(["--session", "focus-close", "close"]);
    const elapsed = performance.now() - started;

    expect(failed.status).toBe(69);
    expect(failed.stderr).toContain("FOCUS_RESTORE_FAILED");
    expect(elapsed).toBeGreaterThanOrEqual(5000);
    expect(elapsed).toBeLessThan(9500);
    expect(trace()).toContain(
      `focus-restored-before-error=${granted.focus.focusLeaseId}`,
    );
    expect(trace()).not.toContain("native-close=focus-close");
    expect(trace()).not.toContain('controller=["release-session"');
    expect(existsSync(granted.path)).toBe(true);
    expect(existsSync(join(stateRoot, "focus-close.sock"))).toBe(true);

    rmSync(join(controls, "focus-delay-ms"));
    rmSync(join(controls, "focus-error"));
    refreshTransportProof();
    const healthPath = join(controls, "health.json");
    const health = JSON.parse(readFileSync(healthPath, "utf8"));
    writeFileSync(
      healthPath,
      JSON.stringify({
        ...health,
        state: "upstream_lost",
        reconnectRequired: true,
        lossReason: "upstream websocket closed",
        upstreamSocketOpen: false,
      }),
      "utf8",
    );
    writeFileSync(tracePath, "", "utf8");
    const transportRed = run(["--session", "focus-close", "close"]);
    expect(transportRed.status).toBe(69);
    expect(transportRed.stderr).toContain("TRANSPORT_FAILURE");
    expect(existsSync(granted.path)).toBe(false);
    expect(trace()).toContain('controller=["release-focus"');
    expect(trace()).not.toContain("native-close=focus-close");
    expect(trace()).not.toContain('controller=["release-session"');

    writeFileSync(healthPath, JSON.stringify(health), "utf8");
    writeFileSync(tracePath, "", "utf8");
    const closed = run(["--session", "focus-close", "close"]);
    expect(closed.status, closed.stderr).toBe(0);
    expect(existsSync(granted.path)).toBe(false);
    const closedAt = trace().indexOf("native-close=focus-close");
    const releasedAt = trace().indexOf('controller=["release-session"');
    expect(trace()).not.toContain('controller=["release-focus"');
    expect(closedAt).toBeGreaterThanOrEqual(0);
    expect(releasedAt).toBeGreaterThan(closedAt);
  }, 12_000);

  it("premise: popup-producing clicks require an exact active foreground lease and one newline settles once; falsifier: background work clicks, EOF is required, or armed evidence disappears", () => {
    writeAttestation();
    const opened = runWorkspace([
      "--session",
      "popup",
      "open",
      "https://example.test",
    ]);
    expect(opened.status, `${opened.stderr}\n${trace()}`).toBe(0);
    writeFileSync(tracePath, "", "utf8");

    const background = run([
      "--session",
      "popup",
      "click",
      "@button",
      "--expect-popup",
    ]);
    expect(background.status, background.stderr).toBe(69);
    expect(background.stderr).toContain("FOREGROUND_REQUIRED");
    expect(trace()).not.toContain("popup-request=");
    expect(trace()).not.toContain("discover-owned-descendants");
    expect(trace()).not.toContain('"click"');

    grantForeground("popup");
    writeFileSync(tracePath, "", "utf8");
    const plain = run([
      "--session",
      "popup",
      "click",
      "@button",
      "--expect-popup",
    ]);
    expect(plain.status, plain.stderr).toBe(0);
    expect(plain.stdout).toBe("✓ Done [popupTracking=event-armed-v1]\n");
    expect(trace()).toContain('controller=["validate-focus-lease"');
    expect(trace()).toContain('"action":"click"');
    expect(trace()).toContain('"expectPopup":true');

    const json = run([
      "--json",
      "--session",
      "popup",
      "click",
      "@button",
      "--expect-popup",
    ]);
    expect(json.status).toBe(0);
    expect(JSON.parse(json.stdout).data.popupTracking).toBe("event-armed-v1");

    control("reconcile-error", "1");
    writeFileSync(tracePath, "", "utf8");
    const unregistered = run([
      "--session",
      "popup",
      "click",
      "@button",
      "--expect-popup",
    ]);
    expect(unregistered.status).toBe(69);
    expect(unregistered.stderr).toContain("TARGET_RECONCILIATION_REQUIRED");
    expect(trace()).toContain("popup-request=");
    expect(trace()).toContain('controller=["discover-owned-descendants"');
    expect(existsSync(join(stateRoot, "popup.sock"))).toBe(true);
    expect(existsSync(join(stateRoot, "session-popup.task-lease"))).toBe(true);
    rmSync(join(controls, "reconcile-error"));

    const unacked = run([
      "--session",
      "popup",
      "click",
      "@unacked",
      "--expect-popup",
    ]);
    expect(unacked.status).not.toBe(0);
    expect(unacked.stderr).toContain(
      "did not acknowledge atomic popup tracking",
    );
  });

  it("premise: every ordinary warm action authenticates current dist bytes before native execution; falsifier: a mismatched graph reaches native or the daemon", () => {
    writeAttestation();
    expect(
      runWorkspace(["--session", "dist-guard", "open", "https://example.test"])
        .status,
    ).toBe(0);
    writeFileSync(tracePath, "", "utf8");
    writeFileSync(
      join(fixtureRepo, "dist", "actions.js"),
      "export const replaced = true;\n",
      "utf8",
    );

    const result = run(["--session", "dist-guard", "snapshot", "-i"]);

    expect(result.status).toBe(70);
    expect(result.stderr).toContain("canonical runtime graph bytes mismatched");
    expect(trace()).toBe("");
  });

  it("premise: receipt self-consistency cannot authorize an arbitrary dist graph; falsifier: a rewritten manifest/identity sends the click", () => {
    writeAttestation();
    expect(
      runWorkspace(["--session", "graph", "open", "https://example.test"])
        .status,
    ).toBe(0);

    writeFileSync(
      join(fixtureRepo, "dist", "actions.js"),
      "export const arbitrary = true;\n",
      "utf8",
    );
    const files = Object.fromEntries(
      graphFiles.map((path) => [
        path,
        sha256(readFileSync(join(fixtureRepo, path))),
      ]),
    );
    const graphSha256 = graphFingerprint(files);
    const manifestPath = join(fixtureRepo, "scripts", "canonical-dist.json");
    writeFileSync(
      manifestPath,
      `${JSON.stringify({
        schema: "agent-browser-canonical-dist.v1",
        authority: "tracked-dist-js",
        algorithm: "sha256",
        files,
      })}\n`,
      "utf8",
    );
    const identityPath = join(stateRoot, "graph.daemon-identity");
    const fields = readFileSync(identityPath, "utf8").trimEnd().split("\t");
    fields[16] = sha256(readFileSync(manifestPath));
    fields[17] = graphSha256;
    writeFileSync(identityPath, `${fields.join("\t")}\n`, { mode: 0o600 });
    chmodSync(identityPath, 0o600);
    writeFileSync(tracePath, "", "utf8");

    const result = run([
      "--session",
      "graph",
      "click",
      "@button",
      "--expect-popup",
    ]);
    expect(result.status).toBe(70);
    expect(result.stderr).toContain("canonical runtime manifest");
    expect(trace()).not.toContain("popup-request=");
  });

  it("premise: every daemon identity field and record boundary is revalidated; falsifier: malformed, missing, copied, or stale evidence reaches native", () => {
    writeAttestation();
    expect(
      runWorkspace(["--session", "identity", "open", "https://example.test"])
        .status,
    ).toBe(0);

    const identityPath = join(stateRoot, "identity.daemon-identity");
    const socketPath = join(stateRoot, "identity.sock");
    const original = readFileSync(identityPath);
    const fields = original.toString("utf8").trimEnd().split("\t");
    const bump = (value) => String(BigInt(value) + 1n);
    expect(fields).toHaveLength(21);

    const mutations = [
      [0, "wrong-schema"],
      [1, "9.9.9"],
      [2, "wrong-protocol"],
      [3, "legacy-click-v0"],
      [4, "another-session"],
      [5, bump(fields[5])],
      [6, bump(fields[6])],
      [7, bump(fields[7])],
      [8, bump(fields[8])],
      [9, bump(fields[9])],
      [10, `${stateRoot}-copied`],
      [11, "tcp"],
      [12, join(stateRoot, "copied.sock")],
      [13, bump(fields[13])],
      [14, bump(fields[14])],
      [15, fixtureRoot],
      [16, "0".repeat(64)],
      [17, "1".repeat(64)],
      [18, bump(fields[18])],
      [19, bump(fields[19])],
      [20, bump(fields[20])],
    ];

    for (const [index, replacement] of mutations) {
      const altered = [...fields];
      altered[index] = replacement;
      writeFileSync(identityPath, `${altered.join("\t")}\n`, { mode: 0o600 });
      chmodSync(identityPath, 0o600);
      writeFileSync(tracePath, "", "utf8");

      const result = run(["--session", "identity", "snapshot", "-i"]);

      expect(result.status, `identity field ${index}`).toBe(70);
      expect(result.stderr).toContain(
        "task daemon identity is not authenticated",
      );
      expect(trace()).not.toContain("native=");
      writeFileSync(identityPath, original, { mode: 0o600 });
      chmodSync(identityPath, 0o600);
    }

    for (const malformed of [
      Buffer.from("malformed\ntrailing\n", "utf8"),
      Buffer.from([0xc3, 0x28, 0x0a]),
    ]) {
      writeFileSync(identityPath, malformed, { mode: 0o600 });
      chmodSync(identityPath, 0o600);
      writeFileSync(tracePath, "", "utf8");

      const result = run(["--session", "identity", "snapshot", "-i"]);

      expect(result.status).toBe(70);
      expect(result.stderr).toContain(
        "task daemon identity receipt is invalid",
      );
      expect(trace()).not.toContain("native=");
      writeFileSync(identityPath, original, { mode: 0o600 });
      chmodSync(identityPath, 0o600);
    }

    expect(run(["--session", "identity", "snapshot", "-i"]).status).toBe(0);
    rmSync(identityPath);
    writeFileSync(tracePath, "", "utf8");

    const use = run(["--session", "identity", "snapshot", "-i"]);
    const close = run(["--session", "identity", "close"]);

    expect(use.status).toBe(70);
    expect(close.status).toBe(70);
    expect(`${use.stderr}${close.stderr}`).toContain(
      "task daemon identity is not authenticated",
    );
    expect(trace()).not.toContain("native=");
    expect(existsSync(socketPath)).toBe(true);
    writeFileSync(identityPath, original, { mode: 0o600 });
    chmodSync(identityPath, 0o600);
  });

  it("premise: diagnostics bound and redact controls, URL identity/fragments, auth headers, bearer values, and structured secrets; falsifier: literal secret survives", () => {
    writeAttestation();
    expect(
      runWorkspace(["--session", "redact", "open", "https://example.test"])
        .status,
    ).toBe(0);
    control(
      "controller-error",
      '\u001b[31mAuthorization: Bearer HEADERSECRET; https://user:pass@example.test/path?token=QUERYSECRET#FRAGMENT {"token":"JSON SECRET WITH SPACE","password":"PASSWORDSECRET"}\u001b[0m',
    );
    const result = run(["--session", "redact", "snapshot", "-i"]);
    const visible = `${result.stdout}${result.stderr}`;
    expect(result.status).not.toBe(0);
    expect(visible.length).toBeLessThan(2000);
    for (const secret of [
      "HEADERSECRET",
      "user:pass",
      "QUERYSECRET",
      "FRAGMENT",
      "JSON SECRET WITH SPACE",
      "PASSWORDSECRET",
      "\u001b",
    ]) {
      expect(visible).not.toContain(secret);
    }
    expect(visible).toContain("TRANSPORT_FAILURE");
  });

  it("premise: package and compatibility entries cannot bypass authentication; falsifier: bin or postinstall selects/downloads native directly", () => {
    const packageData = JSON.parse(
      readFileSync(join(sourceRoot, "package.json")),
    );
    const compatibility = readFileSync(
      join(sourceRoot, "bin", "agent-browser.js"),
      "utf8",
    );
    const postinstall = readFileSync(
      join(sourceRoot, "scripts", "postinstall.js"),
      "utf8",
    );
    expect(packageData.bin["agent-browser"]).toBe(
      "./scripts/agent-browser-real-chrome",
    );
    expect(packageData.scripts?.postinstall).toBeUndefined();
    expect(compatibility).toContain("agent-browser-real-chrome");
    expect(compatibility).not.toContain("agent-browser-linux-x64");
    expect(postinstall).not.toMatch(/https|download|symlinkSync|execSync/);
  });

  it("premise: shipped templates generate invocation-local sessions and close only after their own open succeeds; falsifier: stale env or failed open triggers close", () => {
    const layout = join(fixtureRoot, "template-layout");
    const templateDir = join(layout, "skills", "agent-browser", "templates");
    const calls = join(layout, "calls.log");
    mkdirSync(templateDir, { recursive: true, mode: 0o700 });
    executable(
      join(layout, "scripts", "agent-browser-real-chrome"),
      `#!/usr/bin/bash\n/usr/bin/printf '%s\\n' "$*" >> ${JSON.stringify(calls)}\nexit 7\n`,
    );

    for (const name of [
      "authenticated-session.sh",
      "capture-workflow.sh",
      "form-automation.sh",
    ]) {
      const source = readFileSync(
        join(sourceRoot, "skills", "agent-browser", "templates", name),
        "utf8",
      );
      expect(source).not.toContain("AGENT_BROWSER_TASK_SESSION");
      expect(source).toContain("/proc/sys/kernel/random/uuid");
      expect(source).toContain('if [[ "$created_session" == 1 ]]');
      expect(source.indexOf("created_session=0")).toBeLessThan(
        source.indexOf("trap cleanup EXIT"),
      );
      const copied = join(templateDir, name);
      writeFileSync(copied, source, { mode: 0o700 });
      chmodSync(copied, 0o700);
      writeFileSync(calls, "", "utf8");
      const args =
        name === "capture-workflow.sh"
          ? ["https://example.test", join(layout, "capture")]
          : ["https://example.test", "caleb"];
      const result = spawnSync("/usr/bin/bash", [copied, ...args], {
        encoding: "utf8",
        env: hostileEnv({ AGENT_BROWSER_TASK_SESSION: "stale-lane" }),
      });
      expect(result.status, name).toBe(7);
      const invoked = readFileSync(calls, "utf8").trim().split("\n");
      expect(invoked, name).toHaveLength(1);
      expect(invoked[0]).toContain(" open https://example.test");
      expect(invoked[0]).not.toContain("stale-lane");
      expect(invoked[0]).not.toContain(" close");
    }
  });

  it("premise: production has immutable transport trust hooks and the exact final runtime graph; falsifier: an env/live producer, placeholder, or guessed graph becomes reachable", () => {
    const wrapperSource = readFileSync(
      join(sourceRoot, "scripts", "agent-browser-wrapper.js"),
      "utf8",
    );
    const popupSource = readFileSync(
      join(sourceRoot, "scripts", "agent-browser-daemon-click.js"),
      "utf8",
    );
    expect(wrapperSource).toContain(
      '"agent-browser.transport-proof-helper.wsl-stable.v2"',
    );
    expect(wrapperSource).toContain('const FIXED_CONTROLLER_STATE_ROOT = "";');
    expect(wrapperSource).toContain(
      "const SUPPORTED_CHROME_DEBUGGING_PORT = 9222;",
    );
    expect(wrapperSource).toContain(
      "expectedControllerEndpointId(SUPPORTED_CHROME_DEBUGGING_PORT)",
    );
    expect(wrapperSource).toContain(
      '"ensure-supported-existing-transport"',
    );
    expect(wrapperSource).toContain(
      'join(repoRoot, "scripts", "agent-browser-cdp-broker.js")',
    );
    expect(wrapperSource).not.toContain(
      '"attest-supported-existing-transport"',
    );
    expect(wrapperSource).toContain('"transport-proof-state.v1.json"');
    expect(wrapperSource).not.toContain("TRUSTED_PROCESS_SNAPSHOT_PATH");
    expect(wrapperSource).toContain("/cdp/${data.transportGeneration}");
    expect(wrapperSource).toContain("/healthz/${data.transportGeneration}");
    expect(wrapperSource).toContain("AGENT_BROWSER_BROKER_AUTHORIZATION:");
    expect(wrapperSource).not.toContain(
      "AGENT_BROWSER_CDP_AUTHORIZATION_HEADER",
    );
    expect(wrapperSource).not.toContain("/json/version");
    expect(wrapperSource).not.toContain("/json/list");
    expect(wrapperSource).not.toContain("/devtools/browser/");
    expect(wrapperSource).not.toContain("json_version_fingerprint");
    expect(wrapperSource).not.toContain("process.env.AGENT_BROWSER_NATIVE_BIN");
    expect(wrapperSource).not.toContain(
      "process.env.AGENT_BROWSER_CHROME_PROFILE_ATTESTATION_PATH",
    );
    const manifestRaw = readFileSync(
      join(sourceRoot, "scripts", "canonical-dist.json"),
    );
    const manifest = JSON.parse(manifestRaw.toString("utf8"));
    expect(Object.keys(manifest.files)).toEqual(graphFiles);
    const manifestSha256 = sha256(manifestRaw);
    const graphSha256 = graphFingerprint(manifest.files);
    for (const exact of [manifest.schema, manifestSha256, graphSha256]) {
      expect(wrapperSource).toContain(exact);
      expect(popupSource).toContain(exact);
    }
    expect(wrapperSource).toContain(sha256(Buffer.from(popupSource)));
    for (const pending of [
      "__PENDING_FINAL_CANONICAL_DIST_SCHEMA__",
      "__PENDING_FINAL_CANONICAL_DIST_SHA256__",
      "__PENDING_FINAL_CANONICAL_GRAPH_SHA256__",
    ]) {
      expect(wrapperSource).not.toContain(pending);
      expect(popupSource).not.toContain(pending);
    }
    expect(wrapperSource).not.toMatch(/dist\/ios-(?:actions|manager)\.js/);
    expect(popupSource).not.toMatch(/dist\/ios-(?:actions|manager)\.js/);
  });
});
