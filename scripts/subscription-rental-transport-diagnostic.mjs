// Temporary diagnostic only. Never emit request URLs/headers, endpoint tokens,
// cleanup grants, page data or extension messages. Do not change admission.
import { constants, openSync, closeSync, fstatSync, lstatSync, readSync } from 'node:fs';
import { join } from 'node:path';

export function createLazyTransportDiagnostic(stateRoot, startTicks, writePrivateJson, now = Date.now) {
  let active = null;
  // Scope can be supplied AFTER the broker starts. Keep the first armed object
  // even after expiry/saturation, so edits/removal never rearm this generation.
  const ensure = session => active ??= armTransportDiagnostic(stateRoot, startTicks,
    writePrivateJson, now, session?.name);
  return {
    event(kind, session, retire = false) { ensure(session)?.event(kind, session, retire); },
    upgrade(session, token, hostMatched) { ensure(session)?.upgrade(session, token, hostMatched); },
  };
}

export function armTransportDiagnostic(stateRoot, startTicks, writePrivateJson, now = Date.now, expectedSession) {
  let fd;
  try {
    fd = openSync(join(stateRoot, 'subscription-rental-transport-scope.json'),
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.uid !== process.getuid() || stat.nlink !== 1 ||
        (stat.mode & 0o777) !== 0o600 || stat.size < 1 || stat.size > 1024) return null;
    const bytes = Buffer.alloc(1025), count = readSync(fd, bytes, 0, bytes.length, 0);
    const after = fstatSync(fd);
    if (count !== stat.size || ['size', 'mtimeMs', 'ctimeMs'].some(k => stat[k] !== after[k])) return null;
    const value = JSON.parse(bytes.subarray(0, count).toString('utf8'));
    if (Object.keys(value).sort().join(',') !== 'expiresAt,schema,session' ||
        value.schema !== 'subscription-rental.transport-scope.v1' ||
        !/^s[a-f0-9]{32}$/.test(value.session) || !Number.isSafeInteger(value.expiresAt) ||
        value.expiresAt <= now() || value.expiresAt > now() + 300_000) return null;
    if (expectedSession !== undefined && expectedSession !== value.session) return null;
    const output = join(stateRoot, 'subscription-rental-transport-last.json');
    // An old/foreign receipt must not be mistaken for this capture or overwritten.
    const reserve = openSync(output, constants.O_WRONLY | constants.O_CREAT |
      constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    let owned = fstatSync(reserve); closeSync(reserve);
    const ownWriter = (file, record) => {
      const current = lstatSync(output);
      if (current.dev !== owned.dev || current.ino !== owned.ino || !current.isFile() ||
          current.uid !== process.getuid() || current.nlink !== 1 || (current.mode & 0o777) !== 0o600)
        throw Error('CAPTURE_OWNERSHIP_CHANGED');
      writePrivateJson(file, record);
      owned = lstatSync(output);
    };
    return createTransportDiagnostic(value, startTicks, ownWriter, stateRoot, now);
  } catch { return null; }
  finally { if (fd !== undefined) closeSync(fd); }
}

export function createTransportDiagnostic(scope, startTicks, writePrivateJson, stateRoot, now = Date.now) {
  const events = [], retired = new Set();
  let sequence = 0;
  const armedAt = now();
  const emit = (event) => {
    if (now() >= scope.expiresAt || sequence >= 256) return;
    events.push({ sequence: ++sequence, observedAt: now(), ...event });
    if (events.length > 64) events.shift();
    try {
      writePrivateJson(join(stateRoot, 'subscription-rental-transport-last.json'), {
        schema: 'subscription-rental.transport-capture.v1', brokerPid: process.pid,
        brokerStartTicks: startTicks, scopeSession: scope.session, armedAt,
        expiresAt: scope.expiresAt, sequence, saturated: sequence >= 256,
        dropped: sequence - events.length, events,
      });
    } catch { /* Capture failure is UNKNOWN, never a transport failure. */ }
  };
  emit({ kind: 'armed' });
  return {
    event(kind, session, retire = false) {
      if (session?.name !== scope.session || now() >= scope.expiresAt) return;
      if (!['root-revoked', 'peer-offline', 'ledger-retired', 'provider-close-request',
        'provider-close-retired'].includes(kind)) return;
      if (retire && typeof session.endpointToken === 'string') {
        retired.add(session.endpointToken);
        if (retired.size > 16) retired.delete(retired.values().next().value);
      }
      emit({ kind });
    },
    upgrade(session, token, hostMatched) {
      if (session && session.name !== scope.session) return;
      const endpointMatched = Boolean(session), offline = Boolean(session?.offline);
      const retiredTarget = !session && retired.has(token);
      emit({ kind: 'upgrade', endpointMatched, offline, hostMatched: hostMatched === true,
        correlation: session ? 'target' : retiredTarget ? 'retired-target' : 'unknown',
        decision: !session || offline || !hostMatched ? 'reject' : 'accept' });
    },
  };
}
