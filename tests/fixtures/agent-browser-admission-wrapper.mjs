import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

// This is an entrypoint, not a run() export: admission must retain the existing
// wrapper's main/status handling and its original caller process.
assert.equal(process.argv[1], fileURLToPath(import.meta.url));
process.send({
  stage: 'imported', pid: process.pid, parentPid: process.ppid,
  cwd: process.cwd(), argv: process.argv.slice(2),
});
await new Promise((resolve, reject) => {
  const timer = setTimeout(() => {
    process.stdin.destroy();
    reject(Error('fixture completion deadline'));
  }, 3000);
  process.stdin.once('end', () => { clearTimeout(timer); resolve(); });
  process.stdin.resume();
});
process.exitCode = 23;
