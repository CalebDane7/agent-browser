import { readFileSync, mkdtempSync, writeFileSync, rmSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import vm from "node:vm";
import { describe, expect, it, vi } from "vitest";
import { Broker } from "../scripts/agent-browser-extension-broker.js";
import { resolveInvokingOwner, observeProcessIdentity, ownerSession } from "../scripts/agent-browser-owner.js";
import {
  CONTROL_SCHEMA,
  MAX_CONTROL_MESSAGE_BYTES,
  MAX_EXTENSION_TO_HOST_MESSAGE_BYTES,
  MAX_HOST_TO_EXTENSION_MESSAGE_BYTES,
  PROFILE_CONFIG_SCHEMA,
  boundedError,
  opaqueId,
  sha256,
} from "../scripts/agent-browser-extension-protocol.js";
import * as control from "../scripts/agent-browser-extension-control.js";
import * as supervisor from "../scripts/agent-browser-extension-supervisor.js";

const manifestUrl = new URL("../extension/manifest.json", import.meta.url);
const workerUrl = new URL("../extension/service-worker.js", import.meta.url);
const workerSource = readFileSync(workerUrl, "utf8");
const brokerSource = readFileSync(
  new URL("../scripts/agent-browser-extension-broker.js", import.meta.url),
  "utf8",
);
const stdioSource = readFileSync(
  new URL("../scripts/agent-browser-extension-stdio.js", import.meta.url),
  "utf8",
);
const nativeHostSource = readFileSync(
  new URL("../native-host/agent_browser_native_host.cpp", import.meta.url),
  "utf8",
);
const SCHEMA = "agent-browser.extension-bridge.v1";
const HOST = "com.kaleeb.agent_browser";
const FOCUS_TOKEN = "f".repeat(64);

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

class FakeEvent {
  constructor() {
    this.listeners = [];
  }

  addListener(listener) {
    this.listeners.push(listener);
  }

  removeListener(listener) {
    this.listeners = this.listeners.filter(
      (candidate) => candidate !== listener,
    );
  }

  emit(...args) {
    for (const listener of [...this.listeners]) listener(...args);
  }
}

class FakePort {
  constructor() {
    this.onMessage = new FakeEvent();
    this.onDisconnect = new FakeEvent();
    this.sent = [];
  }

  postMessage(message) {
    this.sent.push(clone(message));
  }

  receive(message) {
    this.onMessage.emit(clone(message));
  }

  disconnect() {
    this.onDisconnect.emit();
  }
}

class FakeTimers {
  constructor() {
    this.nextId = 1;
    this.jobs = [];
  }

  setTimeout = (callback, delay) => {
    const job = { id: this.nextId++, callback, delay, canceled: false };
    this.jobs.push(job);
    return job.id;
  };

  clearTimeout = (id) => {
    const job = this.jobs.find((candidate) => candidate.id === id);
    if (job) job.canceled = true;
  };

  runNext() {
    const job = this.jobs.shift();
    if (!job) return false;
    if (!job.canceled) job.callback();
    return true;
  }

  pending() {
    return this.jobs.filter((job) => !job.canceled).length;
  }
}

function storageArea(map) {
  return {
    async get(keys) {
      if (typeof keys === "string") return { [keys]: clone(map.get(keys)) };
      if (Array.isArray(keys)) {
        return Object.fromEntries(
          keys.map((key) => [key, clone(map.get(key))]),
        );
      }
      return Object.fromEntries(
        [...map.entries()].map(([key, value]) => [key, clone(value)]),
      );
    },
    async set(items) {
      for (const [key, value] of Object.entries(items))
        map.set(key, clone(value));
    },
  };
}

function makeFake({
  windows = [{ id: 10, type: "normal", focused: true, state: "normal" }],
  tabs = [{ id: 1, windowId: 10, active: true, url: "https://example.test/" }],
  storage,
  omitQueryUrls = false,
  emitDetachSynchronously = false,
} = {}) {
  const state = {
    windows: new Map(windows.map((entry) => [entry.id, clone(entry)])),
    tabs: new Map(tabs.map((entry) => [entry.id, clone(entry)])),
    alarms: new Map(),
    nextWindowId: 900,
    nextTabId: 1_000,
  };
  const sharedStorage = storage || { local: new Map(), session: new Map() };
  const events = {
    startup: new FakeEvent(),
    installed: new FakeEvent(),
    tabCreated: new FakeEvent(),
    navigationTargetCreated: new FakeEvent(),
    tabAttached: new FakeEvent(),
    tabRemoved: new FakeEvent(),
    windowRemoved: new FakeEvent(),
    tabActivated: new FakeEvent(),
    windowFocused: new FakeEvent(),
    debuggerEvent: new FakeEvent(),
    debuggerDetach: new FakeEvent(),
    alarm: new FakeEvent(),
    actionClicked: new FakeEvent(),
  };
  const calls = {
    connectNative: [],
    windowsCreate: [],
    windowsRemove: [],
    windowsGetAll: [],
    windowsUpdate: [],
    tabsCreate: [],
    tabsRemove: [],
    tabsGet: [],
    tabsQuery: [],
    tabsUpdate: [],
    debuggerAttach: [],
    debuggerDetach: [],
    debuggerSend: [],
    alarmsGet: [],
    alarmsCreate: [],
    alarmsClear: [],
    actionSetBadgeText: [],
    actionSetTitle: [],
  };
  const ports = [];
  let commandHandler = null;
  let tabCreateBarrier = null;

  function tabResult(tab) {
    const result = clone(tab);
    if (omitQueryUrls) delete result.url;
    return result;
  }

  const chrome = {
    webNavigation: { onCreatedNavigationTarget: events.navigationTargetCreated },
    action: {
      onClicked: events.actionClicked,
      async setBadgeText(details) {
        calls.actionSetBadgeText.push(clone(details));
      },
      async setTitle(details) {
        calls.actionSetTitle.push(clone(details));
      },
    },
    alarms: {
      onAlarm: events.alarm,
      async get(name) {
        calls.alarmsGet.push(name);
        return clone(state.alarms.get(name));
      },
      async create(name, info) {
        calls.alarmsCreate.push({ name, info: clone(info) });
        state.alarms.set(name, { name, ...clone(info) });
      },
      async clear(name) {
        calls.alarmsClear.push(name);
        return state.alarms.delete(name);
      },
    },
    runtime: {
      onStartup: events.startup,
      onInstalled: events.installed,
      connectNative(host) {
        calls.connectNative.push(host);
        const port = new FakePort();
        ports.push(port);
        return port;
      },
      getManifest() {
        return { version: "0.1.0" };
      },
    },
    storage: {
      local: storageArea(sharedStorage.local),
      session: storageArea(sharedStorage.session),
    },
    windows: {
      onRemoved: events.windowRemoved,
      onFocusChanged: events.windowFocused,
      async update(id, updateData) {
        calls.windowsUpdate.push({ id, updateData: clone(updateData) });
        const window = state.windows.get(id);
        if (!window) throw new Error("window missing");
        Object.assign(window, updateData);
        if (updateData.focused) {
          for (const other of state.windows.values()) other.focused = other.id === id;
          events.windowFocused.emit(id);
        }
        return clone(window);
      },
      async getAll(query) {
        calls.windowsGetAll.push(clone(query));
        return [...state.windows.values()]
          .filter(
            (entry) =>
              !query.windowTypes || query.windowTypes.includes(entry.type),
          )
          .map(clone);
      },
      async get(id) {
        const entry = state.windows.get(id);
        if (!entry) throw new Error("window missing");
        return clone(entry);
      },
      async getLastFocused(query) {
        const candidates = [...state.windows.values()].filter(
          (entry) =>
            !query.windowTypes || query.windowTypes.includes(entry.type),
        );
        const focused = candidates.find((entry) => entry.focused);
        if (!focused) throw new Error("no focused window");
        return clone(focused);
      },
      async create(createData) {
        calls.windowsCreate.push(clone(createData));
        const window = {
          id: state.nextWindowId++,
          type: createData.type || "normal",
          focused: Boolean(createData.focused),
          state: createData.state || "normal",
        };
        state.windows.set(window.id, window);
        const tab = {
          id: state.nextTabId++,
          windowId: window.id,
          active: true,
          url: createData.url || "about:blank",
        };
        state.tabs.set(tab.id, tab);
        events.tabCreated.emit(tabResult(tab));
        return clone(window);
      },
      async remove(id) {
        calls.windowsRemove.push(id);
        if (!state.windows.has(id)) throw new Error("window missing");
        state.windows.delete(id);
        for (const [tabId, tab] of [...state.tabs]) {
          if (tab.windowId === id) state.tabs.delete(tabId);
        }
        events.windowRemoved.emit(id);
      },
    },
    tabs: {
      onActivated: events.tabActivated,
      async update(id, updateData) {
        calls.tabsUpdate.push({ id, updateData: clone(updateData) });
        const tab = state.tabs.get(id);
        if (!tab) throw new Error("tab missing");
        Object.assign(tab, updateData);
        if (updateData.active) {
          for (const other of state.tabs.values()) {
            if (other.windowId === tab.windowId) other.active = other.id === id;
          }
          events.tabActivated.emit({ tabId: id, windowId: tab.windowId });
        }
        return tabResult(tab);
      },
      onCreated: events.tabCreated,
      onAttached: events.tabAttached,
      onRemoved: events.tabRemoved,
      async create(createData) {
        calls.tabsCreate.push(clone(createData));
        if (tabCreateBarrier) await tabCreateBarrier;
        if (!state.windows.has(createData.windowId))
          throw new Error("window missing");
        const tab = {
          id: state.nextTabId++,
          windowId: createData.windowId,
          active: Boolean(createData.active),
          url: createData.url,
        };
        state.tabs.set(tab.id, tab);
        events.tabCreated.emit(tabResult(tab));
        return tabResult(tab);
      },
      async query(query) {
        calls.tabsQuery.push(clone(query));
        return [...state.tabs.values()]
          .filter(
            (tab) =>
              query.windowId === undefined || tab.windowId === query.windowId,
          )
          .filter(
            (tab) => query.active === undefined || tab.active === query.active,
          )
          .map(tabResult);
      },
      async get(id) {
        calls.tabsGet.push(id);
        const tab = state.tabs.get(id);
        if (!tab) throw new Error("tab missing");
        return tabResult(tab);
      },
      async remove(ids) {
        for (const id of Array.isArray(ids) ? ids : [ids]) {
          calls.tabsRemove.push(id);
          if (!state.tabs.has(id)) throw new Error("tab missing");
          state.tabs.delete(id);
          events.tabRemoved.emit(id, { isWindowClosing: false });
        }
      },
    },
    debugger: {
      onEvent: events.debuggerEvent,
      onDetach: events.debuggerDetach,
      async attach(target, version) {
        calls.debuggerAttach.push({ target: clone(target), version });
        if (!state.tabs.has(target.tabId)) throw new Error("target missing");
      },
      async detach(target) {
        calls.debuggerDetach.push(clone(target));
        if (emitDetachSynchronously) {
          events.debuggerDetach.emit(clone(target), "canceled_by_user");
        }
      },
      async sendCommand(target, method, params) {
        calls.debuggerSend.push({
          target: clone(target),
          method,
          params: clone(params),
        });
        if (commandHandler)
          return commandHandler({ target, method, params, state, events });
        const tab = state.tabs.get(target.tabId);
        if (!tab) throw new Error("target missing");
        const frameId = `frame-${target.tabId}`;
        if (method === "Page.getFrameTree") {
          return { frameTree: { frame: { id: frameId, url: tab.url } } };
        }
        if (method === "Runtime.enable") {
          events.debuggerEvent.emit(
            { tabId: target.tabId },
            "Runtime.executionContextCreated",
            {
              context: {
                id: target.tabId + 50_000,
                auxData: { isDefault: true, frameId },
              },
            },
          );
          return {};
        }
        if (method === "Page.navigate") {
          tab.url = params.url;
          return { frameId };
        }
        if (method === "Runtime.evaluate")
          return { result: { type: "string", value: "ok" } };
        return {};
      },
    },
  };

  return {
    chrome,
    calls,
    events,
    ports,
    state,
    storage: sharedStorage,
    setCommandHandler(handler) {
      commandHandler = handler;
    },
    setTabCreateBarrier(barrier) {
      tabCreateBarrier = barrier;
    },
    addTab(tab, emit = true, sourceTabId) {
      state.tabs.set(tab.id, clone(tab));
      if (emit) events.tabCreated.emit(tabResult(tab));
      if (Number.isInteger(sourceTabId)) events.navigationTargetCreated.emit({
        sourceTabId, sourceFrameId: 0, sourceProcessId: 1,
        tabId: tab.id, url: tab.url, timeStamp: 1_000,
      });
    },
    focus(windowId, tabId) {
      for (const window of state.windows.values())
        window.focused = window.id === windowId;
      for (const tab of state.tabs.values()) {
        if (tab.windowId === windowId) tab.active = tab.id === tabId;
      }
    },
  };
}

function deterministicCrypto() {
  let cursor = 1;
  return {
    getRandomValues(bytes) {
      for (let index = 0; index < bytes.length; index += 1) {
        bytes[index] = cursor++ % 251;
      }
      return bytes;
    },
  };
}

function loadContract() {
  const context = vm.createContext({
    __AGENT_BROWSER_EXTENSION_TEST__: true,
    __AGENT_BROWSER_EXTENSION_NO_AUTOSTART__: true,
    TextEncoder,
    URL,
    console,
    setTimeout,
    clearTimeout,
    crypto: deterministicCrypto(),
  });
  vm.runInContext(workerSource, context, { filename: "service-worker.js" });
  return context.__agentBrowserExtensionContract;
}

async function flush(rounds = 12) {
  for (let index = 0; index < rounds; index += 1) await Promise.resolve();
}

async function bootUnready(
  fake,
  { timers = new FakeTimers(), now = () => 1_000 } = {},
) {
  const contract = loadContract();
  const bridge = contract.createBridge(fake.chrome, {
    crypto: deterministicCrypto(),
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
    now,
  });
  bridge.start();
  await flush();
  await bridge._test.settle();
  await flush();
  const port = fake.ports.at(-1);
  const hello = port.sent.find((message) => message.type === "hello");
  return { bridge, contract, port, hello, timers };
}

async function boot(fake, options = {}) {
  const result = await bootUnready(fake, options);
  const { port, hello } = result;
  port.receive({
    schema: SCHEMA,
    type: "ready",
    profileKey: hello.profileKey,
    connectionEpoch: hello.connectionEpoch,
  });
  await flush();
  return result;
}

let requestCounter = 1;
function requestId() {
  return (requestCounter++).toString(16).padStart(64, "0");
}

async function request(bridge, port, hello, op, args, overrides = {}) {
  const id = overrides.id || requestId();
  port.receive({
    schema: SCHEMA,
    type: "request",
    id,
    profileKey: hello.profileKey,
    connectionEpoch: hello.connectionEpoch,
    op,
    args,
    ...overrides,
  });
  await flush();
  await bridge._test.settle();
  await flush();
  return [...port.sent]
    .reverse()
    .find((message) => message.type === "response" && message.id === id);
}

describe("directional native-message bounds", () => {
  it("keeps every producer and consumer on Chrome's documented direction", () => {
    expect(MAX_HOST_TO_EXTENSION_MESSAGE_BYTES).toBe(1024 * 1024);
    expect(MAX_EXTENSION_TO_HOST_MESSAGE_BYTES).toBe(64 * 1024 * 1024);
    expect(MAX_CONTROL_MESSAGE_BYTES).toBe(64 * 1024);

    expect(brokerSource).toContain(
      "this.buffer.length + chunk.length >\n      MAX_EXTENSION_TO_HOST_MESSAGE_BYTES + 4",
    );
    expect(brokerSource).toContain(
      "payload.length > MAX_HOST_TO_EXTENSION_MESSAGE_BYTES",
    );
    expect(stdioSource).toContain(
      "const fromChrome = new ExactFrameForwarder(\n  MAX_EXTENSION_TO_HOST_MESSAGE_BYTES",
    );
    expect(stdioSource).toContain(
      "const fromBroker = new ExactFrameForwarder(\n  MAX_HOST_TO_EXTENSION_MESSAGE_BYTES",
    );
    expect(stdioSource).not.toMatch(
      /Buffer\.alloc(?:Unsafe)?\(64 \* 1024 \* 1024\)/,
    );
    expect(nativeHostSource).toContain(
      "constexpr uint32_t kFirstFrameLimit = 64U * 1024U;",
    );
    expect(nativeHostSource).toContain(
      "input_context.frame_limit = kExtensionToHostFrameLimit;",
    );
    expect(nativeHostSource).toContain(
      "output_context.frame_limit = kHostToExtensionFrameLimit;",
    );
  });
});

describe("navigation-source popup ownership", () => {
  const nav = (fake, sourceTabId, tabId, sourceFrameId = 0) =>
    fake.events.navigationTargetCreated.emit({
      sourceTabId, sourceFrameId, sourceProcessId: 1, tabId,
      url: "about:blank", timeStamp: 1_000,
    });

  it("uses the creating background source, not the unrelated active opener, through nested adoption and exact close", async () => {
    const fake = makeFake();
    const { bridge, port, hello } = await boot(fake);
    const ask = (op, args) => request(bridge, port, hello, op, args);
    const a = (await ask("tab.create", { session: "popup-a", url: "about:blank" })).result;
    const b = (await ask("tab.create", { session: "popup-b", url: "about:blank" })).result;
    // This mismatch is the literal old red: UI opener points elsewhere while
    // the navigation event names the actual background source.
    fake.addTab({ id: 2001, windowId: 10, active: false, openerTabId: 1001, url: "about:blank" });
    await flush(30); await bridge._test.settle();
    expect(bridge._test.inventory().sessions.map(item => item.tabIds)).toEqual([[a.tabId], [b.tabId]]);
    let release, attachEntered = false;
    const held = new Promise(resolve => { release = resolve; });
    const attach = fake.chrome.debugger.attach;
    fake.chrome.debugger.attach = async (target, version) => {
      if (target.tabId === 2001) { attachEntered = true; await held; }
      return attach(target, version);
    };
    nav(fake, 1000, 2001);
    await flush(30);
    expect(attachEntered).toBe(true);
    fake.addTab({ id: 2002, windowId: 10, active: false, url: "about:blank" });
    nav(fake, 2001, 2002, 4);
    nav(fake, 1000, 2001); // duplicate event cannot create a second owner
    await flush(20);
    expect(fake.calls.debuggerAttach.some(call => call.target.tabId === 2002)).toBe(false);
    release();
    await bridge._test.settle(); await flush(30);
    const inventory = bridge._test.inventory().sessions;
    const ownedA = inventory.find(item => item.session === "popup-a");
    expect(ownedA.tabIds).toHaveLength(3);
    expect(inventory.find(item => item.session === "popup-b").tabIds).toEqual([b.tabId]);
    expect(port.sent.filter(item => item.method === "AgentBrowser.tabAdopted")).toHaveLength(2);
    expect((await ask("session.close", { session: "popup-a", tabIds: ownedA.tabIds })).ok).toBe(true);
    expect([...fake.state.tabs.keys()].sort((x, y) => x - y)).toEqual([1, 1001]);
    expect(fake.calls.tabsRemove.sort((x, y) => x - y)).toEqual([1000, 2001, 2002]);
    expect(fake.calls.tabsUpdate).toEqual([]);
    expect(fake.calls.windowsUpdate).toEqual([]);
  });

  it("rejects unowned sources, malformed frames and extension targets without attaching or closing unknown tabs", async () => {
    const fake = makeFake();
    const { bridge, port, hello } = await boot(fake);
    const root = await request(bridge, port, hello, "tab.create", { session: "popup-denied", url: "about:blank" });
    const baseline = fake.calls.debuggerAttach.length;
    fake.addTab({ id: 2001, windowId: 10, active: false, openerTabId: 1000, url: "about:blank" });
    nav(fake, 1, 2001);
    nav(fake, 1000, 2001, -1);
    fake.addTab({ id: 2002, windowId: 10, active: false, url: "chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/page.html" });
    nav(fake, 1000, 2002);
    await bridge._test.settle(); await flush(30);
    expect(bridge._test.inventory().sessions[0].tabIds).toEqual([root.result.tabId]);
    expect(fake.calls.debuggerAttach).toHaveLength(baseline);
    expect(fake.calls.tabsRemove).toEqual([]);
    expect(fake.state.tabs.has(2001)).toBe(true);
    expect(fake.state.tabs.has(2002)).toBe(true);
  });

  it.each(["source removal", "connection turnover"])("rejects delayed navigation adoption after %s", async (change) => {
    const fake = makeFake();
    const { bridge, port, hello } = await boot(fake);
    await request(bridge, port, hello, "tab.create", { session: "popup-stale", url: "about:blank" });
    let release, queried = false;
    const barrier = new Promise(resolve => { release = resolve; });
    const get = fake.chrome.tabs.get;
    fake.chrome.tabs.get = async (id) => {
      if (id === 2001) { queried = true; await barrier; }
      return get(id);
    };
    fake.addTab({ id: 2001, windowId: 10, active: false, url: "about:blank" });
    nav(fake, 1000, 2001);
    await flush(30); expect(queried).toBe(true);
    if (change === "source removal") await fake.chrome.tabs.remove(1000);
    else port.disconnect();
    await flush(20); release();
    await bridge._test.settle(); await flush(30);
    expect(fake.calls.debuggerAttach.some(call => call.target.tabId === 2001)).toBe(false);
    expect(fake.calls.tabsRemove).not.toContain(2001);
    expect(port.sent.some(item => item.method === "AgentBrowser.tabAdopted")).toBe(false);
  });

  it("keeps ordinary core usable without navigation API and never revives opener-based adoption", async () => {
    const fake = makeFake();
    delete fake.chrome.webNavigation;
    const { bridge, port, hello } = await boot(fake);
    const root = await request(bridge, port, hello, "tab.create", { session: "popup-unavailable", url: "about:blank" });
    expect(root.ok).toBe(true);
    fake.addTab({ id: 2001, windowId: 10, active: false, openerTabId: 1000, url: "about:blank" });
    await flush(30); await bridge._test.settle();
    expect(bridge._test.inventory().sessions[0].tabIds).toEqual([root.result.tabId]);
    expect((await request(bridge, port, hello, "session.close", {
      session: "popup-unavailable", tabIds: [root.result.tabId],
    })).ok).toBe(true);
    expect(fake.state.tabs.has(2001)).toBe(true);
  });
});

describe("owned removal failure truth", () => {
  const failureKey = "agentBrowserOwnershipFailuresV1";
  const ownershipKey = "agentBrowserOwnershipV1";

  it("retains worker and broker cleanup authority after rejected descendant removal, including exact rebind", async () => {
    const fake = makeFake({ emitDetachSynchronously: true });
    const { bridge, port, hello } = await boot(fake);
    const created = await request(bridge, port, hello, "tab.create", {
      session: "removal-owner", url: "about:blank",
    });
fake.addTab({ id: 2001, windowId: 10, active: false, openerTabId: 1000, url: "about:blank" }, true, 1000);
    await flush(30);
    await bridge._test.settle();
    const retained = clone(bridge._test.inventory().sessions[0]);
    const neighbor = await request(bridge, port, hello, "tab.create", {
      session: "removal-neighbor", url: "about:blank",
    });
    const remove = fake.chrome.tabs.remove;
    fake.chrome.tabs.remove = async (id) => {
      if (id === 2001) throw new Error("private page text must never escape");
      return remove(id);
    };
    // Real broker close ordering and MV3 dispatcher; no listener or process.
    const broker = Object.create(Broker.prototype);
    const session = { name: "removal-owner", account: "fixture", epoch: hello.connectionEpoch,
      cleanup: "fixture-cleanup", endpointToken: "fixture-endpoint", tabIds: new Set(retained.tabIds),
      ws: { close: vi.fn() } };
    const owner = {};
    broker.sessions = new Map([[session.name, session]]);
    broker.ownerRecords = new Map([[session.name, owner]]);
    broker.endpoints = new Map([[session.endpointToken, session]]);
    broker.forgetOwner = vi.fn();
    broker.peersByAccount = new Map([["fixture", { epoch: hello.connectionEpoch,
      async request(op, args) {
        const response = await request(bridge, port, hello, op, args);
        if (!response.ok) throw Object.assign(new Error(response.error.code), { bridgeCode: response.error.code });
        return response.result;
      } }]]);
    await expect(broker.closeSession(session.cleanup)).rejects.toMatchObject({ bridgeCode: "TAB_REMOVE_FAILED" });
    expect(broker.sessions.get(session.name)).toBe(session);
    expect(broker.ownerRecords.get(session.name)).toBe(owner);
    expect(broker.endpoints.get(session.endpointToken)).toBe(session);
    expect(broker.forgetOwner).not.toHaveBeenCalled();
    expect(session.ws.close).not.toHaveBeenCalled();
    expect(bridge._test.inventory().sessions.find((item) => item.session === session.name)).toEqual(retained);
    expect(fake.calls.tabsRemove).toEqual([]); // root was not attempted first
    expect(fake.calls.debuggerDetach).toEqual([]); // no fabricated detached state
    expect(fake.storage.session.get(ownershipKey).tabs.filter((item) => item.session === session.name)).toHaveLength(2);
    expect(fake.storage.session.get(failureKey).entries).toEqual([{
      connectionEpoch: hello.connectionEpoch,
      tabId: retained.tabIds.find((id) => id !== created.result.tabId), chromeTabId: 2001,
      openerTabId: created.result.tabId, stage: "tabs.remove", code: "TAB_REMOVE_FAILED",
    }]);
    expect((await request(bridge, port, hello, "cdp.send", { session: "removal-neighbor",
      tabId: neighbor.result.tabId, method: "Page.getFrameTree", params: {} })).ok).toBe(true);
    const resumed = makeFake({ storage: fake.storage, windows: [...fake.state.windows.values()], tabs: [...fake.state.tabs.values()] });
    const rebound = await boot(resumed);
    expect((await request(rebound.bridge, rebound.port, rebound.hello, "session.rebind", {
      session: retained.session, rootTabId: retained.rootTabId, tabIds: retained.tabIds,
    })).ok).toBe(true);
    expect((await request(rebound.bridge, rebound.port, rebound.hello, "cdp.send", {
      session: retained.session, tabId: retained.rootTabId, method: "Page.getFrameTree", params: {},
    })).ok).toBe(true);
    expect(resumed.calls.debuggerAttach.some((call) => call.target.tabId === 1000)).toBe(true);
    expect((await request(rebound.bridge, rebound.port, rebound.hello, "session.close", {
      session: retained.session, tabIds: retained.tabIds,
    })).ok).toBe(true);
    expect(resumed.calls.tabsRemove).toEqual([2001, 1000]);
    expect(resumed.state.tabs.has(1001)).toBe(true);
  });

  it.each(["exact-absence", "removed-event", "wrong-id"])("classifies %s without broadly accepting remove errors", async (variant) => {
    const fake = makeFake();
    const { bridge, port, hello } = await boot(fake);
    const created = await request(bridge, port, hello, "tab.create", { session: "absent", url: "about:blank" });
    fake.chrome.tabs.remove = async (id) => {
      if (variant !== "wrong-id") fake.state.tabs.delete(id);
      if (variant === "removed-event") fake.events.tabRemoved.emit(id, { isWindowClosing: false });
      throw new Error(variant === "removed-event" ? "late rejection" : `No tab with id: ${variant === "wrong-id" ? id + 1 : id}.`);
    };
    const result = await request(bridge, port, hello, "session.close", { session: "absent", tabIds: [created.result.tabId] });
    if (variant === "wrong-id") {
      expect(result).toMatchObject({ ok: false, error: { code: "TAB_REMOVE_FAILED" } });
      expect(bridge._test.inventory().sessions).toHaveLength(1);
    } else {
      expect(result).toMatchObject({ ok: true, result: { closedTabIds: [created.result.tabId] } });
      expect(bridge._test.inventory()).toEqual({ sessions: [] });
      fake.events.tabRemoved.emit(1000, { isWindowClosing: false });
      fake.events.debuggerDetach.emit({ tabId: 1000 }, "target_closed");
      await flush(20);
      expect(port.sent.filter((message) => message.method === "AgentBrowser.tabRevoked")).toEqual([]);
    }
  });

  it("retains a claimed user tab on detach rejection without attempting removal", async () => {
    const fake = makeFake();
    const { bridge, port, hello } = await boot(fake);
    await request(bridge, port, hello, "focus.snapshot", {});
    const created = await request(bridge, port, hello, "tab.claim-active", { session: "detach-owner" });
    expect(created.ok).toBe(true);
    fake.chrome.debugger.detach = async () => { throw new Error("private browser text"); };
    const result = await request(bridge, port, hello, "session.close", { session: "detach-owner", tabIds: [created.result.tabId] });
    expect(result).toMatchObject({ ok: false, error: { code: "TAB_DETACH_FAILED" } });
    expect(bridge._test.inventory().sessions[0].claimedCurrentTab).toBe(true);
    expect(fake.calls.tabsRemove).toEqual([]);
    expect(fake.state.tabs.has(1)).toBe(true);
    expect(fake.storage.session.get(failureKey).entries[0]).toMatchObject({ stage: "debugger.detach", code: "TAB_DETACH_FAILED" });
  });

  it.each(["debugger.attach", "Page.getFrameTree", "target.validate"])("retains bounded exact-owner adoption failure evidence at %s", async (stage) => {
    const fake = makeFake();
    const { bridge, port, hello } = await boot(fake);
    const root = await request(bridge, port, hello, "tab.create", { session: "adoption-owner", url: "about:blank" });
    const attach = fake.chrome.debugger.attach;
    const send = fake.chrome.debugger.sendCommand;
    fake.chrome.debugger.attach = async (target, version) => {
      if (stage === "debugger.attach" && target.tabId >= 2000) throw new Error("private target URL");
      return attach(target, version);
    };
    fake.chrome.debugger.sendCommand = async (target, method, params) => {
      if (target.tabId >= 2000 && method === "Page.getFrameTree") {
        if (stage === "Page.getFrameTree") throw new Error("private frame content");
        if (stage === "target.validate") return { frameTree: { frame: { id: "frame", url: "chrome://settings/" } } };
      }
      return send(target, method, params);
    };
    // No exact opener => neither diagnostics nor ownership, even in root's window.
    fake.addTab({ id: 1999, windowId: 10, active: false, url: "https://unrelated.test/" });
    await flush(20);
    expect(fake.storage.session.has(failureKey)).toBe(false);
    for (let id = 2000; id < 2034; id++) {
fake.addTab({ id, windowId: 10, active: false, openerTabId: 1000, url: "about:blank" }, true, 1000);
      await flush(20);
    }
    await bridge._test.settle();
    const failures = fake.storage.session.get(failureKey);
    expect(failures.dropped).toBe(2);
    expect(failures.entries).toHaveLength(32);
    for (const entry of failures.entries) {
      expect(Object.keys(entry).sort()).toEqual(["chromeTabId", "code", "connectionEpoch", "openerTabId", "stage", "tabId"]);
      expect(entry).toMatchObject({ connectionEpoch: hello.connectionEpoch, openerTabId: root.result.tabId,
        stage, code: stage === "target.validate" ? "TARGET_DENIED" : "OPERATION_FAILED" });
    }
    expect(JSON.stringify(failures)).not.toMatch(/private|https:|chrome:/);
    expect(bridge._test.inventory().sessions[0].tabIds).toEqual([root.result.tabId]);
    expect(fake.calls.tabsRemove).toEqual([]);
    expect(port.sent.filter((message) => message.method === "AgentBrowser.tabAdopted")).toEqual([]);
  });
});

async function focusFixture() {
  const root = mkdtempSync(join(tmpdir(), "ab-focus-return-"));
  const fake = makeFake({ windows: [{ id: 10, type: "normal", focused: false, state: "normal" }],
    tabs: [{ id: 1, windowId: 10, active: true, url: "https://example.test/prior" }] });
  const { bridge, port, hello } = await boot(fake, { now: () => Date.now() });
  const profile = { account: "fixture", profileDirectory: "Default", profileKey: hello.profileKey };
  const configPath = join(root, "profiles.json");
  writeFileSync(configPath, JSON.stringify({ schema: PROFILE_CONFIG_SCHEMA,
    extensionOrigin: "chrome-extension://" + "a".repeat(32) + "/", profiles: [profile] }), { mode: 0o600 });
  const broker = new Broker({ stateRoot: root, profileConfig: configPath });
  broker.httpServer = { address: () => ({ port: 12345 }) };
  const wire = [], native = { begin: "captured", commit: "armed", check: "unchanged",
    release: "prepared", "finish-release": "returned", cancel: "cancelled" };
  const peer = { profile, epoch: hello.connectionEpoch, stage: "ready", closed: false,
    async request(op, args, timeout, options = {}) {
      wire.push({ op, args: clone(args) });
      if (op.startsWith("native.focus.")) {
        expect(args).toEqual({ handoffToken: broker.focusHandoff.token,
          session: broker.focusHandoff.session.name, tabId: broker.focusHandoff.tabId });
        expect(options.deadlineAt).toBeGreaterThan(Date.now());
        expect(options.deadlineAt).toBeLessThanOrEqual(Date.now() + timeout + 2);
        const value = native[op.slice("native.focus.".length)];
        return typeof value === "function" ? value() : { status: value };
      }
      const response = await request(bridge, port, hello, op, args,
        options.deadlineAt === undefined ? {} : { deadlineAt: options.deadlineAt });
      if (!response?.ok) throw Object.assign(new Error(response?.error?.code || "NO_REPLY"),
        { bridgeCode: response?.error?.code || "NO_REPLY" });
      return response.result;
    } };
  broker.peersByAccount.set(profile.account, peer);
  const owner = resolveInvokingOwner();
  const grant = (alias = "task", agentOwner = owner) => ({
    session: ownerSession(agentOwner, sha256(alias)), agentOwner, aliasHash: sha256(alias),
    account: profile.account, currentTab: false, issuedAt: Date.now(), expiresAt: Date.now() + 30000,
    nonce: opaqueId(),
  });
  await broker.launch(grant());
  const session = broker.sessions.get(grant().session);
  return { fake, broker, session, grant, peer, native, wire, port, owner,
    async dispose() { await broker.cancelFocusHandoff(broker.focusHandoff);
      rmSync(root, { recursive: true, force: true }); } };
}

describe("conditional focus return", () => {
  it("joins begin/Chrome activation/commit/exact checkpoint, restores only prior tab then releases once", async () => {
    const f = await focusFixture();
    try {
      const observed = await f.broker.foreground(f.grant(), "password");
      expect(observed).toEqual({ tabId: f.session.rootTabId, windowId: f.session.windowId,
        active: true, focused: true });
      expect(f.wire.slice(-4).map(x => x.op)).toEqual([
        "native.focus.begin", "tab.foreground", "native.focus.commit", "tab.foreground.check"]);
      expect(f.fake.events.tabActivated.listeners).toHaveLength(1);
      const windowsBefore = clone(f.fake.calls.windowsUpdate);
      expect(await f.broker.handleControl({ schema: CONTROL_SCHEMA, id: opaqueId(),
        op: "background", grant: f.grant() })).toEqual({ status: "returned" });
      expect(f.fake.calls.tabsUpdate).toEqual([
        { id: 1000, updateData: { active: true } }, { id: 1, updateData: { active: true } }]);
      expect(f.fake.calls.windowsUpdate).toEqual([...windowsBefore,
        { id: 10, updateData: { focused: false } }]);
      expect(f.wire.filter(x => x.op === "native.focus.release")).toHaveLength(1);
      expect(f.wire.slice(-5, -2).map(x => x.op)).toEqual([
        "native.focus.release", "window.background", "native.focus.finish-release"]);
      expect(f.fake.events.tabActivated.listeners).toHaveLength(0);
      expect(f.fake.events.windowFocused.listeners).toHaveLength(0);
      expect(f.broker.focusHandoff).toBeNull();
      expect(await f.broker.background(f.grant())).toEqual({ status: "no-handoff" });
    } finally { await f.dispose(); }
  });

  it.each(["tab", "window"])("latches independent %s away-and-back for the entire input interval", async (kind) => {
    const f = await focusFixture();
    try {
      await f.broker.foreground(f.grant(), "two-factor");
      if (kind === "tab") {
        f.fake.events.tabActivated.emit({ tabId: 1, windowId: 10 });
        f.fake.events.tabActivated.emit({ tabId: 1000, windowId: 10 });
      } else {
        f.fake.events.windowFocused.emit(-1);
        f.fake.events.windowFocused.emit(10);
      }
      expect(await f.broker.background(f.grant())).toEqual({ status: "cancelled" });
      expect(f.fake.calls.tabsUpdate).toHaveLength(1);
      expect(f.wire.filter(x => ["tab.background", "native.focus.release"].includes(x.op))).toEqual([]);
      expect(f.fake.events.tabActivated.listeners).toHaveLength(0);
    } finally { await f.dispose(); }
  });

  it("native cancellation blocks Chrome restoration even when its last snapshot is unchanged", async () => {
    const f = await focusFixture();
    try {
      await f.broker.foreground(f.grant(), "recovery");
      f.native.check = "cancelled";
      expect(await f.broker.background(f.grant())).toEqual({ status: "cancelled" });
      expect(f.fake.calls.tabsUpdate).toHaveLength(1);
      expect(f.wire.some(x => x.op === "tab.background")).toBe(false);
    } finally { await f.dispose(); }
  });

  it("a different genuine process owner cannot release or replace the global handoff", async () => {
    const f = await focusFixture();
    try {
      const other = observeProcessIdentity(f.owner.pid === process.pid ? process.ppid : process.pid);
      await f.broker.launch(f.grant("neighbor", other));
      await f.broker.foreground(f.grant(), "password");
      const count = f.wire.length;
      await expect(f.broker.background(f.grant("neighbor", other))).rejects.toMatchObject({ bridgeCode: "SESSION_CONFLICT" });
      await expect(f.broker.foreground(f.grant("neighbor", other), "password"))
        .rejects.toMatchObject({ bridgeCode: "FOCUS_HANDOFF_BUSY" });
      expect(f.wire).toHaveLength(count);
      expect(f.broker.focusHandoff.session).toBe(f.session);
    } finally { await f.dispose(); }
  });

  it("post-commit exact window checkpoint rejects a focused-tab-only false positive", async () => {
    const f = await focusFixture();
    try {
      f.native.commit = () => { f.fake.state.windows.get(10).focused = false; return { status: "armed" }; };
      await expect(f.broker.foreground(f.grant(), "captcha"))
        .rejects.toMatchObject({ bridgeCode: "FOREGROUND_NOT_CONFIRMED" });
      expect(f.wire.some(x => x.op === "native.focus.cancel")).toBe(true);
      expect(f.fake.events.windowFocused.listeners).toHaveLength(0);
      expect(f.broker.focusHandoff).toBeNull();
    } finally { await f.dispose(); }
  });

  it.each(["missing-prior", "unfocused-task", "failed-tab-update"])("%s cancels without native release or guessed prior tab", async (fault) => {
    const f = await focusFixture();
    try {
      await f.broker.foreground(f.grant(), "file-picker");
      if (fault === "missing-prior") f.fake.state.tabs.delete(1);
      if (fault === "unfocused-task") f.fake.state.windows.get(10).focused = false;
      if (fault === "failed-tab-update") f.fake.chrome.tabs.update = async () => { throw Error("denied"); };
      expect(await f.broker.background(f.grant())).toEqual({ status: "cancelled" });
      expect(f.wire.some(x => x.op === "native.focus.release")).toBe(false);
      expect(f.fake.calls.tabsUpdate).toHaveLength(1);
    } finally { await f.dispose(); }
  });

  it.each(["denied", "unconfirmed"])("native release %s remains explicit, with no retry", async (status) => {
    const f = await focusFixture();
    try {
      await f.broker.foreground(f.grant(), "password");
      if (status === "denied") f.native.release = "unavailable";
      else f.native["finish-release"] = status;
      expect(await f.broker.background(f.grant())).toEqual({ status });
      expect(f.wire.filter(x => x.op === "native.focus.release")).toHaveLength(1);
      expect(f.broker.focusHandoff).toBeNull();
    } finally { await f.dispose(); }
  });

  it("a lost native release reply is unconfirmed, never denied or successful", async () => {
    const f = await focusFixture();
    try {
      await f.broker.foreground(f.grant(), "password");
      f.native["finish-release"] = () => { throw Error("fixture transport timeout"); };
      expect(await f.broker.background(f.grant())).toEqual({ status: "unconfirmed" });
      expect(f.wire.filter(x => x.op === "native.focus.release")).toHaveLength(1);
      expect(f.broker.focusHandoff).toBeNull();
    } finally { await f.dispose(); }
  });

  it.each(["begin", "commit"])("native %s unavailability cancels both participants without silent success", async (phase) => {
    const f = await focusFixture();
    try {
      f.native[phase] = "unavailable";
      await expect(f.broker.foreground(f.grant(), "password"))
        .rejects.toMatchObject({ bridgeCode: "FOREGROUND_NOT_CONFIRMED" });
      expect(f.fake.calls.tabsUpdate).toHaveLength(phase === "begin" ? 0 : 1);
      expect(f.wire.filter(x => x.op === "native.focus.cancel")).toHaveLength(1);
      expect(f.fake.events.windowFocused.listeners).toHaveLength(0);
      expect(f.broker.focusHandoff).toBeNull();
    } finally { await f.dispose(); }
  });

  it.each(["retirement", "epoch-loss"])("%s drops both observations without returning focus", async (loss) => {
    const f = await focusFixture();
    try {
      await f.broker.foreground(f.grant(), "password");
      const handoff = f.broker.focusHandoff;
      if (loss === "retirement") f.broker.retireSessionLedger(f.session, "fixture retirement");
      else { f.port.disconnect(); f.peer.closed = true; f.broker.unregisterPeer(f.peer); }
      await handoff.cancellation;
      expect(f.broker.focusHandoff).toBeNull();
      expect(f.fake.events.tabActivated.listeners).toHaveLength(0);
      expect(f.fake.events.windowFocused.listeners).toHaveLength(0);
      expect(f.fake.calls.tabsUpdate).toHaveLength(1);
      expect(f.wire.some(x => x.op === "native.focus.release")).toBe(false);
    } finally { await f.dispose(); }
  });
});

describe("explicit foreground only", () => {
  it("production wrapper → broker → worker requires genuine input and retained owner; rejects target commands without blocking a neighbor", async () => {
    // Only transport and supervisor health are fixture boundaries. The real
    // parser/run, live-process owner derivation, grant checks, native-command
    // fence, and MV3 dispatcher execute. No server, engine or browser is started.
    const root = mkdtempSync(join(tmpdir(), "ab-foreground-"));
    const fake = makeFake({ omitQueryUrls: true,
      windows: [{ id: 10, type: "normal", focused: false, state: "minimized" }] });
    const { bridge, port, hello } = await boot(fake, { now: () => Date.now() });
    const profile = { account: "fixture", profileDirectory: "Default", profileKey: hello.profileKey };
    const configPath = join(root, "profiles.json");
    writeFileSync(configPath, JSON.stringify({ schema: PROFILE_CONFIG_SCHEMA,
      extensionOrigin: "chrome-extension://" + "a".repeat(32) + "/", profiles: [profile] }), { mode: 0o600 });
    const broker = new Broker({ stateRoot: root, profileConfig: configPath });
    broker.httpServer = { address: () => ({ port: 12345 }) }; // no listener
    const wire = [];
    const peer = { profile, epoch: hello.connectionEpoch, stage: "ready", closed: false,
      async request(op, args, _timeout, options = {}) {
        wire.push({ op, args: clone(args) });
        if (op.startsWith("native.focus.")) {
          expect(args).toEqual({ handoffToken: broker.focusHandoff.token,
            session: broker.focusHandoff.session.name, tabId: broker.focusHandoff.tabId });
          expect(options.deadlineAt).toBeGreaterThan(Date.now());
          return { status: { "native.focus.begin": "captured", "native.focus.commit": "armed",
            "native.focus.check": "unchanged", "native.focus.release": "prepared",
            "native.focus.finish-release": "returned",
            "native.focus.cancel": "cancelled" }[op] };
        }
        const response = await request(bridge, port, hello, op, args,
          options.deadlineAt === undefined ? {} : { deadlineAt: options.deadlineAt });
        if (!response?.ok) throw Object.assign(new Error(response?.error?.code || "NO_REPLY"),
          { bridgeCode: response?.error?.code || "NO_REPLY" });
        return response.result;
      } };
    broker.peersByAccount.set(profile.account, peer);
    const owner = resolveInvokingOwner();
    const grant = (alias, currentTab = false, agentOwner = owner) => ({
      session: ownerSession(agentOwner, sha256(alias)), agentOwner, aliasHash: sha256(alias),
      account: profile.account, currentTab, issuedAt: Date.now(), expiresAt: Date.now() + 30000,
      nonce: opaqueId(),
    });
    const invoke = (alias, tail = ["foreground", "--input-boundary", "password"]) =>
      ["--account", "fixture", "--session", alias, ...tail];
    const receipt = { controlSocket: join(root, "control.sock") };
    vi.stubEnv("AGENT_BROWSER_PRIVATE_CWS_PROFILE_CONFIG", configPath);
    vi.stubEnv("AGENT_BROWSER_PRIVATE_CWS_STATE_ROOT", root);
    vi.stubEnv("AGENT_BROWSER_PRIVATE_CWS_ENGINE_PATH", join(root, "absent-engine"));
    vi.stubEnv("AGENT_BROWSER_PRIVATE_CWS_CHROME_EXE", join(root, "absent-chrome"));
    const existing = vi.spyOn(supervisor, "requireExtensionBroker").mockResolvedValue(receipt);
    const bootstrap = vi.spyOn(supervisor, "ensureExtensionBroker").mockImplementation(() => {
      throw new Error("foreground must not bootstrap");
    });
    vi.spyOn(control, "requestExtensionControl").mockImplementation(async (_socket, body) => {
      try { return await broker.handleControl({ schema: CONTROL_SCHEMA, id: opaqueId(), ...body }); }
      catch (error) { error.code = error.bridgeCode; throw error; }
    });
    let stdout = "";
    try {
      const { run, parseWrapperArgs } = await import("../scripts/agent-browser-private-cws-wrapper.js");
      expect(() => parseWrapperArgs(invoke("task", ["foreground"]))).toThrow("input-boundary");
      expect(() => parseWrapperArgs(invoke("task", ["foreground", "--input-boundary", "screenshot"]))).toThrow("input-boundary");
      expect(() => parseWrapperArgs(invoke("task", ["background", "unexpected"]))).toThrow("takes no arguments");
      await expect(run(invoke("absent"))).rejects.toThrow("SESSION_CONFLICT");
      expect(wire).toEqual([]); // no allocation/adoption, even for a new alias
      await broker.launch(grant("task"));
      const session = broker.sessions.get(grant("task").session);
      const rootRecord = fake.calls.tabsCreate.at(-1);
      expect(rootRecord.active).toBe(false);
      await peer.request("cdp.send", { session: session.name, tabId: session.rootTabId,
        method: "Runtime.evaluate", params: { expression: "1" } });
      expect(fake.calls.tabsUpdate).toEqual([]);
      expect(fake.calls.windowsUpdate).toEqual([]); // ordinary work is still inactive
      const wrongOwner = observeProcessIdentity(owner.pid === process.pid ? process.ppid : process.pid);
      await expect(broker.foreground(grant("task", false, wrongOwner), "password"))
        .rejects.toMatchObject({ bridgeCode: "SESSION_CONFLICT" });
      const forged = grant("other"); forged.session = session.name;
      await expect(broker.foreground(forged, "password"))
        .rejects.toMatchObject({ bridgeCode: "GRANT_REJECTED" });
      await expect(broker.foreground(grant("task"), "navigation"))
        .rejects.toMatchObject({ bridgeCode: "INPUT_BOUNDARY_REQUIRED" });
      broker.daemonIdentity = (_session, pid) => observeProcessIdentity(pid);
      const command = await broker.beginCommand(grant("task"), process.pid);
      await expect(run(invoke("task"))).rejects.toThrow("TARGET_BUSY");
      expect(fake.calls.tabsUpdate).toEqual([]);
      await broker.completeCommand(command.command, process.pid);
      await broker.launch(grant("neighbor"));
      const neighbor = await broker.beginCommand(grant("neighbor"), process.pid);
      const beforeTabs = [...fake.state.tabs.keys()];
      const beforeAttach = fake.calls.debuggerAttach.length;
      const output = vi.spyOn(process.stdout, "write").mockImplementation((value) => { stdout += value; return true; });
      expect(await run(invoke("task"))).toBe(0);
      output.mockRestore();
      expect(JSON.parse(stdout)).toEqual({ success: true, data: {
        tabId: session.rootTabId, windowId: session.windowId, active: true, focused: true,
      } });
      expect(fake.calls.tabsUpdate).toEqual([{ id: 1000, updateData: { active: true } }]);
      expect(fake.calls.windowsUpdate).toEqual([{ id: 10, updateData: { focused: true, state: "normal" } }]);
      expect([...fake.state.tabs.keys()]).toEqual(beforeTabs);
      expect(fake.calls.tabsRemove).toEqual([]);
      expect(fake.calls.windowsRemove).toEqual([]);
      expect(fake.calls.debuggerAttach).toHaveLength(beforeAttach);
      expect(broker.authorizedCommand(broker.sessions.get(grant("neighbor").session), neighbor.command)).toBeTruthy();
      // The installed command must consume the retained handoff without an
      // engine/bootstrap, and report the native owner's result—not just an ACK.
      stdout = "";
      const returning = vi.spyOn(process.stdout, "write").mockImplementation((value) => { stdout += value; return true; });
      expect(await run(invoke("task", ["background"]))).toBe(0);
      returning.mockRestore();
      expect(JSON.parse(stdout)).toEqual({ success: true, data: { status: "returned" } });
      expect(broker.focusHandoff).toBeNull();
      expect(fake.calls.tabsRemove).toEqual([]);
      expect(fake.calls.windowsRemove).toEqual([]);
      expect(broker.authorizedCommand(broker.sessions.get(grant("neighbor").session), neighbor.command)).toBeTruthy();
      await broker.completeCommand(neighbor.command, process.pid);
      const windowsBeforeLoss = clone(fake.calls.windowsUpdate);
      peer.closed = true;
      await expect(run(invoke("task"))).rejects.toThrow("SESSION_CONFLICT");
      expect(fake.calls.windowsUpdate).toEqual(windowsBeforeLoss); // no fallback/retry
      expect(bootstrap).not.toHaveBeenCalled();
      expect(existing).toHaveBeenCalled();
      expect(readdirSync(join(root, "grants"))).toEqual([]);
    } finally {
      vi.restoreAllMocks(); vi.unstubAllEnvs();
      rmSync(root, { recursive: true, force: true }); // exact test-created fixture
    }
  }, 5000);

  it("foreground uses a fresh exact main frame when Chrome omits Tab.url, not cached attachment validation", async () => {
    const fake = makeFake({ omitQueryUrls: true,
      windows: [{ id: 10, type: "normal", focused: false, state: "normal" }] });
    const { bridge, port, hello } = await boot(fake);
    const ask = (op, args) => request(bridge, port, hello, op, args, { deadlineAt: 6000 });
    const root = (await ask("tab.create", { session: "task", url: "https://example.test/" })).result;
    const attachCount = fake.calls.debuggerAttach.length;
    const frameCount = fake.calls.debuggerSend.filter((call) => call.method === "Page.getFrameTree").length;
    fake.state.tabs.get(1000).url = "https://example.test/current";
    expect((await ask("tab.foreground", { session: "task", tabId: root.tabId,
      windowId: root.windowId, currentTab: false, inputBoundary: "password", handoffToken: FOCUS_TOKEN })).ok).toBe(true);
    expect(fake.calls.debuggerSend.filter((call) => call.method === "Page.getFrameTree"))
      .toHaveLength(frameCount + 1);
    expect(fake.calls.debuggerSend.at(-1)).toEqual({
      target: { tabId: 1000 }, method: "Page.getFrameTree", params: {},
    });
    expect(fake.calls.debuggerAttach).toHaveLength(attachCount);
    expect(fake.calls.tabsUpdate).toEqual([{ id: 1000, updateData: { active: true } }]);
    expect(fake.calls.windowsUpdate).toEqual([{ id: 10, updateData: { focused: true } }]);
    expect(fake.calls.tabsRemove).toEqual([]);
    // The observer now owns the whole input handoff, not just foreground RPC.
    expect(fake.events.tabActivated.listeners).toHaveLength(1);
    expect(fake.events.windowFocused.listeners).toHaveLength(1);
    await ask("tab.foreground.cancel", { session: "task", tabId: root.tabId, windowId: root.windowId, handoffToken: FOCUS_TOKEN });
    expect(fake.events.tabActivated.listeners).toHaveLength(0);
    expect(fake.events.windowFocused.listeners).toHaveLength(0);
  });

  it.each([
    ["forbidden URL", { frameTree: { frame: { id: "main", url: "chrome://settings/" } } }],
    ["extension URL", { frameTree: { frame: { id: "main", url: "chrome-extension://" + "a".repeat(32) + "/" } } }],
    ["missing tree", {}],
    ["missing URL", { frameTree: { frame: { id: "main" } } }],
    ["invalid frame identity", { frameTree: { frame: { id: 7, url: "https://example.test/" } } }],
  ])("foreground with missing Tab.url rejects fresh %s before any activation", async (_name, tree) => {
    const fake = makeFake({ omitQueryUrls: true,
      windows: [{ id: 10, type: "normal", focused: false, state: "normal" }] });
    const { bridge, port, hello } = await boot(fake);
    const ask = (op, args) => request(bridge, port, hello, op, args, { deadlineAt: 6000 });
    const root = (await ask("tab.create", { session: "task", url: "https://example.test/" })).result;
    const original = fake.chrome.debugger.sendCommand;
    fake.chrome.debugger.sendCommand = async (target, method, params) => {
      expect(target).toEqual({ tabId: 1000 });
      if (method === "Page.getFrameTree") { expect(params).toEqual({}); return clone(tree); }
      return original(target, method, params);
    };
    expect((await ask("tab.foreground", { session: "task", tabId: root.tabId,
      windowId: root.windowId, currentTab: false, inputBoundary: "password", handoffToken: FOCUS_TOKEN })).error.code)
      .toBe("TARGET_DENIED");
    expect(fake.calls.tabsUpdate).toEqual([]);
    expect(fake.calls.windowsUpdate).toEqual([]);
    expect(fake.calls.tabsRemove).toEqual([]);
    expect(fake.events.tabActivated.listeners).toHaveLength(0);
    expect(fake.events.windowFocused.listeners).toHaveLength(0);
  });

  it.each(["switch", "expired", "epoch"])("foreground rechecks %s after fresh frame lookup before activation", async (outcome) => {
    let now = 1000;
    const fake = makeFake({ omitQueryUrls: true,
      windows: [{ id: 10, type: "normal", focused: false, state: "normal" }] });
    const { bridge, port, hello } = await boot(fake, { now: () => now });
    const ask = (op, args) => request(bridge, port, hello, op, args, { deadlineAt: 6000 });
    const root = (await ask("tab.create", { session: "task", url: "https://example.test/" })).result;
    const original = fake.chrome.debugger.sendCommand;
    fake.chrome.debugger.sendCommand = async (...args) => {
      const tree = await original(...args);
      if (args[1] === "Page.getFrameTree") {
        if (outcome === "switch") fake.events.windowFocused.emit(-1);
        if (outcome === "expired") now = 6001;
        if (outcome === "epoch") port.disconnect();
      }
      return tree;
    };
    const result = await ask("tab.foreground", { session: "task", tabId: root.tabId,
      windowId: root.windowId, currentTab: false, inputBoundary: "password", handoffToken: FOCUS_TOKEN });
    expect(result.error.code).toBe({ switch: "FOREGROUND_CHANGED",
      expired: "REQUEST_EXPIRED", epoch: "STALE_CONNECTION" }[outcome]);
    expect(fake.calls.tabsUpdate).toEqual([]);
    expect(fake.calls.windowsUpdate).toEqual([]);
    expect(fake.calls.tabsRemove).toEqual([]);
    expect(fake.events.tabActivated.listeners).toHaveLength(0);
    expect(fake.events.windowFocused.listeners).toHaveLength(0);
  });

  it("foreground holds the physical target until Chrome settles; command.begin cannot overtake it", async () => {
    const fake = makeFake();
    const { bridge, port, hello } = await boot(fake);
    const ask = (op, args) => request(bridge, port, hello, op, args, { deadlineAt: 6000 });
    await ask("focus.snapshot", {});
    const a = (await ask("tab.claim-active", { session: "a" })).result;
    await ask("focus.snapshot", {});
    const b = (await ask("tab.claim-active", { session: "b" })).result;
    fake.state.tabs.get(1).active = false;
    let release;
    const original = fake.chrome.tabs.update;
    fake.chrome.tabs.update = async (...args) => {
      await new Promise((resolve) => { release = resolve; });
      return original(...args);
    };
    const foregroundId = requestId();
    port.receive({ schema: SCHEMA, type: "request", id: foregroundId,
      profileKey: hello.profileKey, connectionEpoch: hello.connectionEpoch,
      op: "tab.foreground", deadlineAt: 6000,
      args: { session: "a", tabId: a.tabId, windowId: a.windowId, currentTab: true, inputBoundary: "two-factor", handoffToken: FOCUS_TOKEN } });
    await flush(60);
    expect(release).toBeTypeOf("function");
    const commandId = requestId();
    port.receive({ schema: SCHEMA, type: "request", id: commandId,
      profileKey: hello.profileKey, connectionEpoch: hello.connectionEpoch,
      op: "command.begin", args: { session: "b", tabId: b.tabId, command: "c".repeat(64) } });
    await flush(60);
    expect(port.sent.find((message) => message.id === commandId)).toMatchObject({ ok: false, error: { code: "TARGET_BUSY" } });
    release(); await bridge._test.settle(); await flush();
    expect(port.sent.find((message) => message.id === foregroundId)).toMatchObject({ ok: true });
    expect((await ask("command.begin", { session: "b", tabId: b.tabId, command: "c".repeat(64) })).ok).toBe(true);
    expect((await ask("tab.foreground", { session: "a", tabId: a.tabId, windowId: a.windowId,
      currentTab: true, inputBoundary: "password", handoffToken: FOCUS_TOKEN })).error.code).toBe("TARGET_BUSY");
    await ask("command.end", { session: "b", tabId: b.tabId, command: "c".repeat(64) });
    expect((await ask("tab.foreground", { session: "a", tabId: a.tabId, windowId: a.windowId,
      currentTab: false, inputBoundary: "password", handoffToken: FOCUS_TOKEN })).error.code).toBe("TAB_NOT_OWNED");
    expect(fake.calls.debuggerDetach).toEqual([]);
    expect(fake.calls.tabsRemove).toEqual([]);
  }, 3000);

  it("foreground stops after an observed user switch or expiry; denied window focus is not success or a retry", async () => {
    for (const outcome of ["switch", "expired", "denied"]) {
      let now = 1000;
      const fake = makeFake({ windows: [{ id: 10, type: "normal", focused: false, state: "normal" }] });
      const { bridge, port, hello } = await boot(fake, { now: () => now });
      const ask = (op, args) => request(bridge, port, hello, op, args, { deadlineAt: 6000 });
      const root = (await ask("tab.create", { session: "task", url: "https://example.test/" })).result;
      const original = fake.chrome.tabs.update;
      fake.chrome.tabs.update = async (...args) => {
        const result = await original(...args);
        if (outcome === "switch") fake.events.windowFocused.emit(-1);
        if (outcome === "expired") now = 6001;
        return result;
      };
      if (outcome === "denied") fake.chrome.windows.update = async (id, updateData) => {
        fake.calls.windowsUpdate.push({ id, updateData });
        return clone(fake.state.windows.get(id)); // API reply alone is not success
      };
      const result = await ask("tab.foreground", { session: "task", tabId: root.tabId,
        windowId: root.windowId, currentTab: false, inputBoundary: "hardware-key", handoffToken: FOCUS_TOKEN });
      expect(result.error.code).toBe({ switch: "FOREGROUND_CHANGED", expired: "REQUEST_EXPIRED",
        denied: "FOREGROUND_NOT_CONFIRMED_YYYYNY" }[outcome]);
      expect(fake.calls.tabsUpdate).toHaveLength(1);
      expect(fake.calls.windowsUpdate).toHaveLength(outcome === "denied" ? 1 : 0);
      expect(fake.calls.tabsRemove).toEqual([]);
      expect(fake.events.tabActivated.listeners).toHaveLength(0);
      expect(fake.events.windowFocused.listeners).toHaveLength(0);
    }
  }, 3000);

  it.each([
    ["tab", { id: -100 }, "NYYYYY"],
    ["tab", { windowId: -100 }, "YNYYYY"],
    ["window", { id: -100 }, "YYNYYY"],
    ["tab", { active: false }, "YYYNYY"],
    ["window", { focused: false }, "YYYYNY"],
    ["window", { state: "minimized" }, "YYYYYN"],
    ["window", { focused: false, state: "minimized" }, "YYYYNN"],
  ])("foreground retains the exact final %s confirmation failure %j", async (owner, fields, suffix) => {
    const fake = makeFake({ windows: [{ id: 10, type: "normal", focused: false, state: "normal" }] });
    const { bridge, port, hello } = await boot(fake);
    const ask = (op, args) => request(bridge, port, hello, op, args, { deadlineAt: 6000 });
    const root = (await ask("tab.create", { session: "task", url: "https://example.test/" })).result;
    const api = owner === "tab" ? fake.chrome.tabs : fake.chrome.windows;
    const original = api.get;
    let reads = 0;
    api.get = async (...args) => {
      const result = await original(...args);
      // The final read, not its preceding owner validation, is the observed red.
      return ++reads === 3 ? { ...result, ...fields } : result;
    };
    const result = await ask("tab.foreground", { session: "task", tabId: root.tabId,
      windowId: root.windowId, currentTab: false, inputBoundary: "file-picker", handoffToken: FOCUS_TOKEN });
    expect(result.error).toEqual({ code: "FOREGROUND_NOT_CONFIRMED_" + suffix });
    expect(fake.calls.tabsUpdate).toHaveLength(1);
    expect(fake.calls.windowsUpdate).toHaveLength(1);
    expect(fake.events.tabActivated.listeners).toHaveLength(0);
    expect(fake.events.windowFocused.listeners).toHaveLength(0);
  });

  it("foreground accepts its exact activation event arriving after the tab-update reply", async () => {
    const fake = makeFake({ windows: [{ id: 10, type: "normal", focused: false, state: "normal" }] });
    const { bridge, port, hello } = await boot(fake);
    const ask = (op, args) => request(bridge, port, hello, op, args, { deadlineAt: 6000 });
    const root = (await ask("tab.create", { session: "task", url: "https://example.test/" })).result;
    fake.chrome.tabs.update = async (id, updateData) => {
      fake.calls.tabsUpdate.push({ id, updateData });
      for (const tab of fake.state.tabs.values()) tab.active = tab.id === id;
      return clone(fake.state.tabs.get(id)); // event is delivered separately
    };
    const updateWindow = fake.chrome.windows.update;
    fake.chrome.windows.update = async (...args) => {
      fake.events.tabActivated.emit({ tabId: 1000, windowId: 10 });
      return updateWindow(...args);
    };
    expect((await ask("tab.foreground", { session: "task", tabId: root.tabId, windowId: root.windowId,
      currentTab: false, inputBoundary: "file-picker", handoffToken: FOCUS_TOKEN })).ok).toBe(true);
    expect(fake.calls.tabsUpdate).toHaveLength(1);
    expect(fake.calls.windowsUpdate).toHaveLength(1);
  }, 3000);

  it("foreground existing-broker lookup fails without starting or recovering an absent broker", async () => {
    const root = mkdtempSync(join(tmpdir(), "ab-foreground-offline-"));
    try {
      await expect(supervisor.requireExtensionBroker({ stateRoot: root,
        profileConfig: join(root, "absent.json") })).rejects.toThrow();
      expect(readdirSync(root)).toEqual([]);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});

describe("private MV3 extension contract", () => {
  it("keeps the manifest and code authority surface minimal", () => {
    const manifest = JSON.parse(readFileSync(manifestUrl, "utf8"));
    expect(manifest.manifest_version).toBe(3);
    expect(manifest.minimum_chrome_version).toBe("120");
    expect(manifest.permissions).toEqual([
      "alarms",
      "debugger",
      "nativeMessaging",
      "storage",
      "webNavigation",
    ]);
    for (const key of [
      "host_permissions",
      "optional_host_permissions",
      "content_scripts",
      "externally_connectable",
      "update_url",
    ]) {
      expect(manifest).not.toHaveProperty(key);
    }
    expect(manifest.action).toEqual({
      default_title: "Pair Agent Browser with this Chrome profile",
      default_icon: manifest.icons,
    });
    for (const permission of [
      "tabs",
      "cookies",
      "scripting",
      "identity",
      "background",
      "downloads",
    ]) {
      expect(manifest.permissions).not.toContain(permission);
    }
    expect(workerSource).toContain(`const HOST_NAME = "${HOST}"`);
    expect(workerSource).not.toMatch(/chromeApi\.debugger\.getTargets/);
    expect(workerSource).not.toMatch(
      /chromeApi\.(cookies|scripting|identity|downloads)/,
    );
    expect(workerSource).not.toMatch(
      /\b(fetch|XMLHttpRequest|WebSocket|importScripts)\b\s*\(/,
    );
    expect(workerSource).not.toMatch(
      /debugger\.(attach|sendCommand)\(\s*\{\s*(extensionId|targetId)/,
    );
    // WHY: the explicit user-input route legitimately activates its exact
    // retained owner. A whole-file ban also rejected that authorized route.
    // The production wrapper → broker → worker test above asserts zero
    // activation for ordinary/unauthorized work and exact IDs for authorized
    // input; raw page activation and tab highlighting remain unsupported.
    expect(workerSource).not.toMatch(
      /chromeApi\.tabs\.highlight|Page\.bringToFront/,
    );
  });

  it("consumes one exact-profile click when its later challenge arrives", async () => {
    const fake = makeFake();
    const { bridge, port, hello } = await bootUnready(fake);
    const enrollmentA = "a".repeat(64);
    const challengeA = "b".repeat(64);

    fake.events.actionClicked.emit({ id: 1 });
    await flush();
    await bridge._test.settle();
    expect(
      port.sent.some((message) => message.type === "enrollment-intent"),
    ).toBe(false);

    port.receive({
      schema: SCHEMA,
      type: "enrollment-required",
      profileKey: hello.profileKey,
      connectionEpoch: hello.connectionEpoch,
      enrollmentId: enrollmentA,
      challenge: challengeA,
    });
    await flush();
    await bridge._test.settle();

    const intents = port.sent.filter(
      (message) => message.type === "enrollment-intent",
    );
    expect(intents).toEqual([
      {
        schema: SCHEMA,
        type: "enrollment-intent",
        profileKey: hello.profileKey,
        connectionEpoch: hello.connectionEpoch,
        enrollmentId: enrollmentA,
        challenge: challengeA,
      },
    ]);
    expect(fake.calls.actionSetBadgeText.at(-1)).toEqual({ text: "PAIR" });

    port.receive({
      schema: SCHEMA,
      type: "enrollment-required",
      profileKey: hello.profileKey,
      connectionEpoch: hello.connectionEpoch,
      enrollmentId: enrollmentA,
      challenge: challengeA,
    });
    await flush();
    await bridge._test.settle();
    expect(
      port.sent.filter((message) => message.type === "enrollment-intent"),
    ).toHaveLength(1);

    port.receive({
      schema: SCHEMA,
      type: "ready",
      profileKey: hello.profileKey,
      connectionEpoch: hello.connectionEpoch,
    });
    await flush();
    await bridge._test.settle();
    expect(bridge._test.enrollmentId).toBeNull();
    expect(bridge._test.enrollmentChallenge).toBeNull();
    expect(fake.calls.actionSetBadgeText.at(-1)).toEqual({ text: "" });
    expect(fake.calls.actionSetTitle.at(-1)).toEqual({
      title: "Agent Browser connected",
    });
  });

  it("arms a click synchronously while the native port is still absent", async () => {
    const fake = makeFake();
    const contract = loadContract();
    const bridge = contract.createBridge(fake.chrome, {
      crypto: deterministicCrypto(),
      now: () => 1_000,
    });
    bridge.start();
    expect(fake.ports).toHaveLength(0);
    fake.events.actionClicked.emit({ id: 1 });
    await flush();
    await bridge._test.settle();
    const port = fake.ports.at(-1);
    const hello = port.sent.find((message) => message.type === "hello");

    port.receive({
      schema: SCHEMA,
      type: "enrollment-required",
      profileKey: hello.profileKey,
      connectionEpoch: hello.connectionEpoch,
      enrollmentId: "c".repeat(64),
      challenge: "d".repeat(64),
    });
    await flush();
    await bridge._test.settle();
    expect(
      port.sent.filter((message) => message.type === "enrollment-intent"),
    ).toHaveLength(1);
  });

  it("retains an unconsumed click across MV3 worker reconstruction", async () => {
    const storage = { local: new Map(), session: new Map() };
    const firstFake = makeFake({ storage });
    const first = await bootUnready(firstFake);
    firstFake.events.actionClicked.emit({ id: 1 });
    await flush();
    await first.bridge._test.settle();

    const secondFake = makeFake({ storage });
    const second = await bootUnready(secondFake);
    second.port.receive({
      schema: SCHEMA,
      type: "enrollment-required",
      profileKey: second.hello.profileKey,
      connectionEpoch: second.hello.connectionEpoch,
      enrollmentId: "e".repeat(64),
      challenge: "f".repeat(64),
    });
    await flush();
    await second.bridge._test.settle();
    expect(
      second.port.sent.filter(
        (message) => message.type === "enrollment-intent",
      ),
    ).toHaveLength(1);
  });

  it("does not let wrong profile or epoch consume the click", async () => {
    const fake = makeFake();
    const { bridge, port, hello } = await bootUnready(fake);
    fake.events.actionClicked.emit({ id: 1 });
    await flush();
    await bridge._test.settle();

    port.receive({
      schema: SCHEMA,
      type: "enrollment-required",
      profileKey: "9".repeat(64),
      connectionEpoch: hello.connectionEpoch,
      enrollmentId: "a".repeat(64),
      challenge: "b".repeat(64),
    });
    await flush();
    await bridge._test.settle();
    expect(
      port.sent.some((message) => message.type === "enrollment-intent"),
    ).toBe(false);

    port.receive({
      schema: SCHEMA,
      type: "enrollment-required",
      profileKey: hello.profileKey,
      connectionEpoch: "8".repeat(64),
      enrollmentId: "c".repeat(64),
      challenge: "d".repeat(64),
    });
    await flush();
    await bridge._test.settle();
    expect(
      port.sent.some((message) => message.type === "enrollment-intent"),
    ).toBe(false);

    port.receive({
      schema: SCHEMA,
      type: "enrollment-required",
      profileKey: hello.profileKey,
      connectionEpoch: hello.connectionEpoch,
      enrollmentId: "e".repeat(64),
      challenge: "f".repeat(64),
    });
    await flush();
    await bridge._test.settle();
    expect(
      port.sent.filter((message) => message.type === "enrollment-intent"),
    ).toHaveLength(1);
  });

  it("expires an unconsumed click instead of applying it later", async () => {
    let now = 1_000;
    const fake = makeFake();
    const { bridge, contract, port, hello } = await bootUnready(fake, {
      now: () => now,
    });
    fake.events.actionClicked.emit({ id: 1 });
    await flush();
    await bridge._test.settle();
    now += contract.constants.ENROLLMENT_ACTION_TTL_MS;
    port.receive({
      schema: SCHEMA,
      type: "enrollment-required",
      profileKey: hello.profileKey,
      connectionEpoch: hello.connectionEpoch,
      enrollmentId: "a".repeat(64),
      challenge: "b".repeat(64),
    });
    await flush();
    await bridge._test.settle();
    expect(
      port.sent.some((message) => message.type === "enrollment-intent"),
    ).toBe(false);
    expect(
      fake.storage.session.get(
        contract.constants.ENROLLMENT_ACTION_STORAGE_KEY,
      ),
    ).toBeNull();
  });

  it("carries only an unbound click across reconnect to the fresh epoch", async () => {
    const fake = makeFake();
    const { bridge, port, hello, timers } = await bootUnready(fake);
    fake.events.actionClicked.emit({ id: 1 });
    await flush();
    await bridge._test.settle();
    port.receive({
      schema: SCHEMA,
      type: "enrollment-required",
      profileKey: hello.profileKey,
      connectionEpoch: hello.connectionEpoch,
      enrollmentId: "a".repeat(64),
      challenge: "b".repeat(64),
    });
    port.disconnect();
    await flush();
    await bridge._test.settle();
    expect(
      port.sent.some((message) => message.type === "enrollment-intent"),
    ).toBe(false);

    expect(timers.runNext()).toBe(true);
    await flush();
    await bridge._test.settle();
    const freshPort = fake.ports.at(-1);
    const freshHello = freshPort.sent.find(
      (message) => message.type === "hello",
    );
    expect(freshHello.connectionEpoch).not.toBe(hello.connectionEpoch);
    freshPort.receive({
      schema: SCHEMA,
      type: "enrollment-required",
      profileKey: freshHello.profileKey,
      connectionEpoch: freshHello.connectionEpoch,
      enrollmentId: "c".repeat(64),
      challenge: "d".repeat(64),
    });
    await flush();
    await bridge._test.settle();
    expect(
      freshPort.sent.filter((message) => message.type === "enrollment-intent"),
    ).toHaveLength(1);
  });

  it("cancels a queued click before its async drain and never sends", async () => {
    const fake = makeFake();
    const { bridge, port, hello } = await bootUnready(fake);
    const enrollment = "a".repeat(64);
    fake.events.actionClicked.emit({ id: 1 });
    await flush();
    await bridge._test.settle();

    port.receive({
      schema: SCHEMA,
      type: "enrollment-required",
      profileKey: hello.profileKey,
      connectionEpoch: hello.connectionEpoch,
      enrollmentId: enrollment,
      challenge: "b".repeat(64),
    });
    port.receive({
      schema: SCHEMA,
      type: "enrollment-cancelled",
      profileKey: hello.profileKey,
      connectionEpoch: hello.connectionEpoch,
      enrollmentId: enrollment,
    });
    await flush();
    await bridge._test.settle();
    expect(
      port.sent.some((message) => message.type === "enrollment-intent"),
    ).toBe(false);

    port.receive({
      schema: SCHEMA,
      type: "enrollment-required",
      profileKey: hello.profileKey,
      connectionEpoch: hello.connectionEpoch,
      enrollmentId: "c".repeat(64),
      challenge: "d".repeat(64),
    });
    await flush();
    await bridge._test.settle();
    expect(
      port.sent.some((message) => message.type === "enrollment-intent"),
    ).toBe(false);
  });

  it("single-flights startup, emits exact hello, rotates epochs, and bounds reconnect", async () => {
    const fake = makeFake();
    const persistedProfileBits = "a".repeat(64);
    fake.storage.local.set("profileKey", `profile_${persistedProfileBits}`);
    const timers = new FakeTimers();
    const contract = loadContract();
    const bridge = contract.createBridge(fake.chrome, {
      crypto: deterministicCrypto(),
      setTimeout: timers.setTimeout,
      clearTimeout: timers.clearTimeout,
      now: () => 1_000,
    });
    bridge.start();
    fake.events.startup.emit();
    fake.events.installed.emit();
    void bridge.ensureConnected();
    await flush();
    await bridge._test.settle();
    expect(fake.calls.connectNative).toEqual([HOST]);
    const first = fake.ports[0];
    const hello = first.sent[0];
    expect(hello).toEqual({
      schema: SCHEMA,
      type: "hello",
      profileKey: expect.stringMatching(/^[0-9a-f]{64}$/),
      connectionEpoch: expect.stringMatching(/^[0-9a-f]{64}$/),
      extensionVersion: "0.1.0",
    });
    expect(hello.profileKey).toBe(persistedProfileBits);
    expect(fake.storage.local.get("profileKey")).toBe(persistedProfileBits);
    first.receive({
      schema: SCHEMA,
      type: "ready",
      profileKey: hello.profileKey,
      connectionEpoch: hello.connectionEpoch,
    });
    first.disconnect();
    expect(timers.pending()).toBe(1);
    timers.runNext();
    await flush();
    const secondHello = fake.ports[1].sent[0];
    expect(secondHello.profileKey).toBe(hello.profileKey);
    expect(secondHello.connectionEpoch).not.toBe(hello.connectionEpoch);

    const stale = await request(
      bridge,
      first,
      hello,
      "state.inventory",
      {},
      { connectionEpoch: hello.connectionEpoch },
    );
    expect(stale).toMatchObject({
      ok: false,
      error: { code: "STALE_CONNECTION" },
    });

    fake.ports[1].disconnect();
    while (timers.pending()) {
      timers.runNext();
      await flush();
      fake.ports.at(-1).disconnect();
    }
    await bridge._test.settle();
    expect(fake.ports).toHaveLength(8);
    expect(bridge._test.reconnectAttempt).toBe(
      contract.constants.RECONNECT_DELAYS_MS.length,
    );
    expect(
      fake.state.alarms.get(contract.constants.RECONNECT_ALARM_NAME),
    ).toEqual({
      name: contract.constants.RECONNECT_ALARM_NAME,
      delayInMinutes: contract.constants.RECONNECT_ALARM_INTERVAL_MINUTES,
      periodInMinutes: contract.constants.RECONNECT_ALARM_INTERVAL_MINUTES,
    });

    fake.events.alarm.emit({ name: "unrelated-alarm" });
    await bridge._test.settle();
    expect(fake.ports).toHaveLength(8);

    fake.events.alarm.emit({ name: contract.constants.RECONNECT_ALARM_NAME });
    await flush();
    await bridge._test.settle();
    expect(fake.ports).toHaveLength(9);
    expect(fake.state.alarms.has(contract.constants.RECONNECT_ALARM_NAME)).toBe(
      true,
    );

    const stalledPort = fake.ports.at(-1);
    const stalledHello = stalledPort.sent[0];
    const preReady = await request(
      bridge,
      stalledPort,
      stalledHello,
      "state.inventory",
      {},
    );
    expect(preReady).toMatchObject({
      ok: false,
      error: { code: "NOT_READY" },
    });
    expect(fake.state.alarms.has(contract.constants.RECONNECT_ALARM_NAME)).toBe(
      true,
    );

    fake.events.alarm.emit({ name: contract.constants.RECONNECT_ALARM_NAME });
    await flush();
    await bridge._test.settle();
    expect(fake.ports).toHaveLength(10);
    expect(bridge._test.port).not.toBe(stalledPort);
    expect(fake.state.alarms.has(contract.constants.RECONNECT_ALARM_NAME)).toBe(
      true,
    );

    const alarmHello = fake.ports.at(-1).sent[0];
    fake.ports.at(-1).receive({
      schema: SCHEMA,
      type: "ready",
      profileKey: alarmHello.profileKey,
      connectionEpoch: alarmHello.connectionEpoch,
    });
    await bridge._test.settle();
    expect(fake.state.alarms.has(contract.constants.RECONNECT_ALARM_NAME)).toBe(
      false,
    );
  });

  it("creates one inactive root in an exact user window and rebinds only exact retained state", async () => {
    const fake = makeFake();
    const { bridge, port, hello } = await boot(fake);
    const first = await request(bridge, port, hello, "tab.create", {
      session: "session-a",
      url: "https://example.test/path",
    });
    expect(first).toMatchObject({ ok: true, result: { ownedWindow: false } });
    expect(first.result.tabId).toMatch(/^tab_[0-9a-f]{64}$/);
    expect(first.result.windowId).toMatch(/^window_[0-9a-f]{64}$/);
    expect(first.result.windowId).not.toBe("10");
    expect(fake.calls.tabsCreate).toEqual([
      { active: false, windowId: 10, url: "https://example.test/path" },
    ]);

    const retry = await request(bridge, port, hello, "tab.create", {
      session: "session-a",
      url: "https://different.test/",
    });
    expect(retry.result).toEqual(first.result);
    expect(fake.calls.tabsCreate).toHaveLength(1);

    const inventory = await request(bridge, port, hello, "state.inventory", {});
    expect(inventory.result).toEqual({
      sessions: [
        {
          session: "session-a",
          currentTab: first.result.tabId,
          rootTabId: first.result.tabId,
          tabIds: [first.result.tabId],
          windowId: first.result.windowId,
          ownedWindow: false,
          claimedCurrentTab: false,
        },
      ],
    });
    const rebound = await request(bridge, port, hello, "session.rebind", {
      session: "session-a",
      rootTabId: first.result.tabId,
      tabIds: [first.result.tabId],
    });
    expect(rebound.result).toEqual(first.result);
    const mismatch = await request(bridge, port, hello, "session.rebind", {
      session: "session-a",
      rootTabId: first.result.tabId,
      tabIds: [],
    });
    expect(mismatch).toMatchObject({
      ok: false,
      error: { code: "OWNERSHIP_MISMATCH" },
    });

    const denied = await request(bridge, port, hello, "tab.create", {
      session: "session-b",
      url: "chrome-extension://wallet-id/home.html",
    });
    expect(denied).toMatchObject({ ok: false, error: { code: "URL_DENIED" } });
    expect(fake.calls.tabsCreate).toHaveLength(1);
  });

  it("uses one exact-tab Viz frame only for the default PNG screenshot", async () => {
    const fake = makeFake();
    const { bridge, port, hello } = await boot(fake);
    const created = await request(bridge, port, hello, "tab.create", {
      session: "viz-screenshot",
      url: "https://example.test/viz",
    });
    expect(fake.events.debuggerEvent.listeners).toHaveLength(1);

    fake.setCommandHandler(({ target, method, params, state, events }) => {
      const tab = state.tabs.get(target.tabId);
      const frameId = `frame-${target.tabId}`;
      if (method === "Page.getFrameTree") {
        return { frameTree: { frame: { id: frameId, url: tab.url } } };
      }
      if (method === "Runtime.enable") {
        events.debuggerEvent.emit(
          { tabId: target.tabId },
          "Runtime.executionContextCreated",
          {
            context: {
              id: target.tabId + 50_000,
              auxData: { isDefault: true, frameId },
            },
          },
        );
        return {};
      }
      if (method === "Page.startScreencast") {
        expect(params).toEqual({ format: "png" });
        expect(events.debuggerEvent.listeners).toHaveLength(2);
        events.debuggerEvent.emit(
          { tabId: target.tabId + 1 },
          "Page.screencastFrame",
          { data: "foreign-tab-pixels", sessionId: 40, metadata: {} },
        );
        events.debuggerEvent.emit(
          { tabId: target.tabId, sessionId: "foreign-child" },
          "Page.screencastFrame",
          { data: "foreign-session-pixels", sessionId: 41, metadata: {} },
        );
        events.debuggerEvent.emit(
          { tabId: target.tabId },
          "Page.screencastFrame",
          { data: "exact-current-pixels", sessionId: 42, metadata: {} },
        );
        return {};
      }
      if (method === "Page.captureScreenshot") {
        return { data: "unchanged-old-path" };
      }
      return {};
    });

    const captured = await request(bridge, port, hello, "cdp.send", {
      session: "viz-screenshot",
      tabId: created.result.tabId,
      method: "Page.captureScreenshot",
      params: { format: "png", fromSurface: true },
    });
    expect(captured).toMatchObject({
      ok: true,
      result: { data: "exact-current-pixels" },
    });
    expect(
      fake.calls.debuggerSend
        .filter((call) =>
          [
            "Page.startScreencast",
            "Page.screencastFrameAck",
            "Page.stopScreencast",
          ].includes(call.method),
        )
        .map(({ target, method, params }) => ({ target, method, params })),
    ).toEqual([
      {
        target: { tabId: 1_000 },
        method: "Page.startScreencast",
        params: { format: "png" },
      },
      {
        target: { tabId: 1_000 },
        method: "Page.screencastFrameAck",
        params: { sessionId: 42 },
      },
      {
        target: { tabId: 1_000 },
        method: "Page.stopScreencast",
        params: {},
      },
    ]);
    expect(fake.events.debuggerEvent.listeners).toHaveLength(1);
    expect(
      port.sent.some(
        (message) =>
          message.type === "event" &&
          message.method === "Page.screencastFrame",
      ),
    ).toBe(false);

    const oldPath = await request(bridge, port, hello, "cdp.send", {
      session: "viz-screenshot",
      tabId: created.result.tabId,
      method: "Page.captureScreenshot",
      params: {},
    });
    expect(oldPath).toMatchObject({
      ok: true,
      result: { data: "unchanged-old-path" },
    });
    expect(
      fake.calls.debuggerSend.filter(
        (call) => call.method === "Page.captureScreenshot",
      ),
    ).toEqual([
      { target: { tabId: 1_000 }, method: "Page.captureScreenshot", params: {} },
    ]);

    const beforeDenied = fake.calls.debuggerSend.length;
    const denied = await request(bridge, port, hello, "cdp.send", {
      session: "viz-screenshot",
      tabId: created.result.tabId,
      method: "Page.startScreencast",
      params: { format: "png" },
    });
    expect(denied).toMatchObject({
      ok: false,
      error: { code: "CDP_METHOD_DENIED" },
    });
    expect(fake.calls.debuggerSend).toHaveLength(beforeDenied);
  });

  it.each([
    { format: "png", mode: "clip" },
    { format: "png", mode: "full" },
    { format: "jpeg", mode: "viewport", quality: 80 },
    { format: "jpeg", mode: "clip", quality: 0 },
    { format: "jpeg", mode: "full", quality: 100 },
  ])(
    "keeps Viz active through native $format $mode capture",
    async ({ format, mode, quality }) => {
      const fake = makeFake();
      const { bridge, port, hello } = await boot(fake);
      const created = await request(bridge, port, hello, "tab.create", {
        session: "native-viz",
        url: "https://example.test/tall",
      });
      const screenshotParams = {
        format,
        fromSurface: true,
        ...(quality === undefined ? {} : { quality }),
        ...(mode === "viewport"
          ? {}
          : {
              clip: {
                x: 0,
                y: mode === "full" ? 0 : 20,
                width: 1280,
                height: mode === "full" ? 2400 : 100,
                scale: 1,
              },
            }),
        ...(mode === "full" ? { captureBeyondViewport: true } : {}),
      };
      const captureCalls = [];
      fake.setCommandHandler(({ target, method, params, state, events }) => {
        const frameId = `frame-${target.tabId}`;
        if (method === "Page.getFrameTree")
          return {
            frameTree: {
              frame: { id: frameId, url: state.tabs.get(target.tabId).url },
            },
          };
        if (method === "Runtime.enable") {
          events.debuggerEvent.emit(target, "Runtime.executionContextCreated", {
            context: {
              id: target.tabId + 50_000,
              auxData: { isDefault: true, frameId },
            },
          });
        }
        if (
          [
            "Page.startScreencast",
            "Page.screencastFrameAck",
            "Page.captureScreenshot",
            "Page.stopScreencast",
          ].includes(method)
        ) {
          captureCalls.push({ target, method, params });
        }
        if (method === "Page.startScreencast") {
          events.debuggerEvent.emit(
            { tabId: target.tabId + 1 },
            "Page.screencastFrame",
            { data: "foreign", sessionId: 1 },
          );
          events.debuggerEvent.emit(
            { ...target, sessionId: "child" },
            "Page.screencastFrame",
            { data: "foreign", sessionId: 2 },
          );
          events.debuggerEvent.emit(target, "Page.screencastFrame", {
            data: "viewport-only",
            sessionId: 3,
          });
        }
        if (method === "Page.captureScreenshot") {
          expect(params).toEqual(screenshotParams);
          events.debuggerEvent.emit(target, "Page.screencastFrame", {
            data: "second-viewport",
            sessionId: 4,
          });
          return { data: "native-requested-pixels" };
        }
        return {};
      });
      const captured = await request(bridge, port, hello, "cdp.send", {
        session: "native-viz",
        tabId: created.result.tabId,
        method: "Page.captureScreenshot",
        params: screenshotParams,
      });
      expect(captured).toMatchObject({
        ok: true,
        result: { data: "native-requested-pixels" },
      });
      expect(captureCalls.map(({ method }) => method)).toEqual([
        "Page.startScreencast",
        "Page.screencastFrameAck",
        "Page.captureScreenshot",
        "Page.screencastFrameAck",
        "Page.stopScreencast",
      ]);
      expect(
        captureCalls
          .filter(({ method }) => method === "Page.screencastFrameAck")
          .map(({ params }) => params.sessionId),
      ).toEqual([3, 4]);
      expect(
        captureCalls.every(
          ({ target }) => target.tabId === 1000 && !target.sessionId,
        ),
      ).toBe(true);
      expect(fake.events.debuggerEvent.listeners).toHaveLength(1);
    },
  );

  it("bounds native full capture once and stops streaming after its timeout", async () => {
    const fake = makeFake();
    const timers = new FakeTimers();
    const { bridge, port, hello } = await boot(fake, { timers });
    const created = await request(bridge, port, hello, "tab.create", {
      session: "native-viz-timeout",
      url: "https://example.test/tall",
    });
    let resolveNative;
    fake.setCommandHandler(({ target, method, state, events }) => {
      const frameId = `frame-${target.tabId}`;
      if (method === "Page.getFrameTree")
        return {
          frameTree: {
            frame: { id: frameId, url: state.tabs.get(target.tabId).url },
          },
        };
      if (method === "Runtime.enable")
        events.debuggerEvent.emit(target, "Runtime.executionContextCreated", {
          context: {
            id: target.tabId + 50_000,
            auxData: { isDefault: true, frameId },
          },
        });
      if (method === "Page.startScreencast")
        events.debuggerEvent.emit(target, "Page.screencastFrame", {
          data: "viewport-only",
          sessionId: 1,
        });
      if (method === "Page.captureScreenshot")
        return new Promise((resolve) => {
          resolveNative = resolve;
        });
      return {};
    });
    const id = requestId();
    port.receive({
      schema: SCHEMA,
      type: "request",
      id,
      profileKey: hello.profileKey,
      connectionEpoch: hello.connectionEpoch,
      op: "cdp.send",
      args: {
        session: "native-viz-timeout",
        tabId: created.result.tabId,
        method: "Page.captureScreenshot",
        params: {
          format: "png",
          fromSurface: true,
          clip: { x: 0, y: 0, width: 1280, height: 2400, scale: 1 },
          captureBeyondViewport: true,
        },
      },
    });
    await flush(40);
    expect(resolveNative).toBeTypeOf("function");
    expect(timers.pending()).toBe(1);
    timers.runNext();
    await flush(40);
    await bridge._test.settle();
    expect(
      port.sent.find((m) => m.type === "response" && m.id === id),
    ).toMatchObject({
      ok: false,
      error: { code: "SCREENSHOT_TIMEOUT" },
    });
    expect(
      fake.calls.debuggerSend.filter((c) => c.method === "Page.stopScreencast"),
    ).toHaveLength(1);
    expect(fake.events.debuggerEvent.listeners).toHaveLength(1);
    expect(timers.pending()).toBe(0);
    resolveNative({ data: "late-pixels" });
    await flush(20);
    expect(
      port.sent.filter((m) => m.type === "response" && m.id === id),
    ).toHaveLength(1);
  });

  it("stops Viz capture while preserving a native start failure", async () => {
    const fake = makeFake();
    const { bridge, port, hello } = await boot(fake);
    const created = await request(bridge, port, hello, "tab.create", {
      session: "viz-native-failure",
      url: "https://example.test/viz-native-failure",
    });
    fake.setCommandHandler(({ target, method, state, events }) => {
      const tab = state.tabs.get(target.tabId);
      const frameId = `frame-${target.tabId}`;
      if (method === "Page.getFrameTree") {
        return { frameTree: { frame: { id: frameId, url: tab.url } } };
      }
      if (method === "Runtime.enable") {
        events.debuggerEvent.emit(
          { tabId: target.tabId },
          "Runtime.executionContextCreated",
          {
            context: {
              id: target.tabId + 50_000,
              auxData: { isDefault: true, frameId },
            },
          },
        );
        return {};
      }
      if (method === "Page.startScreencast") {
        throw new Error("native start rejected");
      }
      return {};
    });

    const result = await request(bridge, port, hello, "cdp.send", {
      session: "viz-native-failure",
      tabId: created.result.tabId,
      method: "Page.captureScreenshot",
      params: { format: "png", fromSurface: true },
    });
    expect(result).toMatchObject({
      ok: false,
      error: { code: "OPERATION_FAILED" },
    });
    expect(
      fake.calls.debuggerSend
        .filter((call) =>
          ["Page.startScreencast", "Page.stopScreencast"].includes(
            call.method,
          ),
        )
        .map((call) => call.method),
    ).toEqual(["Page.startScreencast", "Page.stopScreencast"]);
    expect(fake.events.debuggerEvent.listeners).toHaveLength(1);
  });

  it("bounds a missing Viz frame and still stops the exact tab", async () => {
    const fake = makeFake();
    const timers = new FakeTimers();
    const { bridge, port, hello } = await boot(fake, { timers });
    const created = await request(bridge, port, hello, "tab.create", {
      session: "viz-frame-timeout",
      url: "https://example.test/viz-frame-timeout",
    });
    fake.setCommandHandler(({ target, method, state, events }) => {
      const tab = state.tabs.get(target.tabId);
      const frameId = `frame-${target.tabId}`;
      if (method === "Page.getFrameTree") {
        return { frameTree: { frame: { id: frameId, url: tab.url } } };
      }
      if (method === "Runtime.enable") {
        events.debuggerEvent.emit(
          { tabId: target.tabId },
          "Runtime.executionContextCreated",
          {
            context: {
              id: target.tabId + 50_000,
              auxData: { isDefault: true, frameId },
            },
          },
        );
      }
      return {};
    });

    const id = requestId();
    port.receive({
      schema: SCHEMA,
      type: "request",
      id,
      profileKey: hello.profileKey,
      connectionEpoch: hello.connectionEpoch,
      op: "cdp.send",
      args: {
        session: "viz-frame-timeout",
        tabId: created.result.tabId,
        method: "Page.captureScreenshot",
        params: { format: "png", fromSurface: true },
      },
    });
    await flush(30);
    expect(
      port.sent.find(
        (message) => message.type === "response" && message.id === id,
      ),
    ).toBeUndefined();
    expect(timers.pending()).toBe(1);
    expect(timers.runNext()).toBe(true);
    await flush(30);
    await bridge._test.settle();
    const response = port.sent.find(
      (message) => message.type === "response" && message.id === id,
    );
    expect(response).toMatchObject({
      ok: false,
      error: { code: "SCREENCAST_FRAME_TIMEOUT" },
    });
    expect(
      fake.calls.debuggerSend
        .filter((call) =>
          ["Page.startScreencast", "Page.stopScreencast"].includes(
            call.method,
          ),
        )
        .map((call) => call.method),
    ).toEqual(["Page.startScreencast", "Page.stopScreencast"]);
    expect(fake.events.debuggerEvent.listeners).toHaveLength(1);
  });

  it("does not let one stalled page command block another session from opening", async () => {
    const fake = makeFake();
    const { bridge, port, hello } = await boot(fake);
    const first = await request(bridge, port, hello, "tab.create", {
      session: "stalled-session",
      url: "https://example.test/first",
    });

    let releaseScreenshot;
    const screenshotBarrier = new Promise((resolve) => {
      releaseScreenshot = resolve;
    });
    fake.setCommandHandler(async ({ target, method, params, state, events }) => {
      const tab = state.tabs.get(target.tabId);
      if (method === "Page.captureScreenshot" && target.tabId === 1_000) {
        return screenshotBarrier;
      }
      const frameId = `frame-${target.tabId}`;
      if (method === "Page.getFrameTree") {
        return { frameTree: { frame: { id: frameId, url: tab.url } } };
      }
      if (method === "Runtime.enable") {
        events.debuggerEvent.emit(
          { tabId: target.tabId },
          "Runtime.executionContextCreated",
          {
            context: {
              id: target.tabId + 50_000,
              auxData: { isDefault: true, frameId },
            },
          },
        );
      }
      if (method === "Page.navigate") tab.url = params.url;
      return {};
    });

    const stalledId = requestId();
    port.receive({
      schema: SCHEMA,
      type: "request",
      id: stalledId,
      profileKey: hello.profileKey,
      connectionEpoch: hello.connectionEpoch,
      op: "cdp.send",
      args: {
        session: "stalled-session",
        tabId: first.result.tabId,
        method: "Page.captureScreenshot",
        params: {},
      },
    });
    await flush(20);

    const secondId = requestId();
    port.receive({
      schema: SCHEMA,
      type: "request",
      id: secondId,
      profileKey: hello.profileKey,
      connectionEpoch: hello.connectionEpoch,
      op: "tab.create",
      args: {
        session: "independent-session",
        url: "https://example.test/second",
      },
    });
    await flush(50);
    const second = port.sent.find(
      (message) => message.type === "response" && message.id === secondId,
    );
    expect(second).toMatchObject({ ok: true });
    expect(
      port.sent.find(
        (message) => message.type === "response" && message.id === stalledId,
      ),
    ).toBeUndefined();

    releaseScreenshot({ data: "fixture" });
    await flush(20);
    await bridge._test.settle();
    expect(
      port.sent.find(
        (message) => message.type === "response" && message.id === stalledId,
      ),
    ).toMatchObject({ ok: true, result: { data: "fixture" } });
  });

  it("lets exact session teardown preempt its own stalled Chrome command", async () => {
    const fake = makeFake();
    const { bridge, port, hello } = await boot(fake);
    const created = await request(bridge, port, hello, "tab.create", {
      session: "stalled-close",
      url: "about:blank",
    });
    let releaseScreenshot;
    const screenshotBarrier = new Promise((resolve) => {
      releaseScreenshot = resolve;
    });
    fake.setCommandHandler(async ({ method }) => {
      if (method === "Page.captureScreenshot") return screenshotBarrier;
      return {};
    });

    const cdpId = requestId();
    port.receive({
      schema: SCHEMA,
      type: "request",
      id: cdpId,
      profileKey: hello.profileKey,
      connectionEpoch: hello.connectionEpoch,
      op: "cdp.send",
      args: {
        session: "stalled-close",
        tabId: created.result.tabId,
        method: "Page.captureScreenshot",
        params: {},
      },
    });
    await flush(20);

    const closeId = requestId();
    port.receive({
      schema: SCHEMA,
      type: "request",
      id: closeId,
      profileKey: hello.profileKey,
      connectionEpoch: hello.connectionEpoch,
      op: "session.close",
      args: {
        session: "stalled-close",
        tabIds: [created.result.tabId],
      },
    });
    await flush(30);
    expect(
      port.sent.find(
        (message) => message.type === "response" && message.id === closeId,
      ),
    ).toMatchObject({ ok: true });
    expect(
      port.sent.find(
        (message) => message.type === "response" && message.id === cdpId,
      ),
    ).toBeUndefined();
    expect(bridge._test.inventory()).toEqual({ sessions: [] });

    releaseScreenshot({ data: "too-late" });
    await flush(30);
    await bridge._test.settle();
    expect(
      port.sent.find(
        (message) => message.type === "response" && message.id === cdpId,
      ),
    ).toMatchObject({ ok: false, error: { code: "TAB_NOT_OWNED" } });
  });

  it("admits exact session teardown after sixty-four page requests fill capacity", async () => {
    const fake = makeFake();
    const { bridge, port, hello } = await boot(fake);
    const created = await request(bridge, port, hello, "tab.create", {
      session: "capacity-close",
      url: "about:blank",
    });
    let releaseScreenshot;
    const screenshotBarrier = new Promise((resolve) => {
      releaseScreenshot = resolve;
    });
    fake.setCommandHandler(async ({ method }) => {
      if (method === "Page.captureScreenshot") return screenshotBarrier;
      return {};
    });

    for (let index = 0; index < 64; index += 1) {
      port.receive({
        schema: SCHEMA,
        type: "request",
        id: requestId(),
        profileKey: hello.profileKey,
        connectionEpoch: hello.connectionEpoch,
        op: "cdp.send",
        args: {
          session: "capacity-close",
          tabId: created.result.tabId,
          method: "Page.captureScreenshot",
          params: {},
        },
      });
    }
    await flush(20);

    const boundedId = requestId();
    port.receive({
      schema: SCHEMA,
      type: "request",
      id: boundedId,
      profileKey: hello.profileKey,
      connectionEpoch: hello.connectionEpoch,
      op: "state.inventory",
      args: {},
    });
    const closeId = requestId();
    port.receive({
      schema: SCHEMA,
      type: "request",
      id: closeId,
      profileKey: hello.profileKey,
      connectionEpoch: hello.connectionEpoch,
      op: "session.close",
      args: {
        session: "capacity-close",
        tabIds: [created.result.tabId],
      },
    });
    await flush(30);

    try {
      expect(
        port.sent.find(
          (message) => message.type === "response" && message.id === boundedId,
        ),
      ).toMatchObject({
        ok: false,
        error: { code: "TOO_MANY_REQUESTS" },
      });
      expect(
        port.sent.find(
          (message) => message.type === "response" && message.id === closeId,
        ),
      ).toMatchObject({ ok: true });
      expect(bridge._test.inventory()).toEqual({ sessions: [] });
    } finally {
      releaseScreenshot({ data: "too-late" });
      await flush(30);
      await bridge._test.settle();
    }
  });

  it("keeps an old in-flight create inert when it finishes after a reconnect", async () => {
    const fake = makeFake();
    let releaseCreate;
    fake.setTabCreateBarrier(
      new Promise((resolve) => {
        releaseCreate = resolve;
      }),
    );
    const { bridge, port, hello, timers } = await boot(fake);
    const id = requestId();
    port.receive({
      schema: SCHEMA,
      type: "request",
      id,
      profileKey: hello.profileKey,
      connectionEpoch: hello.connectionEpoch,
      op: "tab.create",
      args: { session: "late-create", url: "about:blank" },
    });
    await flush();
    expect(fake.calls.tabsCreate).toHaveLength(1);

    port.disconnect();
    timers.runNext();
    await flush();
    const nextPort = fake.ports.at(-1);
    const nextHello = nextPort.sent[0];
    nextPort.receive({
      schema: SCHEMA,
      type: "ready",
      profileKey: nextHello.profileKey,
      connectionEpoch: nextHello.connectionEpoch,
    });
    releaseCreate();
    await flush(30);
    await bridge._test.settle();

    const inventory = await request(
      bridge,
      nextPort,
      nextHello,
      "state.inventory",
      {},
    );
    const retained = inventory.result.sessions[0];
    expect(retained.session).toBe("late-create");
    const denied = await request(bridge, nextPort, nextHello, "cdp.send", {
      session: "late-create",
      tabId: retained.rootTabId,
      method: "Page.reload",
      params: {},
    });
    expect(denied).toMatchObject({
      ok: false,
      error: { code: "REBIND_REQUIRED" },
    });
  });

  it("retires an exact launch that Chrome completes after its broker deadline", async () => {
    const fake = makeFake();
    let releaseCreate;
    fake.setTabCreateBarrier(
      new Promise((resolve) => {
        releaseCreate = resolve;
      }),
    );
    let now = 1_000;
    const { bridge, port, hello } = await boot(fake, { now: () => now });
    const id = requestId();
    port.receive({
      schema: SCHEMA,
      type: "request",
      id,
      profileKey: hello.profileKey,
      connectionEpoch: hello.connectionEpoch,
      deadlineAt: 1_050,
      op: "tab.create",
      args: { session: "expired-create", url: "about:blank" },
    });
    await flush(20);
    expect(fake.calls.tabsCreate).toHaveLength(1);

    now = 1_100;
    releaseCreate();
    await flush(30);
    await bridge._test.settle();
    const response = port.sent.find(
      (message) => message.type === "response" && message.id === id,
    );
    expect(response).toMatchObject({
      ok: false,
      error: { code: "REQUEST_EXPIRED" },
    });
    expect(bridge._test.inventory()).toEqual({ sessions: [] });
    expect(fake.calls.tabsRemove).toEqual([1_000]);
  });

  it("lazily reuses one minimized owned window and closes it only after its last session", async () => {
    const fake = makeFake({
      windows: [],
      tabs: [],
      emitDetachSynchronously: true,
    });
    const { bridge, port, hello } = await boot(fake);
    const a = await request(bridge, port, hello, "tab.create", {
      session: "session-a",
      url: "about:blank",
    });
    const b = await request(bridge, port, hello, "tab.create", {
      session: "session-b",
      url: "https://example.test/",
    });
    expect(fake.calls.windowsCreate).toEqual([
      { url: "about:blank", focused: false, state: "minimized" },
    ]);
    expect(fake.calls.tabsCreate).toHaveLength(2);
    expect(
      fake.calls.tabsCreate.every(
        (call) => call.active === false && call.windowId === 900,
      ),
    ).toBe(true);
    expect(a.result).toMatchObject({ ownedWindow: true });
    expect(b.result.windowId).toBe(a.result.windowId);

    const closeA = await request(bridge, port, hello, "session.close", {
      session: "session-a",
      tabIds: [a.result.tabId],
    });
    expect(closeA.result.closedWindowIds).toEqual([]);
    expect(fake.calls.windowsRemove).toEqual([]);
    const closeB = await request(bridge, port, hello, "session.close", {
      session: "session-b",
      tabIds: [b.result.tabId],
    });
    expect(fake.calls.windowsRemove).toEqual([]);
    expect(closeB.result.closedWindowIds).toEqual([]);

    // WHY: the close response must cross the native port before last-window
    // cleanup is allowed to tear that same port down.
    const cleanup = await request(bridge, port, hello, "window.cleanup", {});
    expect(fake.calls.windowsRemove).toEqual([900]);
    expect(cleanup.result.closedWindowIds).toEqual([a.result.windowId]);
  });

  it("never removes an owned window after a foreign cross-window tab contaminates it", async () => {
    const fake = makeFake({ windows: [], tabs: [] });
    const { bridge, port, hello } = await boot(fake);
    const created = await request(bridge, port, hello, "tab.create", {
      session: "session-a",
      url: "https://example.test/",
    });
    const sentinelId = 1_000;
    const foreignId = 7_777;
    fake.addTab(
      {
        id: foreignId,
        windowId: 900,
        active: false,
        url: "https://foreign.test/",
      },
      false,
    );
    const closed = await request(bridge, port, hello, "session.close", {
      session: "session-a",
      tabIds: [created.result.tabId],
    });
    expect(closed.result.closedWindowIds).toEqual([]);
    expect(fake.calls.windowsRemove).toEqual([]);
    const cleanup = await request(bridge, port, hello, "window.cleanup", {});
    expect(cleanup.result.closedWindowIds).toEqual([]);
    expect(fake.calls.tabsRemove).toContain(sentinelId);
    expect(fake.calls.tabsRemove).not.toContain(foreignId);
    expect(fake.state.tabs.has(foreignId)).toBe(true);

    const next = await request(bridge, port, hello, "tab.create", {
      session: "session-b",
      url: "about:blank",
    });
    expect(next.result.ownedWindow).toBe(true);
    expect(fake.calls.windowsCreate).toHaveLength(2);
    expect(fake.calls.tabsCreate.at(-1).windowId).toBe(901);
  });

  it("cleans the exact minimized window when the user closes its last owned tab", async () => {
    const fake = makeFake({ windows: [], tabs: [] });
    const { bridge, port, hello } = await boot(fake);
    await request(bridge, port, hello, "tab.create", {
      session: "user-close",
      url: "about:blank",
    });
    await fake.chrome.tabs.remove(1_001);
    await flush(30);
    await bridge._test.settle();
    expect(fake.calls.windowsRemove).toEqual([900]);
    expect(bridge._test.inventory()).toEqual({ sessions: [] });
  });

  it("emits each exact revoke once across window/tab/detach callback orders", async () => {
    async function runOrder(windowFirst) {
      const fake = makeFake();
      const { bridge, port, hello } = await boot(fake);
      const created = await request(bridge, port, hello, "tab.create", {
        session: windowFirst ? "window-first" : "tabs-first",
        url: "about:blank",
      });
fake.addTab({
        id: 2_001,
        windowId: 10,
        active: false,
        openerTabId: 1_000,
        url: "about:blank",
      }, true, 1_000);
      await flush(20);
      await bridge._test.settle();
      const owned = bridge._test.inventory().sessions[0];
      const child = owned.tabIds.find((tabId) => tabId !== created.result.tabId);

      if (windowFirst) fake.events.windowRemoved.emit(10);
      fake.events.tabRemoved.emit(1_000, { isWindowClosing: true });
      fake.events.tabRemoved.emit(2_001, { isWindowClosing: true });
      if (!windowFirst) fake.events.windowRemoved.emit(10);
      fake.events.debuggerDetach.emit({ tabId: 1_000 }, "target_closed");
      fake.events.debuggerDetach.emit({ tabId: 2_001 }, "target_closed");
      await flush(30);
      await bridge._test.settle();

      const revoked = port.sent.filter(
        (message) =>
          message.type === "event" &&
          message.method === "AgentBrowser.tabRevoked",
      );
      expect(revoked.map((message) => message.tabId).sort()).toEqual(
        [created.result.tabId, child].sort(),
      );
      expect(new Set(revoked.map((message) => message.tabId)).size).toBe(2);
      expect(bridge._test.inventory()).toEqual({ sessions: [] });
    }

    await runOrder(true);
    await runOrder(false);
  });

  it("allows gone requested handles but still rejects omission of a live descendant", async () => {
    const fake = makeFake();
    const { bridge, port, hello } = await boot(fake);
    const created = await request(bridge, port, hello, "tab.create", {
      session: "stale-close-set",
      url: "about:blank",
    });
fake.addTab({
      id: 2_001,
      windowId: 10,
      active: false,
      openerTabId: 1_000,
      url: "about:blank",
    }, true, 1_000);
    await flush(20);
    await bridge._test.settle();
    const owned = bridge._test.inventory().sessions[0];
    const child = owned.tabIds.find((tabId) => tabId !== created.result.tabId);

    fake.events.debuggerDetach.emit({ tabId: 1_000 }, "canceled_by_user");
    await flush(20);
    await bridge._test.settle();

    const omitted = await request(bridge, port, hello, "session.close", {
      session: "stale-close-set",
      tabIds: [created.result.tabId],
    });
    expect(omitted).toMatchObject({
      ok: false,
      error: { code: "OWNERSHIP_MISMATCH" },
    });
    const closed = await request(bridge, port, hello, "session.close", {
      session: "stale-close-set",
      tabIds: [created.result.tabId, child],
    });
    expect(closed).toMatchObject({
      ok: true,
      result: { closedTabIds: [child] },
    });
    expect(bridge._test.inventory()).toEqual({ sessions: [] });
  });

  it("classifies initial claim denial without leaking raw target or debugger data", async () => {
    // R94: every preflight failure became TARGET_DENIED after the real nonce
    // fixture was focused. A fixed discriminator must survive the actual worker
    // dispatcher while retaining failure, detach and user-tab survival.
    const cases = [
      { tab: { url: "chrome-extension://private.invalid/hidden" }, code: "METADATA_URL_EXTENSION" },
      { tab: { pendingUrl: "file:///private-hidden" }, code: "METADATA_PENDING_FILE" },
      { tab: { incognito: true }, code: "METADATA_INCOGNITO" },
      { stage: "debugger.attach", message: "Cannot attach to this target.", code: "ATTACH_RESTRICTED" },
      { stage: "debugger.attach", message: "Another debugger is already attached to the tab with id: 123.", code: "ATTACH_ALREADY_ATTACHED" },
      { stage: "debugger.attach", message: "No tab with given id 123.", code: "ATTACH_NO_TARGET" },
      { stage: "debugger.attach", message: "private-hidden native error", code: "ATTACH_OTHER" },
      { stage: "Page.getFrameTree", message: '{"code":-32601,"message":"private-hidden"}', code: "FRAME_TREE_CDP_METHOD" },
      { frame: {}, code: "VALIDATE_FRAME_MISSING" },
      { frame: { frameTree: { frame: { url: "https://example.test" } } }, code: "VALIDATE_FRAME_ID" },
      { frame: { frameTree: { frame: { id: "f", url: "" } } }, code: "VALIDATE_URL_EMPTY" },
      { frame: { frameTree: { frame: { id: "f" } } }, code: "VALIDATE_URL_MISSING" },
      { frame: { frameTree: { frame: { id: "f", url: "chrome://private-hidden" } } }, code: "VALIDATE_URL_CHROME" },
      { stage: "Emulation.setFocusEmulationEnabled", message: '{"code":-32602,"message":"private-hidden"}', code: "EMULATION_CDP_PARAMS" },
      { stage: "Page.enable", message: "Debugger is not attached to the tab with id: 123.", code: "PAGE_ENABLE_NOT_ATTACHED" },
      { stage: "Runtime.enable", message: "Detached while handling command.", code: "RUNTIME_ENABLE_DETACHED" },
    ];
    for (const item of cases) {
      const fake = makeFake({ tabs: [{ id: 1, windowId: 10, active: true, url: "https://example.test/", ...item.tab }] });
      if (item.stage === "debugger.attach") {
        const attach = fake.chrome.debugger.attach;
        fake.chrome.debugger.attach = async (...args) => { await attach(...args); throw new Error(item.message); };
      }
      fake.setCommandHandler(({ method }) => {
        if (method === item.stage) throw new Error(item.message);
        if (method === "Page.getFrameTree") return item.frame ?? { frameTree: { frame: { id: "f", url: "https://example.test/" } } };
        return {};
      });
      const { bridge, port, hello } = await boot(fake);
      await request(bridge, port, hello, "focus.snapshot", {});
      const response = await request(bridge, port, hello, "tab.claim-active", { session: "claim-diagnostic" });
      expect(response).toMatchObject({ ok: false, error: { code: "TARGET_DENIED_CLAIM_" + item.code } });
      expect(boundedError(response.error.code).code).toBe(response.error.code);
      expect(JSON.stringify(response)).not.toContain("private-hidden");
      expect(JSON.stringify(response)).not.toContain("private.invalid");
      expect(fake.calls.tabsRemove).toEqual([]);
      expect(fake.calls.windowsUpdate).toEqual([]);
      expect(fake.calls.tabsUpdate).toEqual([]);
      expect(bridge._test.inventory()).toEqual({ sessions: [] });
      expect(fake.calls.debuggerDetach).toHaveLength(item.tab || item.stage === "debugger.attach" ? 0 : 1);
    }
  });

  it("claims only a one-shot unchanged focused user tab and post-validates restricted targets", async () => {
    const fake = makeFake({
      windows: [
        { id: 10, type: "normal", focused: true, state: "normal" },
        { id: 20, type: "normal", focused: false, state: "normal" },
      ],
      tabs: [
        { id: 1, windowId: 10, active: true, url: "https://one.test/" },
        { id: 2, windowId: 20, active: true, url: "https://two.test/" },
      ],
    });
    const { bridge, port, hello } = await boot(fake);
    const snapshot = await request(bridge, port, hello, "focus.snapshot", {});
    expect(snapshot.result).toEqual({ claimable: true });
    fake.focus(20, 2);
    const moved = await request(bridge, port, hello, "tab.claim-active", {
      session: "focus-a",
    });
    expect(moved).toMatchObject({
      ok: false,
      error: { code: "FOCUS_CHANGED" },
    });
    expect(fake.calls.debuggerAttach).toHaveLength(0);

    await request(bridge, port, hello, "focus.snapshot", {});
    const claimed = await request(bridge, port, hello, "tab.claim-active", {
      session: "focus-a",
    });
    expect(claimed).toMatchObject({ ok: true, result: { ownedWindow: false } });
    expect(fake.calls.debuggerAttach.at(-1).target).toEqual({ tabId: 2 });

    await request(bridge, port, hello, "focus.snapshot", {});
    const otherSession = await request(
      bridge,
      port,
      hello,
      "tab.claim-active",
      { session: "focus-b" },
    );
    expect(otherSession).toMatchObject({
      // Exact fresh --current-tab invitations now share only a USER root.
      ok: true,
      result: { sharedUserTab: claimed.result.sharedUserTab, ownedWindow: false },
    });
    expect(otherSession.result.tabId).not.toBe(claimed.result.tabId);
    expect(fake.calls.debuggerAttach).toHaveLength(1);

    const restrictedFake = makeFake({
      tabs: [
        {
          id: 55,
          windowId: 10,
          active: true,
          url: "chrome-extension://own-id/page.html",
        },
      ],
      omitQueryUrls: true,
    });
    const restricted = await boot(restrictedFake);
    await request(
      restricted.bridge,
      restricted.port,
      restricted.hello,
      "focus.snapshot",
      {},
    );
    const denied = await request(
      restricted.bridge,
      restricted.port,
      restricted.hello,
      "tab.claim-active",
      { session: "restricted" },
    );
    expect(denied).toMatchObject({
      ok: false,
      error: { code: "TARGET_DENIED_CLAIM_VALIDATE_URL_EXTENSION" },
    });
    expect(restrictedFake.calls.debuggerAttach).toEqual([
      { target: { tabId: 55 }, version: "1.3" },
    ]);
    expect(
      restrictedFake.calls.debuggerSend.map((call) => call.method),
    ).toEqual(["Page.getFrameTree"]);
    expect(restrictedFake.calls.debuggerDetach).toContainEqual({ tabId: 55 });
  });

  it("shared user participants fence input generations and detach only the last member", async () => {
    const fake = makeFake({ emitDetachSynchronously: true });
    const { bridge, port, hello } = await boot(fake);
    const ask = (op, args) => request(bridge, port, hello, op, args);
    await ask("focus.snapshot", {});
    const a = (await ask("tab.claim-active", { session: "shared-a" })).result;
    expect((await ask("tab.claim-active", { session: "shared-b" })).ok).toBe(false);
    await ask("focus.snapshot", {});
    const b = (await ask("tab.claim-active", { session: "shared-b" })).result;
    expect(a.tabId).not.toBe(b.tabId);
    expect(a.sharedUserTab).toBe(b.sharedUserTab);
    expect(fake.calls.debuggerAttach).toHaveLength(1);
    const ca = "a".repeat(64), cb = "b".repeat(64);
    expect((await ask("command.begin", { session: "shared-a", tabId: a.tabId, command: ca })).ok).toBe(true);
    const send = (session, tab, command, text) => ask("cdp.send", {
      session, tabId: tab.tabId, command, method: "Input.insertText", params: { text },
    });
    expect((await send("shared-a", a, ca, "A-first")).ok).toBe(true);
    expect((await ask("command.begin", { session: "shared-b", tabId: b.tabId, command: cb })).ok).toBe(false);
    expect((await send("shared-b", b, cb, "B-interleaved")).ok).toBe(false);
    expect((await send("shared-a", a, undefined, "warm-bypass")).ok).toBe(false);
    expect((await send("shared-a", a, ca, "A-last")).ok).toBe(true);
    expect((await ask("command.end", { session: "shared-a", tabId: a.tabId, command: ca })).ok).toBe(true);
    expect((await ask("command.begin", { session: "shared-b", tabId: b.tabId, command: cb })).ok).toBe(true);
    expect((await send("shared-a", a, ca, "stale-A")).ok).toBe(false);
    expect((await send("shared-b", b, cb, "B-only")).ok).toBe(true);
    const inputs = fake.calls.debuggerSend.filter((call) => call.method === "Input.insertText");
    expect(inputs.map((call) => call.params.text)).toEqual(["A-first", "A-last", "B-only"]);
    await ask("session.close", { session: "shared-a", tabIds: [a.tabId] });
    expect(fake.calls.debuggerDetach).toHaveLength(0);
    expect(fake.calls.tabsRemove).toEqual([]);
    expect((await send("shared-b", b, cb, "B-survives")).ok).toBe(true);
    const sameContext = await ask("cdp.send", { session: "shared-b", tabId: b.tabId, command: cb,
      method: "Runtime.evaluate", params: { expression: "document.title", returnByValue: true } });
    expect(sameContext.ok).toBe(true);
    expect(fake.calls.debuggerSend.at(-1).params.contextId).toBe(50001);
    await ask("session.close", { session: "shared-b", tabIds: [b.tabId] });
    expect(fake.calls.debuggerDetach).toEqual([{ tabId: 1 }]);
    expect(fake.calls.tabsRemove).toEqual([]);
    expect(fake.state.tabs.has(1)).toBe(true);
  });

  it("shared user join rejects a focused task root and fans events to exact surviving participants", async () => {
    const fake = makeFake();
    const { bridge, port, hello } = await boot(fake);
    const ask = (op, args) => request(bridge, port, hello, op, args);
    const task = (await ask("tab.create", { session: "task-owner", url: "https://example.test/" })).result;
    const created = fake.calls.tabsCreate.at(-1);
    const taskId = [...fake.state.tabs.values()].find((tab) => tab.id >= 1000 && tab.url === created.url)?.id;
    fake.focus(fake.state.tabs.get(taskId).windowId, taskId);
    await ask("focus.snapshot", {});
    expect((await ask("tab.claim-active", { session: "intruder" })).ok).toBe(false);
    fake.focus(10, 1);
    await ask("focus.snapshot", {});
    const a = (await ask("tab.claim-active", { session: "shared-a" })).result;
    await ask("focus.snapshot", {});
    const b = (await ask("tab.claim-active", { session: "shared-b" })).result;
    port.sent.length = 0;
    fake.events.debuggerEvent.emit({ tabId: 1 }, "Page.loadEventFired", { timestamp: 1 });
    await flush();
    expect(port.sent.filter((message) => message.type === "event").map((message) => message.tabId).sort())
      .toEqual([a.tabId, b.tabId].sort());
    await ask("session.close", { session: "shared-a", tabIds: [a.tabId] });
    port.sent.length = 0;
    fake.events.debuggerEvent.emit({ tabId: 1 }, "Page.loadEventFired", { timestamp: 2 });
    await flush();
    expect(port.sent.filter((message) => message.type === "event").map((message) => message.tabId)).toEqual([b.tabId]);
    fake.events.tabRemoved.emit(1);
    await flush();
    expect(bridge._test.inventory().sessions.map((session) => session.session)).toEqual(["task-owner"]);
    expect(fake.calls.tabsRemove).toEqual([]);
    expect(fake.storage.session.get("agentBrowserOwnershipV1").tabs.find((tab) => tab.tabId === task.tabId)
      .createdByExtension).toBe(true);
  });

  it("shared user participants preserve domain subscriptions and reject old transport generations after rebind", async () => {
    const fake = makeFake();
    const first = await boot(fake);
    const ask = (op, args) => request(first.bridge, first.port, first.hello, op, args);
    await ask("focus.snapshot", {});
    const a = (await ask("tab.claim-active", { session: "shared-a" })).result;
    await ask("focus.snapshot", {});
    const b = (await ask("tab.claim-active", { session: "shared-b" })).result;
    const ca = "a".repeat(64), cb = "b".repeat(64);
    await ask("command.begin", { session: "shared-a", tabId: a.tabId, command: ca });
    await ask("cdp.send", { session: "shared-a", tabId: a.tabId, command: ca, method: "DOM.enable" });
    await ask("command.end", { session: "shared-a", tabId: a.tabId, command: ca });
    await ask("command.begin", { session: "shared-b", tabId: b.tabId, command: cb });
    await ask("cdp.send", { session: "shared-b", tabId: b.tabId, command: cb, method: "DOM.enable" });
    await ask("cdp.send", { session: "shared-b", tabId: b.tabId, command: cb, method: "DOM.disable" });
    expect(fake.calls.debuggerSend.filter((call) => call.method === "DOM.disable")).toEqual([]);
    const restoredFake = makeFake({ storage: fake.storage });
    const restored = await boot(restoredFake);
    const next = (op, args) => request(restored.bridge, restored.port, restored.hello, op, args);
    expect(restored.bridge._test.inventory().sessions).toHaveLength(2);
    expect((await next("command.begin", { session: "shared-b", tabId: b.tabId, command: cb })).ok).toBe(false);
    expect((await next("session.rebind", { session: "shared-b", rootTabId: b.tabId, tabIds: [b.tabId] })).ok).toBe(true);
    const cc = "c".repeat(64);
    expect((await next("command.begin", { session: "shared-b", tabId: b.tabId, command: cc })).ok).toBe(true);
    expect((await next("cdp.send", { session: "shared-b", tabId: b.tabId, command: cb,
      method: "Input.insertText", params: { text: "old" } })).ok).toBe(false);
    expect((await next("cdp.send", { session: "shared-b", tabId: b.tabId, command: cc,
      method: "Input.insertText", params: { text: "new" } })).ok).toBe(true);
    expect(restoredFake.calls.debuggerAttach).toHaveLength(1);
    expect(restoredFake.calls.tabsCreate).toEqual([]);
  });

  it("never closes a claimed current tab through session close, direct close, or rebind", async () => {
    async function claimCurrent(fake, session) {
      const running = await boot(fake);
      await request(
        running.bridge,
        running.port,
        running.hello,
        "focus.snapshot",
        {},
      );
      const claimed = await request(
        running.bridge,
        running.port,
        running.hello,
        "tab.claim-active",
        { session },
      );
      return { ...running, claimed };
    }

    const sessionFake = makeFake();
    const sessionClaim = await claimCurrent(sessionFake, "claimed-session");
    const persistedClaim = sessionFake.storage.session.get(
      "agentBrowserOwnershipV1",
    );
    expect(persistedClaim.tabs).toHaveLength(1);
    expect(persistedClaim.tabs[0].createdByExtension).toBe(false);
    const sessionClosed = await request(
      sessionClaim.bridge,
      sessionClaim.port,
      sessionClaim.hello,
      "session.close",
      {
        session: "claimed-session",
        tabIds: [sessionClaim.claimed.result.tabId],
      },
    );
    expect(sessionClosed.result).toEqual({
      closedTabIds: [],
      detachedTabIds: [sessionClaim.claimed.result.tabId],
      closedWindowIds: [],
    });
    expect(sessionFake.calls.debuggerDetach).toEqual([{ tabId: 1 }]);
    expect(sessionFake.calls.tabsRemove).toEqual([]);
    expect(sessionFake.state.tabs.has(1)).toBe(true);
    expect(sessionClaim.bridge._test.inventory()).toEqual({ sessions: [] });

    const directFake = makeFake();
    const directClaim = await claimCurrent(directFake, "claimed-direct");
    const directlyClosed = await request(
      directClaim.bridge,
      directClaim.port,
      directClaim.hello,
      "tab.close",
      {
        session: "claimed-direct",
        tabId: directClaim.claimed.result.tabId,
      },
    );
    expect(directlyClosed.result).toEqual({
      closedTabIds: [],
      detachedTabIds: [directClaim.claimed.result.tabId],
      closedWindowIds: [],
    });
    expect(directFake.calls.debuggerDetach).toEqual([{ tabId: 1 }]);
    expect(directFake.calls.tabsRemove).toEqual([]);
    expect(directFake.state.tabs.has(1)).toBe(true);

    const retainedFake = makeFake();
    const retainedClaim = await claimCurrent(retainedFake, "claimed-retained");
    const restartedFake = makeFake({
      windows: [...retainedFake.state.windows.values()],
      tabs: [...retainedFake.state.tabs.values()],
      storage: retainedFake.storage,
    });
    const restarted = await boot(restartedFake);
    const retainedInventory = await request(
      restarted.bridge,
      restarted.port,
      restarted.hello,
      "state.inventory",
      {},
    );
    const retained = retainedInventory.result.sessions[0];
    const rebound = await request(
      restarted.bridge,
      restarted.port,
      restarted.hello,
      "session.rebind",
      {
        session: retained.session,
        rootTabId: retained.rootTabId,
        tabIds: retained.tabIds,
        createdByExtension: true,
      },
    );
    expect(rebound.ok).toBe(true);
    expect(
      restartedFake.storage.session.get("agentBrowserOwnershipV1").tabs[0]
        .createdByExtension,
    ).toBe(false);
    const retiredAfterRebind = await request(
      restarted.bridge,
      restarted.port,
      restarted.hello,
      "session.close",
      { session: retained.session, tabIds: retained.tabIds },
    );
    expect(retiredAfterRebind.result.closedTabIds).toEqual([]);
    expect(retiredAfterRebind.result.detachedTabIds).toEqual([
      retainedClaim.claimed.result.tabId,
    ]);
    expect(restartedFake.calls.tabsRemove).toEqual([]);
    expect(restartedFake.state.tabs.has(1)).toBe(true);
  });

  it("keeps focus emulation internal to validated attachment and detaches on initialization failure", async () => {
    const fake = makeFake();
    const { bridge, port, hello } = await boot(fake);
    const created = await request(bridge, port, hello, "tab.create", {
      session: "focus-emulation",
      url: "https://example.test/",
    });
    expect(created.ok).toBe(true);
    expect(
      fake.calls.debuggerSend.filter(
        (call) => call.method === "Emulation.setFocusEmulationEnabled",
      ),
    ).toEqual([
      {
        target: { tabId: 1_000 },
        method: "Emulation.setFocusEmulationEnabled",
        params: { enabled: true },
      },
    ]);

    const permitted = await request(bridge, port, hello, "cdp.send", {
      session: "focus-emulation",
      tabId: created.result.tabId,
      method: "Page.getFrameTree",
      params: {},
    });
    expect(permitted.ok).toBe(true);
    expect(
      fake.calls.debuggerSend.filter(
        (call) => call.method === "Emulation.setFocusEmulationEnabled",
      ),
    ).toHaveLength(1);

    const beforeDenied = fake.calls.debuggerSend.length;
    const denied = await request(bridge, port, hello, "cdp.send", {
      session: "focus-emulation",
      tabId: created.result.tabId,
      method: "Emulation.setFocusEmulationEnabled",
      params: { enabled: true },
    });
    expect(denied).toMatchObject({
      ok: false,
      error: { code: "CDP_METHOD_DENIED" },
    });
    expect(fake.calls.debuggerSend).toHaveLength(beforeDenied);

    const failingFake = makeFake();
    failingFake.setCommandHandler(({ target, method, state }) => {
      if (method === "Page.getFrameTree") {
        return {
          frameTree: {
            frame: {
              id: `frame-${target.tabId}`,
              url: state.tabs.get(target.tabId).url,
            },
          },
        };
      }
      if (method === "Emulation.setFocusEmulationEnabled") {
        throw new Error("focus emulation unavailable");
      }
      return {};
    });
    const failing = await boot(failingFake);
    const failed = await request(
      failing.bridge,
      failing.port,
      failing.hello,
      "tab.create",
      {
        session: "focus-emulation-failure",
        url: "https://example.test/",
      },
    );
    expect(failed).toMatchObject({
      ok: false,
      error: { code: "TARGET_DENIED" },
    });
    expect(failingFake.calls.debuggerSend).toEqual([
      {
        target: { tabId: 1_000 },
        method: "Page.getFrameTree",
        params: {},
      },
      {
        target: { tabId: 1_000 },
        method: "Emulation.setFocusEmulationEnabled",
        params: { enabled: true },
      },
    ]);
    expect(failingFake.calls.debuggerDetach).toEqual([{ tabId: 1_000 }]);
    expect(failing.bridge._test.inventory()).toEqual({ sessions: [] });
  });

  it("forwards diagnostics only from current-epoch roots and their default main contexts", async () => {
    const fake = makeFake();
    const { bridge, port, hello } = await boot(fake);
    const first = await request(bridge, port, hello, "tab.create", {
      session: "diagnostic-a", url: "https://example.test/a",
    });
    const second = await request(bridge, port, hello, "tab.create", {
      session: "diagnostic-b", url: "https://example.test/b",
    });
fake.addTab({
      id: 2_001, windowId: 10, active: false, openerTabId: 1_000,
      url: "https://example.test/child",
    }, true, 1_000);
    await flush(30);
    await bridge._test.settle();
    const consoleParams = {
      type: "log", args: [{ type: "string", value: "root-a" }],
      executionContextId: 51_000, timestamp: 42,
    };
    const exceptionParams = {
      timestamp: 43,
      exceptionDetails: {
        exceptionId: 7, text: "Uncaught", lineNumber: 3, columnNumber: 4,
        executionContextId: 51_000,
        exception: {
          type: "object", subtype: "error", description: "Error: root-error",
          objectId: "must-not-cross",
        },
        stackTrace: { callFrames: [{ secret: "not-needed" }] },
      },
    };
    fake.events.debuggerEvent.emit({ tabId: 1_000 }, "Runtime.consoleAPICalled", consoleParams);
    fake.events.debuggerEvent.emit({ tabId: 1_000 }, "Runtime.exceptionThrown", exceptionParams);
    fake.events.debuggerEvent.emit({ tabId: 1_001 }, "Runtime.consoleAPICalled", {
      ...consoleParams, executionContextId: 51_001,
      args: [{ type: "string", value: "root-b" }],
    });
    // These cannot borrow the valid root's routing or default execution context.
    for (const [source, params] of [
      [{ tabId: 1 }, consoleParams],
      [{ tabId: 1_000, sessionId: "child-session" }, consoleParams],
      [{ tabId: 1_000 }, { ...consoleParams, executionContextId: 99 }],
      [{ tabId: 1_000 }, { ...consoleParams, executionContextId: undefined }],
      [{ tabId: 2_001 }, { ...consoleParams, executionContextId: 52_001 }],
    ]) fake.events.debuggerEvent.emit(source, "Runtime.consoleAPICalled", params);
    fake.events.debuggerEvent.emit({ tabId: 1_000 }, "Runtime.exceptionThrown", {
      ...exceptionParams,
      exceptionDetails: { ...exceptionParams.exceptionDetails, executionContextId: undefined },
    });
    fake.events.debuggerEvent.emit({ tabId: 1_000 }, "Runtime.exceptionRevoked", {
      exceptionId: 7, reason: "not forwarded",
    });
    await flush(30);
    const diagnostics = () => port.sent.filter((message) =>
      message.type === "event" && message.method.startsWith("Runtime."),
    );
    expect(diagnostics()).toEqual([
      {
        schema: SCHEMA, type: "event", profileKey: hello.profileKey,
        connectionEpoch: hello.connectionEpoch, tabId: first.result.tabId,
        method: "Runtime.consoleAPICalled", params: consoleParams,
      },
      {
        schema: SCHEMA, type: "event", profileKey: hello.profileKey,
        connectionEpoch: hello.connectionEpoch, tabId: first.result.tabId,
        method: "Runtime.exceptionThrown",
        params: {
          timestamp: 43,
          exceptionDetails: {
            exceptionId: 7, text: "Uncaught", lineNumber: 3, columnNumber: 4,
            executionContextId: 51_000,
            exception: { type: "object", subtype: "error", description: "Error: root-error" },
          },
        },
      },
      {
        schema: SCHEMA, type: "event", profileKey: hello.profileKey,
        connectionEpoch: hello.connectionEpoch, tabId: second.result.tabId,
        method: "Runtime.consoleAPICalled",
        params: { ...consoleParams, executionContextId: 51_001, args: [{ type: "string", value: "root-b" }] },
      },
    ]);
    fake.events.debuggerEvent.emit({ tabId: 1_000 }, "Runtime.executionContextsCleared", {});
    fake.events.debuggerEvent.emit({ tabId: 1_000 }, "Runtime.consoleAPICalled", consoleParams);
    await flush();
    expect(diagnostics()).toHaveLength(3);
    fake.events.debuggerEvent.emit({ tabId: 1_000 }, "Runtime.executionContextCreated", {
      context: { id: 61_000, auxData: { isDefault: true, frameId: "frame-1000" } },
    });
    fake.events.debuggerEvent.emit({ tabId: 1_000 }, "Runtime.consoleAPICalled", {
      ...consoleParams, executionContextId: 61_000,
    });
    await flush();
    expect(diagnostics()).toHaveLength(4);
    // The event was queued under the old epoch; disconnect before its continuation.
    fake.events.debuggerEvent.emit({ tabId: 1_000 }, "Runtime.consoleAPICalled", {
      ...consoleParams, executionContextId: 61_000,
    });
    port.disconnect();
    await flush();
    expect(diagnostics()).toHaveLength(4);
  });

  it("bounds diagnostic arguments and previews with visible consumer-readable truncation", async () => {
    const fake = makeFake();
    const { bridge, port, hello } = await boot(fake);
    await request(bridge, port, hello, "tab.create", {
      session: "diagnostic-bounds", url: "https://example.test/",
    });
    const objectArg = {
      type: "object", description: "Object", objectId: "private-handle",
      customPreview: { header: "not-forwarded" },
      preview: {
        overflow: false,
        properties: Array.from({ length: 20 }, (_, index) => ({
          name: String(index), type: "string", value: "value-" + index,
          valuePreview: { description: "nested-not-forwarded" },
        })),
      },
    };
    fake.events.debuggerEvent.emit({ tabId: 1_000 }, "Runtime.consoleAPICalled", {
      type: "error", executionContextId: 51_000, timestamp: 1,
      args: [
        { type: "string", value: "keep-this-marker" },
        objectArg,
        { type: "string", value: "\u0000".repeat(20_000) },
        ...Array.from({ length: 30 }, () => objectArg),
      ],
      stackTrace: { description: "not-forwarded" },
    });
    fake.events.debuggerEvent.emit({ tabId: 1_000 }, "Runtime.exceptionThrown", {
      timestamp: 2,
      exceptionDetails: {
        exceptionId: 1, text: "Uncaught", executionContextId: 51_000,
        lineNumber: 0, columnNumber: 0,
        exception: { type: "object", subtype: "error", description: "Error: " + "x".repeat(20_000) },
      },
    });
    await flush();
    const diagnostics = port.sent.filter((message) =>
      message.type === "event" && message.method.startsWith("Runtime."),
    );
    expect(diagnostics).toHaveLength(2);
    const args = diagnostics[0].params.args;
    expect(args).toHaveLength(17);
    expect(args[0].value).toBe("keep-this-marker");
    expect(args[1].preview.properties).toHaveLength(8);
    expect(args[1].preview.overflow).toBe(true);
    expect(args.at(-1)).toEqual({ type: "string", value: "[Agent Browser diagnostics truncated]" });
    expect(diagnostics[1].params.exceptionDetails.exception.description)
      .toContain("[Agent Browser diagnostics truncated]");
    for (const event of diagnostics) {
      expect(Buffer.byteLength(JSON.stringify(event))).toBeLessThan(64 * 1024);
      expect(JSON.stringify(event)).not.toMatch(/objectId|stackTrace|customPreview|valuePreview|private-handle/);
    }
  });

  it("keeps diagnostic floods separate from neighboring roots and ownership/lifecycle capacity", async () => {
    let now = 1_000;
    const fake = makeFake();
    const { bridge, port, hello } = await boot(fake, { now: () => now });
    const first = await request(bridge, port, hello, "tab.create", {
      session: "diagnostic-flood", url: "https://example.test/a",
    });
    const second = await request(bridge, port, hello, "tab.create", {
      session: "diagnostic-neighbor", url: "https://example.test/b",
    });
    const params = {
      type: "log", args: [{ type: "string", value: "flood" }],
      executionContextId: 51_000, timestamp: 1,
    };
    for (let index = 0; index < 200; index++)
      fake.events.debuggerEvent.emit({ tabId: 1_000 }, "Runtime.consoleAPICalled", params);
    fake.events.debuggerEvent.emit({ tabId: 1_001 }, "Runtime.consoleAPICalled", {
      ...params, executionContextId: 51_001,
      args: [{ type: "string", value: "neighbor-survives" }],
    });
    fake.events.debuggerEvent.emit({ tabId: 1_000 }, "Page.loadEventFired", { timestamp: 2 });
    await flush(220);
    const rootLogs = () => port.sent.filter((message) =>
      message.method === "Runtime.consoleAPICalled" && message.tabId === first.result.tabId,
    );
    expect(rootLogs()).toHaveLength(128);
    expect(port.sent).toContainEqual(expect.objectContaining({
      method: "Runtime.consoleAPICalled", tabId: second.result.tabId,
      params: expect.objectContaining({ args: [{ type: "string", value: "neighbor-survives" }] }),
    }));
    expect(port.sent).toContainEqual(expect.objectContaining({
      method: "Page.loadEventFired", tabId: first.result.tabId,
    }));
    now += 10_000;
    fake.events.debuggerEvent.emit({ tabId: 1_000 }, "Runtime.consoleAPICalled", params);
    await flush();
    expect(rootLogs()).toHaveLength(129);
    await fake.chrome.tabs.remove(1_000);
    await flush(30);
    await bridge._test.settle();
    expect(port.sent).toContainEqual(expect.objectContaining({
      method: "AgentBrowser.tabRevoked", tabId: first.result.tabId,
    }));
    expect(fake.state.tabs.has(1)).toBe(true);
    expect(fake.state.tabs.has(1_001)).toBe(true);
    expect(bridge._test.inventory().sessions.map((session) => session.session))
      .toEqual(["diagnostic-neighbor"]);
    fake.events.debuggerEvent.emit({ tabId: 1_000 }, "Runtime.consoleAPICalled", params);
    await flush();
    expect(rootLogs()).toHaveLength(129);
  });

  it("upload forwards only the exact object and Windows paths on its owned target", async () => {
    const fake = makeFake();
    let checks = 0;
    fake.chrome.extension = {
      async isAllowedFileSchemeAccess() { checks += 1; return true; },
    };
    const { bridge, port, hello, timers } = await boot(fake);
    const created = await request(bridge, port, hello, "tab.create", {
      session: "upload-owned", url: "https://example.test/",
    });
    const params = {
      objectId: "owned-input-object",
      files: ["C:\\fixture\\one.txt", "D:/fixture/two space.txt"],
    };
    const response = await request(bridge, port, hello, "cdp.send", {
      session: "upload-owned", tabId: created.result.tabId,
      method: "DOM.setFileInputFiles", params,
    });
    expect(response).toMatchObject({ ok: true, result: {} });
    expect(checks).toBe(1);
    expect(fake.calls.debuggerSend.filter((call) => call.method === "DOM.setFileInputFiles"))
      .toEqual([{ target: { tabId: 1_000 }, method: "DOM.setFileInputFiles", params }]);
    expect(timers.jobs.filter((job) => job.delay === 1_000 && !job.canceled)).toEqual([]);
    expect(fake.state.tabs.get(1).active).toBe(true);
    expect(fake.state.tabs.get(1_000).active).toBe(false);
  });

  it("upload distinguishes false from unverified file access without issuing the Chrome file command", async () => {
    for (const [query, code] of [
      [undefined, "FILE_ACCESS_UNVERIFIED"],
      [async () => false, "FILE_ACCESS_REQUIRED"],
      [async () => undefined, "FILE_ACCESS_UNVERIFIED"],
      [async () => "true", "FILE_ACCESS_UNVERIFIED"],
      [async () => { throw new Error("permission state unavailable"); }, "FILE_ACCESS_UNVERIFIED"],
    ]) {
      const fake = makeFake();
      fake.chrome.extension = query ? { isAllowedFileSchemeAccess: query } : undefined;
      const { bridge, port, hello } = await boot(fake);
      const created = await request(bridge, port, hello, "tab.create", {
        session: "upload-denied", url: "https://example.test/",
      });
      const response = await request(bridge, port, hello, "cdp.send", {
        session: "upload-denied", tabId: created.result.tabId,
        method: "DOM.setFileInputFiles",
        params: { objectId: "owned-input-object", files: ["C:/fixture/one.txt"] },
      });
      expect(response).toMatchObject({ ok: false, error: { code } });
      expect(fake.calls.debuggerSend.filter((call) => call.method === "DOM.setFileInputFiles"))
        .toEqual([]);
    }
  });

  it("upload rejects malformed paths and alternate foreign-node selectors before file access", async () => {
    const fake = makeFake();
    let checks = 0;
    fake.chrome.extension = {
      async isAllowedFileSchemeAccess() { checks += 1; return true; },
    };
    const { bridge, port, hello } = await boot(fake);
    const created = await request(bridge, port, hello, "tab.create", {
      session: "upload-shapes", url: "https://example.test/",
    });
    const valid = { objectId: "owned-input-object", files: ["C:/fixture/one.txt"] };
    for (const params of [
      {}, { ...valid, objectId: "" }, { ...valid, objectId: 42 },
      { files: valid.files, backendNodeId: 42 }, { files: valid.files, nodeId: 42 },
      { ...valid, backendNodeId: 42 }, { ...valid, sessionId: "foreign" },
      { ...valid, contextId: 999 }, { ...valid, executionContextId: 999 },
      { ...valid, files: "C:/fixture/one.txt" }, { ...valid, files: [42] },
      ...["one.txt", "C:one.txt", "/mnt/c/fixture/one.txt", "/home/fixture/one.txt",
        "\\\\remote.example\\share\\one.txt", "\\\\wsl.localhost\\Ubuntu", "",
        "C:/fixture/one\u0000.txt"]
        .map((file) => ({ ...valid, files: [file] })),
    ]) {
      const response = await request(bridge, port, hello, "cdp.send", {
        session: "upload-shapes", tabId: created.result.tabId,
        method: "DOM.setFileInputFiles", params,
      });
      expect(response).toMatchObject({ ok: false, error: { code: "INVALID_CDP_PARAMS" } });
    }
    expect(checks).toBe(0);
    expect(fake.calls.debuggerSend.filter((call) => call.method === "DOM.setFileInputFiles"))
      .toEqual([]);
    // This checks the production envelope/selector guard, not Chrome's rejection
    // of a genuine foreign remote object or the readability of an actual file.
  });

  it("upload cannot use another session's tab or retain a removed tab across permission checking", async () => {
    const fake = makeFake();
    let allow;
    fake.chrome.extension = {
      isAllowedFileSchemeAccess: () => new Promise((resolve) => { allow = resolve; }),
    };
    const { bridge, port, hello } = await boot(fake);
    const created = await request(bridge, port, hello, "tab.create", {
      session: "upload-race", url: "https://example.test/",
    });
    const args = {
      session: "upload-race", tabId: created.result.tabId,
      method: "DOM.setFileInputFiles",
      params: { objectId: "owned-input-object", files: ["C:/fixture/one.txt"] },
    };
    const foreign = await request(bridge, port, hello, "cdp.send", { ...args, session: "foreign" });
    expect(foreign).toMatchObject({ ok: false, error: { code: "TAB_NOT_OWNED" } });
    const pending = request(bridge, port, hello, "cdp.send", args);
    await flush(30);
    expect(typeof allow).toBe("function");
    await fake.chrome.tabs.remove(1_000);
    await flush(30);
    allow(true);
    expect(await pending).toMatchObject({ ok: false, error: { code: "TAB_NOT_OWNED" } });
    expect(fake.calls.debuggerSend.filter((call) => call.method === "DOM.setFileInputFiles"))
      .toEqual([]);
  });

  it("upload accepts client-mapped local WSL paths without changing names or mapping in the worker", async () => {
    const fake = makeFake();
    fake.chrome.extension = { async isAllowedFileSchemeAccess() { return true; } };
    const { bridge, port, hello } = await boot(fake);
    const created = await request(bridge, port, hello, "tab.create", {
      session: "upload-local-wsl", url: "https://example.test/",
    });
    const params = {
      objectId: "owned-input-object",
      files: [
        "\\\\wsl.localhost\\Ubuntu\\home\\caller\\upload fixture.txt",
        "\\\\wsl$\\Ubuntu\\home\\caller\\trailing space ",
      ],
    };
    const response = await request(bridge, port, hello, "cdp.send", {
      session: "upload-local-wsl", tabId: created.result.tabId,
      method: "DOM.setFileInputFiles", params,
    });
    expect(response).toMatchObject({ ok: true, result: {} });
    expect(fake.calls.debuggerSend.filter((call) => call.method === "DOM.setFileInputFiles"))
      .toEqual([{ target: { tabId: 1_000 }, method: "DOM.setFileInputFiles", params }]);
    // A hook green proves forwarding only, not Chrome's ability to read a file.
  });

  it("upload bounds a hung file-access query and never sends the file command later", async () => {
    const fake = makeFake();
    let lateAllow;
    fake.chrome.extension = {
      isAllowedFileSchemeAccess: () => new Promise((resolve) => { lateAllow = resolve; }),
    };
    const { bridge, port, hello, timers } = await boot(fake);
    const created = await request(bridge, port, hello, "tab.create", {
      session: "upload-timeout", url: "https://example.test/",
    });
    const pending = request(bridge, port, hello, "cdp.send", {
      session: "upload-timeout", tabId: created.result.tabId,
      method: "DOM.setFileInputFiles",
      params: { objectId: "owned-input-object", files: ["C:/fixture/one.txt"] },
    });
    await flush(30);
    const timeout = timers.jobs.find((job) => job.delay === 1_000 && !job.canceled);
    expect(timeout).toBeDefined();
    timeout.callback();
    expect(await pending).toMatchObject({ ok: false, error: { code: "FILE_ACCESS_UNVERIFIED" } });
    lateAllow(true);
    await flush(30);
    expect(fake.calls.debuggerSend.filter((call) => call.method === "DOM.setFileInputFiles"))
      .toEqual([]);
    expect(timeout.canceled).toBe(true);
  });

  it("upload cannot cross a native disconnect or request deadline during permission checking", async () => {
    for (const edge of ["disconnect", "deadline"]) {
      const fake = makeFake();
      let allow;
      let now = 1_000;
      fake.chrome.extension = {
        isAllowedFileSchemeAccess: () => new Promise((resolve) => { allow = resolve; }),
      };
      const { bridge, port, hello } = await boot(fake, { now: () => now });
      const created = await request(bridge, port, hello, "tab.create", {
        session: "upload-expiry", url: "https://example.test/",
      });
      const pending = request(bridge, port, hello, "cdp.send", {
        session: "upload-expiry", tabId: created.result.tabId,
        method: "DOM.setFileInputFiles",
        params: { objectId: "owned-input-object", files: ["C:/fixture/one.txt"] },
      }, { deadlineAt: 1_500 });
      await flush(30);
      expect(typeof allow).toBe("function");
      if (edge === "disconnect") port.disconnect();
      else now = 1_501;
      allow(true);
      const response = await pending;
      if (edge === "deadline") {
        expect(response).toMatchObject({ ok: false, error: { code: "REQUEST_EXPIRED" } });
      }
      expect(fake.calls.debuggerSend.filter((call) => call.method === "DOM.setFileInputFiles"))
        .toEqual([]);
    }
  });

  it("pins CDP to owned tabs/main contexts and enforces directional native-message bounds", async () => {
    const fake = makeFake();
    const { bridge, port, hello } = await boot(fake);
    const created = await request(bridge, port, hello, "tab.create", {
      session: "cdp-a",
      url: "https://example.test/",
    });
    await flush();
    const before = fake.calls.debuggerSend.length;
    const browserWide = await request(bridge, port, hello, "cdp.send", {
      session: "cdp-a",
      tabId: created.result.tabId,
      method: "Browser.getVersion",
      params: {},
    });
    expect(browserWide).toMatchObject({
      ok: false,
      error: { code: "CDP_METHOD_DENIED" },
    });
    expect(fake.calls.debuggerSend).toHaveLength(before);

    const foreignContext = await request(bridge, port, hello, "cdp.send", {
      session: "cdp-a",
      tabId: created.result.tabId,
      method: "Runtime.evaluate",
      params: { expression: "document.title", contextId: 999 },
    });
    expect(foreignContext).toMatchObject({
      ok: false,
      error: { code: "NON_MAIN_CONTEXT_DENIED" },
    });

    const evaluated = await request(bridge, port, hello, "cdp.send", {
      session: "cdp-a",
      tabId: created.result.tabId,
      method: "Runtime.evaluate",
      params: { expression: "document.title" },
    });
    expect(evaluated).toEqual({
      schema: SCHEMA,
      type: "response",
      id: evaluated.id,
      ok: true,
      result: { result: { type: "string", value: "ok" } },
    });
    const evaluationCall = fake.calls.debuggerSend.find(
      (call) => call.method === "Runtime.evaluate",
    );
    expect(evaluationCall.target).toEqual({ tabId: 1_000 });
    expect(evaluationCall.params.contextId).toBe(51_000);

    const scrolled = await request(bridge, port, hello, "cdp.send", {
      session: "cdp-a",
      tabId: created.result.tabId,
      method: "DOM.scrollIntoViewIfNeeded",
      params: { backendNodeId: 42 },
    });
    expect(scrolled.ok).toBe(true);
    const resolved = await request(bridge, port, hello, "cdp.send", {
      session: "cdp-a",
      tabId: created.result.tabId,
      method: "DOM.resolveNode",
      params: { backendNodeId: 42, objectGroup: "agent-browser" },
    });
    expect(resolved.ok).toBe(true);
    const called = await request(bridge, port, hello, "cdp.send", {
      session: "cdp-a",
      tabId: created.result.tabId,
      method: "Runtime.callFunctionOn",
      params: {
        objectId: "node-42",
        functionDeclaration: "function(x) { return x; }",
        arguments: [{ value: 7 }],
        returnByValue: true,
        awaitPromise: false,
      },
    });
    expect(called.ok).toBe(true);
    expect(
      fake.calls.debuggerSend.filter((call) =>
        [
          "DOM.scrollIntoViewIfNeeded",
          "DOM.resolveNode",
          "Runtime.callFunctionOn",
        ].includes(call.method),
      ),
    ).toEqual([
      {
        target: { tabId: 1_000 },
        method: "DOM.scrollIntoViewIfNeeded",
        params: { backendNodeId: 42 },
      },
      {
        target: { tabId: 1_000 },
        method: "DOM.resolveNode",
        params: { backendNodeId: 42, objectGroup: "agent-browser" },
      },
      {
        target: { tabId: 1_000 },
        method: "Runtime.callFunctionOn",
        params: {
          objectId: "node-42",
          functionDeclaration: "function(x) { return x; }",
          arguments: [{ value: 7 }],
          returnByValue: true,
          awaitPromise: false,
        },
      },
    ]);

    // These are the donor's scoped snapshot, cursor-ref, and iframe lookups.
    // Denial respectively fails snapshot or silently omits actionable refs.
    for (const params of [
      { objectId: "node-42", depth: -1 },
      { nodeId: 42 },
      { backendNodeId: 42, depth: 1 },
    ]) {
      const described = await request(bridge, port, hello, "cdp.send", {
        session: "cdp-a",
        tabId: created.result.tabId,
        method: "DOM.describeNode",
        params,
      });
      expect(described.ok).toBe(true);
      expect(fake.calls.debuggerSend.at(-1)).toEqual({
        target: { tabId: 1_000 }, method: "DOM.describeNode", params,
      });
    }
    const beforeInvalidObjectCalls = fake.calls.debuggerSend.length;
    for (const params of [
      {}, { nodeId: 0 }, { nodeId: 42, backendNodeId: 42 },
      { objectId: "", depth: -1 }, { objectId: "node-42", depth: 0 },
      { backendNodeId: 42, depth: -1 },
      { nodeId: 42, pierce: true }, { nodeId: 42, sessionId: "foreign" },
    ]) {
      const rejected = await request(bridge, port, hello, "cdp.send", {
        session: "cdp-a",
        tabId: created.result.tabId,
        method: "DOM.describeNode",
        params,
      });
      expect(rejected).toMatchObject({
        ok: false, error: { code: "INVALID_CDP_PARAMS" },
      });
    }
    const foreignObjectContext = await request(
      bridge,
      port,
      hello,
      "cdp.send",
      {
        session: "cdp-a",
        tabId: created.result.tabId,
        method: "Runtime.callFunctionOn",
        params: {
          objectId: "node-42",
          functionDeclaration: "function() { return true; }",
          executionContextId: 999,
        },
      },
    );
    expect(foreignObjectContext).toMatchObject({
      ok: false,
      error: { code: "INVALID_CDP_PARAMS" },
    });
    const foreignResolveContext = await request(
      bridge,
      port,
      hello,
      "cdp.send",
      {
        session: "cdp-a",
        tabId: created.result.tabId,
        method: "DOM.resolveNode",
        params: { backendNodeId: 42, executionContextId: 999 },
      },
    );
    expect(foreignResolveContext).toMatchObject({
      ok: false,
      error: { code: "INVALID_CDP_PARAMS" },
    });
    const invalidScroll = await request(bridge, port, hello, "cdp.send", {
      session: "cdp-a",
      tabId: created.result.tabId,
      method: "DOM.scrollIntoViewIfNeeded",
      params: { backendNodeId: 0 },
    });
    expect(invalidScroll).toMatchObject({
      ok: false,
      error: { code: "INVALID_CDP_PARAMS" },
    });
    expect(fake.calls.debuggerSend).toHaveLength(beforeInvalidObjectCalls);

    const crossSession = await request(bridge, port, hello, "cdp.send", {
      session: "cdp-b",
      tabId: created.result.tabId,
      method: "Page.reload",
      params: {},
    });
    expect(crossSession).toMatchObject({
      ok: false,
      error: { code: "TAB_NOT_OWNED" },
    });

    fake.setCommandHandler(({ method, target, state, events }) => {
      if (method === "Page.getFrameTree") {
        return {
          frameTree: {
            frame: {
              id: `frame-${target.tabId}`,
              url: state.tabs.get(target.tabId).url,
            },
          },
        };
      }
      if (method === "Runtime.enable") {
        events.debuggerEvent.emit(
          { tabId: target.tabId },
          "Runtime.executionContextCreated",
          {
            context: {
              id: 51_000,
              auxData: { isDefault: true, frameId: `frame-${target.tabId}` },
            },
          },
        );
        return {};
      }
      if (method === "Page.captureScreenshot")
        return { data: "x".repeat(1024 * 1024) };
      return {};
    });
    const largeReply = await request(bridge, port, hello, "cdp.send", {
      session: "cdp-a",
      tabId: created.result.tabId,
      method: "Page.captureScreenshot",
      params: {},
    });
    expect(largeReply.ok).toBe(true);
    expect(largeReply.result.data).toHaveLength(1024 * 1024);
    expect(Buffer.byteLength(JSON.stringify(largeReply))).toBeGreaterThan(
      1024 * 1024,
    );

    const oversizedInboundId = requestId();
    port.receive({
      schema: SCHEMA,
      type: "request",
      id: oversizedInboundId,
      profileKey: hello.profileKey,
      connectionEpoch: hello.connectionEpoch,
      op: "state.inventory",
      args: { padding: "x".repeat(1024 * 1024) },
    });
    await flush();
    await bridge._test.settle();
    expect(
      port.sent.find(
        (message) =>
          message.type === "response" && message.id === oversizedInboundId,
      ),
    ).toBeUndefined();

    for (let index = 0; index < 200; index += 1) {
      fake.events.debuggerEvent.emit({ tabId: 1_000 }, "Page.loadEventFired", {
        timestamp: index,
      });
    }
    await flush(220);
    const boundedEvents = port.sent.filter(
      (message) =>
        message.type === "event" && message.method === "Page.loadEventFired",
    );
    expect(boundedEvents).toHaveLength(128);
    expect(
      boundedEvents.every(
        (message) => JSON.stringify(message).length < 1024 * 1024,
      ),
    ).toBe(true);

    const stale = await request(
      bridge,
      port,
      hello,
      "state.inventory",
      {},
      { connectionEpoch: "0".repeat(64) },
    );
    expect(stale).toMatchObject({
      ok: false,
      error: { code: "STALE_CONNECTION" },
    });
    const wrongProfile = await request(
      bridge,
      port,
      hello,
      "state.inventory",
      {},
      { profileKey: "f".repeat(64) },
    );
    expect(wrongProfile).toMatchObject({
      ok: false,
      error: { code: "PROFILE_MISMATCH" },
    });
  });

  it("never attributes a shared opener popup to the executing participant or closes it on participant exit", async () => {
    const fake = makeFake();
    const { bridge, port, hello } = await boot(fake);
    const ask = (op, args) => request(bridge, port, hello, op, args);
    await ask("focus.snapshot", {});
    const a = (await ask("tab.claim-active", { session: "shared-a" })).result;
    await ask("focus.snapshot", {});
    const b = (await ask("tab.claim-active", { session: "shared-b" })).result;
    const ca = "a".repeat(64), cb = "b".repeat(64);
    expect((await ask("command.begin", { session: "shared-b", tabId: b.tabId, command: cb })).ok).toBe(true);
    // Chrome's event cannot distinguish A's delayed timer or a user action
    // from B's command. Merely observing execution B grants no popup ownership.
fake.addTab({ id: 2000, windowId: 10, active: false, openerTabId: 1,
      url: "https://example.test/unattributed-timer" }, true, 1);
    await flush(30); await bridge._test.settle();
    const beforeExit = (await ask("state.inventory", {})).result.sessions;
    const bInventory = beforeExit.find((item) => item.session === "shared-b");
    expect((await ask("cdp.send", { session: "shared-b", tabId: b.tabId, command: cb,
      method: "Runtime.evaluate", params: { expression: "1" } })).ok).toBe(true);
    expect((await ask("command.begin", { session: "shared-a", tabId: a.tabId, command: ca })).ok).toBe(false);
    // Use the actual inventory: the old worker includes the incorrectly adopted
    // popup and then actually removes it, not just reports a misleading ledger.
    expect((await ask("session.close", { session: "shared-b", tabIds: bInventory.tabIds })).ok).toBe(true);
    expect((await ask("command.begin", { session: "shared-a", tabId: a.tabId, command: ca })).ok).toBe(true);
    // Losing a participant does not make the co-working user page exclusive.
fake.addTab({ id: 2001, windowId: 10, active: false, openerTabId: 1,
      url: "https://example.test/unattributed-user" }, true, 1);
    await flush(30); await bridge._test.settle();
    const aInventory = (await ask("state.inventory", {})).result.sessions[0];
    expect((await ask("command.end", { session: "shared-a", tabId: a.tabId, command: ca })).ok).toBe(true);
    expect((await ask("session.close", { session: "shared-a", tabIds: aInventory.tabIds })).ok).toBe(true);
    expect.soft(bInventory.tabIds).toEqual([b.tabId]);
    expect.soft(aInventory.tabIds).toEqual([a.tabId]);
    expect.soft(port.sent.filter((message) => message.method === "AgentBrowser.tabAdopted")).toEqual([]);
    expect.soft(fake.calls.tabsRemove).toEqual([]);
    expect.soft([...fake.state.tabs.keys()].sort()).toEqual([1, 2000, 2001]);
    expect(bridge._test.inventory()).toEqual({ sessions: [] });
    expect(fake.calls.debuggerAttach).toEqual([{ target: { tabId: 1 }, version: "1.3" }]);
  }, 3000);

  it("adopts only exact opener descendants and revokes cross-window moves without closing them", async () => {
    const fake = makeFake();
    const { bridge, port, hello } = await boot(fake);
    const created = await request(bridge, port, hello, "tab.create", {
      session: "descendants",
      url: "https://example.test/",
    });
    const rootChromeTab = 1_000;
    fake.addTab({
      id: 2_000,
      windowId: 10,
      active: false,
      url: "https://unrelated.test/",
    });
    await flush();
    expect(bridge._test.inventory().sessions[0].tabIds).toEqual([
      created.result.tabId,
    ]);

fake.addTab({
      id: 2_001,
      windowId: 10,
      active: false,
      openerTabId: rootChromeTab,
      url: "https://child.test/",
    }, true, rootChromeTab);
    await flush(20);
    await bridge._test.settle();
    const withChild = bridge._test.inventory().sessions[0];
    expect(withChild.tabIds).toHaveLength(2);
    const childHandle = withChild.tabIds.find(
      (value) => value !== created.result.tabId,
    );
    expect(port.sent).toContainEqual(
      expect.objectContaining({
        schema: SCHEMA,
        type: "event",
        profileKey: hello.profileKey,
        connectionEpoch: hello.connectionEpoch,
        tabId: childHandle,
        method: "AgentBrowser.tabAdopted",
      }),
    );

    fake.events.tabAttached.emit(2_001, { newWindowId: 99, newPosition: 0 });
    await flush(20);
    await bridge._test.settle();
    expect(bridge._test.inventory().sessions[0].tabIds).toEqual([
      created.result.tabId,
    ]);
    expect(fake.calls.tabsRemove).not.toContain(2_001);
    expect(fake.state.tabs.has(2_001)).toBe(true);
  });

  it("enforces the retained-state caps of 16 sessions and 64 tabs per session", async () => {
    const fake = makeFake();
    const { bridge, port, hello } = await boot(fake);
    const roots = [];
    for (let index = 0; index < 16; index += 1) {
      const response = await request(bridge, port, hello, "tab.create", {
        session: `session-${index.toString().padStart(2, "0")}`,
        url: "about:blank",
      });
      expect(response.ok).toBe(true);
      roots.push(response.result.tabId);
    }
    const seventeenth = await request(bridge, port, hello, "tab.create", {
      session: "session-16",
      url: "about:blank",
    });
    expect(seventeenth).toMatchObject({
      ok: false,
      error: { code: "SESSION_LIMIT_REACHED" },
    });
    expect(fake.calls.tabsCreate).toHaveLength(16);

    for (let index = 0; index < 64; index += 1) {
fake.addTab({
        id: 3_000 + index,
        windowId: 10,
        active: false,
        openerTabId: 1_000,
        url: "about:blank",
      }, true, 1_000);
    }
    for (let index = 0; index < 5; index += 1) {
      await flush(100);
      await bridge._test.settle();
    }
    const firstSession = bridge._test
      .inventory()
      .sessions.find((item) => item.session === "session-00");
    expect(firstSession.tabIds).toHaveLength(64);
    expect(firstSession.rootTabId).toBe(roots[0]);
    expect(fake.calls.tabsRemove).not.toContain(3_063);
    expect(fake.state.tabs.has(3_063)).toBe(true);
  });

  it("serializes seventeen concurrent allocations so the session cap cannot race", async () => {
    const fake = makeFake();
    const { bridge, port, hello } = await boot(fake);
    const ids = [];
    for (let index = 0; index < 17; index += 1) {
      const id = requestId();
      ids.push(id);
      port.receive({
        schema: SCHEMA,
        type: "request",
        id,
        profileKey: hello.profileKey,
        connectionEpoch: hello.connectionEpoch,
        op: "tab.create",
        args: { session: `concurrent-${index}`, url: "about:blank" },
      });
    }
    await flush(50);
    await bridge._test.settle();
    const responses = ids.map((id) =>
      port.sent.find(
        (message) => message.type === "response" && message.id === id,
      ),
    );
    expect(responses.slice(0, 16).every((response) => response?.ok)).toBe(true);
    expect(responses[16]).toMatchObject({
      ok: false,
      error: { code: "SESSION_LIMIT_REACHED" },
    });
    expect(fake.calls.tabsCreate).toHaveLength(16);
    expect(bridge._test.inventory().sessions).toHaveLength(16);
  });

  it("restores only exact storage.session ownership and inventories it after worker restart", async () => {
    const firstFake = makeFake();
    const first = await boot(firstFake);
    const created = await request(
      first.bridge,
      first.port,
      first.hello,
      "tab.create",
      {
        session: "retained",
        url: "https://example.test/",
      },
    );
    await first.bridge._test.settle();

    const secondFake = makeFake({
      windows: [...firstFake.state.windows.values()],
      tabs: [...firstFake.state.tabs.values()],
      storage: firstFake.storage,
    });
    const second = await boot(secondFake);
    expect(secondFake.calls.tabsGet).toEqual([1_000]);
    expect(secondFake.calls.windowsGetAll).toEqual([]);
    const inventory = await request(
      second.bridge,
      second.port,
      second.hello,
      "state.inventory",
      {},
    );
    expect(inventory.result.sessions).toHaveLength(1);
    expect(inventory.result.sessions[0]).toMatchObject({
      session: "retained",
      currentTab: created.result.tabId,
      rootTabId: created.result.tabId,
      tabIds: [created.result.tabId],
      windowId: created.result.windowId,
      ownedWindow: false,
      claimedCurrentTab: false,
    });
    const beforeRebind = await request(
      second.bridge,
      second.port,
      second.hello,
      "cdp.send",
      {
        session: "retained",
        tabId: created.result.tabId,
        method: "Page.reload",
        params: {},
      },
    );
    expect(beforeRebind).toMatchObject({
      ok: false,
      error: { code: "REBIND_REQUIRED" },
    });
    const rebound = await request(
      second.bridge,
      second.port,
      second.hello,
      "session.rebind",
      {
        session: "retained",
        rootTabId: created.result.tabId,
        tabIds: [created.result.tabId],
      },
    );
    expect(rebound.result).toEqual({
      tabId: created.result.tabId,
      windowId: created.result.windowId,
      ownedWindow: false,
    });
    const afterRebind = await request(
      second.bridge,
      second.port,
      second.hello,
      "cdp.send",
      {
        session: "retained",
        tabId: created.result.tabId,
        method: "Page.reload",
        params: {},
      },
    );
    expect(afterRebind.ok).toBe(true);
  });
});
