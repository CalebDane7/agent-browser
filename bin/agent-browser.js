#!/usr/bin/env node

/**
 * Compatibility entry for callers that still invoke bin/agent-browser.js.
 * The package command itself points directly at the authenticated wrapper.
 */

import { spawn } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const entrypoint = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'scripts',
  'agent-browser-real-chrome',
);

const child = spawn(entrypoint, process.argv.slice(2), {
  stdio: 'inherit',
});

child.once('error', (error) => {
  process.stderr.write(`agent-browser compatibility entry failed: ${error.message}\n`);
  process.exitCode = 1;
});

child.once('exit', (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exitCode = code ?? 1;
});
