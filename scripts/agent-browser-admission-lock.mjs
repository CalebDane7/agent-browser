import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

// R1501 WHY: the admission CLI awaits the wrapper import; importing that CLI
// from its supervisor creates an unsettled top-level-await cycle (exit 13).
// Keep this lock owner free of entrypoint imports and browser/runtime effects.
const defaultRoot = path.join(os.tmpdir(), `agent-browser-admission-${process.getuid()}`);
const same = (a, b) => a.dev === b.dev && a.ino === b.ino;
function fail(code) { throw Object.assign(new Error(code), { code }); }

// This gate protects future ordinary wrapper invocations, not legacy native
// execution. An exclusive lock is NEVER evidence that pre-gate work is gone.
// Keep this directory and lock inode stable; install/rollback must not replace it.
export function acquireAdmissionLock({ root = defaultRoot, exclusive = false, waitSeconds = 5 } = {}) {
  if (!path.isAbsolute(root) || path.resolve(root) !== root ||
      !Number.isInteger(waitSeconds) || waitSeconds < 0 || waitSeconds > 30) fail('ADMISSION_INPUT_INVALID');
  const uid = process.getuid();
  try { fs.mkdirSync(root, { mode: 0o700 }); }
  catch (e) { if (e.code !== 'EEXIST') throw e; }
  const directory = fs.lstatSync(root);
  if (!directory.isDirectory() || directory.isSymbolicLink() || directory.uid !== uid ||
      (directory.mode & 0o777) !== 0o700 || fs.realpathSync(root) !== root) fail('ADMISSION_DIRECTORY_UNSAFE');
  const lock = path.join(root, 'admission.lock');
  let fd;
  try {
    fd = fs.openSync(lock, fs.constants.O_RDONLY | fs.constants.O_CREAT | fs.constants.O_NOFOLLOW, 0o600);
    const opened = fs.fstatSync(fd);
    const validate = () => {
      const current = fs.lstatSync(lock), currentRoot = fs.lstatSync(root);
      if (!opened.isFile() || opened.uid !== uid || (opened.mode & 0o777) !== 0o600 ||
          opened.nlink !== 1 || opened.size !== 0 || current.isSymbolicLink() ||
          !same(opened, current) || current.uid !== uid || (current.mode & 0o777) !== 0o600 ||
          current.nlink !== 1 || !same(directory, currentRoot) ||
          !currentRoot.isDirectory() || (currentRoot.mode & 0o777) !== 0o700) fail('ADMISSION_LOCK_UNSAFE');
    };
    validate();
    // Descriptor mode locks the open-file description shared with this Node
    // process. The short-lived flock child is NOT the wrapper's parent. Running
    // wrapper main below in this original Node process preserves caller identity.
    const acquired = spawnSync('/usr/bin/flock', [exclusive ? '--exclusive' : '--shared',
      '--timeout', String(waitSeconds), '--conflict-exit-code', '75', '3'], {
      stdio: ['ignore', 'ignore', 'pipe', fd], encoding: 'utf8',
      env: { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8' },
    });
    if (acquired.error || acquired.signal || acquired.status !== 0) fail('ADMISSION_BUSY');
    validate();
    return fd;
  } catch (e) { if (fd !== undefined) fs.closeSync(fd); throw e; }
}

