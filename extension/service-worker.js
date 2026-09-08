"use strict";

(() => {
  const SCHEMA = "agent-browser.extension-bridge.v1";
  const HOST_NAME = "com.kaleeb.agent_browser";
  const PROFILE_KEY_STORAGE_KEY = "profileKey";
  const OWNERSHIP_STORAGE_KEY = "agentBrowserOwnershipV1";
  const OWNERSHIP_FAILURE_STORAGE_KEY = "agentBrowserOwnershipFailuresV1";
  const MAX_OWNERSHIP_FAILURES = 32;
  const ENROLLMENT_ACTION_STORAGE_KEY = "agentBrowserEnrollmentActionV1";
  const ENROLLMENT_ACTION_TTL_MS = 15_000;
  const MAX_HOST_TO_EXTENSION_MESSAGE_BYTES = 1024 * 1024;
  const MAX_EXTENSION_TO_HOST_MESSAGE_BYTES = 64 * 1024 * 1024;
  const MAX_PENDING_REQUESTS = 64;
  const MAX_SESSIONS = 16;
  const MAX_TABS_PER_SESSION = 64;
  const MAX_EVENT_BURST = 128;
  const EVENT_WINDOW_MS = 10_000;
  const MAX_DIAGNOSTIC_EVENT_BURST = 128;
  const MAX_DIAGNOSTIC_TEXT_CHARS = 4_096;
  const MAX_DIAGNOSTIC_ARGS = 16;
  const MAX_DIAGNOSTIC_PREVIEW_PROPERTIES = 8;
  const DIAGNOSTIC_TRUNCATION = "[Agent Browser diagnostics truncated]";
  const MAX_REQUEST_DEADLINE_MS = 30_000;
  const FOCUS_PROOF_MS = 5_000;
  const SCREENCAST_FRAME_TIMEOUT_MS = 1_500;
  const FILE_ACCESS_CHECK_TIMEOUT_MS = 1_000;
  const DEBUGGER_PROTOCOL_VERSION = "1.3";
  const RECONNECT_DELAYS_MS = [0, 250, 1_000, 2_000, 5_000, 10_000, 20_000];
  const RECONNECT_ALARM_NAME = "agent-browser-native-reconnect";
  const RECONNECT_ALARM_INTERVAL_MINUTES = 0.5;
  const REQUEST_ID = /^[0-9a-f]{64}$/i;
  const SESSION_ID = /^[A-Za-z0-9_-]{1,128}$/;

  const SAFE_CDP_METHODS = new Set([
    // WHY: v0.36.0 initializes each owned page with Network.enable. This
    // exact domain-enable carries no cross-tab discovery or request control.
    "Network.enable",
    "Page.enable",
    "Page.navigate",
    "Page.reload",
    "Page.stopLoading",
    "Page.getFrameTree",
    "Page.getLayoutMetrics",
    "Page.captureScreenshot",
    "Runtime.enable",
    "Runtime.evaluate",
    "Runtime.callFunctionOn",
    "DOM.enable",
    "DOM.disable",
    "DOM.getDocument",
    "DOM.querySelector",
    "DOM.querySelectorAll",
    "DOM.describeNode",
    "DOM.resolveNode",
    "DOM.setFileInputFiles",
    "DOM.scrollIntoViewIfNeeded",
    "DOM.getOuterHTML",
    "DOM.getBoxModel",
    "DOM.getAttributes",
    "CSS.enable",
    "CSS.disable",
    "CSS.getComputedStyleForNode",
    "Accessibility.enable",
    "Accessibility.disable",
    "Accessibility.getFullAXTree",
    "Accessibility.getPartialAXTree",
    "Accessibility.queryAXTree",
    "Input.dispatchMouseEvent",
    "Input.dispatchKeyEvent",
    "Input.insertText",
    "Input.dispatchTouchEvent",
  ]);

  const FORWARDED_PAGE_EVENTS = new Set([
    "Page.loadEventFired",
    "Page.domContentEventFired",
  ]);
  const DIAGNOSTIC_EVENTS = new Set([
    "Runtime.consoleAPICalled",
    "Runtime.exceptionThrown",
  ]);
  const SAFE_LIFECYCLE_NAMES = new Set([
    "init",
    "DOMContentLoaded",
    "load",
    "networkAlmostIdle",
    "networkIdle",
  ]);

  class BridgeError extends Error {
    constructor(code) {
      super(code);
      this.code = code;
    }
  }

  function createBridge(chromeApi, options = {}) {
    const clock = options.now || (() => Date.now());
    const schedule =
      options.setTimeout || globalThis.setTimeout.bind(globalThis);
    const cancelSchedule =
      options.clearTimeout || globalThis.clearTimeout.bind(globalThis);
    const randomSource = options.crypto || globalThis.crypto;
    const encoder = new TextEncoder();

    let started = false;
    let port = null;
    let connectionEpoch = null;
    let profileKey = null;
    let profileKeyPromise = null;
    let connectPromise = null;
    let reconnectTimer = null;
    let reconnectAttempt = 0;
    let reconnectAlarmTask = Promise.resolve();
    let enrollmentActionTask = Promise.resolve();
    let pendingEnrollmentAction = null;
    let ready = false;
    let enrollmentId = null;
    let enrollmentChallenge = null;
    let pendingRequests = 0;
    const requestQueues = new Map();
    const pendingAdoptions = new Map();
    let focusProof = null;
    let focusHandoff = null;
    let eventWindowStartedAt = 0;
    let eventCount = 0;
    let persistenceQueue = Promise.resolve();
    const ownershipFailures = [];
    let ownershipFailureDropped = 0;
    let ownershipFailureRevision = 0;
    let ownershipFailureWrite = null;

    const tabsByHandle = new Map();
    const handlesByChromeTab = new Map();
    const sessions = new Map();
    const sessionCurrentTabs = new Map();
    const sessionEpochs = new Map();
    const windowHandles = new Map();
    const quarantinedWindowIds = new Set();
    const closingTabIds = new Set();
    const confirmedClosedTabIds = new Set();
    const retiringTabIds = new Set();
    const retiringSessions = new Set();
    let ownedWindow = null;

    const stateReady = restoreOwnership();

    function randomHex() {
      const bytes = new Uint8Array(32);
      randomSource.getRandomValues(bytes);
      let value = "";
      for (const byte of bytes) value += byte.toString(16).padStart(2, "0");
      return value;
    }

    function opaque(prefix) {
      return `${prefix}_${randomHex()}`;
    }

    function byteLength(value) {
      let encoded;
      try {
        encoded = JSON.stringify(value);
      } catch {
        throw new BridgeError("MESSAGE_NOT_SERIALIZABLE");
      }
      if (encoded === undefined)
        throw new BridgeError("MESSAGE_NOT_SERIALIZABLE");
      return encoder.encode(encoded).byteLength;
    }

    function assertHostToExtensionWireSize(value) {
      if (byteLength(value) > MAX_HOST_TO_EXTENSION_MESSAGE_BYTES)
        throw new BridgeError("MESSAGE_TOO_LARGE");
    }

    function assertExtensionToHostWireSize(value) {
      if (byteLength(value) > MAX_EXTENSION_TO_HOST_MESSAGE_BYTES)
        throw new BridgeError("MESSAGE_TOO_LARGE");
    }

    function isObject(value) {
      return (
        value !== null && typeof value === "object" && !Array.isArray(value)
      );
    }

    function hasExactKeys(value, keys) {
      if (!isObject(value)) return false;
      const actual = Object.keys(value).sort();
      const expected = [...keys].sort();
      return (
        actual.length === expected.length &&
        actual.every((key, index) => key === expected[index])
      );
    }

    function assertSession(value) {
      if (typeof value !== "string" || !SESSION_ID.test(value)) {
        throw new BridgeError("INVALID_SESSION");
      }
      return value;
    }

    function canonicalUrl(value) {
      if (value === "about:blank") return value;
      if (typeof value !== "string" || value.length > 8_192) {
        throw new BridgeError("URL_DENIED");
      }
      let parsed;
      try {
        parsed = new URL(value);
      } catch {
        throw new BridgeError("URL_DENIED");
      }
      if (
        (parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
        parsed.username ||
        parsed.password
      ) {
        throw new BridgeError("URL_DENIED");
      }
      return parsed.href;
    }

    function isAllowedTargetUrl(value) {
      try {
        canonicalUrl(value);
        return true;
      } catch {
        return false;
      }
    }

    function windowHandleFor(chromeWindowId) {
      let handle = windowHandles.get(chromeWindowId);
      if (!handle) {
        handle = opaque("window");
        windowHandles.set(chromeWindowId, handle);
      }
      return handle;
    }

    function ownedRecord(fields, createdByExtension) {
      Object.defineProperty(fields, "createdByExtension", {
        // WHY: Rebind and broker input may never upgrade a user-claimed current tab
        // into something closeable. Only the local creation path supplies true.
        value: createdByExtension === true,
        enumerable: true,
        writable: false,
        configurable: false,
      });
      return fields;
    }

    function addRecord(record) {
      const prior = tabsByHandle.get(handlesByChromeTab.get(record.chromeTabId));
      // WHY: invited agents get different opaque roots, never another owner's
      // handle. Only explicit user claims may share one native attachment.
      if (prior && (!record.sharedUserTab || record.sharedUserTab !== prior.sharedUserTab ||
          record.createdByExtension || prior.createdByExtension || !record.root || !prior.root)) {
        throw new BridgeError("TAB_ALREADY_OWNED");
      }
      record.physical = prior?.physical || {
        members: new Set(), attached: record.attached, validated: record.validated,
        mainFrameId: record.mainFrameId, mainContextId: record.mainContextId,
        contextWaiters: record.contextWaiters || [], execution: null,
      };
      for (const key of ["attached", "validated", "mainFrameId", "mainContextId", "contextWaiters"]) {
        Object.defineProperty(record, key, {
          enumerable: true, configurable: true,
          get: () => record.physical[key],
          set: (value) => { record.physical[key] = value; },
        });
      }
      record.subscriptions = new Set(["Page", "Runtime"]);
      record.physical.members.add(record);
      tabsByHandle.set(record.tabId, record);
      if (!prior) handlesByChromeTab.set(record.chromeTabId, record.tabId);
      windowHandles.set(record.chromeWindowId, record.windowId);
      let set = sessions.get(record.session);
      if (!set) {
        set = new Set();
        sessions.set(record.session, set);
      }
      set.add(record.tabId);
      if (record.root || !sessionCurrentTabs.has(record.session)) {
        sessionCurrentTabs.set(record.session, record.tabId);
      }
    }

    function removeRecord(record) {
      if (tabsByHandle.get(record.tabId) !== record) return;
      if (focusHandoff?.record === record) disposeFocusHandoff(focusHandoff, true);
      tabsByHandle.delete(record.tabId);
      record.physical.members.delete(record);
      if (record.physical.execution?.session === record.session) record.physical.execution = null;
      const remaining = [...record.physical.members][0];
      if (remaining) handlesByChromeTab.set(record.chromeTabId, remaining.tabId);
      else handlesByChromeTab.delete(record.chromeTabId);
      const set = sessions.get(record.session);
      if (set) {
        set.delete(record.tabId);
        if (set.size === 0) {
          sessions.delete(record.session);
          sessionCurrentTabs.delete(record.session);
          sessionEpochs.delete(record.session);
        } else if (sessionCurrentTabs.get(record.session) === record.tabId) {
          const root = [...set]
            .map((handle) => tabsByHandle.get(handle))
            .find((candidate) => candidate && candidate.root);
          sessionCurrentTabs.set(
            record.session,
            root ? root.tabId : [...set][0],
          );
        }
      }
      if (!remaining) resolveContextWaiters(record, null);
    }

    function recordForWire(session, tabId, requestEpoch) {
      assertSession(session);
      if (retiringSessions.has(session)) {
        throw new BridgeError("SESSION_RETIRING");
      }
      if (typeof tabId !== "string") throw new BridgeError("TAB_NOT_OWNED");
      const record = tabsByHandle.get(tabId);
      // WHY: Chrome's numeric IDs are process-global. Only an opaque handle already bound
      // to this profile-owned session may cross the native bridge.
      if (!record || record.session !== session)
        throw new BridgeError("TAB_NOT_OWNED");
      // WHY: Retained ownership is inert in a fresh native connection until the
      // broker proves the exact root and tab set through session.rebind.
      if (sessionEpochs.get(session) !== requestEpoch) {
        throw new BridgeError("REBIND_REQUIRED");
      }
      return record;
    }

    function removePhysicalRecords(record) {
      for (const member of [...record.physical.members]) removeRecord(member);
    }

    function beginExecution(args, requestEpoch) {
      const record = recordForWire(args.session, args.tabId, requestEpoch);
      if (record.physical.foregroundPending) throw new BridgeError("TARGET_BUSY");
      if (!/^[a-f0-9]{64}$/.test(args.command || "")) throw new BridgeError("INVALID_ARGS");
      const active = record.physical.execution;
      if (active && active.epoch === requestEpoch &&
          (active.command !== args.command || active.session !== args.session))
        throw new BridgeError("SESSION_RETIRING");
      // A reconnected transport fences every older generation. It grants no
      // adoption: recordForWire has already required exact participant rebind.
      record.physical.execution = { command: args.command, session: args.session, epoch: requestEpoch };
      return { command: args.command };
    }

    function endExecution(args, requestEpoch) {
      const record = recordForWire(args.session, args.tabId, requestEpoch);
      if (record.physical.execution === null) return { completed: true };
      assertExecution(record, args.command, requestEpoch);
      record.physical.execution = null;
      return { completed: true };
    }

    function assertExecution(record, command, epoch) {
      const active = record.physical.execution;
      if (!active || active.command !== command || active.session !== record.session ||
          active.epoch !== epoch) throw new BridgeError("TAB_NOT_OWNED");
    }

    function descriptor(record) {
      return {
        tabId: record.tabId,
        windowId: record.windowId,
        ownedWindow: record.ownedWindow,
        ...(record.sharedUserTab ? { sharedUserTab: record.sharedUserTab } : {}),
      };
    }

    function serializableOwnership() {
      return {
        ownedWindow: ownedWindow
          ? {
              chromeWindowId: ownedWindow.chromeWindowId,
              windowId: ownedWindow.windowId,
              sentinelTabId: ownedWindow.sentinelTabId,
              contaminated: ownedWindow.contaminated,
            }
          : null,
        currentTabs: [...sessionCurrentTabs.entries()],
        quarantinedWindowIds: [...quarantinedWindowIds],
        tabs: [...tabsByHandle.values()].map((record) => ({
          tabId: record.tabId,
          chromeTabId: record.chromeTabId,
          chromeWindowId: record.chromeWindowId,
          windowId: record.windowId,
          ownedWindow: record.ownedWindow,
          session: record.session,
          root: record.root,
          createdByExtension: record.createdByExtension,
          ...(record.sharedUserTab ? { sharedUserTab: record.sharedUserTab } : {}),
          openerTabId: record.openerTabId || null,
          creationEpoch: record.creationEpoch || null,
        })),
      };
    }

    function persistOwnership() {
      if (!chromeApi.storage.session) return Promise.resolve();
      const snapshot = serializableOwnership();
      persistenceQueue = persistenceQueue
        .catch(() => undefined)
        .then(() =>
          chromeApi.storage.session.set({ [OWNERSHIP_STORAGE_KEY]: snapshot }),
        )
        .catch(() => undefined);
      return persistenceQueue;
    }

    async function restoreOwnership() {
      if (!chromeApi.storage.session) return;
      let stored;
      try {
        stored = (await chromeApi.storage.session.get(OWNERSHIP_STORAGE_KEY))[
          OWNERSHIP_STORAGE_KEY
        ];
      } catch {
        return;
      }
      if (!isObject(stored) || !Array.isArray(stored.tabs)) return;

      if (Array.isArray(stored.quarantinedWindowIds)) {
        for (const id of stored.quarantinedWindowIds) {
          if (Number.isInteger(id)) quarantinedWindowIds.add(id);
        }
      }

      if (
        isObject(stored.ownedWindow) &&
        Number.isInteger(stored.ownedWindow.chromeWindowId) &&
        typeof stored.ownedWindow.windowId === "string" &&
        Number.isInteger(stored.ownedWindow.sentinelTabId)
      ) {
        ownedWindow = {
          chromeWindowId: stored.ownedWindow.chromeWindowId,
          windowId: stored.ownedWindow.windowId,
          sentinelTabId: stored.ownedWindow.sentinelTabId,
          contaminated: Boolean(stored.ownedWindow.contaminated),
        };
        windowHandles.set(ownedWindow.chromeWindowId, ownedWindow.windowId);
      }

      for (const item of stored.tabs) {
        if (tabsByHandle.size >= MAX_SESSIONS * MAX_TABS_PER_SESSION) break;
        if (
          !isObject(item) ||
          typeof item.tabId !== "string" ||
          !Number.isInteger(item.chromeTabId) ||
          !Number.isInteger(item.chromeWindowId) ||
          typeof item.windowId !== "string" ||
          typeof item.session !== "string" ||
          !SESSION_ID.test(item.session)
        ) {
          continue;
        }
        const retainedSession = sessions.get(item.session);
        if (
          (!retainedSession && sessions.size >= MAX_SESSIONS) ||
          retainedSession?.size >= MAX_TABS_PER_SESSION
        ) {
          continue;
        }
        try {
          const exactTab = await chromeApi.tabs.get(item.chromeTabId);
          if (
            !exactTab ||
            exactTab.windowId !== item.chromeWindowId ||
            exactTab.incognito === true
          )
            continue;
        } catch {
          continue;
        }
        addRecord(
          ownedRecord(
            {
              tabId: item.tabId,
              chromeTabId: item.chromeTabId,
              chromeWindowId: item.chromeWindowId,
              windowId: item.windowId,
              ownedWindow: Boolean(item.ownedWindow),
              session: item.session,
              root: Boolean(item.root),
              // Only the exact historical explicit false user-root producer
              // may migrate. Missing legacy provenance stays detach-only.
              sharedUserTab: item.createdByExtension === false && item.root === true &&
                item.ownedWindow === false
                ? (/^tab_[a-f0-9]{64}$/.test(item.sharedUserTab || "") ? item.sharedUserTab : item.tabId)
                : null,
              openerTabId:
                typeof item.openerTabId === "string" ? item.openerTabId : null,
              creationEpoch:
                typeof item.creationEpoch === "string"
                  ? item.creationEpoch
                  : null,
              attached: false,
              validated: false,
              mainFrameId: null,
              mainContextId: null,
              contextWaiters: [],
            },
            // Missing/non-boolean legacy state is deliberately detach-only.
            item.createdByExtension === true,
          ),
        );
      }
      if (Array.isArray(stored.currentTabs)) {
        for (const item of stored.currentTabs) {
          if (!Array.isArray(item) || item.length !== 2) continue;
          const [session, tabId] = item;
          const record = tabsByHandle.get(tabId);
          if (record && record.session === session)
            sessionCurrentTabs.set(session, tabId);
        }
      }
      if (
        ownedWindow &&
        ![...tabsByHandle.values()].some(
          (record) => record.chromeWindowId === ownedWindow.chromeWindowId,
        )
      ) {
        await cleanupOwnedWindow();
      }
      await persistOwnership();
    }

    async function getProfileKey() {
      if (profileKey) return profileKey;
      if (profileKeyPromise) return profileKeyPromise;
      profileKeyPromise = (async () => {
        const stored = await chromeApi.storage.local.get(
          PROFILE_KEY_STORAGE_KEY,
        );
        const candidate = stored[PROFILE_KEY_STORAGE_KEY];
        if (typeof candidate === "string") {
          const legacyValue = candidate.startsWith("profile_")
            ? candidate.slice("profile_".length)
            : candidate;
          if (/^[0-9a-f]{64}$/i.test(legacyValue)) {
            // WHY: Native host and broker own the wire shape: exactly 64 lowercase
            // hex. Canonicalizing preserves all 256 persisted identity bits.
            profileKey = legacyValue.toLowerCase();
            if (profileKey !== candidate) {
              await chromeApi.storage.local.set({
                [PROFILE_KEY_STORAGE_KEY]: profileKey,
              });
            }
            return profileKey;
          }
        }
        profileKey = randomHex();
        await chromeApi.storage.local.set({
          [PROFILE_KEY_STORAGE_KEY]: profileKey,
        });
        return profileKey;
      })();
      try {
        return await profileKeyPromise;
      } finally {
        profileKeyPromise = null;
      }
    }

    function postWire(targetPort, message) {
      assertExtensionToHostWireSize(message);
      targetPort.postMessage(message);
    }

    function queueReconnectAlarm(operation) {
      reconnectAlarmTask = reconnectAlarmTask
        .catch(() => undefined)
        .then(operation)
        .catch(() => undefined);
      return reconnectAlarmTask;
    }

    function ensureReconnectAlarm() {
      return queueReconnectAlarm(async () => {
        if (ready) return;
        const existing = await chromeApi.alarms.get(RECONNECT_ALARM_NAME);
        if (existing || ready) return;
        // WHY: MV3 may terminate this worker and its bounded setTimeout burst while
        // the broker is down, and connectNative returning does not prove the broker
        // completed its ready handshake. Chrome's 30-second alarm remains armed
        // until exact ready without keeping a worker or fast polling loop resident.
        await chromeApi.alarms.create(RECONNECT_ALARM_NAME, {
          delayInMinutes: RECONNECT_ALARM_INTERVAL_MINUTES,
          periodInMinutes: RECONNECT_ALARM_INTERVAL_MINUTES,
        });
      });
    }

    function clearReconnectAlarm() {
      return queueReconnectAlarm(async () => {
        await chromeApi.alarms.clear(RECONNECT_ALARM_NAME);
      });
    }

    async function showPairingAction() {
      if (!chromeApi.action) return;
      try {
        await chromeApi.action.setTitle({
          title: "Click once to pair Agent Browser with this Chrome profile",
        });
        await chromeApi.action.setBadgeText({ text: "PAIR" });
      } catch {
        // The native connection remains fail-closed if Chrome cannot paint UI.
      }
    }

    async function clearPairingAction(title = "Agent Browser connected") {
      if (!chromeApi.action) return;
      try {
        await chromeApi.action.setBadgeText({ text: "" });
        await chromeApi.action.setTitle({ title });
      } catch {
        // Presentation is never transport authority.
      }
    }

    function queueEnrollmentAction(operation) {
      const task = enrollmentActionTask.catch(() => undefined).then(operation);
      enrollmentActionTask = task.catch(() => undefined);
      return task;
    }

    function parseEnrollmentAction(value) {
      if (
        !hasExactKeys(value, [
          "schema",
          "token",
          "profileKey",
          "observedAt",
          "expiresAt",
          "connectionEpoch",
          "enrollmentId",
        ]) ||
        value.schema !== "agent-browser.enrollment-action.v1" ||
        typeof value.token !== "string" ||
        !REQUEST_ID.test(value.token) ||
        typeof value.profileKey !== "string" ||
        (value.profileKey !== "" && !REQUEST_ID.test(value.profileKey)) ||
        !Number.isSafeInteger(value.observedAt) ||
        !Number.isSafeInteger(value.expiresAt) ||
        value.expiresAt <= value.observedAt ||
        value.expiresAt > value.observedAt + ENROLLMENT_ACTION_TTL_MS ||
        typeof value.connectionEpoch !== "string" ||
        (value.connectionEpoch !== "" &&
          !REQUEST_ID.test(value.connectionEpoch)) ||
        typeof value.enrollmentId !== "string" ||
        (value.enrollmentId !== "" && !REQUEST_ID.test(value.enrollmentId))
      ) {
        return null;
      }
      return {
        schema: value.schema,
        token: value.token.toLowerCase(),
        profileKey: value.profileKey.toLowerCase(),
        observedAt: value.observedAt,
        expiresAt: value.expiresAt,
        connectionEpoch: value.connectionEpoch.toLowerCase(),
        enrollmentId: value.enrollmentId.toLowerCase(),
      };
    }

    async function readEnrollmentAction() {
      if (!chromeApi.storage.session) return null;
      const stored = await chromeApi.storage.session.get(
        ENROLLMENT_ACTION_STORAGE_KEY,
      );
      return parseEnrollmentAction(stored[ENROLLMENT_ACTION_STORAGE_KEY]);
    }

    async function writeEnrollmentAction(value) {
      if (!chromeApi.storage.session) return false;
      await chromeApi.storage.session.set({
        [ENROLLMENT_ACTION_STORAGE_KEY]: value,
      });
      return true;
    }

    function armEnrollmentAction() {
      const observedAt = Math.trunc(clock());
      const permit = {
        schema: "agent-browser.enrollment-action.v1",
        token: randomHex(),
        profileKey: "",
        observedAt,
        expiresAt: observedAt + ENROLLMENT_ACTION_TTL_MS,
        connectionEpoch: "",
        enrollmentId: "",
      };
      // WHY: action.onClicked can wake a dormant MV3 worker before its native
      // port or enrollment challenge exists. Arm the one-use permit before any
      // await so that this exact click is not lost while the connection starts.
      pendingEnrollmentAction = permit;
      return queueEnrollmentAction(async () => {
        try {
          if (!(await writeEnrollmentAction(permit))) return false;
          const key = await getProfileKey();
          if (pendingEnrollmentAction?.token !== permit.token) return false;
          const current = await readEnrollmentAction();
          if (!current || current.token !== permit.token) return false;
          const bound = { ...current, profileKey: key };
          pendingEnrollmentAction = bound;
          await writeEnrollmentAction(bound);
          return true;
        } catch {
          if (pendingEnrollmentAction?.token === permit.token) {
            pendingEnrollmentAction = null;
          }
          return false;
        }
      });
    }

    function clearEnrollmentAction(predicate = () => true) {
      return queueEnrollmentAction(async () => {
        let current;
        try {
          current = await readEnrollmentAction();
        } catch {
          return false;
        }
        if (!current || !predicate(current)) return false;
        if (pendingEnrollmentAction?.token === current.token) {
          pendingEnrollmentAction = null;
        }
        try {
          return await writeEnrollmentAction(null);
        } catch {
          return false;
        }
      });
    }

    function drainEnrollmentAction() {
      return queueEnrollmentAction(async () => {
        let permit;
        try {
          permit = await readEnrollmentAction();
        } catch {
          return false;
        }
        if (!permit) return false;
        const now = Math.trunc(clock());
        if (permit.expiresAt <= now) {
          if (pendingEnrollmentAction?.token === permit.token) {
            pendingEnrollmentAction = null;
          }
          await writeEnrollmentAction(null);
          return false;
        }

        const key = await getProfileKey();
        permit = await readEnrollmentAction();
        if (!permit || permit.expiresAt <= Math.trunc(clock())) return false;
        if (permit.profileKey === "") {
          permit = { ...permit, profileKey: key };
          await writeEnrollmentAction(permit);
        } else if (permit.profileKey !== key) {
          if (pendingEnrollmentAction?.token === permit.token) {
            pendingEnrollmentAction = null;
          }
          await writeEnrollmentAction(null);
          return false;
        }

        const targetPort = port;
        const targetEpoch = connectionEpoch;
        const targetEnrollmentId = enrollmentId;
        const targetChallenge = enrollmentChallenge;
        if (
          ready ||
          !targetPort ||
          typeof targetEpoch !== "string" ||
          !REQUEST_ID.test(targetEpoch) ||
          typeof targetEnrollmentId !== "string" ||
          !REQUEST_ID.test(targetEnrollmentId) ||
          typeof targetChallenge !== "string" ||
          !REQUEST_ID.test(targetChallenge)
        ) {
          return false;
        }
        if (
          (permit.connectionEpoch !== "" &&
            permit.connectionEpoch !== targetEpoch) ||
          (permit.enrollmentId !== "" &&
            permit.enrollmentId !== targetEnrollmentId)
        ) {
          if (pendingEnrollmentAction?.token === permit.token) {
            pendingEnrollmentAction = null;
          }
          await writeEnrollmentAction(null);
          return false;
        }

        const bound = {
          ...permit,
          connectionEpoch: targetEpoch,
          enrollmentId: targetEnrollmentId,
        };
        pendingEnrollmentAction = bound;
        await writeEnrollmentAction(bound);
        const latest = await readEnrollmentAction();
        if (
          !latest ||
          latest.token !== bound.token ||
          latest.profileKey !== key ||
          latest.connectionEpoch !== targetEpoch ||
          latest.enrollmentId !== targetEnrollmentId ||
          latest.expiresAt <= Math.trunc(clock()) ||
          port !== targetPort ||
          connectionEpoch !== targetEpoch ||
          enrollmentId !== targetEnrollmentId ||
          enrollmentChallenge !== targetChallenge ||
          ready
        ) {
          if (pendingEnrollmentAction?.token === bound.token) {
            pendingEnrollmentAction = null;
          }
          await writeEnrollmentAction(null);
          return false;
        }

        // Consume before sending. If this async boundary disconnects, the final
        // exact-state check below fails and a stale bound click cannot reconnect.
        if (pendingEnrollmentAction?.token === bound.token) {
          pendingEnrollmentAction = null;
        }
        await writeEnrollmentAction(null);
        if (
          port !== targetPort ||
          connectionEpoch !== targetEpoch ||
          enrollmentId !== targetEnrollmentId ||
          enrollmentChallenge !== targetChallenge ||
          ready
        ) {
          return false;
        }
        postWire(targetPort, {
          schema: SCHEMA,
          type: "enrollment-intent",
          profileKey: key,
          connectionEpoch: targetEpoch,
          enrollmentId: targetEnrollmentId,
          challenge: targetChallenge,
        });
        return true;
      });
    }

    async function handleActionClick() {
      if (ready) return;
      await armEnrollmentAction();
      if (ready) return;
      await ensureConnected();
      const targetPort = port;
      const targetEpoch = connectionEpoch;
      if (
        !ready &&
        targetPort &&
        typeof targetEpoch === "string" &&
        typeof profileKey === "string"
      ) {
        try {
          postWire(targetPort, {
            schema: SCHEMA,
            type: "enrollment-action-observed",
            profileKey,
            connectionEpoch: targetEpoch,
            enrollmentId: typeof enrollmentId === "string" ? enrollmentId : "",
          });
        } catch {
          // The ordinary one-use permit below remains authoritative.
        }
      }
      await drainEnrollmentAction();
    }

    async function handleReconnectAlarm(alarm) {
      if (!alarm || alarm.name !== RECONNECT_ALARM_NAME || ready) return;
      const stalePort = port;
      const staleEpoch = connectionEpoch;
      if (stalePort && connectionEpoch === staleEpoch) {
        port = null;
        connectionEpoch = null;
        ready = false;
        enrollmentId = null;
        enrollmentChallenge = null;
        focusProof = null;
        void clearEnrollmentAction(
          (permit) => permit.connectionEpoch === staleEpoch,
        );
        void clearPairingAction("Agent Browser reconnecting");
        try {
          stalePort.disconnect();
        } catch {
          // The exact unready native port may already be gone.
        }
      }
      reconnectAttempt = 0;
      await ensureConnected();
    }

    function scheduleReconnect() {
      if (!port) void ensureReconnectAlarm();
      if (
        reconnectTimer !== null ||
        port ||
        reconnectAttempt >= RECONNECT_DELAYS_MS.length
      )
        return;
      const delay = RECONNECT_DELAYS_MS[reconnectAttempt++];
      reconnectTimer = schedule(() => {
        reconnectTimer = null;
        void ensureConnected();
      }, delay);
    }

    async function ensureConnected() {
      if (!ready) void ensureReconnectAlarm();
      if (port || connectPromise) return connectPromise;
      if (reconnectTimer !== null) {
        cancelSchedule(reconnectTimer);
        reconnectTimer = null;
      }
      connectPromise = (async () => {
        await stateReady;
        const key = await getProfileKey();
        const nextEpoch = randomHex();
        let nextPort;
        try {
          nextPort = chromeApi.runtime.connectNative(HOST_NAME);
        } catch {
          scheduleReconnect();
          return;
        }
        port = nextPort;
        connectionEpoch = nextEpoch;
        ready = false;
        enrollmentId = null;
        enrollmentChallenge = null;
        focusProof = null;
        nextPort.onMessage.addListener((message) => {
          void receiveNativeMessage(nextPort, nextEpoch, message);
        });
        nextPort.onDisconnect.addListener(() => {
          if (port !== nextPort || connectionEpoch !== nextEpoch) return;
          disposeFocusHandoff(focusHandoff, true);
          port = null;
          connectionEpoch = null;
          ready = false;
          enrollmentId = null;
          enrollmentChallenge = null;
          focusProof = null;
          void clearEnrollmentAction(
            (permit) => permit.connectionEpoch === nextEpoch,
          );
          void clearPairingAction("Agent Browser reconnecting");
          scheduleReconnect();
        });
        postWire(nextPort, {
          schema: SCHEMA,
          type: "hello",
          profileKey: key,
          connectionEpoch: nextEpoch,
          extensionVersion: chromeApi.runtime.getManifest().version,
        });
        void drainEnrollmentAction();
      })().finally(() => {
        connectPromise = null;
      });
      return connectPromise;
    }

    function requestEnvelopeError(message, expectedPort, expectedEpoch) {
      assertHostToExtensionWireSize(message);
      if (
        !isObject(message) ||
        message.schema !== SCHEMA ||
        message.type !== "request"
      ) {
        throw new BridgeError("INVALID_MESSAGE");
      }
      if (typeof message.id !== "string" || !REQUEST_ID.test(message.id)) {
        throw new BridgeError("INVALID_REQUEST_ID");
      }
      if (port !== expectedPort || connectionEpoch !== expectedEpoch) {
        throw new BridgeError("STALE_CONNECTION");
      }
      // WHY: Only the broker's exact ready handshake proves this native epoch.
      // A request arriving first must not disarm reconnect or gain tab authority.
      if (!ready) throw new BridgeError("NOT_READY");
      if (message.profileKey !== profileKey)
        throw new BridgeError("PROFILE_MISMATCH");
      if (message.connectionEpoch !== expectedEpoch)
        throw new BridgeError("STALE_CONNECTION");
      if (!isObject(message.args)) throw new BridgeError("INVALID_ARGS");
      if (Object.hasOwn(message, "deadlineAt")) {
        if (
          !Number.isSafeInteger(message.deadlineAt) ||
          message.deadlineAt > clock() + MAX_REQUEST_DEADLINE_MS
        ) {
          throw new BridgeError("INVALID_DEADLINE");
        }
        if (message.deadlineAt <= clock()) {
          throw new BridgeError("REQUEST_EXPIRED");
        }
      }
    }

    async function receiveNativeMessage(expectedPort, expectedEpoch, message) {
      try {
        assertHostToExtensionWireSize(message);
      } catch {
        return;
      }

      if (
        hasExactKeys(message, [
          "schema",
          "type",
          "profileKey",
          "connectionEpoch",
          "enrollmentId",
          "challenge",
        ]) &&
        message.schema === SCHEMA &&
        message.type === "enrollment-required" &&
        message.profileKey === profileKey &&
        message.connectionEpoch === expectedEpoch &&
        typeof message.enrollmentId === "string" &&
        REQUEST_ID.test(message.enrollmentId) &&
        typeof message.challenge === "string" &&
        REQUEST_ID.test(message.challenge) &&
        expectedPort === port
      ) {
        enrollmentId = message.enrollmentId.toLowerCase();
        enrollmentChallenge = message.challenge.toLowerCase();
        ready = false;
        void showPairingAction();
        void drainEnrollmentAction();
        return;
      }

      if (
        hasExactKeys(message, [
          "schema",
          "type",
          "profileKey",
          "connectionEpoch",
          "enrollmentId",
        ]) &&
        message.schema === SCHEMA &&
        message.type === "enrollment-cancelled" &&
        message.profileKey === profileKey &&
        message.connectionEpoch === expectedEpoch &&
        message.enrollmentId === enrollmentId &&
        expectedPort === port
      ) {
        enrollmentId = null;
        enrollmentChallenge = null;
        ready = false;
        void clearEnrollmentAction();
        void clearPairingAction("Agent Browser not paired");
        return;
      }

      if (
        isObject(message) &&
        message.schema === SCHEMA &&
        message.type === "ready" &&
        message.profileKey === profileKey &&
        message.connectionEpoch === expectedEpoch &&
        expectedPort === port
      ) {
        ready = true;
        enrollmentId = null;
        enrollmentChallenge = null;
        reconnectAttempt = 0;
        void clearEnrollmentAction();
        void clearReconnectAlarm();
        void clearPairingAction();
        return;
      }

      if (
        !isObject(message) ||
        message.type !== "request" ||
        typeof message.id !== "string" ||
        !REQUEST_ID.test(message.id)
      ) {
        return;
      }
      const requestSession =
        isObject(message.args) &&
        typeof message.args.session === "string" &&
        SESSION_ID.test(message.args.session)
          ? message.args.session
          : null;
      const teardownLane =
        requestSession && ["session.close", "tab.foreground.cancel"].includes(message.op);
      // WHY: One stuck Chrome promise can leave all 64 ordinary admissions
      // queued on its session lane. Exact teardown must still reach its separate
      // lane, but only through a bounded reserve; non-teardown capacity stays 64.
      const pendingLimit = teardownLane
        ? MAX_PENDING_REQUESTS + MAX_SESSIONS
        : MAX_PENDING_REQUESTS;
      if (pendingRequests >= pendingLimit) {
        sendError(expectedPort, message.id, "TOO_MANY_REQUESTS");
        return;
      }
      pendingRequests += 1;
      const sessionLane =
        requestSession &&
        ["cdp.send", "tab.close", "session.rebind", "tab.foreground",
          "tab.foreground.check", "tab.background", "window.background"].includes(message.op);
      // WHY: Chrome supports one extension debugging multiple tabs. A page
      // command whose Chrome promise stalls must serialize only its own task;
      // a profile-wide queue previously blocked every unrelated agent/session.
      // Exact session teardown has its own lane so detach/remove can preempt a
      // stuck command and make Chrome reject it. Other profile/window topology
      // remains serialized on the control lane.
      const queueKey = teardownLane
        ? `teardown:${requestSession}`
        : sessionLane
          ? `session:${requestSession}`
          : "control";
      const previous = requestQueues.get(queueKey) || Promise.resolve();
      const requestTask = previous
        .catch(() => undefined)
        .then(async () => {
          try {
            requestEnvelopeError(message, expectedPort, expectedEpoch);
            const result = await dispatch(
              message.op,
              message.args,
              expectedEpoch,
              message.deadlineAt,
            );
            if (
              Number.isSafeInteger(message.deadlineAt) &&
              message.deadlineAt <= clock()
            ) {
              if (
                message.op === "tab.create" ||
                message.op === "tab.claim-active"
              ) {
                await retireExpiredLaunch(
                  message.args.session,
                  expectedEpoch,
                );
              }
              throw new BridgeError("REQUEST_EXPIRED");
            }
            sendResult(expectedPort, message.id, result);
          } catch (error) {
            sendError(expectedPort, message.id, errorCode(error));
          } finally {
            pendingRequests -= 1;
          }
        });
      requestQueues.set(queueKey, requestTask);
      void requestTask.then(
        () => {
          if (requestQueues.get(queueKey) === requestTask) {
            requestQueues.delete(queueKey);
          }
        },
        () => {
          if (requestQueues.get(queueKey) === requestTask) {
            requestQueues.delete(queueKey);
          }
        },
      );
      await requestTask;
    }

    function errorCode(error) {
      if (error instanceof BridgeError) return error.code;
      return "OPERATION_FAILED";
    }

    function sendResult(targetPort, id, result) {
      let response = { schema: SCHEMA, type: "response", id, ok: true, result };
      try {
        assertExtensionToHostWireSize(response);
      } catch {
        response = {
          schema: SCHEMA,
          type: "response",
          id,
          ok: false,
          error: { code: "MESSAGE_TOO_LARGE" },
        };
      }
      try {
        postWire(targetPort, response);
      } catch {
        // The current port may have disconnected while the exact operation completed.
      }
    }

    function sendError(targetPort, id, code) {
      try {
        postWire(targetPort, {
          schema: SCHEMA,
          type: "response",
          id,
          ok: false,
          error: { code },
        });
      } catch {
        // No retry on an old port: a new epoch must inventory retained state.
      }
    }

    async function dispatch(op, args, requestEpoch, deadlineAt) {
      switch (op) {
        case "tab.create":
          return createTab(args, requestEpoch);
        case "tab.claim-active":
          return claimActiveTab(args, requestEpoch);
        case "tab.foreground":
          return foregroundTab(args, requestEpoch, deadlineAt);
        case "tab.foreground.check":
          return checkForegroundTab(args, requestEpoch, deadlineAt);
        case "tab.foreground.cancel":
          return cancelForegroundTab(args, requestEpoch);
        case "tab.background":
          return backgroundTab(args, requestEpoch, deadlineAt);
        case "window.background":
          return backgroundWindow(args, requestEpoch, deadlineAt);
        case "cdp.send":
          return sendCdp(args, requestEpoch, deadlineAt);
        case "command.begin":
          return beginExecution(args, requestEpoch);
        case "command.end":
          return endExecution(args, requestEpoch);
        case "tab.close":
          return closeTab(args, requestEpoch);
        case "session.close":
          return closeSession(args, requestEpoch);
        case "window.cleanup":
          return cleanupWindow(args);
        case "session.rebind":
          return rebindSession(args, requestEpoch);
        case "focus.snapshot":
          return snapshotFocus(args, requestEpoch);
        case "state.inventory":
          return inventory(args);
        default:
          throw new BridgeError("OP_NOT_ALLOWED");
      }
    }

    async function retireExpiredLaunch(session, requestEpoch) {
      if (
        typeof session !== "string" ||
        sessionEpochs.get(session) !== requestEpoch
      ) {
        return;
      }
      // WHY: the provider must never abandon a launch that later leaves a
      // hidden retained root. If Chrome finishes after the broker's absolute
      // deadline, retire the exact session (including adopted descendants)
      // before reporting expiry; unrelated session lanes remain untouched.
      const records = [...(sessions.get(session) || new Set())]
        .map((tabId) => tabsByHandle.get(tabId))
        .filter(Boolean)
        .sort((a, b) => Number(Boolean(a.root)) - Number(Boolean(b.root)));
      for (const record of records) await retireOwnedRecord(record);
      await cleanupOwnedWindow();
    }

    async function chooseTabWindow() {
      const all = await chromeApi.windows.getAll({ windowTypes: ["normal"] });
      const userWindows = all.filter(
        (candidate) =>
          candidate &&
          Number.isInteger(candidate.id) &&
          candidate.incognito !== true &&
          !quarantinedWindowIds.has(candidate.id) &&
          (!ownedWindow || candidate.id !== ownedWindow.chromeWindowId),
      );
      if (userWindows.length > 0) {
        userWindows.sort((left, right) => {
          if (Boolean(left.focused) !== Boolean(right.focused))
            return left.focused ? -1 : 1;
          return left.id - right.id;
        });
        const selected = userWindows[0];
        return {
          chromeWindowId: selected.id,
          windowId: windowHandleFor(selected.id),
          ownedWindow: false,
          newlyCreated: false,
        };
      }

      if (ownedWindow) {
        try {
          const exact = await chromeApi.windows.get(ownedWindow.chromeWindowId);
          if (exact && exact.type === "normal") {
            return { ...ownedWindow, ownedWindow: true, newlyCreated: false };
          }
        } catch {
          ownedWindow = null;
        }
      }

      // WHY: A Chrome profile cannot host a tab without a window. This exact,
      // extension-owned minimized window is lazy and is never reused as a user window.
      const created = await chromeApi.windows.create({
        url: "about:blank",
        focused: false,
        state: "minimized",
      });
      if (!created || !Number.isInteger(created.id))
        throw new BridgeError("WINDOW_CREATE_FAILED");
      const initialTabs = await chromeApi.tabs.query({ windowId: created.id });
      if (
        !Array.isArray(initialTabs) ||
        initialTabs.length !== 1 ||
        !Number.isInteger(initialTabs[0].id)
      ) {
        try {
          await chromeApi.windows.remove(created.id);
        } catch {
          // Best effort only for the exact window just created by this extension.
        }
        throw new BridgeError("WINDOW_CREATE_FAILED");
      }
      ownedWindow = {
        chromeWindowId: created.id,
        windowId: windowHandleFor(created.id),
        sentinelTabId: initialTabs[0].id,
        contaminated: false,
      };
      await persistOwnership();
      return { ...ownedWindow, ownedWindow: true, newlyCreated: true };
    }

    function existingRoot(session) {
      const handles = sessions.get(session);
      if (!handles) return null;
      for (const handle of handles) {
        const record = tabsByHandle.get(handle);
        if (record && record.root) return record;
      }
      return null;
    }

    async function createTab(args, requestEpoch) {
      const session = assertSession(args.session);
      if (retiringSessions.has(session)) {
        throw new BridgeError("SESSION_RETIRING");
      }
      const url = canonicalUrl(args.url);
      const prior = existingRoot(session);
      // WHY: Native replies can be lost. Retrying the same session must never create
      // a second root tab in the same owner epoch (retained roots are safer still).
      if (prior) {
        if (sessionEpochs.get(session) !== requestEpoch) {
          throw new BridgeError("REBIND_REQUIRED");
        }
        return descriptor(prior);
      }
      if (!sessions.has(session) && sessions.size >= MAX_SESSIONS) {
        throw new BridgeError("SESSION_LIMIT_REACHED");
      }

      const selected = await chooseTabWindow();
      let created;
      try {
        created = await chromeApi.tabs.create({
          active: false,
          windowId: selected.chromeWindowId,
          url,
        });
      } catch (error) {
        if (selected.newlyCreated) await cleanupOwnedWindow();
        throw error;
      }
      if (
        !created ||
        !Number.isInteger(created.id) ||
        created.windowId !== selected.chromeWindowId
      ) {
        if (created && Number.isInteger(created.id)) {
          try {
            await chromeApi.tabs.remove(created.id);
          } catch {
            // Exact failed create result only.
          }
        }
        if (selected.newlyCreated) await cleanupOwnedWindow();
        throw new BridgeError("TAB_CREATE_FAILED");
      }

      const record = ownedRecord(
        {
          tabId: opaque("tab"),
          chromeTabId: created.id,
          chromeWindowId: created.windowId,
          windowId: selected.windowId,
          ownedWindow: selected.ownedWindow,
          session,
          root: true,
          openerTabId: null,
          creationEpoch: requestEpoch,
          attached: false,
          validated: false,
          mainFrameId: null,
          mainContextId: null,
          contextWaiters: [],
        },
        true,
      );
      addRecord(record);
      sessionEpochs.set(session, requestEpoch);
      await persistOwnership();
      try {
        await attachAndValidate(record);
      } catch (error) {
        await retireOwnedRecord(record);
        await cleanupOwnedWindow();
        throw error;
      }
      return descriptor(record);
    }

    function latchFocusChange(handoff) {
      if (!handoff || handoff.changed || handoff.cancelled) return;
      handoff.changed = true;
      // One event per lease, independent of page-log/lifecycle volume. The
      // native input reader revokes this exact token before queued release;
      // neither an old token nor another participant can revoke its successor.
      if (port && ready && connectionEpoch === handoff.epoch) {
        try {
          postWire(port, { schema: SCHEMA, type: "event", profileKey,
            connectionEpoch: handoff.epoch, tabId: handoff.record.tabId,
            method: "focus.cancelled", params: { session: handoff.record.session,
              handoffToken: handoff.token } });
        } catch { /* Port loss independently cancels the native lease. */ }
      }
    }

    function disposeFocusHandoff(handoff, ownerLost = false) {
      if (!handoff) return;
      if (ownerLost) latchFocusChange(handoff);
      handoff.cancelled = true;
      chromeApi.tabs.onActivated.removeListener(handoff.onActivated);
      chromeApi.windows.onFocusChanged.removeListener(handoff.onFocused);
      if (focusHandoff === handoff) focusHandoff = null;
    }

    function requestedFocusHandoff(args, requestEpoch) {
      if (!hasExactKeys(args, ["session", "tabId", "windowId", "handoffToken"]) ||
          !REQUEST_ID.test(args.handoffToken))
        throw new BridgeError("INVALID_ARGS");
      const handoff = focusHandoff;
      if (!handoff) return null;
      if (handoff.token !== args.handoffToken) return null;
      if (handoff.epoch !== requestEpoch || handoff.record.session !== args.session ||
          handoff.record.tabId !== args.tabId || handoff.record.windowId !== args.windowId)
        throw new BridgeError("TAB_NOT_OWNED");
      return handoff;
    }

    function cancelForegroundTab(args, requestEpoch) {
      disposeFocusHandoff(requestedFocusHandoff(args, requestEpoch));
      return { status: "cancelled" };
    }

    async function observeFocusHandoff(handoff, deadlineAt) {
      const record = handoff.record;
      const check = () => {
        if (!Number.isSafeInteger(deadlineAt) || deadlineAt <= clock() ||
            focusHandoff !== handoff || handoff.cancelled || handoff.changed || !ready ||
            connectionEpoch !== handoff.epoch ||
            recordForWire(record.session, record.tabId, handoff.epoch) !== record)
          throw new BridgeError("FOREGROUND_CHANGED");
      };
      check();
      const tab = await chromeApi.tabs.get(record.chromeTabId);
      check();
      const window = await chromeApi.windows.get(record.chromeWindowId);
      check();
      if (tab.id !== record.chromeTabId || tab.windowId !== record.chromeWindowId ||
          !tab.active || tab.discarded || tab.incognito || window.id !== record.chromeWindowId ||
          !window.focused || window.state === "minimized" || window.type !== "normal" || window.incognito)
        throw new BridgeError("FOREGROUND_CHANGED");
      return check;
    }

    async function checkForegroundTab(args, requestEpoch, deadlineAt) {
      const handoff = requestedFocusHandoff(args, requestEpoch);
      if (!handoff) return { status: "cancelled" };
      try {
        await observeFocusHandoff(handoff, deadlineAt);
        return { status: "unchanged" };
      } catch {
        disposeFocusHandoff(handoff);
        return { status: "cancelled" };
      }
    }

    async function backgroundTab(args, requestEpoch, deadlineAt) {
      const handoff = requestedFocusHandoff(args, requestEpoch);
      if (!handoff) return { status: "cancelled" };
      const record = handoff.record;
      if (record.physical.execution || record.physical.foregroundPending)
        throw new BridgeError("TARGET_BUSY");
      const pending = {};
      record.physical.foregroundPending = pending;
      try {
        let check = await observeFocusHandoff(handoff, deadlineAt);
        if (!handoff.didActivate) {
          handoff.returning = true;
          return { status: "already-current" };
        }
        if (!Number.isInteger(handoff.priorTabId)) throw new BridgeError("FOREGROUND_CHANGED");
        const prior = await chromeApi.tabs.get(handoff.priorTabId);
        check();
        if (prior.id !== handoff.priorTabId || prior.windowId !== record.chromeWindowId || prior.incognito)
          throw new BridgeError("FOREGROUND_CHANGED");
        // Re-observe the exact active tab/window after the prior-tab lookup;
        // active:true in an unfocused Chrome window is never return authority.
        check = await observeFocusHandoff(handoff, deadlineAt);
        handoff.releaseTabRequested = true;
        await chromeApi.tabs.update(prior.id, { active: true });
        check();
        const [observedTab, observedWindow] = await Promise.all([
          chromeApi.tabs.get(prior.id), chromeApi.windows.get(record.chromeWindowId),
        ]);
        check();
        if (!observedTab.active || observedTab.windowId !== record.chromeWindowId ||
            observedWindow.id !== record.chromeWindowId || !observedWindow.focused ||
            observedWindow.state === "minimized") throw new BridgeError("FOREGROUND_CHANGED");
        handoff.returning = true;
        return { status: "returned" };
      } catch {
        disposeFocusHandoff(handoff);
        return { status: "cancelled" };
      } finally {
        if (record.physical.foregroundPending === pending) delete record.physical.foregroundPending;
        // Keep the observer until broker native release/cancel finishes.
      }
    }

    async function backgroundWindow(args, requestEpoch, deadlineAt) {
      const handoff = requestedFocusHandoff(args, requestEpoch);
      if (!handoff) return { status: "cancelled" };
      const record = handoff.record;
      const check = () => {
        if (!Number.isSafeInteger(deadlineAt) || deadlineAt <= clock() ||
            focusHandoff !== handoff || handoff.cancelled || handoff.changed ||
            !handoff.returning || !ready || connectionEpoch !== requestEpoch ||
            recordForWire(record.session, record.tabId, requestEpoch) !== record ||
            record.physical.execution || record.physical.foregroundPending)
          throw new BridgeError("FOREGROUND_CHANGED");
      };
      try {
        check();
        const activeId = handoff.didActivate ? handoff.priorTabId : record.chromeTabId;
        const tab = await chromeApi.tabs.get(activeId);
        check();
        const window = await chromeApi.windows.get(record.chromeWindowId);
        check();
        if (!tab.active || tab.windowId !== record.chromeWindowId ||
            !window.focused || window.state === "minimized" || window.incognito ||
            window.type !== "normal") throw new BridgeError("FOREGROUND_CHANGED");
        // WHY: the ordinary native host was denied foreground permission.
        // Chrome's supported focused:false delegates to its own Deactivate.
        // Broker/native admission proves the exact next-visible HWND is prior;
        // never minimize/reorder or guess another app. This is one submission,
        // not an atomic OS focus-CAS; a late loss remains unconfirmed.
        handoff.windowReleaseRequested = true;
        await chromeApi.windows.update(record.chromeWindowId, { focused: false });
        return { status: "released" };
      } catch (error) {
        if (handoff.windowReleaseRequested) throw error;
        disposeFocusHandoff(handoff);
        return { status: "cancelled" };
      }
    }

    async function foregroundTab(args, requestEpoch, deadlineAt) {
      if (!hasExactKeys(args, ["session", "tabId", "windowId", "currentTab", "inputBoundary", "handoffToken"]) ||
          !REQUEST_ID.test(args.handoffToken) ||
          !["password", "two-factor", "hardware-key", "captcha", "file-picker",
            "recovery", "account-authority"].includes(args.inputBoundary))
        throw new BridgeError("INPUT_BOUNDARY_REQUIRED");
      const record = recordForWire(args.session, args.tabId, requestEpoch);
      if (!record.root || record.windowId !== args.windowId ||
          typeof args.currentTab !== "boolean" || args.currentTab !== !record.createdByExtension ||
          (!record.createdByExtension && !record.sharedUserTab))
        throw new BridgeError("TAB_NOT_OWNED");
      if (record.physical.execution || record.physical.foregroundPending)
        throw new BridgeError("TARGET_BUSY");
      if (focusHandoff) throw new BridgeError("FOCUS_HANDOFF_BUSY");
      if (!Number.isSafeInteger(deadlineAt)) throw new BridgeError("INVALID_ARGS");
      const pending = {};
      record.physical.foregroundPending = pending;
      const handoff = { record, epoch: requestEpoch, token: args.handoffToken, changed: false, cancelled: false,
        priorTabId: null, didActivate: false, releaseTabRequested: false, returning: false };
      let retained = false;
      let tabActivationRequested = false;
      let windowFocusRequested = false;
      const onActivated = (info) => {
        if (handoff.releaseTabRequested && info?.tabId === handoff.priorTabId &&
            info.windowId === record.chromeWindowId) return;
        if (handoff.releaseTabRequested || !tabActivationRequested || info?.tabId !== record.chromeTabId ||
            info.windowId !== record.chromeWindowId) latchFocusChange(handoff);
      };
      const onFocused = (id) => {
        // Once Chrome restoration has replied, native HWND observation owns
        // window changes, including its own expected return to the prior app.
        // Chrome's same-HWND tab observer remains active until native settles.
        if (handoff.windowReleaseRequested) return;
        if (!windowFocusRequested || id !== record.chromeWindowId) latchFocusChange(handoff);
      };
      Object.assign(handoff, { onActivated, onFocused });
      focusHandoff = handoff;
      const check = () => {
        if (connectionEpoch !== requestEpoch || !ready) throw new BridgeError("STALE_CONNECTION");
        if (deadlineAt <= clock()) throw new BridgeError("REQUEST_EXPIRED");
        if (recordForWire(args.session, args.tabId, requestEpoch) !== record ||
            record.windowId !== args.windowId || record.physical.foregroundPending !== pending)
          throw new BridgeError("TAB_NOT_OWNED");
        if (handoff.changed || handoff.cancelled || focusHandoff !== handoff)
          throw new BridgeError("FOREGROUND_CHANGED");
      };
      // WHY: an explicit invitation permits exactly one activation attempt, not
      // retries after the user switches elsewhere. Keep a physical-target guard
      // through actual Chrome completion, including errors/timeouts at callers.
      // WHY: removing these listeners on foreground reply missed user changes
      // during password/2FA input, including away-and-back. Retain the latch
      // until explicit background/cancel; native observation owns other apps.
      try {
        chromeApi.tabs.onActivated.addListener(onActivated);
        chromeApi.windows.onFocusChanged.addListener(onFocused);
        check();
        let tab = await chromeApi.tabs.get(record.chromeTabId);
        check();
        let window = await chromeApi.windows.get(record.chromeWindowId);
        check();
        if (tab.id !== record.chromeTabId || tab.windowId !== record.chromeWindowId ||
            tab.incognito || tab.discarded ||
            (typeof tab.url === "string" && !isAllowedTargetUrl(tab.url)) ||
            window.id !== record.chromeWindowId || window.type !== "normal" || window.incognito)
          throw new BridgeError("TARGET_DENIED");
        // WHY: Chrome omits Tab.url without tab/host permissions; the literal
        // owned HTTPS handoff was denied before activation. Missing metadata is
        // not an unsafe URL. Query this already-owned debugger target afresh:
        // attachAndValidate may return cached validation after navigation.
        const tree = await chromeApi.debugger.sendCommand(
          { tabId: record.chromeTabId }, "Page.getFrameTree", {},
        );
        check();
        const mainFrame = tree && tree.frameTree && tree.frameTree.frame;
        if (!mainFrame || typeof mainFrame.id !== "string" ||
            !isAllowedTargetUrl(mainFrame.url))
          throw new BridgeError("TARGET_DENIED");
        if (!tab.active) {
          const prior = await chromeApi.tabs.query({ windowId: record.chromeWindowId, active: true });
          check();
          if (prior.length === 1 && Number.isInteger(prior[0].id) && prior[0].id !== record.chromeTabId)
            handoff.priorTabId = prior[0].id;
          // API replies and events are distinct deliveries. A delayed event
          // for our exact request is not evidence of a different user choice.
          tabActivationRequested = true;
          handoff.didActivate = true;
          await chromeApi.tabs.update(record.chromeTabId, { active: true });
          check();
        }
        tab = await chromeApi.tabs.get(record.chromeTabId);
        check();
        if (!tab.active || tab.windowId !== record.chromeWindowId)
          throw new BridgeError("FOREGROUND_CHANGED");
        window = await chromeApi.windows.get(record.chromeWindowId);
        check();
        if (!window.focused || window.state === "minimized") {
          windowFocusRequested = true;
          await chromeApi.windows.update(record.chromeWindowId, {
            focused: true, ...(window.state === "minimized" ? { state: "normal" } : {}),
          });
          check();
        }
        const [observedTab, observedWindow] = await Promise.all([
          chromeApi.tabs.get(record.chromeTabId), chromeApi.windows.get(record.chromeWindowId),
        ]);
        check();
        // WHY: a real HWND activation still failed this combined check. Keep
        // all six observations instead of guessing that Chrome denied focus.
        // The fixed Y/N suffix is tab ID, tab's window ID, window ID, active
        // tab, focused window, non-minimized window. No identities or page data
        // leave this owner; this changes diagnostics, not success or retries.
        const confirmation = [observedTab.id === record.chromeTabId,
          observedTab.windowId === record.chromeWindowId,
          observedWindow.id === record.chromeWindowId, Boolean(observedTab.active),
          Boolean(observedWindow.focused), observedWindow.state !== "minimized"];
        if (!confirmation.every(Boolean))
          throw new BridgeError("FOREGROUND_NOT_CONFIRMED_" + confirmation.map(value => value ? "Y" : "N").join(""));
        retained = true;
        return { tabId: record.tabId, windowId: record.windowId, active: true, focused: true };
      } finally {
        if (!retained) disposeFocusHandoff(handoff);
        if (record.physical.foregroundPending === pending) delete record.physical.foregroundPending;
      }
    }

    async function exactFocusedTab() {
      let focused;
      try {
        focused = await chromeApi.windows.getLastFocused({
          windowTypes: ["normal"],
        });
      } catch {
        throw new BridgeError("NO_FOCUSED_USER_TAB");
      }
      if (
        !focused ||
        !focused.focused ||
        !Number.isInteger(focused.id) ||
        focused.incognito === true ||
        (ownedWindow && focused.id === ownedWindow.chromeWindowId)
      ) {
        throw new BridgeError("NO_FOCUSED_USER_TAB");
      }
      const active = await chromeApi.tabs.query({
        active: true,
        windowId: focused.id,
      });
      if (
        !Array.isArray(active) ||
        active.length !== 1 ||
        !Number.isInteger(active[0].id)
      ) {
        throw new BridgeError("NO_FOCUSED_USER_TAB");
      }
      return { chromeWindowId: focused.id, tab: active[0] };
    }

    async function snapshotFocus(args, requestEpoch) {
      if (Object.keys(args).length !== 0) throw new BridgeError("INVALID_ARGS");
      try {
        const exact = await exactFocusedTab();
        if (connectionEpoch !== requestEpoch) {
          throw new BridgeError("STALE_CONNECTION");
        }
        focusProof = {
          connectionEpoch: requestEpoch,
          chromeWindowId: exact.chromeWindowId,
          chromeTabId: exact.tab.id,
          expiresAt: clock() + FOCUS_PROOF_MS,
        };
        return { claimable: true };
      } catch (error) {
        focusProof = null;
        if (
          error instanceof BridgeError &&
          error.code === "NO_FOCUSED_USER_TAB"
        ) {
          return { claimable: false };
        }
        throw error;
      }
    }

    function deniedClaimUrlClass(value) {
      if (typeof value !== "string") return "MISSING";
      if (value.length === 0) return "EMPTY";
      if (value.length > 8192) return "OVERSIZE";
      try {
        return ({ "http:": "HTTP", "https:": "HTTPS", "about:": "ABOUT",
          "chrome:": "CHROME", "chrome-extension:": "EXTENSION", "file:": "FILE",
          "data:": "DATA", "blob:": "BLOB" })[new URL(value).protocol] || "UNSUPPORTED";
      } catch { return "UNSUPPORTED"; }
    }

    function claimApiFailureClass(error) {
      // Chrome 153 debugger_api.cc:93-106 supplies these templates; :958-961
      // serializes backend errors as JSON. RESTRICTED is deliberately NOT a
      // policy/interstitial/profile diagnosis. Unknown text never leaves here.
      try {
        const text = typeof error?.message === "string" ? error.message : "";
        if (text.length > 4096) return "OTHER";
        if (text === "Cannot attach to this target.") return "RESTRICTED";
        if (/^Another debugger is already attached to the tab with id: -?\d+\.$/.test(text)) return "ALREADY_ATTACHED";
        if (/^No tab with given id -?\d+\.$/.test(text)) return "NO_TARGET";
        if (/^Debugger is not attached to the tab with id: -?\d+\.$/.test(text)) return "NOT_ATTACHED";
        if (/^Requested protocol version is not supported: [0-9.]+\.$/.test(text)) return "PROTOCOL_VERSION";
        if (text === "Detached while handling command.") return "DETACHED";
        if (text === "Cannot navigate to a file URL without local file access.") return "FILE_ACCESS";
        const value = JSON.parse(text);
        if (!isObject(value) || !Number.isInteger(value.code)) return "OTHER";
        return ({ "-32601": "CDP_METHOD", "-32602": "CDP_PARAMS",
          "-32603": "CDP_INTERNAL", "-32000": "CDP_SERVER" })[value.code] || "CDP_OTHER";
      } catch { return "OTHER"; }
    }

    async function claimActiveTab(args, requestEpoch) {
      const session = assertSession(args.session);
      if (retiringSessions.has(session)) {
        throw new BridgeError("SESSION_RETIRING");
      }
      const proof = focusProof;
      focusProof = null;
      // WHY: Claiming is one-shot and rechecks the exact focused window/tab. A stale
      // snapshot or a tab in another/minimized extension-owned window grants nothing.
      if (
        !proof ||
        proof.connectionEpoch !== requestEpoch ||
        proof.expiresAt < clock()
      ) {
        throw new BridgeError("FOCUS_PROOF_REQUIRED");
      }
      const exact = await exactFocusedTab();
      if (connectionEpoch !== requestEpoch) {
        throw new BridgeError("STALE_CONNECTION");
      }
      if (
        exact.chromeWindowId !== proof.chromeWindowId ||
        exact.tab.id !== proof.chromeTabId
      ) {
        throw new BridgeError("FOCUS_CHANGED");
      }

      const priorRoot = existingRoot(session);
      if (priorRoot) {
        if (sessionEpochs.get(session) !== requestEpoch) {
          throw new BridgeError("REBIND_REQUIRED");
        }
        if (priorRoot.chromeTabId !== exact.tab.id) {
          throw new BridgeError("SESSION_ALREADY_BOUND");
        }
        if (priorRoot.createdByExtension || !priorRoot.sharedUserTab)
          throw new BridgeError("TAB_ALREADY_OWNED");
        return descriptor(priorRoot);
      }

      const existingHandle = handlesByChromeTab.get(exact.tab.id);
      if (existingHandle) {
        const existing = tabsByHandle.get(existingHandle);
        if (!existing || existing.createdByExtension || !existing.root || !existing.sharedUserTab)
          throw new BridgeError("TAB_ALREADY_OWNED");
        if (existing.session === session) {
          if (sessionEpochs.get(session) !== requestEpoch) throw new BridgeError("REBIND_REQUIRED");
          return descriptor(existing);
        }
        if (!sessions.has(session) && sessions.size >= MAX_SESSIONS)
          throw new BridgeError("SESSION_LIMIT_REACHED");
        const joined = ownedRecord({
          tabId: opaque("tab"), chromeTabId: existing.chromeTabId,
          chromeWindowId: existing.chromeWindowId, windowId: existing.windowId,
          ownedWindow: false, session, root: true, openerTabId: null,
          creationEpoch: requestEpoch, sharedUserTab: existing.sharedUserTab,
        }, false);
        addRecord(joined);
        sessionEpochs.set(session, requestEpoch);
        await persistOwnership();
        return descriptor(joined);
      }

      if (!sessions.has(session) && sessions.size >= MAX_SESSIONS) {
        throw new BridgeError("SESSION_LIMIT_REACHED");
      }

      // R94: the real first claim returned only TARGET_DENIED. Keep identical
      // denial predicates, but expose bounded fixed classes through the existing
      // error-code field; provider/native consumers discard free-text messages.
      if (typeof exact.tab.url === "string" && !isAllowedTargetUrl(exact.tab.url))
        throw new BridgeError("TARGET_DENIED_CLAIM_METADATA_URL_" + deniedClaimUrlClass(exact.tab.url));
      if (typeof exact.tab.pendingUrl === "string" && !isAllowedTargetUrl(exact.tab.pendingUrl))
        throw new BridgeError("TARGET_DENIED_CLAIM_METADATA_PENDING_" + deniedClaimUrlClass(exact.tab.pendingUrl));
      if (exact.tab.incognito === true)
        throw new BridgeError("TARGET_DENIED_CLAIM_METADATA_INCOGNITO");
      const record = ownedRecord(
        {
          tabId: opaque("tab"),
          chromeTabId: exact.tab.id,
          chromeWindowId: exact.chromeWindowId,
          windowId: windowHandleFor(exact.chromeWindowId),
          ownedWindow: false,
          session,
          root: true,
          openerTabId: null,
          creationEpoch: requestEpoch,
          sharedUserTab: opaque("tab"),
          attached: false,
          validated: false,
          mainFrameId: null,
          mainContextId: null,
          contextWaiters: [],
        },
        false,
      );
      addRecord(record);
      sessionEpochs.set(session, requestEpoch);
      let claimFailure = "UNKNOWN_OTHER";
      try {
        await attachAndValidate(record, (stage, _code, classification) => {
          const name = ({ "debugger.attach": "ATTACH", "Page.getFrameTree": "FRAME_TREE",
            "target.validate": "VALIDATE", "Emulation.setFocusEmulationEnabled": "EMULATION",
            "Page.enable": "PAGE_ENABLE", "Runtime.enable": "RUNTIME_ENABLE" })[stage] || "UNKNOWN";
          claimFailure = name + "_" + classification;
        });
      } catch (error) {
        removeRecord(record);
        await persistOwnership();
        // No retry, target substitution, or policy bypass: only the formerly
        // erased initial-claim discriminator changes. Other attach callers keep
        // their existing error codes and cleanup behavior.
        throw error instanceof BridgeError && error.code === "TARGET_DENIED"
          ? new BridgeError("TARGET_DENIED_CLAIM_" + claimFailure)
          : error;
      }
      await persistOwnership();
      return descriptor(record);
    }

    async function attachAndValidate(record, onFailure) {
      if (record.attached && record.validated) return;
      let attachedHere = false;
      let stage = "debugger.attach";
      let failureClass;
      try {
        if (!record.attached) {
          // WHY: Never use getTargets, targetId, or extensionId. Chrome first applies
          // its restricted-target policy to this one exact tab; our main-frame check
          // then also rejects this extension's own pages and every non-web target.
          await chromeApi.debugger.attach(
            { tabId: record.chromeTabId },
            DEBUGGER_PROTOCOL_VERSION,
          );
          record.attached = true;
          attachedHere = true;
        }
        stage = "Page.getFrameTree";
        const tree = await chromeApi.debugger.sendCommand(
          { tabId: record.chromeTabId },
          "Page.getFrameTree",
          {},
        );
        stage = "target.validate";
        const mainFrame = tree && tree.frameTree && tree.frameTree.frame;
        if (
          !mainFrame ||
          typeof mainFrame.id !== "string" ||
          !isAllowedTargetUrl(mainFrame.url)
        ) {
          failureClass = !mainFrame ? "FRAME_MISSING"
            : typeof mainFrame.id !== "string" ? "FRAME_ID"
            : "URL_" + deniedClaimUrlClass(mainFrame.url);
          throw new BridgeError("TARGET_DENIED");
        }
        record.mainFrameId = mainFrame.id;
        // WHY: Hidden-tab input has been acknowledged without DOM delivery. Focus
        // emulation is an unproven discriminator: Playwright crPage.ts:503-504
        // enables it for main pages; Chromium emulation_handler.cc:1009 keeps the
        // emulated-focused renderer visible. Keep this internal to the exact tab.
        stage = "Emulation.setFocusEmulationEnabled";
        await chromeApi.debugger.sendCommand(
          { tabId: record.chromeTabId },
          "Emulation.setFocusEmulationEnabled",
          { enabled: true },
        );
        record.validated = true;
        stage = "Page.enable";
        await chromeApi.debugger.sendCommand(
          { tabId: record.chromeTabId },
          "Page.enable",
          {},
        );
        stage = "Runtime.enable";
        await chromeApi.debugger.sendCommand(
          { tabId: record.chromeTabId },
          "Runtime.enable",
          {},
        );
      } catch (error) {
        onFailure?.(stage, errorCode(error), failureClass || claimApiFailureClass(error));
        if (record.attached || attachedHere) {
          try {
            await chromeApi.debugger.detach({ tabId: record.chromeTabId });
          } catch {
            // The target may already have vanished.
          }
        }
        record.attached = false;
        record.validated = false;
        record.mainFrameId = null;
        record.mainContextId = null;
        throw error instanceof BridgeError
          ? error
          : new BridgeError("TARGET_DENIED");
      }
    }

    function safeCdpParams(record, method, supplied) {
      if (!isObject(supplied)) throw new BridgeError("INVALID_CDP_PARAMS");
      const params = { ...supplied };
      // WHY: Browser/Target/Storage/Network authority and focus/download/permission
      // commands are absent from the allowlist. Runtime.evaluate is pinned to
      // the owned top-level frame; object calls can use only handles resolved
      // through this exact owned tab target.
      if (!SAFE_CDP_METHODS.has(method))
        throw new BridgeError("CDP_METHOD_DENIED");
      if (method === "DOM.setFileInputFiles") {
        // WHY: upload used an unsupported describeNode shape, then a denied
        // file command. Accept only the resolved object on this owned target,
        // never an alternate numeric node/context selector or a path guessed
        // relative to Windows Chrome. The invoking client maps WSL paths to
        // local WSL UNC paths; this worker never substitutes its own cwd.
        if (
          !hasExactKeys(params, ["files", "objectId"]) ||
          typeof params.objectId !== "string" ||
          params.objectId.length === 0 ||
          /[\u0000-\u001f\u007f]/.test(params.objectId) ||
          !Array.isArray(params.files) ||
          !params.files.every((file) =>
            typeof file === "string" &&
            (/^[A-Za-z]:[\\/]/.test(file) ||
              /^\\\\(?:wsl\.localhost|wsl\$)\\[^\\/]+\\[^\\]/i.test(file)) &&
            !/[\u0000-\u001f\u007f]/.test(file),
          )
        ) {
          throw new BridgeError("INVALID_CDP_PARAMS");
        }
      }
      if (method === "Runtime.evaluate") {
        if (
          Object.hasOwn(params, "contextId") ||
          Object.hasOwn(params, "uniqueContextId") ||
          Object.hasOwn(params, "executionContextId")
        ) {
          throw new BridgeError("NON_MAIN_CONTEXT_DENIED");
        }
        if (!Number.isInteger(record.mainContextId))
          throw new BridgeError("MAIN_CONTEXT_UNAVAILABLE");
        params.contextId = record.mainContextId;
      }
      // WHY: v0.36 resolves snapshot refs to objects and scrolls them before
      // coordinate input. Blocking these page-scoped calls made an
      // off-viewport click report success while Chrome received no event.
      if (method === "DOM.scrollIntoViewIfNeeded") {
        if (
          !hasExactKeys(params, ["backendNodeId"]) ||
          !Number.isSafeInteger(params.backendNodeId) ||
          params.backendNodeId < 1
        ) {
          throw new BridgeError("INVALID_CDP_PARAMS");
        }
      }
      // WHY: v0.36 scoped snapshots require a subtree description; cursor-only
      // refs and iframe expansion require the other two shapes. Denying this
      // call fails scoped snapshots or silently loses actionable refs. Keep
      // descriptions on this owned tab and reject alternate selectors/options.
      if (method === "DOM.describeNode") {
        const nodeShape =
          hasExactKeys(params, ["nodeId"]) &&
          Number.isSafeInteger(params.nodeId) && params.nodeId > 0;
        const backendShape =
          hasExactKeys(params, ["backendNodeId", "depth"]) &&
          Number.isSafeInteger(params.backendNodeId) &&
          params.backendNodeId > 0 && params.depth === 1;
        const objectShape =
          hasExactKeys(params, ["objectId", "depth"]) &&
          typeof params.objectId === "string" &&
          params.objectId.length > 0 && params.depth === -1;
        if (!nodeShape && !backendShape && !objectShape)
          throw new BridgeError("INVALID_CDP_PARAMS");
      }
      if (method === "DOM.resolveNode") {
        const keys = Object.keys(params);
        if (
          !Number.isSafeInteger(params.backendNodeId) ||
          params.backendNodeId < 1 ||
          !keys.every((key) =>
            ["backendNodeId", "objectGroup"].includes(key),
          ) ||
          ![1, 2].includes(keys.length) ||
          (Object.hasOwn(params, "objectGroup") &&
            !["agent-browser", "agent-browser-annotate"].includes(
              params.objectGroup,
            ))
        ) {
          throw new BridgeError("INVALID_CDP_PARAMS");
        }
      }
      if (method === "Runtime.callFunctionOn") {
        const allowed = new Set([
          "objectId",
          "functionDeclaration",
          "arguments",
          "returnByValue",
          "awaitPromise",
        ]);
        const argumentsValid =
          !Object.hasOwn(params, "arguments") ||
          (Array.isArray(params.arguments) &&
            params.arguments.every(
              (argument) =>
                isObject(argument) &&
                Object.keys(argument).length === 1 &&
                Object.hasOwn(argument, "value"),
            ));
        if (
          typeof params.objectId !== "string" ||
          params.objectId.length < 1 ||
          typeof params.functionDeclaration !== "string" ||
          params.functionDeclaration.length < 1 ||
          !Object.keys(params).every((key) => allowed.has(key)) ||
          !argumentsValid ||
          (Object.hasOwn(params, "returnByValue") &&
            typeof params.returnByValue !== "boolean") ||
          (Object.hasOwn(params, "awaitPromise") &&
            typeof params.awaitPromise !== "boolean")
        ) {
          throw new BridgeError("INVALID_CDP_PARAMS");
        }
      }
      if (method === "Page.navigate") {
        params.url = canonicalUrl(params.url);
        if (Object.hasOwn(supplied, "frameId"))
          throw new BridgeError("NON_MAIN_CONTEXT_DENIED");
        params.frameId = record.mainFrameId;
      }
      return params;
    }

    function isDefaultPngScreenshot(method, params) {
      return (
        method === "Page.captureScreenshot" &&
        hasExactKeys(params, ["format", "fromSurface"]) &&
        params.format === "png" &&
        params.fromSurface === true
      );
    }

    async function captureDefaultPngViaScreencast(record, requestEpoch) {
      let frameTimer;
      let resolveFrame;
      let rejectFrame;
      let primaryError = null;
      const framePromise = new Promise((resolve, reject) => {
        resolveFrame = resolve;
        rejectFrame = reject;
        frameTimer = schedule(() => {
          reject(new BridgeError("SCREENCAST_FRAME_TIMEOUT"));
        }, SCREENCAST_FRAME_TIMEOUT_MS);
      });
      // The start command can fail before this promise is awaited. Keep its
      // later watchdog rejection handled without changing what await observes.
      void framePromise.catch(() => undefined);
      const onFrame = (source, method, params) => {
        if (
          !source ||
          Object.hasOwn(source, "sessionId") ||
          source.tabId !== record.chromeTabId ||
          method !== "Page.screencastFrame"
        ) {
          return;
        }
        if (
          !record.attached ||
          tabsByHandle.get(record.tabId) !== record ||
          sessionEpochs.get(record.session) !== requestEpoch
        ) {
          rejectFrame(new BridgeError("TAB_NOT_OWNED"));
          return;
        }
        if (
          !isObject(params) ||
          typeof params.data !== "string" ||
          params.data.length === 0 ||
          !Number.isSafeInteger(params.sessionId)
        ) {
          rejectFrame(new BridgeError("INVALID_SCREENCAST_FRAME"));
          return;
        }
        resolveFrame({ data: params.data, sessionId: params.sessionId });
      };

      chromeApi.debugger.onEvent.addListener(onFrame);
      try {
        // WHY: On minimized Chrome 153, ordinary and full-page surface
        // screenshots both hit the 15 s broker boundary while a comparable
        // payload crossed it in 69 ms. This exact default-PNG discriminator
        // uses Viz video capture without exposing screencast authority. Its
        // first-frame freshness still requires the literal mutated fixture.
        await chromeApi.debugger.sendCommand(
          { tabId: record.chromeTabId },
          "Page.startScreencast",
          { format: "png" },
        );
        const frame = await framePromise;
        if (
          !record.attached ||
          tabsByHandle.get(record.tabId) !== record ||
          sessionEpochs.get(record.session) !== requestEpoch
        ) {
          throw new BridgeError("TAB_NOT_OWNED");
        }
        await chromeApi.debugger.sendCommand(
          { tabId: record.chromeTabId },
          "Page.screencastFrameAck",
          { sessionId: frame.sessionId },
        );
        return { data: frame.data };
      } catch (error) {
        primaryError = error;
        throw error;
      } finally {
        cancelSchedule(frameTimer);
        chromeApi.debugger.onEvent.removeListener(onFrame);
        try {
          await chromeApi.debugger.sendCommand(
            { tabId: record.chromeTabId },
            "Page.stopScreencast",
            {},
          );
        } catch (error) {
          // Keep a native start/ack failure or a first-frame timeout distinct
          // from best-effort cleanup failure. A cleanup failure after a valid
          // frame still rejects the screenshot.
          if (!primaryError) throw error;
        }
      }
    }

    async function requireUploadFileAccess() {
      // Chrome's DOMHandler checks the extension's file-access permission even
      // for an HTTP input. A missing/failed/timed-out query is not permission.
      // WHY: only a confirmed false means access is disabled. Lookup failure
      // must not tell an already-authorized user to grant permission again.
      // Never enable it, reattach, or retry the file command automatically.
      let timer;
      let allowed;
      try {
        allowed = await Promise.race([
          Promise.resolve().then(() =>
            chromeApi.extension?.isAllowedFileSchemeAccess?.(),
          ),
          new Promise((resolve) => {
            timer = schedule(() => resolve(undefined), FILE_ACCESS_CHECK_TIMEOUT_MS);
          }),
        ]);
      } catch {
        throw new BridgeError("FILE_ACCESS_UNVERIFIED");
      } finally {
        if (timer !== undefined) cancelSchedule(timer);
      }
      if (allowed === false) throw new BridgeError("FILE_ACCESS_REQUIRED");
      if (allowed !== true) throw new BridgeError("FILE_ACCESS_UNVERIFIED");
    }

    async function sendCdp(args, requestEpoch, deadlineAt) {
      const record = recordForWire(args.session, args.tabId, requestEpoch);
      if (record.physical.foregroundPending) throw new BridgeError("TARGET_BUSY");
      if (record.sharedUserTab || args.command !== undefined)
        assertExecution(record, args.command, requestEpoch);
      if (typeof args.method !== "string")
        throw new BridgeError("CDP_METHOD_DENIED");
      await attachAndValidate(record);
      if (
        args.method === "Runtime.evaluate" &&
        !Number.isInteger(record.mainContextId)
      ) {
        await waitForMainContext(record);
      }
      if (
        tabsByHandle.get(record.tabId) !== record ||
        sessionEpochs.get(record.session) !== requestEpoch
      ) {
        throw new BridgeError("TAB_NOT_OWNED");
      }
      const params = safeCdpParams(record, args.method, args.params || {});
      if (record.physical.foregroundPending) throw new BridgeError("TARGET_BUSY");
      if (record.sharedUserTab || args.command !== undefined)
        assertExecution(record, args.command, requestEpoch);
      const domainChange = /^(Page|Runtime|DOM|CSS|Accessibility)\.(enable|disable)$/.exec(args.method);
      if (domainChange) {
        const [, domain, action] = domainChange;
        if (action === "enable") record.subscriptions.add(domain);
        else {
          record.subscriptions.delete(domain);
          if (["Page", "Runtime"].includes(domain) ||
              [...record.physical.members].some((member) => member.subscriptions.has(domain)))
            return {};
        }
      }
      if (args.method === "DOM.setFileInputFiles") {
        await requireUploadFileAccess();
        // Permission checking is asynchronous: it cannot retain a revoked tab
        // or an expired request long enough to grant that page file access.
        // Disconnect retains sessionEpochs, so also check the current epoch.
        if (connectionEpoch !== requestEpoch)
          throw new BridgeError("STALE_CONNECTION");
        if (Number.isSafeInteger(deadlineAt) && deadlineAt <= clock())
          throw new BridgeError("REQUEST_EXPIRED");
        if (recordForWire(args.session, args.tabId, requestEpoch) !== record)
          throw new BridgeError("TAB_NOT_OWNED");
      }
      // WHY: JPEG viewport capture also stalled at the 15 s native surface
      // boundary on hidden Chrome. Keep Viz active for JPEG in every capture
      // shape; the native result must retain the requested format and quality.
      const result = isDefaultPngScreenshot(args.method, params)
        ? await captureDefaultPngViaScreencast(record, requestEpoch)
        : args.method === "Page.captureScreenshot" &&
            params.fromSurface === true &&
            (params.format === "jpeg" ||
              (params.format === "png" && isObject(params.clip)))
          ? await captureNativeWithActiveViz(record, requestEpoch, params)
          : await chromeApi.debugger.sendCommand(
              { tabId: record.chromeTabId },
              args.method,
              params,
            );
      if (
        tabsByHandle.get(record.tabId) !== record ||
        sessionEpochs.get(record.session) !== requestEpoch
      ) {
        throw new BridgeError("TAB_NOT_OWNED");
      }
      sessionCurrentTabs.set(record.session, record.tabId);
      void persistOwnership();
      // WHY: debugger replies travel from the extension to native-host stdin,
      // whose documented ceiling is 64 MiB. Applying Chrome's 1 MiB limit for
      // the reverse host-to-extension direction discarded valid AX snapshots.
      assertExtensionToHostWireSize(result === undefined ? {} : result);
      return result === undefined ? {} : result;
    }

    async function captureNativeWithActiveViz(record, requestEpoch, params) {
      // WHY: native full-page capture timed out on hidden Chrome 153. Its Viz
      // owner disables frame-sink throttling while video capture is active.
      // Keep that exact tab's stream alive through the native screenshot; only
      // the unchanged native clip/full-page result can satisfy this request.
      // A viewport frame is never substituted for the requested full pixels.
      const target = { tabId: record.chromeTabId };
      let finished = false;
      let firstFrameSeen = false;
      let resolveFirst;
      let rejectCapture;
      let timer;
      let primaryError;
      const firstFrame = new Promise((resolve) => {
        resolveFirst = resolve;
      });
      const failure = new Promise((_, reject) => {
        rejectCapture = reject;
        // One deadline covers start, first frame, acknowledgment and native
        // capture, rather than renewing a full timeout at each owner edge.
        timer = schedule(
          () => reject(new BridgeError("SCREENSHOT_TIMEOUT")),
          3_000,
        );
      });
      void failure.catch(() => undefined);
      const checkOwner = () => {
        if (
          finished ||
          !record.attached ||
          tabsByHandle.get(record.tabId) !== record ||
          sessionEpochs.get(record.session) !== requestEpoch
        ) {
          throw new BridgeError("TAB_NOT_OWNED");
        }
      };
      const onFrame = (source, method, frame) => {
        if (
          finished ||
          !source ||
          Object.hasOwn(source, "sessionId") ||
          source.tabId !== record.chromeTabId ||
          method !== "Page.screencastFrame"
        )
          return;
        try {
          checkOwner();
          if (
            !isObject(frame) ||
            typeof frame.data !== "string" ||
            frame.data.length === 0 ||
            !Number.isSafeInteger(frame.sessionId)
          ) {
            throw new BridgeError("INVALID_SCREENCAST_FRAME");
          }
          const first = !firstFrameSeen;
          firstFrameSeen = true;
          // Ack every matching frame, not just the first: unacknowledged frames
          // can backpressure the stream before native capture presents pixels.
          void chromeApi.debugger
            .sendCommand(target, "Page.screencastFrameAck", {
              sessionId: frame.sessionId,
            })
            .then(() => {
              if (first && !finished) resolveFirst();
            }, rejectCapture);
        } catch (error) {
          rejectCapture(error);
        }
      };
      chromeApi.debugger.onEvent.addListener(onFrame);
      try {
        const capture = (async () => {
          checkOwner();
          await chromeApi.debugger.sendCommand(target, "Page.startScreencast", {
            format: "png",
          });
          checkOwner();
          await firstFrame;
          checkOwner();
          const result = await chromeApi.debugger.sendCommand(
            target,
            "Page.captureScreenshot",
            params,
          );
          checkOwner();
          return result;
        })();
        return await Promise.race([capture, failure]);
      } catch (error) {
        primaryError = error;
        throw error;
      } finally {
        finished = true;
        cancelSchedule(timer);
        chromeApi.debugger.onEvent.removeListener(onFrame);
        let cleanupTimer;
        try {
          await Promise.race([
            chromeApi.debugger.sendCommand(target, "Page.stopScreencast", {}),
            new Promise((_, reject) => {
              cleanupTimer = schedule(
                () => reject(new BridgeError("SCREENCAST_STOP_TIMEOUT")),
                250,
              );
            }),
          ]);
        } catch (error) {
          if (!primaryError) throw error;
        } finally {
          cancelSchedule(cleanupTimer);
        }
      }
    }

    function waitForMainContext(record) {
      if (Number.isInteger(record.mainContextId))
        return Promise.resolve(record.mainContextId);
      return new Promise((resolve, reject) => {
        const timer = schedule(() => {
          record.contextWaiters = record.contextWaiters.filter(
            (waiter) => waiter.timer !== timer,
          );
          reject(new BridgeError("MAIN_CONTEXT_UNAVAILABLE"));
        }, 1_500);
        record.contextWaiters.push({ timer, resolve, reject });
      });
    }

    function resolveContextWaiters(record, contextId) {
      if (!record.contextWaiters) return;
      const waiters = record.contextWaiters.splice(0);
      for (const waiter of waiters) {
        cancelSchedule(waiter.timer);
        if (Number.isInteger(contextId)) waiter.resolve(contextId);
        else waiter.reject(new BridgeError("MAIN_CONTEXT_UNAVAILABLE"));
      }
    }

    function rememberOwnershipFailure(record, stage, code, epoch) {
      // WHY: an orphan survived a successful close, but the old receipt could
      // not distinguish rejected adoption from failed removal. Retain only
      // already-owned identities and fixed local classifications, never raw
      // Chrome errors, URLs, page data, or unrelated/missing-opener events.
      // This bounded, best-effort evidence grants no ownership or retry power.
      if (typeof epoch !== "string" || !REQUEST_ID.test(epoch)) return;
      ownershipFailures.push({
        connectionEpoch: epoch,
        tabId: record.tabId,
        chromeTabId: record.chromeTabId,
        openerTabId: record.openerTabId || null,
        stage,
        code,
      });
      if (ownershipFailures.length > MAX_OWNERSHIP_FAILURES) {
        ownershipFailures.shift();
        ownershipFailureDropped = Math.min(Number.MAX_SAFE_INTEGER, ownershipFailureDropped + 1);
      }
      ownershipFailureRevision += 1;
      persistOwnershipFailures();
    }

    function persistOwnershipFailures() {
      if (ownershipFailureWrite || !chromeApi.storage.session) return;
      // One coalesced write owner, separate from lifecycle persistence/quotas.
      let written;
      let failed = false;
      ownershipFailureWrite = Promise.resolve().then(async () => {
        do {
          written = ownershipFailureRevision;
          await chromeApi.storage.session.set({
            [OWNERSHIP_FAILURE_STORAGE_KEY]: {
              dropped: ownershipFailureDropped,
              entries: [...ownershipFailures],
            },
          });
        } while (written !== ownershipFailureRevision);
      }).catch(() => { failed = true; }).finally(() => {
        ownershipFailureWrite = null;
        // A failure arriving between the last write and this completion still
        // needs a write; a rejected storage call itself is never retried here.
        if (!failed && written !== ownershipFailureRevision) persistOwnershipFailures();
      });
    }

    async function retireOwnedRecord(record) {
      if (record.physical.members.size > 1) {
        // Leaving retires this participant, not the user's physical tab, its
        // main world, object groups, or the other participant's subscriptions.
        removeRecord(record);
        await persistOwnership();
        return { closed: false, detached: true };
      }
      const wasAttached = record.attached;
      const epoch = sessionEpochs.get(record.session);
      retiringTabIds.add(record.chromeTabId);
      try {
        const mayCloseTab = record.createdByExtension === true;
        // WHY: Claiming the user's current tab grants temporary debugger ownership,
        // never destructive ownership. Only a tab created by this extension may reach
        // chrome.tabs.remove; root/descendant/rebind labels cannot upgrade that right.
        if (mayCloseTab) {
          // Chrome's tabs.remove reply follows WebContentsDestroyed. Do not
          // detach first: a rejected removal must retain a usable owner, not
          // fabricate closed:true or guess whether a failed detach succeeded.
          closingTabIds.add(record.chromeTabId);
          try {
            await chromeApi.tabs.remove(record.chromeTabId);
          } catch (error) {
            // Chromium ExtensionTabUtil::kTabNotFoundError is exact-ID absence,
            // not a catch-all for permission, dragging, or transport failures.
            if (!confirmedClosedTabIds.has(record.chromeTabId) &&
                error?.message !== `No tab with id: ${record.chromeTabId}.`) {
              rememberOwnershipFailure(record, "tabs.remove", "TAB_REMOVE_FAILED", epoch);
              await persistOwnership();
              throw new BridgeError("TAB_REMOVE_FAILED");
            }
          } finally {
            closingTabIds.delete(record.chromeTabId);
            confirmedClosedTabIds.delete(record.chromeTabId);
          }
        } else if (record.attached) {
          try {
            await chromeApi.debugger.detach({ tabId: record.chromeTabId });
          } catch {
            rememberOwnershipFailure(record, "debugger.detach", "TAB_DETACH_FAILED", epoch);
            await persistOwnership();
            throw new BridgeError("TAB_DETACH_FAILED");
          }
          record.attached = false;
          record.validated = false;
          record.mainFrameId = null;
          record.mainContextId = null;
        }
        removeRecord(record);
        await persistOwnership();
        return {
          closed: mayCloseTab,
          detached: wasAttached || !mayCloseTab,
        };
      } finally {
        retiringTabIds.delete(record.chromeTabId);
      }
    }

    async function closeTab(args, requestEpoch) {
      const record = recordForWire(args.session, args.tabId, requestEpoch);
      const disposition = await retireOwnedRecord(record);
      const closedWindowIds = await cleanupOwnedWindow();
      return {
        closedTabIds: disposition.closed ? [record.tabId] : [],
        detachedTabIds: disposition.detached ? [record.tabId] : [],
        closedWindowIds,
      };
    }

    async function closeSession(args, requestEpoch) {
      const session = assertSession(args.session);
      if (
        sessions.has(session) &&
        sessionEpochs.get(session) !== requestEpoch
      ) {
        throw new BridgeError("REBIND_REQUIRED");
      }
      if (
        !Array.isArray(args.tabIds) ||
        args.tabIds.some((value) => typeof value !== "string")
      ) {
        throw new BridgeError("INVALID_ARGS");
      }
      const expected = [...(sessions.get(session) || new Set())].sort();
      const requested = [...new Set(args.tabIds)].sort();
      const requestedSet = new Set(requested);
      if (
        requested.length !== args.tabIds.length ||
        expected.some((value) => !requestedSet.has(value))
      ) {
        throw new BridgeError("OWNERSHIP_MISMATCH");
      }
      // WHY: onDetach/tabs.onRemoved can revoke a requested root before the
      // broker's exact close arrives. Stale requested handles grant no power;
      // every handle still owned by this session must nevertheless be present,
      // so omitting a live descendant continues to fail closed.
      const closedTabIds = [];
      const detachedTabIds = [];
      retiringSessions.add(session);
      try {
        // Preserve the inventory/rebind root if any descendant fails removal.
        const retirementOrder = [...expected].sort((a, b) =>
          Number(Boolean(tabsByHandle.get(a)?.root)) -
          Number(Boolean(tabsByHandle.get(b)?.root)));
        for (const tabId of retirementOrder) {
          const record = tabsByHandle.get(tabId);
          if (!record) continue;
          const disposition = await retireOwnedRecord(record);
          if (disposition.detached) detachedTabIds.push(tabId);
          if (disposition.closed) closedTabIds.push(tabId);
        }
      } finally {
        retiringSessions.delete(session);
      }
      // WHY: Removing the last Chrome window can tear down this MV3/native port
      // before the session.close response reaches the broker. Retire task tabs
      // here, then let the broker commit its ledger before requesting window
      // cleanup as a separate best-effort operation.
      return { closedTabIds, detachedTabIds, closedWindowIds: [] };
    }

    async function cleanupWindow(args) {
      if (Object.keys(args).length !== 0) {
        throw new BridgeError("INVALID_ARGS");
      }
      return { closedWindowIds: await cleanupOwnedWindow() };
    }

    function rebindSession(args, requestEpoch) {
      const session = assertSession(args.session);
      if (retiringSessions.has(session)) {
        throw new BridgeError("SESSION_RETIRING");
      }
      if (typeof args.rootTabId !== "string" || !Array.isArray(args.tabIds)) {
        throw new BridgeError("INVALID_ARGS");
      }
      if (args.tabIds.some((value) => typeof value !== "string")) {
        throw new BridgeError("INVALID_ARGS");
      }
      const expected = [...(sessions.get(session) || new Set())].sort();
      const supplied = [...new Set(args.tabIds)].sort();
      const root = tabsByHandle.get(args.rootTabId);
      // WHY: Reconnect may rebind only the exact extension-retained set. A missing,
      // extra, or different root remains stale and can never trigger discovery/adoption.
      if (
        !root ||
        root.session !== session ||
        !root.root ||
        supplied.length !== args.tabIds.length ||
        expected.length !== supplied.length ||
        expected.some((value, index) => value !== supplied[index])
      ) {
        throw new BridgeError("OWNERSHIP_MISMATCH");
      }
      sessionEpochs.set(session, requestEpoch);
      return descriptor(root);
    }

    async function cleanupOwnedWindow() {
      if (!ownedWindow) return [];
      const exactWindow = ownedWindow;
      for (const record of tabsByHandle.values()) {
        if (record.chromeWindowId === exactWindow.chromeWindowId) return [];
      }

      let exactTabs;
      try {
        exactTabs = await chromeApi.tabs.query({
          windowId: exactWindow.chromeWindowId,
        });
      } catch {
        windowHandles.delete(exactWindow.chromeWindowId);
        ownedWindow = null;
        await persistOwnership();
        return [];
      }
      const ids = new Set(
        exactTabs
          .filter((tab) => Number.isInteger(tab.id))
          .map((tab) => tab.id),
      );
      const hasForeignTab = [...ids].some(
        (id) => id !== exactWindow.sentinelTabId,
      );
      exactWindow.contaminated = exactWindow.contaminated || hasForeignTab;
      let closedWindowIds = [];
      if (!exactWindow.contaminated && ids.has(exactWindow.sentinelTabId)) {
        // WHY: Whole-window removal is allowed only while every remaining tab is the
        // sentinel created with this exact window. A cross-window/user tab vetoes it.
        try {
          await chromeApi.windows.remove(exactWindow.chromeWindowId);
          closedWindowIds = [exactWindow.windowId];
        } catch {
          // If Chrome did not confirm removal, never later treat it as a user window.
          exactWindow.contaminated = true;
        }
      } else if (ids.has(exactWindow.sentinelTabId)) {
        try {
          await chromeApi.tabs.remove(exactWindow.sentinelTabId);
        } catch {
          // Remove only the extension-owned sentinel; never the foreign tab/window.
        }
      }
      if (exactWindow.contaminated) {
        // WHY: Once a foreign tab enters this window, relinquishing it makes it a
        // user surface. Quarantine prevents a later create from silently reusing it.
        quarantinedWindowIds.add(exactWindow.chromeWindowId);
      }
      windowHandles.delete(exactWindow.chromeWindowId);
      ownedWindow = null;
      await persistOwnership();
      return closedWindowIds;
    }

    function inventory(args) {
      if (Object.keys(args).length !== 0) throw new BridgeError("INVALID_ARGS");
      const sessionItems = [...sessions.entries()]
        .map(([session, handles]) => {
          const tabIds = [...handles].sort();
          const root = tabIds
            .map((handle) => tabsByHandle.get(handle))
            .find((record) => record && record.root);
          if (!root) return null;
          const current = sessionCurrentTabs.get(session);
          return {
            session,
            currentTab: current && handles.has(current) ? current : root.tabId,
            rootTabId: root.tabId,
            tabIds,
            windowId: root.windowId,
            ownedWindow: root.ownedWindow,
            claimedCurrentTab: root.createdByExtension !== true,
          };
        })
        .filter(Boolean)
        .sort((left, right) => left.session.localeCompare(right.session));
      return { sessions: sessionItems };
    }

    function liveAdoptionSource(record, epoch, root) {
      return Boolean(record && root && ready && epoch === connectionEpoch &&
        sessionEpochs.get(record.session) === epoch &&
        tabsByHandle.get(record.tabId) === record && tabsByHandle.get(root.tabId) === root &&
        root.root && root.session === record.session && root.createdByExtension &&
        record.createdByExtension && !root.sharedUserTab && !record.sharedUserTab &&
        record.attached && record.validated && root.attached && root.validated &&
        !retiringSessions.has(record.session) && !retiringTabIds.has(record.chromeTabId));
    }

    function adoptDescendant(details) {
      const epoch = connectionEpoch;
      if (!ready || !epoch || !details ||
          !Number.isInteger(details.tabId) || details.tabId < 0 ||
          !Number.isInteger(details.sourceTabId) || details.sourceTabId < 0 ||
          !Number.isInteger(details.sourceFrameId) || details.sourceFrameId < 0 ||
          details.tabId === details.sourceTabId ||
          handlesByChromeTab.has(details.tabId) || pendingAdoptions.has(details.tabId)) return;
      const opener = tabsByHandle.get(handlesByChromeTab.get(details.sourceTabId));
      const predecessor = pendingAdoptions.get(details.sourceTabId);
      const root = predecessor?.root || [...(sessions.get(opener?.session) || [])]
        .map((handle) => tabsByHandle.get(handle)).find((record) => record?.root);
      const session = predecessor?.session || opener?.session;
      // WHY: A real background page's popup received the active tab's
      // tabs.Tab.openerTabId, not its creating page. Chromium webNavigation
      // sourceTabId/sourceFrameId identify the actual source WebContents/frame.
      // Never adopt from tabs.onCreated, active-tab order, URL or event timing.
      // A shared/user page still cannot identify which participant caused it.
      if (predecessor ? predecessor.epoch !== epoch ||
          !liveAdoptionSource(root, epoch, root) : !liveAdoptionSource(opener, epoch, root)) return;
      const pendingCount = [...pendingAdoptions.values()].filter((entry) => entry.session === session).length;
      if ((sessions.get(session)?.size || 0) + pendingCount >= MAX_TABS_PER_SESSION) return;
      const pending = { session, epoch, root, task: null };
      pendingAdoptions.set(details.tabId, pending);
      pending.task = (async () => {
        await stateReady;
        // A nested popup may arrive while its proven parent's attachment is
        // pending. Wait only for that exact source edge; unrelated tabs cannot
        // acquire authority by appearing later or by sharing the same window.
        const source = predecessor ? await predecessor.task : opener;
        if (!liveAdoptionSource(source, epoch, root)) return;
        const [sourceTab, tab] = await Promise.all([
          chromeApi.tabs.get(details.sourceTabId), chromeApi.tabs.get(details.tabId),
        ]);
        if (!liveAdoptionSource(source, epoch, root) ||
            sourceTab?.id !== source.chromeTabId || sourceTab.windowId !== source.chromeWindowId ||
            sourceTab.incognito || sourceTab.discarded ||
            !tab || tab.id !== details.tabId || !Number.isInteger(tab.windowId) ||
            tab.incognito || tab.discarded || handlesByChromeTab.has(tab.id) ||
            (typeof sourceTab.url === "string" && !isAllowedTargetUrl(sourceTab.url)) ||
            (typeof tab.url === "string" && !isAllowedTargetUrl(tab.url)) ||
            (typeof tab.pendingUrl === "string" && !isAllowedTargetUrl(tab.pendingUrl))) return;
        return adoptValidatedDescendant(tab, source, epoch, root);
      })().catch(() => undefined).finally(() => {
        if (pendingAdoptions.get(details.tabId) === pending) pendingAdoptions.delete(details.tabId);
      });
      return pending.task;
    }

    async function adoptValidatedDescendant(tab, opener, adoptionEpoch, root) {
      if (!liveAdoptionSource(opener, adoptionEpoch, root)) return;
      const ownedTabs = sessions.get(opener.session);
      if (!ownedTabs || ownedTabs.size >= MAX_TABS_PER_SESSION) return;
      const record = ownedRecord(
        {
          tabId: opaque("tab"),
          chromeTabId: tab.id,
          chromeWindowId: tab.windowId,
          windowId: windowHandleFor(tab.windowId),
          ownedWindow: Boolean(
            ownedWindow && tab.windowId === ownedWindow.chromeWindowId,
          ),
          session: opener.session,
          root: false,
          openerTabId: opener.tabId,
          creationEpoch: adoptionEpoch,
          attached: false,
          validated: false,
          mainFrameId: null,
          mainContextId: null,
          contextWaiters: [],
        },
        true,
      );
      addRecord(record);
      try {
        await attachAndValidate(record, (stage, code) =>
          rememberOwnershipFailure(record, stage, code, adoptionEpoch));
        if (!liveAdoptionSource(opener, adoptionEpoch, root) ||
            tabsByHandle.get(record.tabId) !== record) throw new BridgeError("STALE_CONNECTION");
        await persistOwnership();
        if (!liveAdoptionSource(opener, adoptionEpoch, root) ||
            tabsByHandle.get(record.tabId) !== record) throw new BridgeError("STALE_CONNECTION");
        postEvent(record, "AgentBrowser.tabAdopted", {
          tabId: record.tabId,
          openerTabId: opener.tabId,
        });
        return record;
      } catch {
        if (record.attached) {
          try { await chromeApi.debugger.detach({ tabId: record.chromeTabId }); } catch {}
          record.attached = false;
          record.validated = false;
        }
        if (ownedWindow && record.chromeWindowId === ownedWindow.chromeWindowId) {
          ownedWindow.contaminated = true;
        }
        removeRecord(record);
        await persistOwnership();
        await cleanupOwnedWindow();
      }
    }
    async function handleTabAttached(chromeTabId, attachInfo) {
      await stateReady;
      const handle = handlesByChromeTab.get(chromeTabId);
      const record = handle && tabsByHandle.get(handle);
      if (
        !record ||
        !attachInfo ||
        attachInfo.newWindowId === record.chromeWindowId
      )
        return;
      if (record.attached) {
        try {
          await chromeApi.debugger.detach({ tabId: record.chromeTabId });
        } catch {
          // User movement may already detach the target.
        }
      }
      postEvent(record, "AgentBrowser.tabRevoked", {
        reason: "cross_window_move",
      });
      removePhysicalRecords(record);
      await persistOwnership();
      await cleanupOwnedWindow();
    }

    async function handleTabRemoved(chromeTabId) {
      const extensionClosing = closingTabIds.has(chromeTabId);
      if (extensionClosing) confirmedClosedTabIds.add(chromeTabId);
      await stateReady;
      const handle = handlesByChromeTab.get(chromeTabId);
      const record = handle && tabsByHandle.get(handle);
      if (!record) return;
      if (!extensionClosing) {
        postEvent(record, "AgentBrowser.tabRevoked", { reason: "tab_closed" });
      }
      removePhysicalRecords(record);
      await persistOwnership();
      if (!extensionClosing) await cleanupOwnedWindow();
    }

    async function handleWindowRemoved(chromeWindowId) {
      await stateReady;
      const wasQuarantined = quarantinedWindowIds.delete(chromeWindowId);
      const removedRecords = [...tabsByHandle.values()].filter(
        (record) => record.chromeWindowId === chromeWindowId,
      );
      for (const record of removedRecords) {
        if (!tabsByHandle.has(record.tabId)) continue;
        if (closingTabIds.has(record.chromeTabId))
          confirmedClosedTabIds.add(record.chromeTabId);
        if (
          !closingTabIds.has(record.chromeTabId) &&
          !retiringTabIds.has(record.chromeTabId)
        ) {
          postEvent(record, "AgentBrowser.tabRevoked", {
            reason: "window_closed",
          });
        }
        // Removing synchronously makes tabs.onRemoved/onDetach ordering
        // idempotent: whichever Chrome callback reaches this record first is
        // the sole revocation emitter.
        removePhysicalRecords(record);
      }
      windowHandles.delete(chromeWindowId);
      const removedOwnedWindow =
        ownedWindow?.chromeWindowId === chromeWindowId;
      if (removedOwnedWindow) ownedWindow = null;
      if (wasQuarantined || removedOwnedWindow || removedRecords.length > 0) {
        await persistOwnership();
      }
    }

    function debuggerRecord(source) {
      if (
        !source ||
        Object.hasOwn(source, "sessionId") ||
        !Number.isInteger(source.tabId)
      )
        return null;
      const handle = handlesByChromeTab.get(source.tabId);
      return handle ? tabsByHandle.get(handle) || null : null;
    }

    function diagnosticText(value, budget) {
      const text = value.slice(0, budget.remaining);
      budget.remaining -= text.length;
      if (text.length !== value.length) budget.truncated = true;
      return text;
    }

    function diagnosticArgument(arg, budget) {
      if (!isObject(arg) || typeof arg.type !== "string") {
        budget.truncated = true;
        return { type: "string", value: "[unsupported console argument]" };
      }
      const result = { type: arg.type.slice(0, 32) };
      if (typeof arg.subtype === "string") result.subtype = arg.subtype.slice(0, 32);
      if (Object.hasOwn(arg, "value")) {
        if (typeof arg.value === "string") {
          result.value = diagnosticText(arg.value, budget);
        } else if (
          arg.value === null ||
          typeof arg.value === "boolean" ||
          (typeof arg.value === "number" && Number.isFinite(arg.value))
        ) {
          result.value = arg.value;
        } else {
          budget.truncated = true;
        }
      }
      for (const key of ["description", "unserializableValue"]) {
        if (typeof arg[key] === "string")
          result[key] = diagnosticText(arg[key], budget);
      }
      if (isObject(arg.preview) && Array.isArray(arg.preview.properties)) {
        const properties = arg.preview.properties;
        const overflow =
          arg.preview.overflow === true ||
          properties.length > MAX_DIAGNOSTIC_PREVIEW_PROPERTIES;
        if (overflow) budget.truncated = true;
        result.preview = {
          overflow,
          properties: properties
            .slice(0, MAX_DIAGNOSTIC_PREVIEW_PROPERTIES)
            .filter(isObject)
            .map((property) => {
              const projected = {};
              for (const key of ["name", "type", "value"]) {
                if (typeof property[key] === "string")
                  projected[key] = diagnosticText(property[key], budget);
              }
              return projected;
            }),
        };
        if (typeof arg.preview.subtype === "string")
          result.preview.subtype = arg.preview.subtype.slice(0, 32);
      }
      // Never forward object handles, nested values, stackTrace or custom previews.
      return result;
    }

    function diagnosticParams(method, params) {
      if (!isObject(params) || !Number.isFinite(params.timestamp)) return null;
      const budget = { remaining: MAX_DIAGNOSTIC_TEXT_CHARS, truncated: false };
      if (method === "Runtime.consoleAPICalled") {
        if (
          typeof params.type !== "string" ||
          params.type.length < 1 ||
          params.type.length > 32 ||
          !Array.isArray(params.args)
        ) return null;
        const args = params.args.slice(0, MAX_DIAGNOSTIC_ARGS)
          .map((arg) => diagnosticArgument(arg, budget));
        if (params.args.length > MAX_DIAGNOSTIC_ARGS) budget.truncated = true;
        if (budget.truncated) args.push({ type: "string", value: DIAGNOSTIC_TRUNCATION });
        return {
          type: params.type,
          args,
          executionContextId: params.executionContextId,
          timestamp: params.timestamp,
        };
      }
      const details = params.exceptionDetails;
      if (!isObject(details) || typeof details.text !== "string") return null;
      const exceptionDetails = {
        text: diagnosticText(details.text, budget),
        executionContextId: details.executionContextId,
      };
      for (const key of ["exceptionId", "lineNumber", "columnNumber"]) {
        if (Number.isSafeInteger(details[key]) && details[key] >= 0)
          exceptionDetails[key] = details[key];
      }
      if (isObject(details.exception))
        exceptionDetails.exception = diagnosticArgument(details.exception, budget);
      if (budget.truncated) {
        exceptionDetails.text += " " + DIAGNOSTIC_TRUNCATION;
        // The pinned consumer prefers exception.description over details.text.
        if (typeof exceptionDetails.exception?.description === "string")
          exceptionDetails.exception.description += " " + DIAGNOSTIC_TRUNCATION;
      }
      return { timestamp: params.timestamp, exceptionDetails };
    }

    async function handleDebuggerEvent(source, method, params) {
      const eventEpoch = connectionEpoch;
      await stateReady;
      const record = debuggerRecord(source);
      if (!record || !record.attached) return;
      if (DIAGNOSTIC_EVENTS.has(method)) {
        // WHY: discarding root Runtime events leaves console/errors empty.
        // Keep only this epoch's validated root/default main world;
        // child sessions, opener descendants and unidentified contexts gain no authority.
        const contextId = method === "Runtime.consoleAPICalled"
          ? params?.executionContextId
          : params?.exceptionDetails?.executionContextId;
        if (
          !record.root || !record.validated ||
          !eventEpoch || eventEpoch !== connectionEpoch ||
          ![...record.physical.members].some((member) => sessionEpochs.get(member.session) === eventEpoch) ||
          !Number.isInteger(record.mainContextId) ||
          contextId !== record.mainContextId
        ) return;
        const projected = diagnosticParams(method, params);
        if (projected) postEvent(record, method, projected);
        return;
      }
      if (method === "Runtime.executionContextCreated") {
        const context = params && params.context;
        const aux = context && context.auxData;
        if (
          context &&
          Number.isInteger(context.id) &&
          aux &&
          aux.isDefault === true &&
          aux.frameId === record.mainFrameId
        ) {
          record.mainContextId = context.id;
          resolveContextWaiters(record, context.id);
        }
        return;
      }
      if (method === "Runtime.executionContextsCleared") {
        record.mainContextId = null;
        return;
      }
      if (method === "Page.frameNavigated") {
        const frame = params && params.frame;
        if (!frame || frame.parentId) return;
        if (!isAllowedTargetUrl(frame.url)) {
          await revokeUnsafeTarget(record);
          return;
        }
        record.mainFrameId = frame.id;
        record.mainContextId = null;
        return;
      }
      if (FORWARDED_PAGE_EVENTS.has(method)) {
        postEvent(record, method, {
          timestamp: Number(params && params.timestamp) || 0,
        });
        return;
      }
      if (
        method === "Page.lifecycleEvent" &&
        params &&
        params.frameId === record.mainFrameId &&
        SAFE_LIFECYCLE_NAMES.has(params.name)
      ) {
        postEvent(record, method, {
          name: params.name,
          timestamp: Number(params.timestamp) || 0,
        });
      }
    }

    async function revokeUnsafeTarget(record) {
      if (!tabsByHandle.has(record.tabId)) return;
      postEvent(record, "AgentBrowser.tabRevoked", { reason: "target_denied" });
      if (record.attached) {
        record.attached = false;
        try {
          await chromeApi.debugger.detach({ tabId: record.chromeTabId });
        } catch {
          // Chrome may have detached first when the target changed type.
        }
      }
      if (ownedWindow && record.chromeWindowId === ownedWindow.chromeWindowId) {
        ownedWindow.contaminated = true;
      }
      removePhysicalRecords(record);
      await persistOwnership();
      await cleanupOwnedWindow();
    }

    async function handleDebuggerDetach(source) {
      // WHY: chrome.debugger.onDetach may arrive before detach() resolves. A
      // deliberate close already owns retirement; letting this callback race it
      // can remove the last window before session.close has acknowledged.
      const expectedRetirement =
        Number.isInteger(source?.tabId) && retiringTabIds.has(source.tabId);
      await stateReady;
      if (
        expectedRetirement ||
        (Number.isInteger(source?.tabId) && retiringTabIds.has(source.tabId))
      ) {
        return;
      }
      const record = debuggerRecord(source);
      if (!record) return;
      record.attached = false;
      record.validated = false;
      record.mainFrameId = null;
      record.mainContextId = null;
      postEvent(record, "AgentBrowser.tabRevoked", {
        reason: "debugger_detached",
      });
      if (ownedWindow && record.chromeWindowId === ownedWindow.chromeWindowId) {
        ownedWindow.contaminated = true;
      }
      removePhysicalRecords(record);
      await persistOwnership();
      await cleanupOwnedWindow();
    }

    function postEvent(record, method, params) {
      for (const member of record.physical.members) {
        const domain = method.split(".")[0];
        if (domain === "AgentBrowser" || member.subscriptions.has(domain))
          postParticipantEvent(member, method, params);
      }
    }

    function postParticipantEvent(record, method, params) {
      if (!port || !connectionEpoch || !ready) return;
      if (sessionEpochs.get(record.session) !== connectionEpoch) return;
      const now = clock();
      const diagnostic = DIAGNOSTIC_EVENTS.has(method);
      if (diagnostic) {
        // WHY: diagnostic floods must not consume lifecycle/tab-revocation
        // capacity or another root's budget. Excess events are dropped, not queued.
        // Projection bounds text/args/previews and marks truncated retained data;
        // this is bounded recent diagnostics, never a complete logging archive.
        if (
          record.diagnosticEpoch !== connectionEpoch ||
          now - record.diagnosticWindowStartedAt >= EVENT_WINDOW_MS
        ) {
          record.diagnosticEpoch = connectionEpoch;
          record.diagnosticWindowStartedAt = now;
          record.diagnosticCount = 0;
        }
        if (record.diagnosticCount >= MAX_DIAGNOSTIC_EVENT_BURST) return;
      } else {
        if (now - eventWindowStartedAt >= EVENT_WINDOW_MS) {
          eventWindowStartedAt = now;
          eventCount = 0;
        }
        if (eventCount >= MAX_EVENT_BURST) return;
      }
      const message = {
        schema: SCHEMA,
        type: "event",
        profileKey,
        connectionEpoch,
        tabId: record.tabId,
        method,
        params,
      };
      try {
        assertExtensionToHostWireSize(message);
        port.postMessage(message);
        if (diagnostic) record.diagnosticCount += 1;
        else eventCount += 1;
      } catch {
        // Oversize or disconnected events are dropped; inventory remains authoritative.
      }
    }

    function start() {
      if (started) return;
      started = true;
      chromeApi.alarms.onAlarm.addListener(
        (alarm) => void handleReconnectAlarm(alarm),
      );
      chromeApi.runtime.onStartup.addListener(() => void ensureConnected());
      chromeApi.runtime.onInstalled.addListener(() => void ensureConnected());
      chromeApi.action?.onClicked.addListener(() => void handleActionClick());
      // Missing optional API is not permission to revive opener-based adoption.
      chromeApi.webNavigation?.onCreatedNavigationTarget?.addListener(
        (details) => void adoptDescendant(details),
      );
      chromeApi.tabs.onAttached.addListener(
        (tabId, info) => void handleTabAttached(tabId, info),
      );
      chromeApi.tabs.onRemoved.addListener(
        (tabId) => void handleTabRemoved(tabId),
      );
      chromeApi.windows.onRemoved.addListener(
        (windowId) => void handleWindowRemoved(windowId),
      );
      chromeApi.debugger.onEvent.addListener((source, method, params) => {
        void handleDebuggerEvent(source, method, params);
      });
      chromeApi.debugger.onDetach.addListener(
        (source) => void handleDebuggerDetach(source),
      );
      // Top-level connection plus both lifecycle hooks share one in-flight owner.
      void ensureConnected();
    }

    return {
      start,
      ensureConnected,
      _test: {
        get profileKey() {
          return profileKey;
        },
        get connectionEpoch() {
          return connectionEpoch;
        },
        get port() {
          return port;
        },
        get reconnectAttempt() {
          return reconnectAttempt;
        },
        get enrollmentChallenge() {
          return enrollmentChallenge;
        },
        get enrollmentId() {
          return enrollmentId;
        },
        inventory: () => inventory({}),
        settle: async () => {
          await stateReady;
          await Promise.all([...pendingAdoptions.values()].map((entry) => entry.task));
          await Promise.all(
            [...requestQueues.values()].map((task) =>
              task.catch(() => undefined),
            ),
          );
          await persistenceQueue.catch(() => undefined);
          await ownershipFailureWrite?.catch(() => undefined);
          await reconnectAlarmTask.catch(() => undefined);
          await enrollmentActionTask.catch(() => undefined);
        },
      },
    };
  }

  if (globalThis.__AGENT_BROWSER_EXTENSION_TEST__) {
    globalThis.__agentBrowserExtensionContract = {
      createBridge,
      constants: {
        SCHEMA,
        HOST_NAME,
        MAX_HOST_TO_EXTENSION_MESSAGE_BYTES,
        MAX_EXTENSION_TO_HOST_MESSAGE_BYTES,
        RECONNECT_DELAYS_MS: [...RECONNECT_DELAYS_MS],
        RECONNECT_ALARM_NAME,
        RECONNECT_ALARM_INTERVAL_MINUTES,
        ENROLLMENT_ACTION_STORAGE_KEY,
        ENROLLMENT_ACTION_TTL_MS,
      },
    };
  }

  if (
    !globalThis.__AGENT_BROWSER_EXTENSION_NO_AUTOSTART__ &&
    globalThis.chrome &&
    globalThis.chrome.runtime
  ) {
    createBridge(globalThis.chrome).start();
  }
})();
