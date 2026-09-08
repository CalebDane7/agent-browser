import { readFileSync } from "node:fs";
import vm from "node:vm";
import assert from "node:assert/strict";
import test from "node:test";

const source = readFileSync(new URL("../extension/ownership-diagnostics.js", import.meta.url), "utf8");
const keys = ["agentBrowserOwnershipFailuresV1", "agentBrowserOwnershipV1"];
const epoch = "e".repeat(64);
const tabId = (n) => "tab_" + n.toString(16).padStart(64, "0");
const row = (n) => ({ tabId: tabId(n), chromeTabId: n, chromeWindowId: 10,
  windowId: "window_" + "a".repeat(64), session: "owned-session",
  ownedWindow: false, root: n === 1, createdByExtension: true,
  openerTabId: n === 1 ? null : tabId(1), creationEpoch: epoch });
const fixture = () => ({
  [keys[0]]: { dropped: 0, entries: [{ connectionEpoch: epoch, tabId: tabId(2),
    chromeTabId: 2, openerTabId: tabId(1), stage: "debugger.attach", code: "OPERATION_FAILED",
    rawError: "<img src=x onerror=alert(1)> SECRET" }] },
  [keys[1]]: { ownedWindow: null, currentTabs: [["owned-session", tabId(1)]],
    quarantinedWindowIds: [], tabs: [{ ...row(1), url: "https://secret.invalid", grant: "SECRET" }] },
  unrelatedCredential: "SECRET",
});

function only(properties) {
  return new Proxy(properties, {
    get(target, key) {
      if (!Object.hasOwn(target, key)) throw new Error("UNEXPECTED_CAPABILITY_" + String(key));
      return target[key];
    },
    set() { throw new Error("STATE_WRITE_FORBIDDEN"); },
  });
}
async function observe(stored, readError = false, refresh = false) {
  let text, reads = 0, writes = 0, refreshHandler;
  const before = JSON.stringify(stored);
  const target = new Proxy({}, { set(_target, key, value) {
    assert.equal(key, "value"); assert.equal(typeof value, "string");
    text = value; writes++; return true;
  } });
  const listeners = new Set();
  const chrome = only({ tabs: only({ onCreated: only({ addListener: fn => listeners.add(fn), removeListener: fn => listeners.delete(fn), hasListener: fn => listeners.has(fn) }) }), runtime: only({ id: "a".repeat(32) }),
    storage: only({ session: only({ get: async (requested) => {
      assert.deepEqual(Array.from(requested), keys); reads++;
      if (readError) throw new Error("SECRET browser message https://secret.invalid");
      return stored;
    } }) }) });
  await vm.runInNewContext(source, {
    chrome, TextEncoder, Date, setTimeout: () => 1, clearTimeout: () => {},
    document: only({ getElementById(id) {
      if (id === "stop-tab-creation-capture") return only({ addEventListener(event) { assert.equal(event, "click"); } });
      if (id === "refresh-ownership-diagnostics") return only({ addEventListener(event, handler) {
        assert.equal(event, "click"); refreshHandler = handler;
      } });
      assert.equal(id, "ownership-diagnostics"); return target;
    } }),
  }, { filename: "ownership-diagnostics.js", timeout: 1000 });
  if (refresh) await refreshHandler();
  assert.equal(reads, refresh ? 2 : 1); assert.equal(writes, refresh ? 2 : 1);
  assert.equal(JSON.stringify(stored), before);
  assert.ok(Buffer.byteLength(text) <= 65536);
  return { text, result: JSON.parse(text) };
}

test("production script reads only two keys and projects ownership/failures without raw data or HTML execution", async () => {
  const { text, result } = await observe(fixture());
  assert.equal(result.status, "ok");
  assert.equal(result.truncated, false);
  assert.ok(Number.isFinite(Date.parse(result.capturedAt)));
  assert.equal(result.extensionId, "a".repeat(32));
  assert.equal(result.scope, "persisted-metadata-not-physical-absence");
  assert.deepEqual(result.ownership.tabs, [row(1)]);
  assert.equal(result.failures.entries[0].stage, "debugger.attach");
  assert.equal(result.failures.entries[0].chromeTabId, 2);
  assert.equal(result.failures.entries[0].connectionEpoch, epoch);
  assert.doesNotMatch(text, /SECRET|https:|<img|grant|rawError|unrelatedCredential/);
});

test("missing buffers stay explicit missing, never empty-success", async () => {
  const { result } = await observe({});
  assert.equal(result.status, "partial");
  assert.deepEqual(result.failures, { status: "missing" });
  assert.deepEqual(result.ownership, { status: "missing" });
});

test("malformed metadata and oversized buffers fail with fixed non-secret classifications", async () => {
  for (const mutate of [
    (data) => { data[keys[0]].entries[0].stage = "SECRET"; },
    (data) => { data[keys[0]].entries = Array(33).fill(data[keys[0]].entries[0]); },
    (data) => { data[keys[1]].tabs[0].creationEpoch = "SECRET"; },
    (data) => { data[keys[1]].tabs = Array(1025).fill(row(1)); },
  ]) {
    const data = fixture(); mutate(data);
    const { text, result } = await observe(data);
    assert.equal(result.status, "error");
    assert.equal(result.error, "STORED_METADATA_INVALID");
    assert.doesNotMatch(text, /SECRET|secret.invalid/);
  }
});

test("64KiB cap rejects the complete oversized projection explicitly without false partial inventory", async () => {
  const data = fixture();
  data[keys[1]].tabs = Array.from({ length: 1024 }, (_, index) => row(index + 1));
  const { result } = await observe(data);
  assert.equal(result.status, "error");
  assert.equal(result.error, "OUTPUT_TOO_LARGE");
  assert.equal(result.truncated, true);
  assert.equal(result.limitBytes, 65536);
  assert.equal(Object.hasOwn(result, "ownership"), false);
});

test("refresh repeats only the fixed read, while read failure stays secret-free and the visible textarea is paired", async () => {
  assert.equal((await observe(fixture(), false, true)).result.status, "ok");
  const { text, result } = await observe(fixture(), true);
  assert.equal(result.error, "READ_FAILED");
  assert.doesNotMatch(text, /SECRET|https:/);
  const html = readFileSync(new URL("../extension/ownership-diagnostics.html", import.meta.url), "utf8");
  assert.match(html, /<script src="ownership-diagnostics.js" defer><\/script>/);
  assert.match(html, /<textarea id="ownership-diagnostics" aria-label="Agent Browser ownership diagnostics" readonly/);
  assert.match(html, /<button id="refresh-ownership-diagnostics" type="button">Refresh<\/button>/);
  assert.doesNotMatch(html, /https?:|onload=|onclick=/);
});

test("tab creation capture is armed before read and copies numeric metadata only with exact bounded stop", async () => {
  async function make() {
    let text, timer, stop, refresh, reads=0;
    const listeners=new Set();
    const event=only({addListener:fn=>listeners.add(fn),removeListener:fn=>listeners.delete(fn),hasListener:fn=>listeners.has(fn)});
    await vm.runInNewContext(source,{
      TextEncoder,Date,
      setTimeout(fn,ms){assert.equal(ms,60000);timer=fn;return 1;},
      clearTimeout(id){assert.equal(id,1);},
      chrome:only({runtime:only({id:"a".repeat(32)}),tabs:only({onCreated:event}),
        storage:only({session:only({get:async requested=>{
          assert.deepEqual(Array.from(requested),keys);
          assert.equal(listeners.size,1,"real registration must precede first storage snapshot");
          reads++;return fixture();
        }})})}),
      document:only({getElementById(id){
        if(id==="ownership-diagnostics")return new Proxy({},{set(_t,k,v){assert.equal(k,"value");text=v;return true;}});
        return only({addEventListener(name,fn){assert.equal(name,"click");if(id==="stop-tab-creation-capture")stop=fn;else{assert.equal(id,"refresh-ownership-diagnostics");refresh=fn;}}});
      }})
    },{timeout:1000});
    return {emit:tab=>{for(const fn of [...listeners])fn(tab);},value:()=>JSON.parse(text),listeners,deadline:()=>timer(),stop:()=>stop(),refresh:()=>refresh(),reads:()=>reads};
  }
  const a=await make();
  assert.equal(a.value().tabCreationCapture.status,"armed");assert.equal(a.value().tabCreationCapture.listenerArmed,true);
  const bare={id:2,windowId:10};Object.defineProperty(bare,"url",{get(){throw Error("must not read URL");}});
  a.emit(bare);a.emit({id:3,windowId:10,openerTabId:1,title:"SECRET",url:"https://secret.invalid"});
  assert.deepEqual(a.value().tabCreationCapture.events,[{id:2,windowId:10,openerTabId:null},{id:3,windowId:10,openerTabId:1}]);
  assert.doesNotMatch(JSON.stringify(a.value().tabCreationCapture),/SECRET|https:|title|url/);
  for(let n=4;n<=17;n++)a.emit({id:n,windowId:10,openerTabId:1});
  assert.equal(a.value().tabCreationCapture.events.length,16);assert.equal(a.value().tabCreationCapture.status,"limit");assert.equal(a.listeners.size,0);assert.equal(a.reads(),1);
  a.emit({id:99,windowId:10});assert.equal(a.value().tabCreationCapture.events.length,16);
  const d=await make();d.deadline();assert.equal(d.value().tabCreationCapture.status,"deadline");assert.equal(d.listeners.size,0);assert.equal(d.reads(),1);
  const e=await make();e.stop();assert.equal(e.value().tabCreationCapture.status,"stopped");assert.equal(e.listeners.size,0);
  const bad=await make();bad.emit({id:2,windowId:10,openerTabId:"SECRET"});assert.equal(bad.value().tabCreationCapture.status,"invalid-event-metadata");assert.deepEqual(bad.value().tabCreationCapture.events,[]);
});
