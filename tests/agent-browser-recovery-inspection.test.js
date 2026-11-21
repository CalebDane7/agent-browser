import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { it as test } from "vitest";
import { Broker } from "../scripts/agent-browser-extension-broker.js";
import { observeProcessIdentity, ownerSession } from "../scripts/agent-browser-owner.js";
// WHY: recovery failure diagnostics must not retry page work, rebind/retire tabs,
// disclose other owners, or turn an invalid/changed observation into absence.
const inspectRecovery = Broker.prototype.inspectRecovery;
assert.equal(typeof inspectRecovery, "function");
const sha = (s) => createHash("sha256").update(s).digest("hex");
const hex = (c) => c.repeat(64);
const owner = observeProcessIdentity(process.pid);
const aliasHash = sha("synthetic-only-recovery-inspection");
const session = ownerSession(owner, aliasHash);

function fixture(inventory = { sessions: [] }) {
  const calls = [];
  const peer = {
    closed: false, epoch: "synthetic-epoch", profile: { profileKey: hex("a") },
    async request(op, args) {
      calls.push(op);
      assert.equal(op, "state.inventory");
      assert.deepEqual(args, {});
      return inventory;
    },
  };
  const record = { session, agentOwner: owner, aliasHash, account: "caleb",
    currentTab: false, profileHash: sha(peer.profile.profileKey) };
  const broker = Object.create(Broker.prototype);
  Object.assign(broker, {
    peersByAccount: new Map([["caleb", peer]]), ownerRecords: new Map([[session, record]]),
    sessions: new Map(), pendingSessions: new Set(), ownerRetirements: new Map(),
    consumedGrants: new Map(),
  });
  // Any accidental authority, lifecycle or page operation must fail the guard.
  for (const name of ["launch", "recoverExtensionCapacity", "retire", "retireOwnedSession",
    "retireDeadOwner", "rememberOwner", "forgetOwner", "persistOwnerRecords", "beginCommand"]) {
    broker[name] = () => { throw new Error("forbidden inspection effect"); };
  }
  const issuedAt = Date.now();
  const grant = { session, agentOwner: owner, aliasHash, account: "caleb", currentTab: false,
    issuedAt, expiresAt: issuedAt + 30000, nonce: hex("b") };
  return { broker, peer, record, grant, calls };
}

const item = (name = session) => ({ session: name, currentTab: "tab_" + hex("c"),
  rootTabId: "tab_" + hex("c"), tabIds: ["tab_" + hex("c")],
  windowId: "window_" + hex("d"), ownedWindow: false, claimedCurrentTab: false });

test("actual owner/identity/inventory validators classify only requested membership", async () => {
  for (const present of [false, true]) {
    const inventory = { sessions: [item("unrelated-synthetic-owner"), ...(present ? [item()] : [])] };
    const f = fixture(inventory);
    const beforeRecords = [...f.broker.ownerRecords];
    const beforeSessions = [...f.broker.sessions];
    const result = await inspectRecovery.call(f.broker, f.grant);
    assert.equal(result.outcome, present ? "requested-root-present" : "requested-root-missing");
    assert.equal(result.requestedTabCount, present ? 1 : 0);
    assert.deepEqual(f.calls, ["state.inventory"]);
    assert.deepEqual([...f.broker.ownerRecords], beforeRecords);
    assert.deepEqual([...f.broker.sessions], beforeSessions);
    assert.equal(f.broker.consumedGrants.size, 1); // disclosed one-use admission only
    const encoded = JSON.stringify(result);
    for (const secret of [session, "unrelated-synthetic-owner", hex("a"), hex("c"), hex("d")]) {
      assert.equal(encoded.includes(secret), false);
    }
  }
});

test("the actual inventory predicates retain malformed and duplicate rejection", async () => {
  for (const inventory of [{ extra: true }, { sessions: [item(), item()] },
    { sessions: [{ ...item(), rootTabId: "invalid" }] }]) {
    const f = fixture(inventory);
    assert.deepEqual(await inspectRecovery.call(f.broker, f.grant), {
      schema: "agent-browser.recovery-inspection.v1", outcome: "inventory-invalid",
    });
    assert.deepEqual(f.calls, ["state.inventory"]);
  }
});

test("existing exact one-use grant and profile/owner checks remain decisive", async () => {
  for (const change of [g => { g.expiresAt = 0; }, g => { g.nonce = "invalid"; },
    g => { g.aliasHash = hex("e"); }]) {
    const f = fixture(); change(f.grant);
    await assert.rejects(inspectRecovery.call(f.broker, f.grant), { bridgeCode: "GRANT_REJECTED" });
    assert.deepEqual(f.calls, []);
  }
  const f = fixture();
  f.record.profileHash = hex("f");
  await assert.rejects(inspectRecovery.call(f.broker, f.grant), { bridgeCode: "SESSION_CONFLICT" });
  assert.deepEqual(f.calls, []);
  const reuse = fixture();
  await inspectRecovery.call(reuse.broker, reuse.grant);
  await assert.rejects(inspectRecovery.call(reuse.broker, reuse.grant), { bridgeCode: "GRANT_REJECTED" });
  assert.deepEqual(reuse.calls, ["state.inventory"]);
});

test("pending requested work, peer turnover and timeout never become missing-root proof", async () => {
  const busy = fixture(); busy.broker.pendingSessions.add(session);
  await assert.rejects(inspectRecovery.call(busy.broker, busy.grant), { bridgeCode: "SESSION_BUSY" });
  assert.deepEqual(busy.calls, []);
  const changed = fixture();
  changed.peer.request = async () => { changed.peer.epoch = "new-epoch"; return { sessions: [] }; };
  assert.equal((await inspectRecovery.call(changed.broker, changed.grant)).outcome, "state-changed");
  const timeout = fixture();
  timeout.peer.request = async () => { throw Object.assign(new Error("synthetic"), { bridgeCode: "EXTENSION_TIMEOUT" }); };
  await assert.rejects(inspectRecovery.call(timeout.broker, timeout.grant), { bridgeCode: "RETIRE_TIMEOUT" });
});

