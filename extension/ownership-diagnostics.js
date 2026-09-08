"use strict";

(async () => {
  const KEYS = ["agentBrowserOwnershipFailuresV1", "agentBrowserOwnershipV1"];
  const MAX_BYTES = 64 * 1024;
  const HEX = /^[a-f0-9]{64}$/;
  const TAB = /^tab_[a-f0-9]{64}$/;
  const WINDOW = /^window_[a-f0-9]{64}$/;
  const SESSION = /^[A-Za-z0-9_-]{1,128}$/;
  const STAGES = new Set(["debugger.attach", "Page.getFrameTree", "target.validate",
    "Emulation.setFocusEmulationEnabled", "Page.enable", "Runtime.enable",
    "tabs.remove", "debugger.detach"]);
  const CODES = new Set(["OPERATION_FAILED", "TARGET_DENIED", "TAB_REMOVE_FAILED", "TAB_DETACH_FAILED"]);
  const output = document.getElementById("ownership-diagnostics");
  const base = { schema: "agent-browser.ownership-observation.v1",
    scope: "persisted-metadata-not-physical-absence", capturedAt: null, extensionId: null };

  // R74 WHY: JS WindowProxy.opener and missing failure storage cannot identify
  // the actual Chrome tabs.onCreated opener edge. Observe that delivered event
  // before any worker adoption, in this extension page/profile only. The capture
  // grants no tab authority and never writes storage or sends worker/CDP messages.
  const tabCreation = { status: "arming", listenerArmed: false, armedAt: null,
    deadlineAt: null, stoppedAt: null, limit: 16, events: [] };
  let tabCreationTimer = null;
  let lastDisplayed = null;
  function tabCreationView() {
    return { ...tabCreation, events: tabCreation.events.map((event) => ({ ...event })) };
  }
  function stopTabCreation(reason) {
    if (tabCreation.status !== "armed") return;
    chrome.tabs.onCreated.removeListener(onTabCreated);
    clearTimeout(tabCreationTimer);
    tabCreation.status = reason;
    tabCreation.listenerArmed = false;
    tabCreation.stoppedAt = new Date().toISOString();
    if (lastDisplayed) display(lastDisplayed);
  }
  function onTabCreated(tab) {
    if (tabCreation.status !== "armed") return;
    if (Date.now() >= Date.parse(tabCreation.deadlineAt)) {
      stopTabCreation("deadline");
      return;
    }
    if (!tab || !number(tab.id) || !number(tab.windowId) ||
        (tab.openerTabId !== undefined && !number(tab.openerTabId))) {
      stopTabCreation("invalid-event-metadata");
      return;
    }
    // Read/copy only these three numeric fields. Undefined means the delivered
    // optional opener field was absent; null below is not a synthesized owner.
    tabCreation.events.push({ id: tab.id, windowId: tab.windowId,
      openerTabId: tab.openerTabId === undefined ? null : tab.openerTabId });
    if (tabCreation.events.length === tabCreation.limit) stopTabCreation("limit");
    else if (lastDisplayed) display(lastDisplayed);
  }
  function armTabCreation() {
    try {
      chrome.tabs.onCreated.addListener(onTabCreated);
      if (!chrome.tabs.onCreated.hasListener(onTabCreated)) throw new Error();
      tabCreation.armedAt = new Date().toISOString();
      tabCreation.deadlineAt = new Date(Date.now() + 60000).toISOString();
      tabCreation.status = "armed";
      tabCreation.listenerArmed = true;
      tabCreationTimer = setTimeout(() => stopTabCreation("deadline"), 60000);
    } catch {
      tabCreation.status = "unavailable";
      tabCreation.listenerArmed = false;
    }
  }

  class InvalidMetadata extends Error {}
  function requireValue(condition) { if (!condition) throw new InvalidMetadata(); }
  function object(value) { return value !== null && typeof value === "object" && !Array.isArray(value); }
  function matches(value, pattern) { return typeof value === "string" && pattern.test(value); }
  function number(value) { return Number.isSafeInteger(value) && value >= 0; }
  function nullable(value, pattern) { return value === null || matches(value, pattern); }

  function failures(value) {
    if (value === undefined) return { status: "missing" };
    requireValue(object(value) && number(value.dropped) &&
      Array.isArray(value.entries) && value.entries.length <= 32);
    return { status: "present", dropped: value.dropped, entries: value.entries.map((entry) => {
      requireValue(object(entry) && matches(entry.connectionEpoch, HEX) &&
        matches(entry.tabId, TAB) && number(entry.chromeTabId) &&
        nullable(entry.openerTabId, TAB) && STAGES.has(entry.stage) && CODES.has(entry.code));
      return { connectionEpoch: entry.connectionEpoch, tabId: entry.tabId,
        chromeTabId: entry.chromeTabId, openerTabId: entry.openerTabId,
        stage: entry.stage, code: entry.code };
    }) };
  }

  function ownership(value) {
    if (value === undefined) return { status: "missing" };
    requireValue(object(value) && Array.isArray(value.tabs) && value.tabs.length <= 16 * 64);
    const tabs = value.tabs.map((entry) => {
      requireValue(object(entry) && matches(entry.tabId, TAB) && number(entry.chromeTabId) &&
        number(entry.chromeWindowId) && matches(entry.windowId, WINDOW) &&
        matches(entry.session, SESSION) && typeof entry.ownedWindow === "boolean" &&
        typeof entry.root === "boolean" && typeof entry.createdByExtension === "boolean" &&
        nullable(entry.openerTabId, TAB) && nullable(entry.creationEpoch, HEX) &&
        (entry.sharedUserTab === undefined || matches(entry.sharedUserTab, TAB)));
      return { tabId: entry.tabId, chromeTabId: entry.chromeTabId,
        chromeWindowId: entry.chromeWindowId, windowId: entry.windowId,
        session: entry.session, ownedWindow: entry.ownedWindow, root: entry.root,
        createdByExtension: entry.createdByExtension,
        ...(entry.sharedUserTab === undefined ? {} : { sharedUserTab: entry.sharedUserTab }),
        openerTabId: entry.openerTabId, creationEpoch: entry.creationEpoch };
    });
    requireValue(new Set(tabs.map((entry) => entry.tabId)).size === tabs.length);
    return { status: "present", totalTabs: tabs.length, tabs };
  }

  function display(value) {
    lastDisplayed = value;
    let encoded = JSON.stringify({ ...value, tabCreationCapture: tabCreationView() }, null, 2);
    if (new TextEncoder().encode(encoded).length > MAX_BYTES) {
      encoded = JSON.stringify({ ...base, tabCreationCapture: tabCreationView(), status: "error", truncated: true,
        error: "OUTPUT_TOO_LARGE", limitBytes: MAX_BYTES,
        note: "No partial inventory returned; absence is unknown." }, null, 2);
    }
    // Text only: even unexpected markup must never become extension-origin HTML.
    output.value = encoded;
  }

  let reading = false;
  async function capture() {
    if (reading) return;
    reading = true;
    try {
    const extensionId = chrome.runtime.id;
    if (!matches(extensionId, /^[a-p]{32}$/)) throw new InvalidMetadata();
    base.extensionId = extensionId;
    // WHY: reloading the extension clears this session evidence. This standalone
    // page reads exactly the existing b04 keys without worker messaging/reload.
    // Persisted snapshots may lag independent worker writes. Missing data, old
    // epochs, or an empty inventory never prove physical removal or current authority.
    const stored = await chrome.storage.session.get(KEYS);
    base.capturedAt = new Date().toISOString();
    requireValue(object(stored));
    const failureBuffer = failures(stored[KEYS[0]]);
    const ownInventory = ownership(stored[KEYS[1]]);
    display({ ...base,
      status: failureBuffer.status === "present" && ownInventory.status === "present" ? "ok" : "partial",
      truncated: false, failures: failureBuffer, ownership: ownInventory });
    } catch (error) {
    base.capturedAt = new Date().toISOString();
    display({ ...base, status: "error", truncated: false,
      error: error instanceof InvalidMetadata ? "STORED_METADATA_INVALID" : "READ_FAILED" });
    } finally {
      reading = false;
    }
  }
  document.getElementById("refresh-ownership-diagnostics").addEventListener("click", capture);
  document.getElementById("stop-tab-creation-capture").addEventListener("click", () => stopTabCreation("stopped"));
  armTabCreation();
  await capture();
})();
