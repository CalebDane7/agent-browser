import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { acquireAdmissionLock } from './agent-browser-admission-lock.mjs';
export { acquireAdmissionLock };

const here = path.dirname(fileURLToPath(import.meta.url));
const defaultRoot = path.join(os.tmpdir(), `agent-browser-admission-${process.getuid()}`);

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
