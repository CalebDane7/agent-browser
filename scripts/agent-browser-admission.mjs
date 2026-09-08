import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
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

// Options are an internal fixture seam, never CLI flags or inherited overrides.
export async function runAdmission(argv, { root = defaultRoot,
  wrapperPath = path.join(here, 'agent-browser-private-cws-wrapper.js') } = {}) {
  const fd = acquireAdmissionLock({ root });
  try {
    // Import the existing entrypoint, including its own error/status handling.
    // Calling run() directly would bypass WrapperFailure's existing exit code.
    const entry = fs.realpathSync(wrapperPath);
    process.argv = [process.execPath, entry, ...argv];
    await import(pathToFileURL(entry).href);
    return process.exitCode ?? 0;
  } finally { fs.closeSync(fd); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { process.exitCode = await runAdmission(process.argv.slice(2)); }
  catch (e) { process.stderr.write(`agent-browser: ${e.code || 'ADMISSION_UNAVAILABLE'}\n`); process.exitCode = 69; }
}
