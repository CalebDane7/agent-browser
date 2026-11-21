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
export const PRODUCER_REVISION = "agent-browser.cdp-broker.v14";
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
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const METAMASK_EXTENSION_ID = "nkbihfbeogaeaoehlefnkodbefgpgknn";
const METAMASK_EXTENSION_VERSION = "13.45.0";
const METAMASK_STORAGE_VERSION = 221;
const METAMASK_PROFILE_DIRECTORY = "Default";
const METAMASK_ORIGIN = `chrome-extension://${METAMASK_EXTENSION_ID}`;
const METAMASK_URL_PREFIX = `${METAMASK_ORIGIN}/`;
const METAMASK_MAX_PAGES = 8;
const METAMASK_MAX_SERVICE_WORKERS = 2;
const METAMASK_MAX_PROOF_ATTEMPTS = 20;
const METAMASK_MAX_KEYRING_BYTES = 4 * 1024 * 1024;
const METAMASK_TARGET_FILTER = Object.freeze([
  Object.freeze({ type: "tab", exclude: false }),
  Object.freeze({ type: "page", exclude: false }),
  Object.freeze({ type: "service_worker", exclude: false }),
  Object.freeze({ exclude: true }),
]);
export const METAMASK_DEFAULT_WORLD_PROOF_EXPRESSION = `(() => { const hooks = globalThis.stateHooks; return { documentComplete: document.readyState === "complete", extensionOrigin: globalThis.location?.origin === "${METAMASK_ORIGIN}", hasStateHooks: hooks !== null && typeof hooks === "object", hasSentryStateHook: typeof hooks?.getSentryAppState === "function" }; })()`;
export const WORKSPACE_PROFILE_PATH_EXPRESSION =
  "new Promise(resolve=>{const deadline=Date.now()+3000;const inspect=()=>{const cell=document.getElementById('profile_path');const value=String(cell?.innerText||cell?.textContent||'').trim();if(value){resolve(String(document.body?.innerText||''));return;}if(Date.now()>=deadline){resolve('');return;}setTimeout(inspect,50);};inspect();})";
const WORKSPACE_MARKER_PATTERN =
  /^about:blank#agent-browser-workspace-[0-9a-f]{64}$/;
const WORKSPACE_TASK_MARKER_PATTERN =
  /^about:blank#agent-browser-task-[0-9a-f]{64}$/;
const WORKSPACE_BOOTSTRAP_MARKER_PATTERN =
  /^about:blank#agent-browser-bootstrap-[0-9a-f]{64}$/;
const UIA_RUNTIME_ID_PATTERN = /^-?\d+(?:\.-?\d+)*$/;
const WORKSPACE_PROFILE_DIRECTORIES = Object.freeze({
  caleb: "Default",
  erebora: "Profile 1",
});
// Chrome can expose a newly created tab at any one of these fixed internal
// URLs while its New Tab Page finishes selecting a concrete implementation.
// WHY [AGENT-BROWSER-UIA-TASK-CLAIM-001]: UIA creates one unmarked tab before
// the broker owns it. Only the signed exact TAB/page delta may cross that
// boundary, and only while both targets are still on this immutable newborn
// allowlist. Accepting an arbitrary pre-navigation URL could adopt and replace
// a mutable user page; opener/window-open provenance and renderer input are not
// equivalent ownership evidence and must never return as fallbacks.
export const WORKSPACE_TASK_NEWBORN_URLS = Object.freeze([
  "about:blank",
  "chrome-search://local-ntp/local-ntp.html",
  "chrome://new-tab-page/",
  "chrome://new-tab-page-third-party/",
  "chrome://newtab/",
]);

function workspaceProfileBindingIsCanonical(account, profileDirectory) {
  if (
    typeof account !== "string" ||
    typeof profileDirectory !== "string" ||
    !profileDirectory ||
    Buffer.byteLength(profileDirectory, "utf8") > 128 ||
    profileDirectory === "." ||
    profileDirectory === ".." ||
    /[\\/\u0000-\u001f\u007f]/.test(profileDirectory)
  ) {
    return false;
  }
  if (Object.hasOwn(WORKSPACE_PROFILE_DIRECTORIES, account)) {
    return WORKSPACE_PROFILE_DIRECTORIES[account] === profileDirectory;
  }
  return (
    account ===
    `profile-${createHash("sha256").update(profileDirectory, "utf8").digest("hex")}`
  );
}

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
  // WHY: task sessions may interact with their owned page, but focus is a
  // separate controller lease with exact pre/post tab and window proof.
  "Page.bringToFront",
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
export const DENIED_METHOD_PREFIXES = Object.freeze(["Extensions."]);
export const FORBIDDEN_TASK_TARGET_SCHEMES = Object.freeze([
  "chrome-extension",
  "moz-extension",
  "edge-extension",
  "chrome",
  "devtools",
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
const TASK_POPUP_INITIATING_METHODS = new Set([
  "Input.dispatchDragEvent",
  "Input.dispatchKeyEvent",
  "Input.dispatchMouseEvent",
  "Input.dispatchTouchEvent",
  "Runtime.callFunctionOn",
  "Runtime.evaluate",
]);
const TASK_ROOT_DISPOSITIONS = new Set([
  "close-owned-workspace-task",
  "preserve-nonowned-root",
]);
const PAGE_TARGET_FILTER = Object.freeze([
  Object.freeze({ type: "page", exclude: false }),
  Object.freeze({ exclude: true }),
]);
const TAB_TARGET_FILTER = Object.freeze([
  Object.freeze({ type: "tab", exclude: false }),
  Object.freeze({ exclude: true }),
]);
const WORKSPACE_TASK_CREATE_TARGET_FILTER = Object.freeze([
  Object.freeze({ type: "tab", exclude: false }),
  Object.freeze({ type: "page", exclude: false }),
  Object.freeze({ exclude: true }),
]);

const DEFAULT_LIMITS = Object.freeze({
  // Sixteen long-lived task sockets are the user-facing capacity. Keep one
  // independently bounded controller socket so task 16 can still register,
  // reconcile and close without reducing usable capacity to fifteen.
  maxClients: 17,
  maxTaskClients: 16,
  maxControllerClients: 1,
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
  // Chrome keeps the first Stable-profile debugger handshake pending while
  // the user decides its native approval prompt. Preserve that one real input
  // boundary instead of killing the only connection after ten seconds.
  upstreamConnectTimeoutMs: 120_000,
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
  maxTaskClients: [1, 128],
  maxControllerClients: [1, 16],
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

function canonicalSha256(value) {
  return createHash("sha256")
    .update(canonicalJson(value), "utf8")
    .digest("hex");
}

function cloneJsonValue(value) {
  return JSON.parse(JSON.stringify(value));
}

function isForbiddenTaskUrl(value) {
  if (typeof value !== "string") return false;
  const scheme = /^([A-Za-z][A-Za-z0-9+.-]*):/.exec(value.trim())?.[1];
  return Boolean(
    scheme &&
      FORBIDDEN_TASK_TARGET_SCHEMES.includes(scheme.toLowerCase()),
  );
}

function isMetaMaskTargetInfo(value, browserContextId, type) {
  return Boolean(
    isPlainObject(value) &&
      value.type === type &&
      TARGET_ID_PATTERN.test(value.targetId) &&
      value.browserContextId === browserContextId &&
      typeof value.url === "string" &&
      value.url.startsWith(METAMASK_URL_PREFIX),
  );
}

function hasNonemptyVault(value) {
  return Boolean(
    isPlainObject(value) &&
      typeof value.vault === "string" &&
      value.vault.length > 0,
  );
}

function keyringDigest(present, value) {
  return canonicalSha256(
    present
      ? { present: true, value }
      : { present: false },
  );
}

function protectedStorageDigest(storage) {
  return canonicalSha256(
    Object.fromEntries(
      Object.entries(storage).filter(([key]) => key !== "KeyringController"),
    ),
  );
}

function validMetaMaskStorage(storage) {
  const manifest = storage?.manifest;
  const meta = storage?.meta;
  const onboarding = storage?.OnboardingController;
  const keyring = storage?.KeyringController;
  return Boolean(
    isPlainObject(storage) &&
      Array.isArray(manifest) &&
      manifest.includes("KeyringController") &&
      manifest.includes("meta") &&
      isPlainObject(meta) &&
      meta.storageKind === "split" &&
      meta.version === METAMASK_STORAGE_VERSION &&
      // MetaMask 13.45 treats a truthy KeyringController.vault as initialized
      // independently of onboarding completion.  Keep onboarding structurally
      // present and protected, but admit the incomplete state recovery repairs.
      isPlainObject(onboarding) &&
      (!("KeyringController" in storage) || isPlainObject(keyring)),
  );
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

function normalizeSortedTargetIds(value, maximum = 256) {
  if (!Array.isArray(value) || value.length > maximum) {
    throw new Error("client lease target inventory authority is invalid");
  }
  const targetIds = value.map(normalizeTargetId);
  if (
    new Set(targetIds).size !== targetIds.length ||
    targetIds.join("\0") !== [...targetIds].sort().join("\0")
  ) {
    throw new Error("client lease target inventory authority is invalid");
  }
  return targetIds;
}

function normalizeSortedWindowIds(value, maximum = 256) {
  if (!Array.isArray(value) || value.length > maximum) {
    throw new Error("client lease window inventory authority is invalid");
  }
  const windowIds = value.map(normalizeWindowId);
  if (
    new Set(windowIds).size !== windowIds.length ||
    canonicalJson(windowIds) !== canonicalJson([...windowIds].sort((a, b) => a - b))
  ) {
    throw new Error("client lease window inventory authority is invalid");
  }
  return windowIds;
}

function normalizeUiaRuntimeId(value) {
  if (
    typeof value !== "string" ||
    Buffer.byteLength(value, "utf8") > 256 ||
    !UIA_RUNTIME_ID_PATTERN.test(value)
  ) {
    throw new Error("client lease UIA runtime authority is invalid");
  }
  const components = value.split(".");
  if (
    components.length > 32 ||
    components.some((component) => {
      const parsed = Number(component);
      return (
        !Number.isInteger(parsed) ||
        parsed < -2_147_483_648 ||
        parsed > 2_147_483_647 ||
        String(parsed) !== component
      );
    })
  ) {
    throw new Error("client lease UIA runtime authority is invalid");
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
  if (value.kind === "controller-workspace-task-create") {
    if (
      !hasExactKeys(value, [
        "kind",
        "account",
        "profileDirectory",
        "profileBinding",
        "browserContextId",
        "markerUrl",
        "precreateTabTargetIds",
        "precreateActiveTabTargetIds",
        "precreateWindowIds",
        "workspaceWindowTabTargetIds",
        "anchorTabTargetId",
        "anchorPageTargetId",
        "anchorWindowId",
        "anchorExpectedTabActive",
        "anchorMarkerUrl",
        "createdTabTargetId",
        "createdPageTargetId",
        "createdExpectedTabActive",
        "priorForegroundWindowHandle",
        "uiaChromePid",
        "uiaWindowHandle",
        "uiaRootRuntimeId",
        "uiaNewTabRuntimeId",
        "uiaAnchorRuntimeId",
        "uiaPreTabCount",
        "uiaPostTabCount",
        "uiaMarkerSha256",
        "uiaRegistrationSha256",
        "uiaAnchorRestored",
        "uiaForegroundUnchanged",
        "uiaWindowMinimized",
        "uiaForegroundEventCount",
        "uiaMinimizeEndEventCount",
        "uiaNoForegroundEvent",
        "uiaNoMinimizeEndEvent",
      ]) ||
      !workspaceProfileBindingIsCanonical(value.account, value.profileDirectory) ||
      typeof value.profileBinding !== "string" ||
      !SHA256_PATTERN.test(value.profileBinding) ||
      typeof value.markerUrl !== "string" ||
      !WORKSPACE_TASK_MARKER_PATTERN.test(value.markerUrl) ||
      typeof value.anchorMarkerUrl !== "string" ||
      !WORKSPACE_MARKER_PATTERN.test(value.anchorMarkerUrl) ||
      value.anchorExpectedTabActive !== true ||
      value.createdExpectedTabActive !== false ||
      value.uiaAnchorRestored !== true ||
      value.uiaForegroundUnchanged !== true ||
      value.uiaWindowMinimized !== true ||
      value.uiaForegroundEventCount !== 0 ||
      value.uiaMinimizeEndEventCount !== 0 ||
      value.uiaNoForegroundEvent !== true ||
      value.uiaNoMinimizeEndEvent !== true ||
      !Number.isSafeInteger(value.uiaChromePid) ||
      value.uiaChromePid <= 0 ||
      value.uiaChromePid > 0xffff_ffff ||
      typeof value.uiaMarkerSha256 !== "string" ||
      !SHA256_PATTERN.test(value.uiaMarkerSha256) ||
      value.uiaMarkerSha256 !==
        createHash("sha256").update(value.anchorMarkerUrl, "utf8").digest("hex") ||
      typeof value.uiaRegistrationSha256 !== "string" ||
      !SHA256_PATTERN.test(value.uiaRegistrationSha256) ||
      value.uiaRegistrationSha256 !==
        canonicalSha256({
          account: value.account,
          markerSha256: value.uiaMarkerSha256,
          profileBinding: value.profileBinding,
          profileDirectory: value.profileDirectory,
          schema: "agent-browser.chrome-new-tab-registration.v1",
        })
    ) {
      throw new Error("client lease workspace-task-create authority is invalid");
    }
    const precreateTabTargetIds = normalizeSortedTargetIds(
      value.precreateTabTargetIds,
      255,
    );
    const precreateActiveTabTargetIds = normalizeSortedTargetIds(
      value.precreateActiveTabTargetIds,
    );
    const precreateWindowIds = normalizeSortedWindowIds(value.precreateWindowIds);
    const workspaceWindowTabTargetIds = normalizeSortedTargetIds(
      value.workspaceWindowTabTargetIds,
      255,
    );
    const anchorTabTargetId = normalizeTargetId(value.anchorTabTargetId);
    const anchorPageTargetId = normalizeTargetId(value.anchorPageTargetId);
    const anchorWindowId = normalizeWindowId(value.anchorWindowId);
    const createdTabTargetId = normalizeTargetId(value.createdTabTargetId);
    const createdPageTargetId = normalizeTargetId(value.createdPageTargetId);
    const priorForegroundWindowHandle = normalizeWindowId(
      value.priorForegroundWindowHandle,
    );
    const uiaWindowHandle = normalizeWindowId(value.uiaWindowHandle);
    const uiaRootRuntimeId = normalizeUiaRuntimeId(value.uiaRootRuntimeId);
    const uiaNewTabRuntimeId = normalizeUiaRuntimeId(value.uiaNewTabRuntimeId);
    const uiaAnchorRuntimeId = normalizeUiaRuntimeId(value.uiaAnchorRuntimeId);
    if (
      !precreateTabTargetIds.includes(anchorTabTargetId) ||
      precreateTabTargetIds.includes(anchorPageTargetId) ||
      precreateTabTargetIds.includes(createdTabTargetId) ||
      precreateTabTargetIds.includes(createdPageTargetId) ||
      !precreateActiveTabTargetIds.includes(anchorTabTargetId) ||
      precreateActiveTabTargetIds.some(
        (targetId) => !precreateTabTargetIds.includes(targetId),
      ) ||
      !workspaceWindowTabTargetIds.includes(anchorTabTargetId) ||
      workspaceWindowTabTargetIds.some(
        (targetId) => !precreateTabTargetIds.includes(targetId),
      ) ||
      !precreateWindowIds.includes(anchorWindowId) ||
      new Set([
        anchorTabTargetId,
        anchorPageTargetId,
        createdTabTargetId,
        createdPageTargetId,
      ]).size !== 4 ||
      !Number.isSafeInteger(value.uiaPreTabCount) ||
      value.uiaPreTabCount < 1 ||
      value.uiaPreTabCount !== workspaceWindowTabTargetIds.length ||
      !Number.isSafeInteger(value.uiaPostTabCount) ||
      value.uiaPostTabCount !== value.uiaPreTabCount + 1 ||
      uiaWindowHandle <= 0 ||
      uiaWindowHandle === priorForegroundWindowHandle ||
      new Set([
        uiaRootRuntimeId,
        uiaNewTabRuntimeId,
        uiaAnchorRuntimeId,
      ]).size !== 3
    ) {
      throw new Error("client lease workspace-task precreate authority is invalid");
    }
    return Object.freeze({
      kind: value.kind,
      account: value.account,
      profileDirectory: value.profileDirectory,
      profileBinding: value.profileBinding,
      browserContextId: normalizeTargetId(value.browserContextId),
      markerUrl: value.markerUrl,
      precreateTabTargetIds: Object.freeze(precreateTabTargetIds),
      precreateActiveTabTargetIds: Object.freeze(precreateActiveTabTargetIds),
      precreateWindowIds: Object.freeze(precreateWindowIds),
      workspaceWindowTabTargetIds: Object.freeze(workspaceWindowTabTargetIds),
      anchorTabTargetId,
      anchorPageTargetId,
      anchorWindowId,
      anchorExpectedTabActive: value.anchorExpectedTabActive,
      anchorMarkerUrl: value.anchorMarkerUrl,
      createdTabTargetId,
      createdPageTargetId,
      createdExpectedTabActive: value.createdExpectedTabActive,
      priorForegroundWindowHandle,
      uiaChromePid: value.uiaChromePid,
      uiaWindowHandle,
      uiaRootRuntimeId,
      uiaNewTabRuntimeId,
      uiaAnchorRuntimeId,
      uiaPreTabCount: value.uiaPreTabCount,
      uiaPostTabCount: value.uiaPostTabCount,
      uiaMarkerSha256: value.uiaMarkerSha256,
      uiaRegistrationSha256: value.uiaRegistrationSha256,
      uiaAnchorRestored: value.uiaAnchorRestored,
      uiaForegroundUnchanged: value.uiaForegroundUnchanged,
      uiaWindowMinimized: value.uiaWindowMinimized,
      uiaForegroundEventCount: value.uiaForegroundEventCount,
      uiaMinimizeEndEventCount: value.uiaMinimizeEndEventCount,
      uiaNoForegroundEvent: value.uiaNoForegroundEvent,
      uiaNoMinimizeEndEvent: value.uiaNoMinimizeEndEvent,
    });
  }
  if (value.kind === "controller-workspace-provisioning") {
    const hasInitialMarker = Object.hasOwn(value, "initialMarkerUrl");
    if (
      !hasExactKeys(value, [
        "kind",
        "operation",
        "account",
        "profileDirectory",
        "profileBinding",
        "markerUrl",
        "prelaunchTabTargetIds",
        "tabTargetId",
        "browserContextId",
        "windowId",
        "pageTargetId",
        "expectedTabActive",
        "windowDisposition",
        ...(hasInitialMarker ? ["initialMarkerUrl"] : []),
      ]) ||
      ![
        "prove-profile",
        "cleanup-created-target",
        "recover-marker",
        "retire-anchor",
      ].includes(value.operation) ||
      !workspaceProfileBindingIsCanonical(value.account, value.profileDirectory) ||
      typeof value.profileBinding !== "string" ||
      !SHA256_PATTERN.test(value.profileBinding) ||
      typeof value.markerUrl !== "string" ||
      !(
        WORKSPACE_MARKER_PATTERN.test(value.markerUrl) ||
        (value.operation === "cleanup-created-target" &&
          WORKSPACE_TASK_MARKER_PATTERN.test(value.markerUrl))
      ) ||
      !Array.isArray(value.prelaunchTabTargetIds) ||
      value.prelaunchTabTargetIds.length > 256 ||
      (hasInitialMarker &&
        (!WORKSPACE_BOOTSTRAP_MARKER_PATTERN.test(value.initialMarkerUrl) ||
          !["prove-profile", "cleanup-created-target"].includes(
            value.operation,
          ) ||
          value.prelaunchTabTargetIds.length !== 0)) ||
      typeof value.expectedTabActive !== "boolean" ||
      (value.operation === "prove-profile" && value.expectedTabActive !== true) ||
      (value.operation === "retire-anchor" &&
        value.windowDisposition === "reused-existing-window" &&
        value.expectedTabActive !== false) ||
      ![
        "reused-existing-window",
        "temporary-profile-window",
      ].includes(value.windowDisposition)
    ) {
      throw new Error("client lease workspace-provisioning authority is invalid");
    }
    const prelaunchTabTargetIds = value.prelaunchTabTargetIds.map(normalizeTargetId);
    if (
      new Set(prelaunchTabTargetIds).size !== prelaunchTabTargetIds.length ||
      prelaunchTabTargetIds.join("\0") !== [...prelaunchTabTargetIds].sort().join("\0")
    ) {
      throw new Error("client lease workspace prelaunch authority is invalid");
    }
    const tabTargetId = normalizeTargetId(value.tabTargetId);
    if (
      (["recover-marker", "retire-anchor"].includes(value.operation)) !==
      prelaunchTabTargetIds.includes(tabTargetId)
    ) {
      throw new Error("client lease workspace delta authority is invalid");
    }
    return Object.freeze({
      kind: value.kind,
      operation: value.operation,
      account: value.account,
      profileDirectory: value.profileDirectory,
      profileBinding: value.profileBinding,
      markerUrl: value.markerUrl,
      prelaunchTabTargetIds: Object.freeze(prelaunchTabTargetIds),
      tabTargetId,
      browserContextId: normalizeTargetId(value.browserContextId),
      windowId: normalizeWindowId(value.windowId),
      pageTargetId: normalizeTargetId(value.pageTargetId),
      expectedTabActive: value.expectedTabActive,
      windowDisposition: value.windowDisposition,
      ...(hasInitialMarker
        ? { initialMarkerUrl: value.initialMarkerUrl }
        : {}),
    });
  }
  if (value.kind === "controller-metamask-action") {
    if (
      !hasExactKeys(value, [
        "kind",
        "extensionId",
        "tabTargetId",
        "browserContextId",
        "expectedTabActive",
      ]) ||
      value.extensionId !== "nkbihfbeogaeaoehlefnkodbefgpgknn" ||
      typeof value.expectedTabActive !== "boolean"
    ) {
      throw new Error("client lease MetaMask action authority is invalid");
    }
    return Object.freeze({
      kind: value.kind,
      extensionId: value.extensionId,
      tabTargetId: normalizeTargetId(value.tabTargetId),
      browserContextId: normalizeTargetId(value.browserContextId),
      expectedTabActive: value.expectedTabActive,
    });
  }
  if (value.kind === "controller-metamask-vault-recovery") {
    if (
      !hasExactKeys(value, [
        "kind",
        "extensionId",
        "extensionVersion",
        "storageArea",
        "storageVersion",
        "profileDirectory",
        "profileBinding",
        "browserContextId",
        "tabTargetId",
        "expectedTabActive",
      ]) ||
      value.extensionId !== METAMASK_EXTENSION_ID ||
      value.extensionVersion !== METAMASK_EXTENSION_VERSION ||
      value.storageArea !== "local" ||
      value.storageVersion !== METAMASK_STORAGE_VERSION ||
      value.profileDirectory !== METAMASK_PROFILE_DIRECTORY ||
      typeof value.profileBinding !== "string" ||
      !SHA256_PATTERN.test(value.profileBinding) ||
      typeof value.expectedTabActive !== "boolean" ||
      value.expectedTabActive !== true
    ) {
      throw new Error("client lease MetaMask vault-recovery authority is invalid");
    }
    return Object.freeze({
      kind: value.kind,
      extensionId: value.extensionId,
      extensionVersion: value.extensionVersion,
      storageArea: value.storageArea,
      storageVersion: value.storageVersion,
      profileDirectory: value.profileDirectory,
      profileBinding: value.profileBinding,
      browserContextId: normalizeTargetId(value.browserContextId),
      tabTargetId: normalizeTargetId(value.tabTargetId),
      expectedTabActive: value.expectedTabActive,
    });
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
    "rootDisposition",
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
    rootDisposition: value.rootDisposition,
    descendantPolicy: normalizeDescendantPolicy(value.descendantPolicy),
  };
  if (
    capability.targetKind !== "page" ||
    !TASK_ROOT_DISPOSITIONS.has(capability.rootDisposition)
  ) {
    throw new Error("client lease target kind is invalid");
  }
  if (
    ![
      "close-owned-workspace-task",
      "preserve-nonowned-root",
    ].includes(capability.rootDisposition)
  ) {
    throw new Error("client lease root disposition is invalid");
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

function newMetaMaskRecoveryState(capability) {
  if (capability.kind !== "controller-metamask-vault-recovery") return null;
  return {
    phase: "needs-inventory",
    carrierTargetId: null,
    carrierSessionId: null,
    closeQueue: [],
    preimageKeyringPresent: false,
    preimageKeyringValue: null,
    preimageKeyringDigest: null,
    preimageStorageDigest: null,
    protectedStorageDigest: null,
    desiredKeyringValue: null,
    desiredKeyringDigest: null,
    writeAttempted: false,
    writeVerified: false,
    noWrite: false,
    carrierBootstrapPending: false,
    actionSequence: 0,
    actionCreatedTargetId: null,
    createdTargetIds: new Set(),
    mainFrameId: null,
    defaultContexts: [],
    defaultContextId: null,
    defaultUniqueContextId: null,
    proofAttempts: 0,
    failureCode: null,
    rollbackMode: false,
    rollbackCompareMatched: null,
    cleanupMode: null,
    preactionPasses: 0,
    noWriteFinalPasses: 0,
    finalPasses: 0,
    rollbackFinalPasses: 0,
  };
}

function newWorkspaceProvisionState(capability) {
  if (capability.kind !== "controller-workspace-provisioning") return null;
  return {
    phase: "needs-inventory",
    pageSessionId: null,
  };
}

function newWorkspaceTaskCreateState(capability) {
  if (capability.kind !== "controller-workspace-task-create") return null;
  return {
    phase: "needs-inventory",
    pageSessionId: null,
    inventoryTargetKeys: null,
    navigateIssued: false,
    failureObserved: false,
  };
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
  if (
    limits.maxClients !==
    limits.maxTaskClients + limits.maxControllerClients
  ) {
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
  let activeTaskLeaseCount = 0;
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
    if (capability.kind === "task" && expiresAtMs > now) {
      activeTaskLeaseCount += 1;
      if (activeTaskLeaseCount > limits.maxTaskClients) {
        throw new Error("task client leases exceed the connected-agent bound");
      }
    }
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

export function readHealthAuthorizationFile(path) {
  const raw = readSecureFile(path, 64);
  if (
    raw.length !== 44 ||
    raw[43] !== 0x0a ||
    !CAPABILITY_TOKEN_PATTERN.test(raw.subarray(0, 43).toString("ascii"))
  ) {
    throw new Error("broker health authorization is invalid");
  }
  return Object.freeze({
    tokenSha256: createHash("sha256")
      .update(raw.subarray(0, 43))
      .digest("hex"),
  });
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
    maxTaskClients: limits.maxTaskClients,
    maxControllerClients: limits.maxControllerClients,
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
    healthAuthorizationPath,
    healthTokenSha256,
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
    if (
      typeof healthAuthorizationPath !== "string" ||
      !isAbsolute(healthAuthorizationPath) ||
      !TOKEN_DIGEST_PATTERN.test(healthTokenSha256)
    ) {
      throw new Error("broker health authorization identity is invalid");
    }
    this.healthAuthorizationPath = healthAuthorizationPath;
    this.healthTokenDigest = Buffer.from(healthTokenSha256, "hex");
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
    // The capability kind is part of the reservation. Counting only accepted
    // clients leaves an upgrade race where multiple handshakes can all observe
    // the same free task/controller slot before WebSocket acceptance completes.
    this.reservedLeases = new Map();
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
    let startupStage = "connect_upstream";
    try {
      await this._connectUpstreamOnce();
      this.state = "ready";
      startupStage = "prime_target_graph";
      await this._primeTargetGraph();
      startupStage = "listen_loopback";
      await this._listenLoopback();
    } catch {
      await this.stop();
      // Keep failure output bounded and non-sensitive while preserving the
      // exact startup boundary needed to avoid blind reconnect retries.
      throw new Error(`CDP broker startup failed at ${startupStage}`);
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
    if (!this._reconcileLeaseTargetProvenance(this.clientLeases)) {
      throw new Error("client lease target provenance is invalid");
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

  _authenticateHealth(request) {
    if (!isLoopbackAddress(request.socket.remoteAddress)) return false;
    if (request.rawHeaders.length / 2 > this.limits.maxHeaders) return false;
    const authorization = request.headers.authorization;
    if (typeof authorization !== "string" || Array.isArray(authorization)) {
      return false;
    }
    const match =
      /^BrokerHealth ([0-9a-f]{64})\.([A-Za-z0-9_-]{43})$/.exec(
        authorization,
      );
    if (!match) return false;
    const [, presentedGeneration, token] = match;
    return (
      sameDigest(
        sha256(Buffer.from(presentedGeneration, "utf8")),
        sha256(Buffer.from(this.transportGeneration, "utf8")),
      ) &&
      sameDigest(
        sha256(Buffer.from(token, "ascii")),
        this.healthTokenDigest,
      )
    );
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
    if (!this._authenticateHealth(request)) {
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
    const activeTaskClients = this.activeTaskRoots.size;
    const activeControllerClients = this.clients.size - activeTaskClients;
    let reservedTaskClients = 0;
    let reservedControllerClients = 0;
    for (const kind of this.reservedLeases.values()) {
      if (kind === "task") reservedTaskClients += 1;
      else reservedControllerClients += 1;
    }
    const classCapacityReached = taskCapability
      ? activeTaskClients + reservedTaskClients >= this.limits.maxTaskClients
      : activeControllerClients + reservedControllerClients >=
        this.limits.maxControllerClients;
    if (
      this.clients.size + this.reservedLeases.size >= this.limits.maxClients ||
      classCapacityReached ||
      this.activeLeases.has(lease.leaseId) ||
      this.reservedLeases.has(lease.leaseId) ||
      (taskCapability && this._taskClaimConflicts(taskCapability))
    ) {
      rejectUpgrade(socket, 429, "Client Lease Unavailable");
      return;
    }
    this.reservedLeases.set(lease.leaseId, lease.capability.kind);
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
      metamaskActionUsed: false,
      workspaceTaskCreate: newWorkspaceTaskCreateState(lease.capability),
      metamaskRecovery: newMetaMaskRecoveryState(lease.capability),
      workspaceProvision: newWorkspaceProvisionState(lease.capability),
      taskPopupTicket: null,
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
    const upstreamMethod = request._brokerMethod ?? request.method;
    const upstreamParams = request._brokerParams ?? request.params ?? {};
    const upstreamRequest = {
      id: upstreamId,
      method: upstreamMethod,
      params: upstreamParams,
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
      method: upstreamMethod,
      clientMethod: request.method,
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
          : request.method === "Target.attachToTarget" &&
              client.capability.kind ===
                "controller-metamask-vault-recovery"
            ? "metamask_recovery_page"
          : request.method === "Target.attachToTarget" &&
              client.capability.kind === "controller-workspace-provisioning"
            ? "workspace_provision_page"
          : request.method === "Target.attachToTarget" &&
              client.capability.kind === "controller-workspace-task-create"
            ? "workspace_task_create_page"
          : "child",
      taskPopupRequest: this._taskPopupRequestCandidate(
        client,
        request,
        targetSessionId,
        upstreamId,
      ),
      policyStage: request._brokerPolicy ?? null,
    });
    this.pending.set(upstreamId, pending);
    this._commitClientPolicyRequest(client, pending.policyStage);
    this._sendUpstreamPayload(payload);
  }

  _applyClientPolicy(client, request) {
    const capability = client.capability;
    if (capability.kind === "controller-workspace-task-create") {
      return this._applyWorkspaceTaskCreatePolicy(client, request);
    }
    if (capability.kind === "controller-workspace-provisioning") {
      return this._applyWorkspaceProvisionPolicy(client, request);
    }
    if (capability.kind === "controller-metamask-vault-recovery") {
      return this._applyMetaMaskRecoveryPolicy(client, request);
    }
    if (capability.kind === "controller-metamask-action") {
      const params = request.params ?? {};
      const target = this.targetGraph.get(capability.tabTargetId)?.info;
      if (
        client.pendingCount !== 0 ||
        client.metamaskActionUsed ||
        request.sessionId !== undefined ||
        request.method !== "Extensions.triggerAction" ||
        !hasExactKeys(params, ["id", "targetId"]) ||
        params.id !== capability.extensionId ||
        params.targetId !== capability.tabTargetId ||
        !this._freshTabInfo(
          target,
          capability,
          capability.expectedTabActive,
        )
      ) {
        return this._denyRequest(client, request);
      }
      request._brokerPolicy = "metamask-action";
      return true;
    }
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

    const taskSessionOwner =
      request.sessionId === undefined
        ? null
        : this.sessionOwners.get(request.sessionId);
    if (
      DENIED_METHODS.includes(request.method) ||
      DENIED_METHOD_PREFIXES.some((prefix) =>
        request.method.startsWith(prefix),
      ) ||
      (request.method === "Page.navigate" &&
        isForbiddenTaskUrl(request.params?.url)) ||
      (taskSessionOwner?.targetId &&
        !this._taskOwnedTarget(client, taskSessionOwner.targetId))
    ) {
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
        const target = this._taskOwnedTarget(client, targetId);
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

  _applyWorkspaceTaskCreatePolicy(client, request) {
    const capability = client.capability;
    const state = client.workspaceTaskCreate;
    const params = request.params ?? {};
    if (!state || client.pendingCount !== 0) {
      return this._denyRequest(client, request);
    }
    const rootRequest = request.sessionId === undefined;
    const pageOwner = rootRequest
      ? null
      : this.sessionOwners.get(request.sessionId);
    const exactPageSession = Boolean(
      pageOwner?.client === client &&
        pageOwner.kind === "workspace_task_create_page" &&
        pageOwner.targetId === capability.createdPageTargetId &&
        request.sessionId === state.pageSessionId,
    );
    const accept = (stage) => {
      request._brokerPolicy = `workspace-task-create-${stage}`;
      return true;
    };
    if (
      state.phase === "needs-inventory" &&
      rootRequest &&
      request.method === "Target.getTargets" &&
      hasExactKeys(params, ["filter"]) &&
      canonicalJson(params.filter) ===
        canonicalJson(WORKSPACE_TASK_CREATE_TARGET_FILTER)
    ) return accept("inventory");
    if (
      state.phase === "needs-pre-window" &&
      rootRequest &&
      request.method === "Browser.getWindowForTarget" &&
      hasExactKeys(params, ["targetId"]) &&
      params.targetId === capability.createdTabTargetId
    ) return accept("pre-window");
    if (
      state.phase === "needs-page" &&
      rootRequest &&
      request.method === "Target.getTargetInfo" &&
      hasExactKeys(params, ["targetId"]) &&
      params.targetId === capability.createdPageTargetId
    ) return accept("page");
    if (
      state.phase === "needs-attach" &&
      rootRequest &&
      request.method === "Target.attachToTarget" &&
      hasExactKeys(params, ["targetId", "flatten"]) &&
      params.targetId === capability.createdPageTargetId &&
      params.flatten === true
    ) return accept("attach");
    if (
      state.phase === "needs-navigate" &&
      exactPageSession &&
      request.method === "Page.navigate" &&
      hasExactKeys(params, ["url"]) &&
      params.url === capability.markerUrl &&
      !state.navigateIssued
    ) return accept("navigate");
    if (
      state.phase === "needs-detach" &&
      rootRequest &&
      request.method === "Target.detachFromTarget" &&
      hasExactKeys(params, ["sessionId"]) &&
      params.sessionId === state.pageSessionId
    ) return accept("detach");
    if (
      state.phase === "needs-post-inventory" &&
      rootRequest &&
      request.method === "Target.getTargets" &&
      hasExactKeys(params, ["filter"]) &&
      canonicalJson(params.filter) ===
        canonicalJson(WORKSPACE_TASK_CREATE_TARGET_FILTER)
    ) return accept("post-inventory");
    if (
      state.phase === "needs-post-window" &&
      rootRequest &&
      request.method === "Browser.getWindowForTarget" &&
      hasExactKeys(params, ["targetId"]) &&
      params.targetId === capability.createdTabTargetId
    ) return accept("post-window");
    return this._denyRequest(client, request);
  }

  _applyWorkspaceProvisionPolicy(client, request) {
    const capability = client.capability;
    const state = client.workspaceProvision;
    const params = request.params ?? {};
    if (!state || client.pendingCount !== 0) {
      return this._denyRequest(client, request);
    }
    const rootRequest = request.sessionId === undefined;
    const pageOwner = rootRequest
      ? null
      : this.sessionOwners.get(request.sessionId);
    const exactPageSession = Boolean(
      pageOwner?.client === client &&
        pageOwner.kind === "workspace_provision_page" &&
        pageOwner.targetId === capability.pageTargetId &&
        request.sessionId === state.pageSessionId,
    );
    if (
      state.phase === "needs-inventory" &&
      rootRequest &&
      request.method === "Target.getTargets" &&
      hasExactKeys(params, ["filter"]) &&
      canonicalJson(params.filter) === canonicalJson(TAB_TARGET_FILTER)
    ) {
      request._brokerPolicy = "workspace-provision-inventory";
      return true;
    }
    if (
      state.phase === "needs-post-inventory" &&
      rootRequest &&
      request.method === "Target.getTargets" &&
      hasExactKeys(params, ["filter"]) &&
      canonicalJson(params.filter) === canonicalJson(TAB_TARGET_FILTER)
    ) {
      request._brokerPolicy = "workspace-provision-post-inventory";
      return true;
    }
    if (
      state.phase === "needs-tab" &&
      rootRequest &&
      request.method === "Target.getTargetInfo" &&
      hasExactKeys(params, ["targetId"]) &&
      params.targetId === capability.tabTargetId
    ) {
      request._brokerPolicy = "workspace-provision-tab";
      return true;
    }
    if (
      state.phase === "needs-window" &&
      rootRequest &&
      request.method === "Browser.getWindowForTarget" &&
      hasExactKeys(params, ["targetId"]) &&
      params.targetId === capability.tabTargetId
    ) {
      request._brokerPolicy = "workspace-provision-window";
      return true;
    }
    if (
      state.phase === "needs-page" &&
      rootRequest &&
      request.method === "Target.getTargetInfo" &&
      hasExactKeys(params, ["targetId"]) &&
      params.targetId === capability.pageTargetId
    ) {
      request._brokerPolicy = "workspace-provision-page";
      return true;
    }
    if (
      state.phase === "needs-attach" &&
      rootRequest &&
      request.method === "Target.attachToTarget" &&
      hasExactKeys(params, ["targetId", "flatten"]) &&
      params.targetId === capability.pageTargetId &&
      params.flatten === true
    ) {
      request._brokerPolicy = "workspace-provision-attach";
      return true;
    }
    if (
      state.phase === "needs-version-navigation" &&
      exactPageSession &&
      request.method === "Page.navigate" &&
      hasExactKeys(params, ["url"]) &&
      params.url === "chrome://version/"
    ) {
      request._brokerPolicy = "workspace-provision-version";
      return true;
    }
    if (
      state.phase === "needs-profile-evaluation" &&
      exactPageSession &&
      request.method === "Runtime.evaluate" &&
      hasExactKeys(params, ["expression", "awaitPromise", "returnByValue"]) &&
      params.expression === WORKSPACE_PROFILE_PATH_EXPRESSION &&
      params.awaitPromise === true &&
      params.returnByValue === true
    ) {
      request._brokerPolicy = "workspace-provision-profile";
      return true;
    }
    if (
      state.phase === "needs-marker-navigation" &&
      exactPageSession &&
      request.method === "Page.navigate" &&
      hasExactKeys(params, ["url"]) &&
      params.url === capability.markerUrl
    ) {
      request._brokerPolicy = "workspace-provision-marker";
      return true;
    }
    if (
      state.phase === "needs-detach" &&
      rootRequest &&
      request.method === "Target.detachFromTarget" &&
      hasExactKeys(params, ["sessionId"]) &&
      params.sessionId === state.pageSessionId
    ) {
      request._brokerPolicy = "workspace-provision-detach";
      return true;
    }
    if (
      state.phase === "needs-close" &&
      rootRequest &&
      request.method === "Target.closeTarget" &&
      hasExactKeys(params, ["targetId"]) &&
      params.targetId === capability.pageTargetId
    ) {
      request._brokerPolicy = "workspace-provision-close";
      return true;
    }
    if (
      state.phase === "needs-minimize" &&
      rootRequest &&
      capability.operation === "prove-profile" &&
      capability.windowDisposition === "temporary-profile-window" &&
      request.method === "Browser.setWindowBounds" &&
      hasExactKeys(params, ["windowId", "bounds"]) &&
      params.windowId === capability.windowId &&
      isPlainObject(params.bounds) &&
      hasExactKeys(params.bounds, ["windowState"]) &&
      params.bounds.windowState === "minimized"
    ) {
      request._brokerPolicy = "workspace-provision-minimize";
      return true;
    }
    if (
      state.phase === "needs-minimize-proof" &&
      rootRequest &&
      capability.operation === "prove-profile" &&
      capability.windowDisposition === "temporary-profile-window" &&
      request.method === "Browser.getWindowForTarget" &&
      hasExactKeys(params, ["targetId"]) &&
      params.targetId === capability.tabTargetId
    ) {
      request._brokerPolicy = "workspace-provision-minimize-proof";
      return true;
    }
    return this._denyRequest(client, request);
  }

  _applyMetaMaskRecoveryPolicy(client, request) {
    const recovery = client.metamaskRecovery;
    const capability = client.capability;
    const params = request.params ?? {};
    if (!recovery || client.pendingCount !== 0) {
      return this._denyRequest(client, request);
    }
    const rootRequest = request.sessionId === undefined;
    const sessionOwner = rootRequest
      ? null
      : this.sessionOwners.get(request.sessionId);
    const recoverySession = Boolean(
      sessionOwner?.client === client &&
        sessionOwner.kind === "metamask_recovery_page" &&
        request.sessionId === recovery.carrierSessionId,
    );
    const exactTargetInventory =
      rootRequest &&
      request.method === "Target.getTargets" &&
      canonicalJson(params) === canonicalJson({ filter: METAMASK_TARGET_FILTER });
    const exactAllStorageRead =
      recoverySession &&
      request.method === "Extensions.getStorageItems" &&
      hasExactKeys(params, ["id", "storageArea"]) &&
      params.id === capability.extensionId &&
      params.storageArea === capability.storageArea;
    const exactKeyringRead =
      recoverySession &&
      request.method === "Extensions.getStorageItems" &&
      hasExactKeys(params, ["id", "storageArea", "keys"]) &&
      params.id === capability.extensionId &&
      params.storageArea === capability.storageArea &&
      canonicalJson(params.keys) === canonicalJson(["KeyringController"]);

    if (
      rootRequest &&
      request.method === "AgentBrowser.beginMetaMaskRollback" &&
      hasExactKeys(params, []) &&
      recovery.writeAttempted &&
      recovery.desiredKeyringDigest &&
      !["complete", "no-write-complete", "rolled-back"].includes(
        recovery.phase,
      )
    ) {
      recovery.rollbackMode = true;
      recovery.failureCode ||= "lifecycle_proof_failed";
      const owner = recovery.carrierSessionId
        ? this.sessionOwners.get(recovery.carrierSessionId)
        : null;
      recovery.phase =
        owner?.client === client && owner.kind === "metamask_recovery_page"
          ? "rollback-needs-compare"
          : "rollback-needs-inventory";
      this._sendLocalResult(client, request, {
        rollbackStarted: true,
        carrierAvailable: recovery.phase === "rollback-needs-compare",
      });
      return false;
    }

    if (recovery.phase === "needs-inventory" && exactTargetInventory) {
      request._brokerPolicy = "metamask-recovery-inventory";
      return true;
    }
    if (
      recovery.phase === "needs-attach-carrier" &&
      rootRequest &&
      request.method === "Target.attachToTarget" &&
      hasExactKeys(params, ["targetId", "flatten"]) &&
      params.targetId === recovery.carrierTargetId &&
      params.flatten === true
    ) {
      request._brokerPolicy = "metamask-recovery-attach-carrier";
      return true;
    }
    if (
      recovery.phase === "needs-storage-preflight" &&
      exactAllStorageRead
    ) {
      request._brokerPolicy = "metamask-recovery-storage-preflight";
      return true;
    }
    if (
      recovery.phase === "needs-no-write-detach" &&
      rootRequest &&
      request.method === "Target.detachFromTarget" &&
      hasExactKeys(params, ["sessionId"]) &&
      params.sessionId === recovery.carrierSessionId
    ) {
      request._brokerPolicy = "metamask-recovery-no-write-detach";
      return true;
    }
    if (
      recovery.phase === "needs-no-write-close" &&
      rootRequest &&
      request.method === "Target.closeTarget" &&
      hasExactKeys(params, ["targetId"]) &&
      params.targetId === recovery.carrierTargetId &&
      recovery.createdTargetIds.has(params.targetId)
    ) {
      request._brokerPolicy = "metamask-recovery-no-write-close";
      return true;
    }
    if (
      recovery.phase === "needs-no-write-final-inventory" &&
      exactTargetInventory
    ) {
      request._brokerPolicy = "metamask-recovery-no-write-final-inventory";
      return true;
    }
    if (
      recovery.phase === "needs-quiesce-close" &&
      rootRequest &&
      request.method === "Target.closeTarget" &&
      hasExactKeys(params, ["targetId"]) &&
      params.targetId === recovery.closeQueue[0]?.targetId
    ) {
      request._brokerPolicy = "metamask-recovery-quiesce-close";
      return true;
    }
    if (
      recovery.phase === "needs-quiesce-inventory" &&
      exactTargetInventory
    ) {
      request._brokerPolicy = "metamask-recovery-quiesce-inventory";
      return true;
    }
    if (
      recovery.phase === "needs-quiesce-storage" &&
      exactAllStorageRead
    ) {
      request._brokerPolicy = "metamask-recovery-quiesce-storage";
      return true;
    }
    if (
      recovery.phase === "needs-write" &&
      recoverySession &&
      request.method === "Extensions.setStorageItems" &&
      hasExactKeys(params, ["id", "storageArea", "values"]) &&
      params.id === capability.extensionId &&
      params.storageArea === capability.storageArea &&
      hasExactKeys(params.values, ["KeyringController"]) &&
      hasNonemptyVault(params.values.KeyringController)
    ) {
      const encodedBytes = Buffer.byteLength(
        canonicalJson(params.values.KeyringController),
        "utf8",
      );
      if (encodedBytes <= 0 || encodedBytes > METAMASK_MAX_KEYRING_BYTES) {
        return this._denyRequest(client, request);
      }
      recovery.desiredKeyringValue = cloneJsonValue(
        params.values.KeyringController,
      );
      recovery.desiredKeyringDigest = keyringDigest(
        true,
        recovery.desiredKeyringValue,
      );
      recovery.writeAttempted = true;
      request._brokerPolicy = "metamask-recovery-write";
      return true;
    }
    if (recovery.phase === "needs-write-verify" && exactKeyringRead) {
      request._brokerPolicy = "metamask-recovery-write-verify";
      return true;
    }
    if (
      recovery.phase === "needs-carrier-detach" &&
      rootRequest &&
      request.method === "Target.detachFromTarget" &&
      hasExactKeys(params, ["sessionId"]) &&
      params.sessionId === recovery.carrierSessionId
    ) {
      request._brokerPolicy = "metamask-recovery-carrier-detach";
      return true;
    }
    if (
      recovery.phase === "needs-carrier-close" &&
      rootRequest &&
      request.method === "Target.closeTarget" &&
      hasExactKeys(params, ["targetId"]) &&
      params.targetId === recovery.carrierTargetId
    ) {
      request._brokerPolicy = "metamask-recovery-carrier-close";
      return true;
    }
    if (
      ["needs-preaction-inventory", "needs-final-inventory"].includes(
        recovery.phase,
      ) &&
      exactTargetInventory
    ) {
      request._brokerPolicy =
        recovery.phase === "needs-preaction-inventory"
          ? "metamask-recovery-preaction-inventory"
          : "metamask-recovery-final-inventory";
      return true;
    }
    if (
      ["needs-preaction-close", "needs-final-close"].includes(
        recovery.phase,
      ) &&
      rootRequest &&
      request.method === "Target.closeTarget" &&
      hasExactKeys(params, ["targetId"]) &&
      params.targetId === recovery.closeQueue[0]?.targetId
    ) {
      request._brokerPolicy =
        recovery.phase === "needs-preaction-close"
          ? "metamask-recovery-preaction-close"
          : "metamask-recovery-final-close";
      return true;
    }
    if (
      recovery.phase === "needs-tab-proof" &&
      rootRequest &&
      request.method === "Target.getTargetInfo" &&
      hasExactKeys(params, ["targetId"]) &&
      params.targetId === capability.tabTargetId
    ) {
      request._brokerPolicy = "metamask-recovery-tab-proof";
      return true;
    }
    if (
      recovery.phase === "needs-trigger" &&
      rootRequest &&
      request.method === "Extensions.triggerAction" &&
      hasExactKeys(params, ["id", "targetId"]) &&
      params.id === capability.extensionId &&
      params.targetId === capability.tabTargetId
    ) {
      request._brokerPolicy = "metamask-recovery-trigger";
      return true;
    }
    if (
      recovery.phase === "needs-created-attach" &&
      rootRequest &&
      request.method === "Target.attachToTarget" &&
      hasExactKeys(params, ["targetId", "flatten"]) &&
      params.targetId === recovery.actionCreatedTargetId &&
      params.flatten === true
    ) {
      // Bind the exact action-created target before Chrome emits the matching
      // attached event. Waiting for the command response leaves an authority
      // gap because the event can arrive first.
      recovery.carrierTargetId = recovery.actionCreatedTargetId;
      request._brokerPolicy = "metamask-recovery-attach-created";
      return true;
    }
    if (
      recovery.phase === "needs-page-enable" &&
      recoverySession &&
      request.method === "Page.enable" &&
      hasExactKeys(params, [])
    ) {
      request._brokerPolicy = "metamask-recovery-page-enable";
      return true;
    }
    if (
      recovery.phase === "needs-runtime-enable" &&
      recoverySession &&
      request.method === "Runtime.enable" &&
      hasExactKeys(params, [])
    ) {
      request._brokerPolicy = "metamask-recovery-runtime-enable";
      return true;
    }
    if (
      recovery.phase === "needs-frame-tree" &&
      recoverySession &&
      request.method === "Page.getFrameTree" &&
      hasExactKeys(params, [])
    ) {
      request._brokerPolicy = "metamask-recovery-frame-tree";
      return true;
    }
    if (
      recovery.phase === "needs-default-proof" &&
      recoverySession &&
      request.method === "Runtime.evaluate" &&
      this._validMetaMaskDefaultWorldEvaluation(recovery, params)
    ) {
      request._brokerPolicy = "metamask-recovery-default-proof";
      return true;
    }
    if (
      recovery.phase === "needs-fresh-storage-proof" &&
      exactAllStorageRead
    ) {
      request._brokerPolicy = "metamask-recovery-fresh-storage-proof";
      return true;
    }
    if (
      recovery.phase === "needs-success-detach" &&
      rootRequest &&
      request.method === "Target.detachFromTarget" &&
      hasExactKeys(params, ["sessionId"]) &&
      params.sessionId === recovery.carrierSessionId
    ) {
      request._brokerPolicy = "metamask-recovery-success-detach";
      return true;
    }
    if (
      recovery.phase === "needs-success-close" &&
      rootRequest &&
      request.method === "Target.closeTarget" &&
      hasExactKeys(params, ["targetId"]) &&
      params.targetId === recovery.carrierTargetId &&
      recovery.createdTargetIds.has(params.targetId)
    ) {
      request._brokerPolicy = "metamask-recovery-success-close";
      return true;
    }

    if (recovery.phase === "rollback-needs-inventory" && exactTargetInventory) {
      request._brokerPolicy = "metamask-recovery-rollback-inventory";
      return true;
    }
    if (
      recovery.phase === "rollback-needs-attach" &&
      rootRequest &&
      request.method === "Target.attachToTarget" &&
      hasExactKeys(params, ["targetId", "flatten"]) &&
      params.targetId === recovery.carrierTargetId &&
      params.flatten === true
    ) {
      request._brokerPolicy = "metamask-recovery-rollback-attach";
      return true;
    }
    if (recovery.phase === "rollback-needs-compare" && exactKeyringRead) {
      request._brokerPolicy = "metamask-recovery-rollback-compare";
      return true;
    }
    if (
      recovery.phase === "rollback-needs-write" &&
      recoverySession &&
      request.method === "AgentBrowser.restoreMetaMaskPreimage" &&
      hasExactKeys(params, [])
    ) {
      request._brokerMethod = recovery.preimageKeyringPresent
        ? "Extensions.setStorageItems"
        : "Extensions.removeStorageItems";
      request._brokerParams = recovery.preimageKeyringPresent
        ? {
            id: capability.extensionId,
            storageArea: capability.storageArea,
            values: {
              KeyringController: cloneJsonValue(
                recovery.preimageKeyringValue,
              ),
            },
          }
        : {
            id: capability.extensionId,
            storageArea: capability.storageArea,
            keys: ["KeyringController"],
          };
      request._brokerPolicy = "metamask-recovery-rollback-write";
      return true;
    }
    if (recovery.phase === "rollback-needs-verify" && exactKeyringRead) {
      request._brokerPolicy = "metamask-recovery-rollback-verify";
      return true;
    }
    if (recovery.phase === "rollback-needs-protected" && exactAllStorageRead) {
      request._brokerPolicy = "metamask-recovery-rollback-protected";
      return true;
    }
    if (
      ["rollback-needs-detach", "rollback-blocked-needs-detach"].includes(
        recovery.phase,
      ) &&
      rootRequest &&
      request.method === "Target.detachFromTarget" &&
      hasExactKeys(params, ["sessionId"]) &&
      params.sessionId === recovery.carrierSessionId
    ) {
      request._brokerPolicy = "metamask-recovery-rollback-detach";
      return true;
    }
    if (
      ["rollback-needs-close", "rollback-blocked-needs-close"].includes(
        recovery.phase,
      ) &&
      rootRequest &&
      request.method === "Target.closeTarget" &&
      hasExactKeys(params, ["targetId"]) &&
      params.targetId === recovery.carrierTargetId &&
      recovery.createdTargetIds.has(params.targetId)
    ) {
      request._brokerPolicy = "metamask-recovery-rollback-close";
      return true;
    }
    if (
      [
        "rollback-needs-final-inventory",
        "rollback-blocked-needs-final-inventory",
      ].includes(recovery.phase) &&
      exactTargetInventory
    ) {
      request._brokerPolicy = "metamask-recovery-rollback-final-inventory";
      return true;
    }
    if (
      ["rollback-needs-final-close", "rollback-blocked-needs-final-close"].includes(
        recovery.phase,
      ) &&
      rootRequest &&
      request.method === "Target.closeTarget" &&
      hasExactKeys(params, ["targetId"]) &&
      params.targetId === recovery.closeQueue[0]?.targetId
    ) {
      request._brokerPolicy = "metamask-recovery-rollback-final-close";
      return true;
    }
    return this._denyRequest(client, request);
  }

  _validMetaMaskDefaultWorldEvaluation(recovery, params) {
    const expectedContext = recovery.defaultUniqueContextId
      ? { uniqueContextId: recovery.defaultUniqueContextId }
      : { contextId: recovery.defaultContextId };
    return (
      hasExactKeys(params, [
        "expression",
        "returnByValue",
        "awaitPromise",
        ...Object.keys(expectedContext),
      ]) &&
      params.expression === METAMASK_DEFAULT_WORLD_PROOF_EXPRESSION &&
      params.returnByValue === true &&
      params.awaitPromise === false &&
      Object.entries(expectedContext).every(
        ([key, value]) => params[key] === value,
      )
    );
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
    if (stage?.startsWith("workspace-task-create-")) {
      const state = client.workspaceTaskCreate;
      if (state) {
        state.phase = `${stage}-pending`;
        if (stage === "workspace-task-create-navigate") {
          state.navigateIssued = true;
        }
      }
      return;
    }
    if (stage?.startsWith("workspace-provision-")) {
      if (client.workspaceProvision) {
        client.workspaceProvision.phase = `${stage}-pending`;
      }
      return;
    }
    if (stage?.startsWith("metamask-recovery-")) {
      this._commitMetaMaskRecoveryRequest(client, stage);
      return;
    }
    if (stage === "metamask-action") {
      client.metamaskActionUsed = true;
      return;
    }
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
    if (stage.startsWith("workspace-task-create-")) {
      return this._validateWorkspaceTaskCreateResponse(
        client,
        pending,
        message,
      );
    }
    if (stage.startsWith("workspace-provision-")) {
      return this._validateWorkspaceProvisionResponse(
        client,
        pending,
        message,
      );
    }
    if (stage.startsWith("metamask-recovery-")) {
      return this._validateMetaMaskRecoveryResponse(
        client,
        pending,
        message,
      );
    }
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
    if (stage === "metamask-action") {
      if (!hasExactKeys(message.result ?? {}, [])) {
        this._closeClient(client, CLOSE_POLICY, "MetaMask action response invalid");
        return false;
      }
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

  _workspaceTaskCreateTargetInfo(value) {
    if (
      !isPlainObject(value) ||
      !TARGET_ID_PATTERN.test(value.targetId) ||
      !["tab", "page"].includes(value.type) ||
      typeof value.url !== "string" ||
      Buffer.byteLength(value.url, "utf8") > 16 * 1024 ||
      (value.title !== undefined &&
        (typeof value.title !== "string" ||
          Buffer.byteLength(value.title, "utf8") > 4096)) ||
      (value.browserContextId !== undefined &&
        !TARGET_ID_PATTERN.test(value.browserContextId)) ||
      (value.openerId !== undefined &&
        !TARGET_ID_PATTERN.test(value.openerId)) ||
      (value.attached !== undefined && typeof value.attached !== "boolean") ||
      (value.embedderData !== undefined &&
        !isPlainObject(value.embedderData))
    ) {
      return null;
    }
    if (value.type === "tab" && this._inventoryTabInfo(value) === null) {
      return null;
    }
    return value;
  }

  _workspaceTaskCreateInventory(client, targetInfos, postNavigate) {
    const capability = client.capability;
    const state = client.workspaceTaskCreate;
    const normalized = Array.isArray(targetInfos)
      ? targetInfos.map((info) => this._workspaceTaskCreateTargetInfo(info))
      : [];
    if (
      !state ||
      !Array.isArray(targetInfos) ||
      targetInfos.length > this.limits.maxTabInventoryTargets * 2 ||
      normalized.some((info) => info === null) ||
      new Set(normalized.map((info) => info.targetId)).size !== normalized.length
    ) {
      return null;
    }

    const identityKeys = normalized
      .map((info) => `${info.type}\0${info.targetId}`)
      .sort();
    if (
      postNavigate &&
      canonicalJson(identityKeys) !== canonicalJson(state.inventoryTargetKeys)
    ) {
      return null;
    }

    const sameContextTabs = normalized.filter(
      (info) =>
        info.type === "tab" &&
        info.browserContextId === capability.browserContextId,
    );
    if (sameContextTabs.some((info) => !this._freshTabInfo(info))) {
      return null;
    }
    const currentTabIds = sameContextTabs
      .map((info) => info.targetId)
      .sort();
    const expectedTabIds = [
      ...capability.precreateTabTargetIds,
      capability.createdTabTargetId,
    ].sort();
    const activeTabIds = sameContextTabs
      .filter((info) => info.embedderData.tabActive)
      .map((info) => info.targetId)
      .sort();
    const createdTab = sameContextTabs.find(
      (info) => info.targetId === capability.createdTabTargetId,
    );
    const anchorTab = sameContextTabs.find(
      (info) => info.targetId === capability.anchorTabTargetId,
    );
    const anchorPage = normalized.find(
      (info) =>
        info.type === "page" &&
        info.targetId === capability.anchorPageTargetId,
    );
    const createdPage = normalized.find(
      (info) =>
        info.type === "page" &&
        info.targetId === capability.createdPageTargetId,
    );
    const markerTargets = normalized.filter(
      (info) => info.url === capability.markerUrl,
    );
    const createdUrlsValid = postNavigate
      ? createdPage?.url === capability.markerUrl &&
        (createdTab?.url === capability.markerUrl ||
          WORKSPACE_TASK_NEWBORN_URLS.includes(createdTab?.url)) &&
        markerTargets.every((info) =>
          [
            capability.createdPageTargetId,
            capability.createdTabTargetId,
          ].includes(info.targetId),
        )
      : WORKSPACE_TASK_NEWBORN_URLS.includes(createdTab?.url) &&
        WORKSPACE_TASK_NEWBORN_URLS.includes(createdPage?.url) &&
        markerTargets.length === 0;

    if (
      canonicalJson(currentTabIds) !== canonicalJson(expectedTabIds) ||
      canonicalJson(activeTabIds) !==
        canonicalJson(capability.precreateActiveTabTargetIds) ||
      !anchorTab ||
      anchorTab.embedderData.tabActive !==
        capability.anchorExpectedTabActive ||
      !anchorPage ||
      anchorPage.browserContextId !== capability.browserContextId ||
      anchorPage.attached !== false ||
      anchorPage.url !== capability.anchorMarkerUrl ||
      !createdTab ||
      createdTab.embedderData.tabActive !==
        capability.createdExpectedTabActive ||
      !createdPage ||
      createdPage.browserContextId !== capability.browserContextId ||
      createdPage.attached !== false ||
      !createdUrlsValid
    ) {
      return null;
    }

    if (!postNavigate) state.inventoryTargetKeys = identityKeys;
    return {
      targetInfos: [
        {
          targetId: createdTab.targetId,
          type: "tab",
          url: createdTab.url,
          browserContextId: createdTab.browserContextId,
          embedderData: {
            tabActive: createdTab.embedderData.tabActive,
          },
        },
        {
          targetId: createdPage.targetId,
          type: "page",
          url: createdPage.url,
          attached: createdPage.attached,
          browserContextId: createdPage.browserContextId,
        },
      ],
    };
  }

  _validateWorkspaceTaskCreateResponse(client, pending, message) {
    const capability = client.capability;
    const state = client.workspaceTaskCreate;
    const stage = pending.policyStage;
    if (!state) {
      this._closeClient(client, CLOSE_POLICY, "workspace task-create state missing");
      return false;
    }
    if (message.error) {
      const code = message.error.code;
      const errorMessage = message.error.message;
      if (
        !Number.isSafeInteger(code) ||
        typeof errorMessage !== "string" ||
        Buffer.byteLength(errorMessage, "utf8") > 480
      ) {
        this._closeClient(client, CLOSE_POLICY, "workspace task-create error invalid");
        return false;
      }
      // Preserve a bounded owner error so the controller can close/quarantine
      // the signed created target. Never leak ambient inventory or try another
      // creation/navigate path after any partial failure.
      message.error = { code, message: errorMessage };
      state.failureObserved = true;
      if (stage === "workspace-task-create-navigate") {
        state.phase = "needs-detach";
      } else {
        state.phase = "failed";
      }
      return true;
    }
    if (stage === "workspace-task-create-inventory") {
      const inventory = this._workspaceTaskCreateInventory(
        client,
        message.result?.targetInfos,
        false,
      );
      if (!inventory) {
        this._closeClient(client, CLOSE_POLICY, "workspace task-create inventory proof failed");
        return false;
      }
      message.result = inventory;
      state.phase = "needs-pre-window";
      return true;
    }
    if (stage === "workspace-task-create-pre-window") {
      const windowId = message.result?.windowId;
      if (
        !isPlainObject(message.result) ||
        !Number.isSafeInteger(windowId) ||
        windowId < 0 ||
        windowId !== capability.anchorWindowId ||
        !capability.precreateWindowIds.includes(windowId)
      ) {
        this._closeClient(client, CLOSE_POLICY, "workspace task-create pre-window proof failed");
        return false;
      }
      message.result = { windowId };
      state.phase = "needs-page";
      return true;
    }
    if (stage === "workspace-task-create-page") {
      const info = this._workspaceTaskCreateTargetInfo(
        message.result?.targetInfo,
      );
      if (
        !info ||
        info.targetId !== capability.createdPageTargetId ||
        info.type !== "page" ||
        info.browserContextId !== capability.browserContextId ||
        info.attached !== false ||
        !WORKSPACE_TASK_NEWBORN_URLS.includes(info.url) ||
        info.url === capability.markerUrl
      ) {
        this._closeClient(client, CLOSE_POLICY, "workspace task-create page proof failed");
        return false;
      }
      message.result = {
        targetInfo: {
          targetId: info.targetId,
          type: info.type,
          url: info.url,
          attached: info.attached,
          browserContextId: info.browserContextId,
        },
      };
      state.phase = "needs-attach";
      return true;
    }
    if (stage === "workspace-task-create-attach") {
      const sessionId = message.result?.sessionId;
      if (
        !hasExactKeys(message.result ?? {}, ["sessionId"]) ||
        !SESSION_ID_PATTERN.test(sessionId)
      ) {
        this._closeClient(client, CLOSE_POLICY, "workspace task-create attach proof failed");
        return false;
      }
      state.pageSessionId = sessionId;
      state.phase = "needs-navigate";
      return true;
    }
    if (stage === "workspace-task-create-navigate") {
      const result = message.result;
      const resultKeys = isPlainObject(result) ? Object.keys(result) : [];
      if (
        !isPlainObject(result) ||
        !TARGET_ID_PATTERN.test(result.frameId) ||
        resultKeys.some(
          (key) => !["frameId", "loaderId", "isDownload"].includes(key),
        ) ||
        (result.loaderId !== undefined &&
          !TARGET_ID_PATTERN.test(result.loaderId)) ||
        (result.isDownload !== undefined && result.isDownload !== false)
      ) {
        this._closeClient(client, CLOSE_POLICY, "workspace task-create navigate response invalid");
        return false;
      }
      message.result = {};
      state.phase = "needs-detach";
      return true;
    }
    if (stage === "workspace-task-create-detach") {
      if (!hasExactKeys(message.result ?? {}, [])) {
        this._closeClient(client, CLOSE_POLICY, "workspace task-create detach response invalid");
        return false;
      }
      state.phase = state.failureObserved ? "failed" : "needs-post-inventory";
      return true;
    }
    if (stage === "workspace-task-create-post-inventory") {
      const inventory = this._workspaceTaskCreateInventory(
        client,
        message.result?.targetInfos,
        true,
      );
      if (!inventory) {
        this._closeClient(client, CLOSE_POLICY, "workspace task-create post-inventory proof failed");
        return false;
      }
      message.result = inventory;
      state.phase = "needs-post-window";
      return true;
    }
    if (stage === "workspace-task-create-post-window") {
      const windowId = message.result?.windowId;
      if (
        !isPlainObject(message.result) ||
        !Number.isSafeInteger(windowId) ||
        windowId !== capability.anchorWindowId ||
        !capability.precreateWindowIds.includes(windowId)
      ) {
        this._closeClient(client, CLOSE_POLICY, "workspace task-create post-window proof failed");
        return false;
      }
      message.result = { windowId };
      state.phase = "complete";
      return true;
    }
    this._closeClient(client, CLOSE_POLICY, "workspace task-create response sequence invalid");
    return false;
  }

  _validateWorkspaceProvisionResponse(client, pending, message) {
    const capability = client.capability;
    const state = client.workspaceProvision;
    const stage = pending.policyStage;
    if (!state || message.error) {
      this._closeClient(client, CLOSE_POLICY, "workspace provisioning probe failed");
      return false;
    }
    if (
      stage === "workspace-provision-inventory"
    ) {
      const targetInfos = message.result?.targetInfos;
      const classified = Array.isArray(targetInfos)
        ? targetInfos.map((info) => this._inventoryTabInfo(info))
        : [];
      const valid =
        Array.isArray(targetInfos) &&
        targetInfos.length <= this.limits.maxTabInventoryTargets &&
        !classified.some((kind) => kind === null) &&
        new Set(targetInfos.map((info) => info.targetId)).size === targetInfos.length;
      // Chrome can expose WebContents-level `tab` wrappers without the
      // browserContextId/embedderData that proves membership in a real browser
      // tab strip. The ordinary controller inventory already treats those as
      // ineligible, not malformed. Provisioning must use the same causal set;
      // rejecting the entire inventory here closed the exact cleanup client
      // before it could close its owned page.
      const eligibleTargetInfos = valid
        ? targetInfos.filter((_info, index) => classified[index] === "eligible")
        : [];
      const currentIds = valid
        ? new Set(eligibleTargetInfos.map((info) => info.targetId))
        : new Set();
      const deltaIds = valid
        ? [...currentIds].filter(
            (targetId) => !capability.prelaunchTabTargetIds.includes(targetId),
          )
        : [];
      const inventoryValid =
        valid &&
        currentIds.has(capability.tabTargetId) &&
        (capability.operation === "cleanup-created-target" ||
          (["recover-marker", "retire-anchor"].includes(
            capability.operation,
          )
            ? currentIds.size === capability.prelaunchTabTargetIds.length &&
              capability.prelaunchTabTargetIds.every((targetId) =>
                currentIds.has(targetId),
              )
            : deltaIds.length === 1 &&
              deltaIds[0] === capability.tabTargetId));
      if (!inventoryValid) {
        this._closeClient(
          client,
          CLOSE_POLICY,
          "workspace provisioning inventory proof failed",
        );
        return false;
      }
      message.result.targetInfos = eligibleTargetInfos;
      state.phase = "needs-tab";
      return true;
    }
    if (stage === "workspace-provision-post-inventory") {
      const targetInfos = message.result?.targetInfos;
      const classified = Array.isArray(targetInfos)
        ? targetInfos.map((info) => this._inventoryTabInfo(info))
        : [];
      const valid =
        capability.operation === "recover-marker" &&
        Array.isArray(targetInfos) &&
        targetInfos.length <= this.limits.maxTabInventoryTargets &&
        !classified.some((kind) => kind === null) &&
        new Set(targetInfos.map((info) => info.targetId)).size ===
          targetInfos.length;
      const eligibleTargetInfos = valid
        ? targetInfos.filter((_info, index) => classified[index] === "eligible")
        : [];
      const currentIds = new Set(
        eligibleTargetInfos.map((info) => info.targetId),
      );
      if (
        !valid ||
        currentIds.size !== capability.prelaunchTabTargetIds.length ||
        !capability.prelaunchTabTargetIds.every((targetId) =>
          currentIds.has(targetId),
        )
      ) {
        this._closeClient(
          client,
          CLOSE_POLICY,
          "workspace recovery post-inventory proof failed",
        );
        return false;
      }
      message.result.targetInfos = eligibleTargetInfos;
      state.phase = "complete";
      return true;
    }
    if (stage === "workspace-provision-tab") {
      if (
        !this._freshTabInfo(
          message.result?.targetInfo,
          capability,
          capability.expectedTabActive,
        )
      ) {
        this._closeClient(client, CLOSE_POLICY, "workspace provisioning tab proof failed");
        return false;
      }
      state.phase = "needs-window";
      return true;
    }
    if (stage === "workspace-provision-window") {
      const windowId = message.result?.windowId;
      if (
        !isPlainObject(message.result) ||
        !Number.isSafeInteger(windowId) ||
        windowId < 0 ||
        windowId !== capability.windowId ||
        (capability.operation === "retire-anchor" &&
          capability.windowDisposition === "temporary-profile-window" &&
          message.result?.bounds?.windowState !== "minimized")
      ) {
        this._closeClient(client, CLOSE_POLICY, "workspace provisioning window proof failed");
        return false;
      }
      // Browser.getWindowForTarget may include mutable window bounds. Bind and
      // return only the stable identity, matching the proven discovery path.
      message.result = { windowId };
      state.phase = "needs-page";
      return true;
    }
    if (stage === "workspace-provision-page") {
      const info = message.result?.targetInfo;
      let allowedUrl = false;
      if (capability.operation === "prove-profile") {
        // WHY: a cold launch names one requester-bound marker. Accepting plain
        // about:blank as well would let the broker prove a different restored
        // page. The legacy blank path remains valid only when no cold marker
        // was minted.
        allowedUrl = capability.initialMarkerUrl
          ? info?.url === capability.initialMarkerUrl
          : info?.url === "about:blank";
      } else if (capability.operation === "recover-marker") {
        allowedUrl =
          typeof info?.url === "string" &&
          Buffer.byteLength(info.url, "utf8") <= 16 * 1024;
      } else if (capability.operation === "retire-anchor") {
        allowedUrl = info?.url === capability.markerUrl;
      } else {
        // A controller crash can occur after exact UIA creation but before the
        // one broker navigation. Recovery must be able to close that same
        // signed TAB/page while it is still on a fixed newborn URL; widening
        // this to an arbitrary URL would turn cleanup into user-tab adoption.
        const cleanupUrls = [
          "chrome://version/",
          capability.markerUrl,
          ...WORKSPACE_TASK_NEWBORN_URLS,
        ];
        cleanupUrls.push(
          capability.initialMarkerUrl || "about:blank",
        );
        allowedUrl = cleanupUrls.includes(info?.url);
      }
      if (
        !isPlainObject(info) ||
        info.targetId !== capability.pageTargetId ||
        info.type !== "page" ||
        info.browserContextId !== capability.browserContextId ||
        info.attached !== false ||
        !allowedUrl
      ) {
        this._closeClient(client, CLOSE_POLICY, "workspace provisioning page proof failed");
        return false;
      }
      state.phase =
        ["cleanup-created-target", "retire-anchor"].includes(
          capability.operation,
        )
          ? "needs-close"
          : "needs-attach";
      return true;
    }
    if (stage === "workspace-provision-attach") {
      const sessionId = message.result?.sessionId;
      if (
        !hasExactKeys(message.result ?? {}, ["sessionId"]) ||
        !SESSION_ID_PATTERN.test(sessionId)
      ) {
        this._closeClient(client, CLOSE_POLICY, "workspace provisioning attach proof failed");
        return false;
      }
      state.pageSessionId = sessionId;
      state.phase =
        capability.operation === "recover-marker"
          ? "needs-marker-navigation"
          : "needs-version-navigation";
      return true;
    }
    if (
      stage === "workspace-provision-version" ||
      stage === "workspace-provision-marker"
    ) {
      if (
        !isPlainObject(message.result) ||
        "errorText" in message.result ||
        message.result.isDownload === true ||
        typeof message.result.frameId !== "string" ||
        !message.result.frameId
      ) {
        this._closeClient(client, CLOSE_POLICY, "workspace provisioning navigation failed");
        return false;
      }
      state.phase =
        stage === "workspace-provision-version"
          ? "needs-profile-evaluation"
          : "needs-detach";
      return true;
    }
    if (stage === "workspace-provision-profile") {
      const remote = message.result?.result;
      if (
        !isPlainObject(remote) ||
        remote.type !== "string" ||
        typeof remote.value !== "string" ||
        Buffer.byteLength(remote.value, "utf8") > 128 * 1024 ||
        message.result?.exceptionDetails !== undefined
      ) {
        this._closeClient(client, CLOSE_POLICY, "workspace profile-path response invalid");
        return false;
      }
      state.phase = "needs-marker-navigation";
      return true;
    }
    if (stage === "workspace-provision-detach") {
      if (!hasExactKeys(message.result ?? {}, [])) {
        this._closeClient(client, CLOSE_POLICY, "workspace provisioning detach failed");
        return false;
      }
      state.phase =
        capability.operation === "recover-marker"
          ? "needs-post-inventory"
          : capability.operation === "prove-profile" &&
              capability.windowDisposition === "temporary-profile-window"
            ? "needs-minimize"
            : "complete";
      return true;
    }
    if (stage === "workspace-provision-minimize") {
      if (!hasExactKeys(message.result ?? {}, [])) {
        this._closeClient(client, CLOSE_POLICY, "workspace temporary-window minimize failed");
        return false;
      }
      state.phase = "needs-minimize-proof";
      return true;
    }
    if (stage === "workspace-provision-minimize-proof") {
      const result = message.result;
      const bounds = result?.bounds;
      if (
        !isPlainObject(result) ||
        !isPlainObject(bounds) ||
        result.windowId !== capability.windowId ||
        bounds.windowState !== "minimized"
      ) {
        this._closeClient(
          client,
          CLOSE_POLICY,
          "workspace temporary-window minimize proof failed",
        );
        return false;
      }
      message.result = {
        windowId: capability.windowId,
        windowState: "minimized",
      };
      state.phase = "complete";
      return true;
    }
    if (stage === "workspace-provision-close") {
      if (
        !hasExactKeys(message.result ?? {}, ["success"]) ||
        message.result.success !== true
      ) {
        this._closeClient(client, CLOSE_POLICY, "workspace exact-target close failed");
        return false;
      }
      // Target destruction and tab-wrapper retirement are asynchronous in
      // Stable Chrome.  The controller performs the bounded fresh inventory
      // poll after this exact close succeeds; requiring immediate absence on
      // this same socket produced false cleanup failures after a real close.
      state.phase = "complete";
      return true;
    }
    this._closeClient(client, CLOSE_POLICY, "workspace provisioning stage invalid");
    return false;
  }

  _validateMetaMaskRecoveryResponse(client, pending, message) {
    const recovery = client.metamaskRecovery;
    const capability = client.capability;
    const stage = pending.policyStage;
    if (!recovery) return false;
    if (message.error) {
      recovery.failureCode = "upstream_command_failed";
      if (recovery.writeAttempted) {
        recovery.phase = "failed-awaiting-rollback";
        message.error = {
          code: -32010,
          message: "MetaMask recovery command failed; rollback required",
        };
        return true;
      }
      this._closeClient(
        client,
        CLOSE_POLICY,
        "MetaMask recovery preflight failed",
      );
      return false;
    }

    if (stage === "metamask-recovery-inventory") {
      const inventory = this._validatedMetaMaskRecoveryInventory(
        client,
        message.result?.targetInfos,
      );
      if (!inventory) return false;
      if (inventory.pages.length === 0) {
        // A closed MetaMask UI is the normal cold-profile state. Use the
        // already-owned background workspace tab and the supported extension
        // action to create one exact carrier; never adopt or create a user tab.
        recovery.carrierBootstrapPending = true;
        recovery.closeQueue = inventory.workers.map((info) => ({
          targetId: info.targetId,
          type: "service_worker",
        }));
        recovery.phase = "needs-tab-proof";
        message.result = {
          profileDirectory: capability.profileDirectory,
          extensionId: capability.extensionId,
          extensionVersion: capability.extensionVersion,
          browserContextId: capability.browserContextId,
          carrierTargetId: "",
          carrierBootstrapRequired: true,
          closeTargetIds: recovery.closeQueue.map((entry) => entry.targetId),
        };
        return true;
      }
      recovery.carrierBootstrapPending = false;
      recovery.carrierTargetId = inventory.pages[0].targetId;
      recovery.closeQueue = [
        ...inventory.pages.slice(1).map((info) => ({
          targetId: info.targetId,
          type: "page",
        })),
        ...inventory.workers.map((info) => ({
          targetId: info.targetId,
          type: "service_worker",
        })),
      ].sort((left, right) => left.targetId.localeCompare(right.targetId));
      recovery.phase = "needs-attach-carrier";
      message.result = {
        profileDirectory: capability.profileDirectory,
        extensionId: capability.extensionId,
        extensionVersion: capability.extensionVersion,
        browserContextId: capability.browserContextId,
        carrierTargetId: recovery.carrierTargetId,
        closeTargetIds: recovery.closeQueue.map((entry) => entry.targetId),
        carrierBootstrapRequired: false,
      };
      return true;
    }
    if (
      [
        "metamask-recovery-attach-carrier",
        "metamask-recovery-attach-created",
        "metamask-recovery-rollback-attach",
      ].includes(stage)
    ) {
      const sessionId = message.result?.sessionId;
      if (
        !hasExactKeys(message.result, ["sessionId"]) ||
        !SESSION_ID_PATTERN.test(sessionId)
      ) {
        return this._rejectMetaMaskRecoveryResponse(
          client,
          message,
          "extension_page_attach_failed",
        );
      }
      recovery.carrierSessionId = sessionId;
      if (stage === "metamask-recovery-attach-carrier") {
        recovery.phase = "needs-storage-preflight";
      } else if (stage === "metamask-recovery-attach-created") {
        if (recovery.carrierBootstrapPending) {
          recovery.carrierBootstrapPending = false;
          recovery.phase = "needs-storage-preflight";
        } else {
          recovery.mainFrameId = null;
          recovery.defaultContexts = [];
          recovery.defaultContextId = null;
          recovery.defaultUniqueContextId = null;
          recovery.phase = "needs-page-enable";
        }
      } else {
        recovery.phase = "rollback-needs-compare";
      }
      return true;
    }
    if (stage === "metamask-recovery-storage-preflight") {
      const storage = message.result?.data;
      if (!validMetaMaskStorage(storage)) {
        return this._rejectMetaMaskRecoveryResponse(
          client,
          message,
          "storage_contract_changed",
        );
      }
      recovery.preimageKeyringPresent = "KeyringController" in storage;
      recovery.preimageKeyringValue = recovery.preimageKeyringPresent
        ? cloneJsonValue(storage.KeyringController)
        : null;
      recovery.preimageKeyringDigest = keyringDigest(
        recovery.preimageKeyringPresent,
        recovery.preimageKeyringValue,
      );
      recovery.preimageStorageDigest = canonicalSha256(storage);
      recovery.protectedStorageDigest = protectedStorageDigest(storage);
      const onboardingComplete =
        storage.OnboardingController.completedOnboarding === true;
      const vaultPresent = hasNonemptyVault(storage.KeyringController);
      recovery.noWrite = vaultPresent;
      recovery.phase = vaultPresent
        ? "needs-no-write-detach"
        : recovery.closeQueue.length > 0
          ? "needs-quiesce-close"
          : "needs-quiesce-inventory";
      message.result = {
        data: {
          manifestValid: true,
          storageKindSplit: true,
          storageVersionMatches: true,
          onboardingComplete,
          vaultPresent,
          storageKeyCount: Object.keys(storage).length,
          protectedStorageSha256: recovery.protectedStorageDigest,
          preimageKeyringSha256: recovery.preimageKeyringDigest,
        },
      };
      return true;
    }
    if (stage === "metamask-recovery-no-write-detach") {
      if (!hasExactKeys(message.result ?? {}, [])) {
        return this._rejectMetaMaskRecoveryResponse(
          client,
          message,
          "no_write_cleanup_failed",
        );
      }
      const closeCarrier = recovery.createdTargetIds.has(
        recovery.carrierTargetId,
      );
      recovery.phase = closeCarrier
        ? "needs-no-write-close"
        : "no-write-complete";
      message.result = {
        status: "already_initialized",
        noWrite: true,
        vaultPresent: true,
        closeCarrier,
      };
      return true;
    }
    if (stage === "metamask-recovery-no-write-close") {
      if (message.result?.success !== true) {
        return this._rejectMetaMaskRecoveryResponse(
          client,
          message,
          "no_write_cleanup_failed",
        );
      }
      recovery.carrierSessionId = null;
      recovery.phase = "needs-no-write-final-inventory";
      message.result = { success: true };
      return true;
    }
    if (stage === "metamask-recovery-no-write-final-inventory") {
      const inventory = this._validatedMetaMaskRecoveryInventory(
        client,
        message.result?.targetInfos,
      );
      if (!inventory) return false;
      const ownedPages = inventory.pages.filter((info) =>
        recovery.createdTargetIds.has(info.targetId),
      );
      if (ownedPages.length > 0) {
        if (recovery.noWriteFinalPasses >= 4) {
          return this._rejectMetaMaskRecoveryResponse(
            client,
            message,
            "no_write_cleanup_failed",
          );
        }
        recovery.noWriteFinalPasses += 1;
        recovery.phase = "needs-no-write-final-inventory";
        message.result = {
          complete: false,
          ownedPagesRemaining: ownedPages.length,
        };
        return true;
      }
      recovery.phase = "no-write-complete";
      message.result = {
        status: "already_initialized",
        noWrite: true,
        vaultPresent: true,
        cleanupComplete: true,
      };
      return true;
    }
    if (
      [
        "metamask-recovery-quiesce-close",
        "metamask-recovery-preaction-close",
        "metamask-recovery-final-close",
        "metamask-recovery-rollback-final-close",
      ].includes(stage)
    ) {
      if (message.result?.success !== true) {
        return this._rejectMetaMaskRecoveryResponse(
          client,
          message,
          "extension_target_cleanup_failed",
        );
      }
      recovery.closeQueue.shift();
      if (stage === "metamask-recovery-quiesce-close") {
        recovery.phase =
          recovery.closeQueue.length > 0
            ? "needs-quiesce-close"
            : "needs-quiesce-inventory";
      } else if (stage === "metamask-recovery-preaction-close") {
        recovery.phase =
          recovery.closeQueue.length > 0
            ? "needs-preaction-close"
            : "needs-preaction-inventory";
      } else if (stage === "metamask-recovery-final-close") {
        recovery.phase =
          recovery.closeQueue.length > 0
            ? "needs-final-close"
            : "needs-final-inventory";
      } else {
        const blocked = recovery.rollbackCompareMatched === false;
        recovery.phase =
          recovery.closeQueue.length > 0
            ? blocked
              ? "rollback-blocked-needs-final-close"
              : "rollback-needs-final-close"
            : blocked
              ? "rollback-blocked-needs-final-inventory"
              : "rollback-needs-final-inventory";
      }
      message.result = { success: true };
      return true;
    }
    if (stage === "metamask-recovery-quiesce-inventory") {
      const inventory = this._validatedMetaMaskRecoveryInventory(
        client,
        message.result?.targetInfos,
      );
      if (
        !inventory ||
        inventory.pages.length !== 1 ||
        inventory.pages[0].targetId !== recovery.carrierTargetId ||
        inventory.workers.length !== 0
      ) {
        return this._rejectMetaMaskRecoveryResponse(
          client,
          message,
          "extension_not_quiesced",
        );
      }
      recovery.phase = "needs-quiesce-storage";
      message.result = {
        carrierPresent: true,
        otherExtensionPages: 0,
        serviceWorkers: 0,
      };
      return true;
    }
    if (stage === "metamask-recovery-quiesce-storage") {
      const storage = message.result?.data;
      if (
        !validMetaMaskStorage(storage) ||
        canonicalSha256(storage) !== recovery.preimageStorageDigest ||
        protectedStorageDigest(storage) !== recovery.protectedStorageDigest
      ) {
        return this._rejectMetaMaskRecoveryResponse(
          client,
          message,
          "prewrite_storage_changed",
        );
      }
      recovery.phase = "needs-write";
      message.result = {
        data: {
          preimageUnchanged: true,
          protectedStorageUnchanged: true,
          vaultPresent: false,
        },
      };
      return true;
    }
    if (stage === "metamask-recovery-write") {
      if (!hasExactKeys(message.result ?? {}, [])) {
        return this._rejectMetaMaskRecoveryResponse(
          client,
          message,
          "keyring_write_failed",
        );
      }
      recovery.phase = "needs-write-verify";
      message.result = { writeAccepted: true };
      return true;
    }
    if (stage === "metamask-recovery-write-verify") {
      const data = message.result?.data;
      const matches =
        isPlainObject(data) &&
        hasExactKeys(data, ["KeyringController"]) &&
        keyringDigest(true, data.KeyringController) ===
          recovery.desiredKeyringDigest;
      if (!matches) {
        return this._rejectMetaMaskRecoveryResponse(
          client,
          message,
          "keyring_write_mismatch",
        );
      }
      recovery.writeVerified = true;
      recovery.phase = "needs-carrier-detach";
      message.result = { data: { keyringMatchesWritten: true } };
      return true;
    }
    if (
      [
        "metamask-recovery-carrier-detach",
        "metamask-recovery-success-detach",
        "metamask-recovery-rollback-detach",
      ].includes(stage)
    ) {
      if (!hasExactKeys(message.result ?? {}, [])) {
        return this._rejectMetaMaskRecoveryResponse(
          client,
          message,
          "extension_page_detach_failed",
        );
      }
      if (stage === "metamask-recovery-carrier-detach") {
        recovery.phase = "needs-carrier-close";
      } else if (stage === "metamask-recovery-success-detach") {
        recovery.phase = "needs-success-close";
      } else {
        const blocked = recovery.rollbackCompareMatched === false;
        recovery.phase = recovery.createdTargetIds.has(
          recovery.carrierTargetId,
        )
          ? blocked
            ? "rollback-blocked-needs-close"
            : "rollback-needs-close"
          : blocked
            ? "rollback-blocked-needs-final-inventory"
            : "rollback-needs-final-inventory";
      }
      message.result = {
        detached: true,
        closeCarrier: recovery.phase.includes("needs-close"),
      };
      return true;
    }
    if (
      [
        "metamask-recovery-carrier-close",
        "metamask-recovery-success-close",
        "metamask-recovery-rollback-close",
      ].includes(stage)
    ) {
      if (message.result?.success !== true) {
        return this._rejectMetaMaskRecoveryResponse(
          client,
          message,
          "extension_page_close_failed",
        );
      }
      recovery.carrierSessionId = null;
      if (stage === "metamask-recovery-carrier-close") {
        recovery.phase = "needs-preaction-inventory";
      } else if (stage === "metamask-recovery-success-close") {
        recovery.phase = "needs-final-inventory";
      } else {
        recovery.phase =
          recovery.rollbackCompareMatched === false
            ? "rollback-blocked-needs-final-inventory"
            : "rollback-needs-final-inventory";
      }
      message.result = { success: true };
      return true;
    }
    if (stage === "metamask-recovery-preaction-inventory") {
      const inventory = this._validatedMetaMaskRecoveryInventory(
        client,
        message.result?.targetInfos,
      );
      if (!inventory || recovery.preactionPasses >= 4) {
        return this._rejectMetaMaskRecoveryResponse(
          client,
          message,
          "preaction_quiescence_failed",
        );
      }
      recovery.preactionPasses += 1;
      recovery.closeQueue = [
        ...inventory.pages.map((info) => ({
          targetId: info.targetId,
          type: "page",
        })),
        ...inventory.workers.map((info) => ({
          targetId: info.targetId,
          type: "service_worker",
        })),
      ].sort((left, right) => left.targetId.localeCompare(right.targetId));
      recovery.phase =
        recovery.closeQueue.length > 0
          ? "needs-preaction-close"
          : "needs-tab-proof";
      message.result = {
        extensionTargetsRemaining: recovery.closeQueue.length,
        closeTargetIds: recovery.closeQueue.map((entry) => entry.targetId),
      };
      return true;
    }
    if (stage === "metamask-recovery-tab-proof") {
      if (
        !hasExactKeys(message.result, ["targetInfo"]) ||
        !this._freshTabInfo(
          message.result.targetInfo,
          capability,
          capability.expectedTabActive,
        )
      ) {
        return this._rejectMetaMaskRecoveryResponse(
          client,
          message,
          "trigger_tab_identity_changed",
        );
      }
      recovery.phase = "needs-trigger";
      message.result = {
        tabTargetId: capability.tabTargetId,
        browserContextId: capability.browserContextId,
        tabActive: true,
      };
      return true;
    }
    if (stage === "metamask-recovery-trigger") {
      if (!hasExactKeys(message.result ?? {}, [])) {
        return this._rejectMetaMaskRecoveryResponse(
          client,
          message,
          "trigger_action_failed",
        );
      }
      recovery.phase = recovery.actionCreatedTargetId
        ? "needs-created-attach"
        : "awaiting-created-page";
      message.result = {
        triggered: true,
        createdPageObserved: Boolean(recovery.actionCreatedTargetId),
        createdTargetId: recovery.actionCreatedTargetId,
      };
      return true;
    }
    if (
      [
        "metamask-recovery-page-enable",
        "metamask-recovery-runtime-enable",
      ].includes(stage)
    ) {
      if (!hasExactKeys(message.result ?? {}, [])) {
        return this._rejectMetaMaskRecoveryResponse(
          client,
          message,
          "extension_runtime_enable_failed",
        );
      }
      recovery.phase =
        stage === "metamask-recovery-page-enable"
          ? "needs-runtime-enable"
          : "needs-frame-tree";
      return true;
    }
    if (stage === "metamask-recovery-frame-tree") {
      const frame = message.result?.frameTree?.frame;
      if (
        !isPlainObject(frame) ||
        !TARGET_ID_PATTERN.test(frame.id) ||
        typeof frame.url !== "string" ||
        !frame.url.startsWith(METAMASK_URL_PREFIX) ||
        (frame.securityOrigin !== undefined &&
          frame.securityOrigin !== METAMASK_ORIGIN)
      ) {
        return this._rejectMetaMaskRecoveryResponse(
          client,
          message,
          "extension_main_frame_invalid",
        );
      }
      recovery.mainFrameId = frame.id;
      if (!this._selectMetaMaskDefaultContext(client)) return false;
      recovery.phase = recovery.defaultContextId
        ? "needs-default-proof"
        : "awaiting-default-context";
      message.result = {
        frameId: recovery.mainFrameId,
        defaultContextReady: Boolean(recovery.defaultContextId),
        contextId: recovery.defaultContextId,
        uniqueContextId: recovery.defaultUniqueContextId,
      };
      return true;
    }
    if (stage === "metamask-recovery-default-proof") {
      const value = message.result?.result?.value;
      const validShape =
        isPlainObject(value) &&
        hasExactKeys(value, [
          "documentComplete",
          "extensionOrigin",
          "hasStateHooks",
          "hasSentryStateHook",
        ]) &&
        Object.values(value).every((entry) => typeof entry === "boolean");
      if (!validShape || message.result?.exceptionDetails !== undefined) {
        return this._rejectMetaMaskRecoveryResponse(
          client,
          message,
          "default_world_proof_invalid",
        );
      }
      recovery.proofAttempts += 1;
      const complete = Object.values(value).every((entry) => entry === true);
      if (complete) {
        recovery.phase = "needs-fresh-storage-proof";
      } else if (recovery.proofAttempts < METAMASK_MAX_PROOF_ATTEMPTS) {
        recovery.phase = "needs-default-proof";
      } else {
        recovery.failureCode = "default_world_not_ready";
        recovery.phase = "failed-awaiting-rollback";
      }
      message.result = {
        proof: { ...value },
        complete,
        attempt: recovery.proofAttempts,
      };
      return true;
    }
    if (stage === "metamask-recovery-fresh-storage-proof") {
      const storage = message.result?.data;
      const keyringMatches =
        validMetaMaskStorage(storage) &&
        "KeyringController" in storage &&
        keyringDigest(true, storage.KeyringController) ===
          recovery.desiredKeyringDigest;
      const protectedMatches =
        validMetaMaskStorage(storage) &&
        protectedStorageDigest(storage) === recovery.protectedStorageDigest;
      if (!keyringMatches || !protectedMatches) {
        return this._rejectMetaMaskRecoveryResponse(
          client,
          message,
          "fresh_lifecycle_storage_mismatch",
        );
      }
      recovery.phase = "needs-success-detach";
      message.result = {
        data: {
          vaultPresent: hasNonemptyVault(storage.KeyringController),
          keyringMatchesWritten: true,
          protectedStorageMatchesPreflight: true,
        },
      };
      return true;
    }
    if (stage === "metamask-recovery-final-inventory") {
      return this._finishMetaMaskRecoveryInventory(
        client,
        message,
        false,
      );
    }
    if (stage === "metamask-recovery-rollback-inventory") {
      const inventory = this._validatedMetaMaskRecoveryInventory(
        client,
        message.result?.targetInfos,
      );
      const createdPages = inventory?.pages.filter((info) =>
        recovery.createdTargetIds.has(info.targetId),
      );
      if (!inventory || createdPages.length !== 1) {
        recovery.rollbackCompareMatched = false;
        recovery.phase = "rollback-unavailable";
        message.result = {
          rollbackCarrierAvailable: false,
          rollbackPerformed: false,
        };
        return true;
      }
      recovery.carrierTargetId = createdPages[0].targetId;
      recovery.phase = "rollback-needs-attach";
      message.result = {
        rollbackCarrierAvailable: true,
        carrierTargetId: recovery.carrierTargetId,
      };
      return true;
    }
    if (stage === "metamask-recovery-rollback-compare") {
      const data = message.result?.data;
      const matches =
        isPlainObject(data) &&
        hasExactKeys(data, ["KeyringController"]) &&
        keyringDigest(true, data.KeyringController) ===
          recovery.desiredKeyringDigest;
      recovery.rollbackCompareMatched = matches;
      recovery.phase = matches
        ? "rollback-needs-write"
        : "rollback-blocked-needs-detach";
      message.result = {
        data: {
          compareMatched: matches,
          rollbackAllowed: matches,
        },
      };
      return true;
    }
    if (stage === "metamask-recovery-rollback-write") {
      if (!hasExactKeys(message.result ?? {}, [])) {
        recovery.phase = "rollback-failed";
        message.error = {
          code: -32011,
          message: "MetaMask rollback write failed",
        };
        delete message.result;
        return true;
      }
      recovery.phase = "rollback-needs-verify";
      message.result = { rollbackWriteAccepted: true };
      return true;
    }
    if (stage === "metamask-recovery-rollback-verify") {
      const data = message.result?.data;
      const present = isPlainObject(data) && "KeyringController" in data;
      const matches =
        isPlainObject(data) &&
        keyringDigest(present, data.KeyringController) ===
          recovery.preimageKeyringDigest;
      if (!matches) {
        recovery.phase = "rollback-failed";
        message.error = {
          code: -32011,
          message: "MetaMask rollback verification failed",
        };
        delete message.result;
        return true;
      }
      recovery.phase = "rollback-needs-protected";
      message.result = { data: { preimageRestored: true } };
      return true;
    }
    if (stage === "metamask-recovery-rollback-protected") {
      const storage = message.result?.data;
      const present = isPlainObject(storage) && "KeyringController" in storage;
      const keyringMatches =
        validMetaMaskStorage(storage) &&
        keyringDigest(present, storage.KeyringController) ===
          recovery.preimageKeyringDigest;
      const protectedMatches =
        validMetaMaskStorage(storage) &&
        protectedStorageDigest(storage) === recovery.protectedStorageDigest;
      if (!keyringMatches || !protectedMatches) {
        recovery.phase = "rollback-failed";
        message.error = {
          code: -32011,
          message: "MetaMask rollback protected-state verification failed",
        };
        delete message.result;
        return true;
      }
      recovery.phase = "rollback-needs-detach";
      message.result = {
        data: {
          preimageRestored: true,
          protectedStorageMatchesPreflight: true,
        },
      };
      return true;
    }
    if (stage === "metamask-recovery-rollback-final-inventory") {
      return this._finishMetaMaskRecoveryInventory(client, message, true);
    }
    return this._rejectMetaMaskRecoveryResponse(
      client,
      message,
      "unexpected_recovery_response",
    );
  }

  _validatedMetaMaskRecoveryInventory(client, targetInfos) {
    const capability = client.capability;
    if (
      !Array.isArray(targetInfos) ||
      targetInfos.length > this.limits.maxTabInventoryTargets ||
      new Set(targetInfos.map((info) => info?.targetId)).size !==
        targetInfos.length
    ) {
      this._closeClient(
        client,
        CLOSE_POLICY,
        "MetaMask recovery inventory invalid",
      );
      return null;
    }
    const tab = targetInfos.find(
      (info) => info?.targetId === capability.tabTargetId,
    );
    if (!this._freshTabInfo(tab, capability, capability.expectedTabActive)) {
      this._closeClient(
        client,
        CLOSE_POLICY,
        "MetaMask recovery profile/tab identity changed",
      );
      return null;
    }
    const pages = targetInfos
      .filter((info) =>
        isMetaMaskTargetInfo(info, capability.browserContextId, "page"),
      )
      .sort((left, right) => left.targetId.localeCompare(right.targetId));
    const workers = targetInfos
      .filter((info) =>
        isMetaMaskTargetInfo(
          info,
          capability.browserContextId,
          "service_worker",
        ),
      )
      .sort((left, right) => left.targetId.localeCompare(right.targetId));
    if (
      pages.length > METAMASK_MAX_PAGES ||
      workers.length > METAMASK_MAX_SERVICE_WORKERS
    ) {
      this._closeClient(
        client,
        CLOSE_POLICY,
        "MetaMask recovery target bound exceeded",
      );
      return null;
    }
    return { tab, pages, workers };
  }

  _rejectMetaMaskRecoveryResponse(client, message, code) {
    const recovery = client.metamaskRecovery;
    recovery.failureCode = code;
    if (recovery.writeAttempted) {
      recovery.phase = "failed-awaiting-rollback";
      message.error = {
        code: -32010,
        message: "MetaMask lifecycle proof failed; rollback required",
      };
      delete message.result;
      return true;
    }
    this._closeClient(client, CLOSE_POLICY, "MetaMask recovery preflight rejected");
    return false;
  }

  _selectMetaMaskDefaultContext(client) {
    const recovery = client.metamaskRecovery;
    if (!recovery.mainFrameId) return true;
    const matches = recovery.defaultContexts.filter(
      (context) => context.frameId === recovery.mainFrameId,
    );
    if (matches.length > 1) {
      this._closeClient(
        client,
        CLOSE_POLICY,
        "MetaMask default execution context is ambiguous",
      );
      return false;
    }
    if (matches.length === 1) {
      recovery.defaultContextId = matches[0].contextId;
      recovery.defaultUniqueContextId = matches[0].uniqueContextId;
    }
    return true;
  }

  _finishMetaMaskRecoveryInventory(client, message, rollback) {
    const recovery = client.metamaskRecovery;
    const inventory = this._validatedMetaMaskRecoveryInventory(
      client,
      message.result?.targetInfos,
    );
    if (!inventory) return false;
    const safePages = inventory.pages.filter((info) =>
      recovery.createdTargetIds.has(info.targetId),
    );
    const unsafePages = inventory.pages.filter(
      (info) => !recovery.createdTargetIds.has(info.targetId),
    );
    if (unsafePages.length > 0) {
      return this._rejectMetaMaskRecoveryResponse(
        client,
        message,
        "concurrent_extension_page_changed_cleanup",
      );
    }
    const passesKey = rollback ? "rollbackFinalPasses" : "finalPasses";
    if (recovery[passesKey] >= 4) {
      return this._rejectMetaMaskRecoveryResponse(
        client,
        message,
        "extension_cleanup_did_not_settle",
      );
    }
    recovery[passesKey] += 1;
    recovery.closeQueue = [
      ...safePages.map((info) => ({ targetId: info.targetId, type: "page" })),
      ...inventory.workers.map((info) => ({
        targetId: info.targetId,
        type: "service_worker",
      })),
    ].sort((left, right) => left.targetId.localeCompare(right.targetId));
    if (recovery.closeQueue.length > 0) {
      if (rollback) {
        recovery.phase =
          recovery.rollbackCompareMatched === false
            ? "rollback-blocked-needs-final-close"
            : "rollback-needs-final-close";
      } else {
        recovery.phase = "needs-final-close";
      }
      message.result = {
        complete: false,
        extensionTargetsRemaining: recovery.closeQueue.length,
        closeTargetIds: recovery.closeQueue.map((entry) => entry.targetId),
      };
      return true;
    }
    if (rollback) {
      const blocked = recovery.rollbackCompareMatched === false;
      recovery.phase = blocked ? "rollback-blocked" : "rolled-back";
      message.result = {
        complete: true,
        rollbackPerformed: !blocked,
        rollbackCompareMatched: !blocked,
        cleanupComplete: true,
      };
    } else {
      recovery.phase = "complete";
      message.result = {
        complete: true,
        vaultPresent: true,
        defaultWorldProof: true,
        protectedStorageMatchesPreflight: true,
        cleanupComplete: true,
      };
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

  _commitMetaMaskRecoveryRequest(client, stage) {
    const recovery = client.metamaskRecovery;
    if (!recovery) return;
    const pendingPhases = {
      "metamask-recovery-inventory": "inventory-pending",
      "metamask-recovery-attach-carrier": "attaching-carrier",
      "metamask-recovery-storage-preflight": "storage-preflight-pending",
      "metamask-recovery-no-write-detach": "no-write-detaching",
      "metamask-recovery-no-write-close": "no-write-close-pending",
      "metamask-recovery-no-write-final-inventory":
        "no-write-final-inventory-pending",
      "metamask-recovery-quiesce-close": "quiesce-close-pending",
      "metamask-recovery-quiesce-inventory": "quiesce-inventory-pending",
      "metamask-recovery-quiesce-storage": "quiesce-storage-pending",
      "metamask-recovery-write": "write-pending",
      "metamask-recovery-write-verify": "write-verify-pending",
      "metamask-recovery-carrier-detach": "carrier-detaching",
      "metamask-recovery-carrier-close": "carrier-close-pending",
      "metamask-recovery-preaction-inventory": "preaction-inventory-pending",
      "metamask-recovery-preaction-close": "preaction-close-pending",
      "metamask-recovery-tab-proof": "tab-proof-pending",
      "metamask-recovery-trigger": "trigger-pending",
      "metamask-recovery-attach-created": "attaching-created",
      "metamask-recovery-page-enable": "page-enable-pending",
      "metamask-recovery-runtime-enable": "runtime-enable-pending",
      "metamask-recovery-frame-tree": "frame-tree-pending",
      "metamask-recovery-default-proof": "default-proof-pending",
      "metamask-recovery-fresh-storage-proof": "fresh-storage-proof-pending",
      "metamask-recovery-success-detach": "success-detaching",
      "metamask-recovery-success-close": "success-close-pending",
      "metamask-recovery-final-inventory": "final-inventory-pending",
      "metamask-recovery-final-close": "final-close-pending",
      "metamask-recovery-rollback-inventory": "rollback-inventory-pending",
      "metamask-recovery-rollback-attach": "rollback-attaching",
      "metamask-recovery-rollback-compare": "rollback-compare-pending",
      "metamask-recovery-rollback-write": "rollback-write-pending",
      "metamask-recovery-rollback-verify": "rollback-verify-pending",
      "metamask-recovery-rollback-protected": "rollback-protected-pending",
      "metamask-recovery-rollback-detach": "rollback-detaching",
      "metamask-recovery-rollback-close": "rollback-close-pending",
      "metamask-recovery-rollback-final-inventory":
        "rollback-final-inventory-pending",
      "metamask-recovery-rollback-final-close":
        "rollback-final-close-pending",
    };
    if (stage === "metamask-recovery-trigger") {
      recovery.actionSequence = this.targetSequence;
      recovery.actionCreatedTargetId = null;
    }
    recovery.phase = pendingPhases[stage] ?? recovery.phase;
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
      this._observeMetaMaskRecoveryCreatedTarget(info, sequence);
    }
    if (!previous && publish) {
      this._claimTaskPopupTarget(info, record, sequence);
      if (!this._reconcileLeaseTargetProvenance(this.clientLeases)) {
        queueMicrotask(() => this._sweepExpiredLeases());
      }
    }
    if (publish) this._publishTargetGraphChange(info, eventMethod);
    return true;
  }

  _observeMetaMaskRecoveryCreatedTarget(info, sequence) {
    const candidates = [...this.clients.values()].filter((client) => {
      const recovery = client.metamaskRecovery;
      return Boolean(
        client.state !== "closed" &&
          recovery &&
          ["trigger-pending", "awaiting-created-page"].includes(
            recovery.phase,
          ) &&
          sequence > recovery.actionSequence &&
          isMetaMaskTargetInfo(
            info,
            client.capability.browserContextId,
            "page",
          ),
      );
    });
    if (candidates.length > 1) {
      this._loseUpstream("metamask_recovery_target_authority_ambiguous");
      return;
    }
    if (candidates.length !== 1) return;
    const client = candidates[0];
    const recovery = client.metamaskRecovery;
    if (recovery.actionCreatedTargetId) {
      this._closeClient(
        client,
        CLOSE_POLICY,
        "MetaMask recovery created more than one extension page",
      );
      return;
    }
    recovery.actionCreatedTargetId = info.targetId;
    recovery.createdTargetIds.add(info.targetId);
    if (recovery.phase === "awaiting-created-page") {
      recovery.phase = "needs-created-attach";
    }
    this._deliverClient(client, {
      method: "AgentBrowser.metamaskRecoveryTargetCreated",
      params: {
        targetId: info.targetId,
        browserContextId: client.capability.browserContextId,
        exactExtensionOrigin: true,
      },
    });
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
        if (!this._reconcileLeaseTargetProvenance(this.clientLeases)) {
          this._sweepExpiredLeases();
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

  // WHY: openerId describes topology, not who created or may control a page.
  // A same-context user/ambient popup can look identical, so this helper is
  // usable only for relationship checks. Task authority is _taskOwnedTarget.
  _taskTargetTopology(capability, targetId) {
    if (!TARGET_ID_PATTERN.test(targetId)) return null;
    const record = this.targetGraph.get(targetId);
    if (!record) return null;
    const info = record.info;
    if (isForbiddenTaskUrl(info.url)) return null;
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
          root.browserContextId === capability.browserContextId &&
          !isForbiddenTaskUrl(root.url)
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

  _workspaceTaskRoot(capability) {
    const target = this._taskTargetTopology(
      capability,
      capability.rootTargetId,
    );
    if (target?.kind !== "root") return null;
    if (capability.rootDisposition === "preserve-nonowned-root") {
      return target;
    }
    const provenance = target.record.provenance;
    return provenance?.kind === "workspace-task" &&
      provenance.attribution === "controller-root-disposition-v1" &&
      provenance.rootTargetId === capability.rootTargetId &&
      provenance.browserContextId === capability.browserContextId &&
      provenance.rootDisposition === capability.rootDisposition
      ? target
      : null;
  }

  _taskEphemeralProvenanceMatches(
    capability,
    provenance,
    clientInstance = null,
  ) {
    return Boolean(
      provenance?.kind === "task-ephemeral" &&
        [
          "owned-session-window-open-v1",
          "request-window-open-v1",
        ].includes(provenance.attribution) &&
        provenance.rootTargetId === capability.rootTargetId &&
        provenance.browserContextId === capability.browserContextId &&
        provenance.rootDisposition === capability.rootDisposition &&
        (clientInstance === null ||
          provenance.clientInstance === clientInstance),
    );
  }

  _cleanupReauthorizedProvenanceMatches(capability, provenance) {
    return Boolean(
      provenance?.kind === "controller-reauthorized-task-ephemeral" &&
        provenance.attribution === "controller-persisted-target-id-v1" &&
        provenance.rootTargetId === capability.rootTargetId &&
        provenance.browserContextId === capability.browserContextId &&
        provenance.rootDisposition === capability.rootDisposition,
    );
  }

  _taskOwnedTarget(client, targetId) {
    if (client.capability.kind !== "task") return null;
    const target = this._taskTargetTopology(client.capability, targetId);
    if (!target) return null;
    if (target.kind === "root") {
      return this._workspaceTaskRoot(client.capability);
    }
    return this._taskEphemeralProvenanceMatches(
      client.capability,
      target.record.provenance,
      client.instance,
    )
      ? target
      : null;
  }

  _taskPopupRequestCandidate(client, request, targetSessionId, upstreamId) {
    if (
      client.capability.kind !== "task" ||
      request.sessionId === undefined ||
      targetSessionId !== request.sessionId ||
      !TASK_POPUP_INITIATING_METHODS.has(request.method)
    ) {
      return null;
    }
    const owner = this.sessionOwners.get(request.sessionId);
    if (
      owner?.client !== client ||
      owner.kind === "root" ||
      !this._taskOwnedTarget(client, owner.targetId)
    ) {
      return null;
    }
    return Object.freeze({
      clientInstance: client.instance,
      rootTargetId: client.capability.rootTargetId,
      browserContextId: client.capability.browserContextId,
      rootDisposition: client.capability.rootDisposition,
      sourceTargetId: owner.targetId,
      sourceSessionId: request.sessionId,
      upstreamRequestId: upstreamId,
      clientRequestId: request.id,
      requestMethod: request.method,
    });
  }

  _clearTaskPopupTicket(client) {
    const ticket = client.taskPopupTicket;
    if (!ticket) return;
    clearTimeout(ticket.timer);
    client.taskPopupTicket = null;
  }

  _quarantineTaskPopupAuthority(client) {
    this._clearTaskPopupTicket(client);
    this._closeClient(client, CLOSE_POLICY, "task popup authority ambiguous");
  }

  _openTaskPopupTicket(client, value) {
    if (client.taskPopupTicket) {
      this._quarantineTaskPopupAuthority(client);
      return false;
    }
    const ticket = { ...value, timer: null };
    ticket.timer = setTimeout(
      () => {
        if (client.taskPopupTicket === ticket) client.taskPopupTicket = null;
      },
      Math.min(this.limits.upstreamResponseTimeoutMs, 5000),
    );
    ticket.timer.unref?.();
    client.taskPopupTicket = ticket;
    return true;
  }

  _observeTaskWindowOpen(client, message, envelopeSessionId) {
    if (
      client.capability.kind !== "task" ||
      message.method !== "Page.windowOpen" ||
      !isPlainObject(message.params)
    ) {
      return;
    }
    const owner = this.sessionOwners.get(envelopeSessionId);
    const source =
      owner?.client === client &&
      owner.kind !== "root" &&
      this._taskOwnedTarget(client, owner.targetId);
    if (!source) return;

    const pendingRequests = [...this.pending.entries()].filter(
      ([, pending]) =>
        pending.kind === "client" &&
        pending.client === client &&
        pending.taskPopupRequest?.sourceSessionId === envelopeSessionId &&
        pending.taskPopupRequest.sourceTargetId === owner.targetId,
    );
    if (
      client.capability.rootDisposition === "preserve-nonowned-root" &&
      pendingRequests.length !== 1
    ) {
      if (pendingRequests.length > 1) {
        this._quarantineTaskPopupAuthority(client);
      }
      return;
    }
    const requestAttribution =
      pendingRequests.length === 1 ? pendingRequests[0][1].taskPopupRequest : null;
    this._openTaskPopupTicket(client, {
      attribution:
        client.capability.rootDisposition === "preserve-nonowned-root"
          ? "request-window-open-v1"
          : "owned-session-window-open-v1",
      clientInstance: client.instance,
      rootTargetId: client.capability.rootTargetId,
      browserContextId: client.capability.browserContextId,
      rootDisposition: client.capability.rootDisposition,
      sourceTargetId: owner.targetId,
      sourceSessionId: envelopeSessionId,
      observedSequence: this.targetSequence,
      upstreamRequestId: requestAttribution?.upstreamRequestId ?? null,
      clientRequestId: requestAttribution?.clientRequestId ?? null,
      requestMethod: requestAttribution?.requestMethod ?? null,
    });
  }

  _claimTaskPopupTarget(info, record, sequence) {
    const matching = [...this.clients.values()].filter(
      (client) =>
        client.state !== "closed" &&
        client.taskPopupTicket &&
        client.taskPopupTicket?.sourceTargetId === info.openerId,
    );
    if (matching.length === 0) return;
    const valid = [];
    for (const client of matching) {
      const ticket = client.taskPopupTicket;
      this._clearTaskPopupTicket(client);
      const sessionOwner = this.sessionOwners.get(ticket.sourceSessionId);
      if (
        sequence <= ticket.observedSequence ||
        info.browserContextId !== ticket.browserContextId ||
        isForbiddenTaskUrl(info.url) ||
        sessionOwner?.client !== client ||
        sessionOwner.targetId !== ticket.sourceTargetId ||
        !this._taskOwnedTarget(client, ticket.sourceTargetId) ||
        this._taskTargetTopology(client.capability, info.targetId)?.kind !==
          "descendant"
      ) {
        this._quarantineTaskPopupAuthority(client);
        continue;
      }
      valid.push({ client, ticket });
    }
    if (valid.length !== 1 || matching.length !== 1) {
      for (const { client } of valid) this._quarantineTaskPopupAuthority(client);
      return;
    }
    const { client, ticket } = valid[0];
    record.provenance = Object.freeze({
      kind: "task-ephemeral",
      attribution: ticket.attribution,
      rootTargetId: ticket.rootTargetId,
      browserContextId: ticket.browserContextId,
      rootDisposition: ticket.rootDisposition,
      clientInstance: ticket.clientInstance,
      sourceTargetId: ticket.sourceTargetId,
      sourceSessionId: ticket.sourceSessionId,
      upstreamRequestId: ticket.upstreamRequestId,
      clientRequestId: ticket.clientRequestId,
      requestMethod: ticket.requestMethod,
      createdSequence: sequence,
    });
  }

  _provenanceForCleanupMatches(capability, provenance) {
    return (
      this._taskEphemeralProvenanceMatches(capability, provenance) ||
      this._cleanupReauthorizedProvenanceMatches(capability, provenance)
    );
  }

  _configuredTaskForRoot(capability, leases = this.clientLeases) {
    return [...leases.values()].some(
      ({ capability: candidate }) =>
        candidate.kind === "task" &&
        candidate.rootTargetId === capability.rootTargetId,
    );
  }

  _configuredOtherCapabilityRoot(capability, targetId) {
    return [...this.clientLeases.values()].some(
      ({ capability: candidate }) =>
        ["task", "controller-cleanup"].includes(candidate.kind) &&
        candidate !== capability &&
        candidate.rootTargetId === targetId,
    );
  }

  _cleanupClaimIsExclusive(capability, targetId) {
    return (
      [...this.clientLeases.values()].filter(
        ({ capability: candidate }) =>
          candidate.kind === "controller-cleanup" &&
          candidate.targetIds.includes(targetId),
      ).length === 1
    );
  }

  _cleanupLifecycleReady(capability) {
    return Boolean(
      !this._configuredTaskForRoot(capability) &&
        !this.activeTaskRoots.has(capability.rootTargetId) &&
        !this.reservedTaskRoots.has(capability.rootTargetId),
    );
  }

  _cleanupTargetAuthorized(capability, targetId, requireLifecycle = true) {
    if (!capability.targetIds.includes(targetId)) return false;
    const target = this._taskTargetTopology(capability, targetId);
    if (!target || !this._cleanupClaimIsExclusive(capability, targetId)) {
      return false;
    }
    if (target.kind === "root") {
      return Boolean(
        capability.rootDisposition === "close-owned-workspace-task" &&
          this._workspaceTaskRoot(capability) &&
          !this._isProtectedRoot(targetId) &&
          (!requireLifecycle || this._cleanupLifecycleReady(capability)),
      );
    }
    return Boolean(
      !this._configuredOtherCapabilityRoot(capability, targetId) &&
        !this._isProtectedRoot(targetId) &&
        this._provenanceForCleanupMatches(
          capability,
          target.record.provenance,
        ) &&
        (!requireLifecycle || this._cleanupLifecycleReady(capability)),
    );
  }

  _cleanupCapabilityCurrentlyValid(capability) {
    if (!this._workspaceTaskRoot(capability)) return false;
    if (!this._cleanupLifecycleReady(capability)) return false;
    return capability.targetIds.every(
      (targetId) =>
        !this.targetGraph.has(targetId) ||
        this._cleanupTargetAuthorized(capability, targetId),
    );
  }

  // WHY: a transport-only broker restart loses in-memory popup provenance.
  // Only controller-authenticated, exact persisted targetIds may be restored,
  // and restoration is cleanup-only. Any mismatched or multiply claimed ID
  // rejects the whole registry rather than reminting authority from openerId.
  _reconcileLeaseTargetProvenance(leases) {
    const entries = [...leases.entries()];
    const policies = entries.filter(([, { capability }]) =>
      ["task", "controller-cleanup"].includes(capability.kind),
    );
    const planned = new Map();
    const cleanupClaims = new Map();

    for (const [, { capability }] of policies) {
      const root = this._taskTargetTopology(
        capability,
        capability.rootTargetId,
      );
      if (root?.kind !== "root") return false;
      if (capability.rootDisposition !== "close-owned-workspace-task") {
        continue;
      }
      if (this._isProtectedRoot(capability.rootTargetId)) return false;
      const expected = Object.freeze({
        kind: "workspace-task",
        attribution: "controller-root-disposition-v1",
        rootTargetId: capability.rootTargetId,
        browserContextId: capability.browserContextId,
        rootDisposition: capability.rootDisposition,
      });
      const existing = planned.get(capability.rootTargetId) ?? root.record.provenance;
      if (existing === null) {
        planned.set(capability.rootTargetId, expected);
      } else if (
        existing.kind !== expected.kind ||
        existing.attribution !== expected.attribution ||
        existing.rootTargetId !== expected.rootTargetId ||
        existing.browserContextId !== expected.browserContextId ||
        existing.rootDisposition !== expected.rootDisposition
      ) {
        return false;
      }
    }

    for (const [leaseId, { capability }] of entries) {
      if (capability.kind !== "controller-cleanup") continue;
      if (this._configuredTaskForRoot(capability, leases)) return false;
      for (const targetId of capability.targetIds) {
        if (!this.targetGraph.has(targetId)) continue;
        const claims = cleanupClaims.get(targetId) ?? [];
        claims.push(leaseId);
        cleanupClaims.set(targetId, claims);
      }
    }
    if ([...cleanupClaims.values()].some((claims) => claims.length !== 1)) {
      return false;
    }

    for (const [, { capability }] of entries) {
      if (capability.kind !== "controller-cleanup") continue;
      for (const targetId of capability.targetIds) {
        const record = this.targetGraph.get(targetId);
        if (!record) continue;
        const target = this._taskTargetTopology(capability, targetId);
        if (!target) return false;
        if (target.kind === "root") {
          if (capability.rootDisposition !== "close-owned-workspace-task") {
            return false;
          }
          continue;
        }
        if (
          this._isProtectedRoot(targetId) ||
          policies.some(
            ([, { capability: candidate }]) =>
              candidate !== capability &&
              candidate.rootTargetId === targetId,
          )
        ) {
          return false;
        }
        const existing = planned.get(targetId) ?? record.provenance;
        if (existing === null) {
          planned.set(
            targetId,
            Object.freeze({
              kind: "controller-reauthorized-task-ephemeral",
              attribution: "controller-persisted-target-id-v1",
              rootTargetId: capability.rootTargetId,
              browserContextId: capability.browserContextId,
              rootDisposition: capability.rootDisposition,
              createdSequence: record.sequence,
            }),
          );
        } else if (!this._provenanceForCleanupMatches(capability, existing)) {
          return false;
        }
      }
    }

    for (const [targetId, provenance] of planned) {
      const record = this.targetGraph.get(targetId);
      if (record) record.provenance = provenance;
    }
    return true;
  }

  _taskClaimConflicts(capability) {
    const others = [
      ...[...this.activeTaskRoots.values()].map((client) => client.capability),
      ...this.reservedTaskRoots.values(),
    ];
    return others.some(
      (other) =>
        this._taskTargetTopology(other, capability.rootTargetId) ||
        this._taskTargetTopology(capability, other.rootTargetId),
    );
  }

  _isProtectedRoot(targetId) {
    return this.protectedRootIds.has(targetId);
  }

  _rememberProtectedRoots(leases) {
    for (const lease of leases.values()) {
      const capability = lease.capability;
      if (
        ["task", "controller-cleanup"].includes(capability.kind) &&
        capability.rootDisposition === "preserve-nonowned-root"
      ) {
        this.protectedRootIds.add(capability.rootTargetId);
      } else if (capability.kind === "controller-workspace-provisioning") {
        this.protectedRootIds.add(capability.pageTargetId);
      }
    }
  }

  _taskCanClose(client, targetId) {
    const target = this._taskOwnedTarget(client, targetId);
    return Boolean(
      target?.kind === "descendant" &&
      client.capability.descendantPolicy.allowCloseEphemeral &&
      !this._isProtectedRoot(targetId),
    );
  }

  _cleanupCanClose(capability, targetId) {
    return (
      this._cleanupCapabilityCurrentlyValid(capability) &&
      this._cleanupTargetAuthorized(capability, targetId)
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
        "controller-workspace-task-create",
        "controller-workspace-provisioning",
        "controller-metamask-action",
        "controller-metamask-vault-recovery",
      ].includes(capability.kind)
    )
      return true;
    if (!this._workspaceTaskRoot(capability)) return false;
    if (capability.kind === "controller-cleanup") {
      return this._cleanupCapabilityCurrentlyValid(capability);
    }
    return capability.kind === "task";
  }

  _targetVisibleToClient(client, targetId) {
    if (client.capability.kind === "controller-inventory") {
      return this.targetGraph.has(targetId);
    }
    if (client.capability.kind === "task") {
      return Boolean(this._taskOwnedTarget(client, targetId));
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
        const target = this._taskOwnedTarget(client, targetId);
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
      } else if (
        client.capability.kind === "controller-metamask-vault-recovery"
      ) {
        const targetInfo = message.params?.targetInfo;
        const recovery = client.metamaskRecovery;
        const expectedTargetId = recovery?.carrierTargetId;
        if (
          envelopeOwner.kind === "root" &&
          targetInfo?.targetId === expectedTargetId &&
          isMetaMaskTargetInfo(
            targetInfo,
            client.capability.browserContextId,
            "page",
          ) &&
          [
            "attaching-carrier",
            "attaching-created",
            "rollback-attaching",
            "needs-storage-preflight",
            "needs-page-enable",
            "rollback-needs-compare",
          ].includes(recovery?.phase)
        ) {
          sessionKind = "metamask_recovery_page";
        }
      } else if (
        client.capability.kind === "controller-workspace-provisioning"
      ) {
        const targetInfo = message.params?.targetInfo;
        if (
          envelopeOwner.kind === "root" &&
          client.workspaceProvision?.phase ===
            "workspace-provision-attach-pending" &&
          isPlainObject(targetInfo) &&
          targetInfo.type === "page" &&
          targetInfo.targetId === client.capability.pageTargetId &&
          targetInfo.browserContextId ===
            client.capability.browserContextId &&
          (targetInfo.url === "about:blank" ||
            (client.capability.operation === "recover-marker" &&
              typeof targetInfo.url === "string" &&
              Buffer.byteLength(targetInfo.url, "utf8") <= 16 * 1024))
        ) {
          sessionKind = "workspace_provision_page";
        }
      } else if (
        client.capability.kind === "controller-workspace-task-create"
      ) {
        const targetInfo = message.params?.targetInfo;
        if (
          envelopeOwner.kind === "root" &&
          client.workspaceTaskCreate?.phase ===
            "workspace-task-create-attach-pending" &&
          isPlainObject(targetInfo) &&
          targetInfo.type === "page" &&
          targetInfo.targetId === client.capability.createdPageTargetId &&
          targetInfo.browserContextId === client.capability.browserContextId &&
          WORKSPACE_TASK_NEWBORN_URLS.includes(targetInfo.url)
        ) {
          sessionKind = "workspace_task_create_page";
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
    if (client.capability.kind === "controller-workspace-task-create") {
      if (
        !["Target.attachedToTarget", "Target.detachedFromTarget"].includes(
          message.method,
        )
      ) {
        return;
      }
    }
    if (client.capability.kind === "task") {
      this._observeTaskWindowOpen(client, message, envelopeSessionId);
      if (client.state === "closed") return;
    }
    if (client.capability.kind === "controller-metamask-vault-recovery") {
      if (message.method === "Runtime.executionContextCreated") {
        this._observeMetaMaskRecoveryExecutionContext(client, message);
        return;
      }
      if (
        !["Target.attachedToTarget", "Target.detachedFromTarget"].includes(
          message.method,
        )
      ) {
        return;
      }
    }
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

  _observeMetaMaskRecoveryExecutionContext(client, message) {
    const recovery = client.metamaskRecovery;
    const context = message.params?.context;
    const auxData = context?.auxData;
    if (
      !recovery ||
      !isPlainObject(context) ||
      !Number.isSafeInteger(context.id) ||
      context.id <= 0 ||
      typeof context.uniqueId !== "string" ||
      context.uniqueId.length === 0 ||
      context.origin !== METAMASK_ORIGIN ||
      !isPlainObject(auxData) ||
      auxData.isDefault !== true ||
      (auxData.type !== undefined && auxData.type !== "default") ||
      !TARGET_ID_PATTERN.test(auxData.frameId)
    ) {
      return;
    }
    if (
      ![
        "runtime-enable-pending",
        "needs-frame-tree",
        "frame-tree-pending",
        "awaiting-default-context",
        "needs-default-proof",
      ].includes(recovery.phase)
    ) {
      return;
    }
    if (
      recovery.defaultContexts.some(
        (entry) =>
          entry.contextId === context.id ||
          entry.uniqueContextId === context.uniqueId,
      )
    ) {
      return;
    }
    recovery.defaultContexts.push({
      contextId: context.id,
      uniqueContextId: context.uniqueId,
      frameId: auxData.frameId,
    });
    if (!this._selectMetaMaskDefaultContext(client)) return;
    if (
      recovery.phase === "awaiting-default-context" &&
      recovery.defaultContextId
    ) {
      recovery.phase = "needs-default-proof";
      this._deliverClient(client, {
        method: "AgentBrowser.metamaskRecoveryDefaultWorldReady",
        params: {
          frameId: recovery.mainFrameId,
          contextId: recovery.defaultContextId,
          uniqueContextId: recovery.defaultUniqueContextId,
          exactExtensionOrigin: true,
          isDefault: true,
        },
      });
    }
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
    this._clearTaskPopupTicket(client);
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
    if (!this._reconcileLeaseTargetProvenance(next)) {
      throw new Error("client lease target provenance is invalid");
    }
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
        authentication: Object.freeze({
          scheme: "BrokerHealth",
          header: "Authorization",
          credentialFormat:
            "<transportGeneration>.<43-character-base64url-token>",
          credentialPath: this.healthAuthorizationPath,
          tokenSha256: this.healthTokenDigest.toString("hex"),
          tokenInUrl: false,
          scope: "health-only",
          lifetime: "one-broker-generation",
        }),
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
        targetInventory:
          "exact-signed-uia-created-target-and-two-window-probes-only",
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
        "controller-workspace-task-create",
        "controller-workspace-provisioning",
        "controller-tab-inventory",
        "controller-tab-discovery",
        "controller-tab-inspector",
        "controller-tab-focus",
        "controller-metamask-action",
        "controller-metamask-vault-recovery",
      ]),
      taskDeniedMethods: DENIED_METHODS,
      taskDeniedMethodPrefixes: DENIED_METHOD_PREFIXES,
      forbiddenTaskTargetSchemes: FORBIDDEN_TASK_TARGET_SCHEMES,
      limits: publicLimits(this.limits),
    });
  }

  getHealth() {
    const pendingClientCount = [...this.pending.values()].filter(
      (entry) => entry.kind === "client",
    ).length;
    const pendingInternalCount = this.pending.size - pendingClientCount;
    const configuredClientLeases = [...this.clientLeases.values()].map(
      (lease) => ({
        leaseId: lease.leaseId,
        tokenSha256: lease.tokenDigest.toString("hex"),
        issuedAt: lease.issuedAt,
        expiresAt: lease.expiresAt,
        capability: lease.capability,
      }),
    );
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
      configuredClientLeasesSha256: canonicalSha256({
        schema: CLIENT_LEASES_SCHEMA,
        leases: configuredClientLeases,
      }),
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
    "--health-auth-file",
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
    "--health-auth-file",
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
    healthAuthFile: values.get("--health-auth-file"),
    contractFile: values.get("--contract-file"),
    port,
  };
}

async function main() {
  let mainStage = "parse_cli";
  let cli;
  let upstreamAuthority;
  let clientLeases;
  let healthAuthorization;
  let broker;
  try {
    cli = parseCli(process.argv.slice(2));
    mainStage = "read_upstream_authority";
    upstreamAuthority = readUpstreamAuthorityFile(cli.upstreamFile);
    mainStage = "read_client_leases";
    clientLeases = readClientLeasesFile(cli.clientLeasesFile);
    mainStage = "read_health_authorization";
    healthAuthorization = readHealthAuthorizationFile(cli.healthAuthFile);
    mainStage = "start_broker";
    broker = await startCdpBroker({
      ...upstreamAuthority,
      clientLeases,
      healthAuthorizationPath: realpathSync(cli.healthAuthFile),
      healthTokenSha256: healthAuthorization.tokenSha256,
      upstreamAuthorityPath: realpathSync(cli.upstreamFile),
      clientLeasesPath: realpathSync(cli.clientLeasesFile),
      listenPort: cli.port,
    });
    mainStage = "publish_contract";
    writeProducerContract(cli.contractFile, broker.getProducerContract());
  } catch (error) {
    if (broker) await broker.stop();
    if (
      error instanceof Error &&
      /^CDP broker startup failed at [a-z_]+$/.test(error.message)
    ) {
      throw error;
    }
    throw new Error(`CDP broker main failed at ${mainStage}`);
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
  main().catch((error) => {
    const detail =
      error instanceof Error &&
      /^CDP broker (?:startup|main) failed at [a-z_]+$/.test(error.message)
        ? `: ${error.message}`
        : "";
    process.stderr.write(`CDP broker failed${detail}\n`);
    process.exitCode = 1;
  });
}
