import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const linux = process.platform === 'linux';
const admission = linux ? await import('../scripts/agent-browser-admission.mjs') : null;
const self = fileURLToPath(import.meta.url);
const wrapper = fileURLToPath(new URL('./fixtures/agent-browser-admission-wrapper.mjs', import.meta.url));
const fixtureArgs = ['argument with spaces', '', '--literal=value'];

// The child exercises production admission in its own process. No production
// root, owner override, browser, broker, or native engine is used.
if (process.argv[2] === '--admission-fixture') {
  try {
    process.send({ stage: 'attempt', pid: process.pid });
    process.exitCode = await admission.runAdmission(fixtureArgs, {
      root: process.argv[3], wrapperPath: wrapper,
    });
  } finally {
    if (process.connected) process.disconnect();
  }
} else {
  function temporary(t) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-browser-admission-test-'));
    fs.chmodSync(dir, 0o700);
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    return dir;
  }
  function locks(t) {
    const open = new Set();
    t.after(() => { for (const fd of open) fs.closeSync(fd); });
    return {
      acquire(options) { const fd = admission.acquireAdmissionLock(options); open.add(fd); return fd; },
      close(fd) { fs.closeSync(fd); open.delete(fd); },
    };
  }
  async function until(predicate, label) {
    const deadline = Date.now() + 2000;
    while (!predicate()) {
      assert.ok(Date.now() < deadline, label);
      await new Promise(resolve => setTimeout(resolve, 5));
    }
  }
  const options = { skip: !linux, timeout: 10000 };

  test('cold shared locks survive flock-helper exit and exclude EX until every reader releases', options, t => {
    const dir = temporary(t), root = path.join(dir, 'cold'), held = locks(t);
    const first = held.acquire({ root, waitSeconds: 0 });
    assert.equal(fs.statSync(root).mode & 0o777, 0o700);
    const lock = fs.statSync(path.join(root, 'admission.lock'));
    assert.equal(lock.mode & 0o777, 0o600);
    assert.equal(lock.uid, process.getuid());
    const second = held.acquire({ root, waitSeconds: 0 });
    const exclusive = () => held.acquire({ root, exclusive: true, waitSeconds: 0 });
    assert.throws(exclusive, { code: 'ADMISSION_BUSY' });
    held.close(first);
    assert.throws(exclusive, { code: 'ADMISSION_BUSY' });
    held.close(second);
    const writer = exclusive();
    assert.throws(() => held.acquire({ root, waitSeconds: 0 }), { code: 'ADMISSION_BUSY' });
    held.close(writer);
  });

  test('unsafe modes, symlinks and hardlinked lock inodes never gain admission or alter the target', options, t => {
    const dir = temporary(t);
    const badMode = path.join(dir, 'bad-mode');
    fs.mkdirSync(badMode, { mode: 0o700 }); fs.chmodSync(badMode, 0o755);
    assert.throws(() => admission.acquireAdmissionLock({ root: badMode }), { code: 'ADMISSION_DIRECTORY_UNSAFE' });
    const safe = path.join(dir, 'safe'); fs.mkdirSync(safe, { mode: 0o700 });
    const alias = path.join(dir, 'alias'); fs.symlinkSync(safe, alias);
    assert.throws(() => admission.acquireAdmissionLock({ root: alias }), { code: 'ADMISSION_DIRECTORY_UNSAFE' });
    const target = path.join(dir, 'target'); fs.writeFileSync(target, 'unchanged', { mode: 0o600 });
    const lock = path.join(safe, 'admission.lock');
    fs.symlinkSync(target, lock);
    assert.throws(() => admission.acquireAdmissionLock({ root: safe }), { code: 'ELOOP' });
    assert.equal(fs.readFileSync(target, 'utf8'), 'unchanged');
    fs.unlinkSync(lock);
    fs.writeFileSync(lock, '', { mode: 0o600 }); fs.chmodSync(lock, 0o644);
    assert.throws(() => admission.acquireAdmissionLock({ root: safe }), { code: 'ADMISSION_LOCK_UNSAFE' });
    fs.chmodSync(lock, 0o600);
    fs.linkSync(lock, path.join(dir, 'lock-alias'));
    assert.throws(() => admission.acquireAdmissionLock({ root: safe }), { code: 'ADMISSION_LOCK_UNSAFE' });
  });

  test('EX blocks wrapper import; its SH spans completion without changing original PID, caller, argv or cwd', options, async t => {
    const dir = temporary(t), root = path.join(dir, 'gate');
    let writer = admission.acquireAdmissionLock({ root, exclusive: true, waitSeconds: 0 });
    const messages = [], child = spawn(process.execPath, [self, '--admission-fixture', root], {
      cwd: dir, env: { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8' },
      stdio: ['pipe', 'ignore', 'pipe', 'ipc'],
    });
    let stderr = '', finished;
    child.stderr.on('data', data => { stderr = (stderr + data).slice(-4096); });
    child.on('message', message => { assert.ok(messages.length < 8); messages.push(message); });
    const exit = new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', (code, signal) => { finished = { code, signal }; resolve(finished); });
    });
    try {
      await until(() => messages.some(m => m.stage === 'attempt') || finished, 'child did not reach admission');
      assert.equal(messages.find(m => m.stage === 'attempt')?.pid, child.pid, stderr);
      // Observe only this synthetic process's exact child image, not a sleep or
      // a production-process census. A waiter exists before the negative claim.
      await until(() => {
        const children = fs.readFileSync(`/proc/${child.pid}/task/${child.pid}/children`, 'utf8');
        assert.ok(children.length < 256);
        const ids = children.trim().split(/\s+/).filter(Boolean);
        if (ids.length !== 1) return false;
        try {
          const observed = fs.statSync(`/proc/${ids[0]}/exe`), expected = fs.statSync('/usr/bin/flock');
          return observed.dev === expected.dev && observed.ino === expected.ino;
        } catch (error) { if (error.code === 'ENOENT') return false; throw error; }
      }, 'child was not observed waiting for admission');
      assert.equal(messages.some(m => m.stage === 'imported'), false);
      fs.closeSync(writer); writer = undefined;
      await until(() => messages.some(m => m.stage === 'imported') || finished, 'wrapper did not import after release');
      const imported = messages.find(m => m.stage === 'imported');
      assert.ok(imported, stderr);
      assert.equal(imported.pid, child.pid);
      assert.equal(imported.parentPid, process.pid);
      assert.equal(imported.cwd, dir);
      assert.deepEqual(imported.argv, fixtureArgs);
      // Falsifier: returning from the lock helper or importing the wrapper must
      // not release SH while the existing main is still performing its work.
      assert.throws(() => admission.acquireAdmissionLock({
        root, exclusive: true, waitSeconds: 0,
      }), { code: 'ADMISSION_BUSY' });
      child.stdin.end();
      assert.deepEqual(await exit, { code: 23, signal: null }, stderr);
      const released = admission.acquireAdmissionLock({ root, exclusive: true, waitSeconds: 0 });
      fs.closeSync(released);
    } finally {
      if (writer !== undefined) fs.closeSync(writer);
      child.stdin.end();
      await exit; // No kill: the fixture has bounded, natural completion.
    }
  });
}

// R1501 WHY: fixture-only admission tests missed the actual supervisor importing
// the admission entrypoint again. Exercise that static dependency through the
// literal CLI, while replacing browser execution with a no-effect wrapper.
if (process.argv[2] !== '--admission-fixture') test('literal admission CLI resolves actual supervisor graph without unsettled top-level await', { skip: !linux, timeout: 10000 }, async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-browser-admission-graph-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const scripts = path.join(dir, 'scripts');
  fs.mkdirSync(scripts);
  fs.writeFileSync(path.join(dir, 'package.json'), '{"type":"module"}\n');
  for (const name of ['agent-browser-admission.mjs', 'agent-browser-admission-lock.mjs',
    'agent-browser-extension-supervisor.js', 'agent-browser-extension-control.js',
    'agent-browser-extension-protocol.js']) {
    fs.copyFileSync(fileURLToPath(new URL(`../scripts/${name}`, import.meta.url)), path.join(scripts, name));
  }
  fs.writeFileSync(path.join(scripts, 'agent-browser-private-cws-wrapper.js'), `
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import {requireExtensionBroker, ensureExtensionBroker} from './agent-browser-extension-supervisor.js';
assert.equal(typeof requireExtensionBroker, 'function');
assert.equal(typeof ensureExtensionBroker, 'function');
assert.equal(process.argv[1], fileURLToPath(import.meta.url));
process.send({pid:process.pid,parentPid:process.ppid,cwd:process.cwd(),argv:process.argv.slice(2)});
process.exitCode=23;
`);
  const child = spawn(process.execPath, [path.join(scripts, 'agent-browser-admission.mjs'), ...fixtureArgs], {
    cwd: dir, env: {PATH:'/usr/bin:/bin', LANG:'C.UTF-8', TMPDIR:dir},
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
  });
  let stderr = '', observed;
  child.stderr.on('data', b => { stderr = (stderr + b).slice(-4096); });
  child.on('message', message => { observed = message; });
  const result = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => resolve({code, signal}));
  });
  assert.deepEqual(result, {code:23, signal:null}, stderr);
  assert.equal(stderr, '');
  assert.equal(observed?.pid, child.pid);
  assert.equal(observed?.parentPid, process.pid);
  assert.equal(observed?.cwd, dir);
  assert.deepEqual(observed?.argv, fixtureArgs);
  const fd = admission.acquireAdmissionLock({root:path.join(dir, `agent-browser-admission-${process.getuid()}`), exclusive:true, waitSeconds:0});
  fs.closeSync(fd);
});
