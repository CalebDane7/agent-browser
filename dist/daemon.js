import * as net from 'net';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { TextDecoder } from 'node:util';
import { createHash, randomBytes } from 'crypto';
import { fileURLToPath } from 'url';
import { BrowserManager } from './browser.js';
import { parseCommand, serializeResponse, errorResponse, finalizeResponse } from './protocol.js';
import { executeCommand, renderActionError } from './actions.js';
import { StreamServer } from './stream-server.js';
import { getEncryptionKey, encryptData, isValidSessionName, cleanupExpiredStates, getAutoStateFilePath, } from './state-utils.js';
// Platform detection
const isWindows = process.platform === 'win32';
// WSL detection: process.platform reports 'linux' but host OS is Windows
const isWSL = (() => {
    try {
        return /microsoft/i.test(fs.readFileSync('/proc/version', 'utf8'));
    } catch { return false; }
})();
const DAEMON_IDENTITY_SCHEMA = 'agent-browser-daemon-identity-v2';
const DAEMON_RUNTIME_VERSION = '0.13.0';
const DAEMON_PROTOCOL_IDENTITY = 'jsonl-command-v1';
const DAEMON_CAPABILITIES = 'click-expect-popup-v1';
const DAEMON_IDENTITY_REQUIRED_ENV = 'AGENT_BROWSER_DAEMON_IDENTITY_REQUIRED';
const DAEMON_CANONICAL_MANIFEST_ENV = 'AGENT_BROWSER_CANONICAL_DIST_MANIFEST';
const DAEMON_EXPECTED_MANIFEST_SHA256_ENV = 'AGENT_BROWSER_EXPECTED_CANONICAL_DIST_MANIFEST_SHA256';
const DAEMON_IDENTITY_SUFFIX = '.daemon-identity';
const CANONICAL_DIST_SCHEMA = 'agent-browser-canonical-dist.v1';
const CANONICAL_DIST_AUTHORITY = 'tracked-dist-js';
let ownedDaemonIdentityReceipt = null;
// Session support - each session gets its own socket/pid
let currentSession = process.env.AGENT_BROWSER_SESSION || 'default';
// Stream server for browser preview
let streamServer = null;
const managerCloseOperations = new WeakMap();
const FATAL_DIAGNOSTIC_LIMIT = 160;
const FATAL_DIAGNOSTIC_LABELS = new Set([
    'Daemon error',
    'Daemon identity error',
    'Server error',
    'Uncaught exception',
    'Unhandled rejection',
]);
let secureSocketRoot = null;
const ownedDaemonArtifacts = new Map();
const REF_PUBLISHING_ACTIONS = new Set(['snapshot', 'diff_snapshot', 'diff_url']);

function clearManagerRefs(manager) {
    const refs = typeof manager?.getRefMap === 'function' ? manager.getRefMap() : manager?.refMap;
    if (!refs || typeof refs !== 'object')
        return;
    for (const ref of Object.keys(refs))
        delete refs[ref];
}

/**
 * Finalize the post-handler daemon envelope and revoke refs if transport
 * projection removes the snapshot lines that granted them.
 * @internal Exported for deterministic transport-boundary tests.
 */
export function finalizeDaemonResponse(response, controls = {}, manager = null) {
    const finalized = finalizeResponse(response, controls);
    const action = controls?.action;
    if (action === 'diff_screenshot' ||
        (REF_PUBLISHING_ACTIONS.has(action) && (!finalized.success || finalized !== response))) {
        clearManagerRefs(manager);
    }
    return finalized;
}

function serializeDaemonResponse(response, controls, manager) {
    return serializeResponse(finalizeDaemonResponse(response, controls, manager), controls);
}

/**
 * Render only bounded diagnostic classifications. Error messages, stacks,
 * paths, endpoints, receipts, and arbitrary objects are intentionally absent.
 */
export function renderFatalDiagnostic(label, error) {
    const safeLabel = FATAL_DIAGNOSTIC_LABELS.has(label) ? label : 'Daemon failure';
    let classification = 'failure';
    try {
        if (error && (typeof error === 'object' || typeof error === 'function')) {
            const code = error.code;
            const name = error.name;
            if (typeof code === 'string' && /^[A-Za-z][A-Za-z0-9_.-]{0,47}$/.test(code)) {
                classification = code;
            }
            else if (typeof name === 'string' && /^[A-Za-z][A-Za-z0-9_.-]{0,47}$/.test(name)) {
                classification = name;
            }
            else {
                classification = 'object';
            }
        }
        else if (typeof error === 'string') {
            classification = 'string';
        }
        else if (error !== undefined && error !== null) {
            classification = typeof error;
        }
    }
    catch {
        classification = 'object';
    }
    return `${safeLabel} [${classification}]`.slice(0, FATAL_DIAGNOSTIC_LIMIT);
}

/**
 * Close one manager at most once concurrently and never hold a fatal exit path
 * past its deadline. A timed-out operation remains registered so a second
 * signal cannot start a competing cleanup against the same targets.
 */
export async function closeManagerBounded(manager, timeoutMs = 1000) {
    if (!manager || typeof manager.close !== 'function') {
        return { closed: true, timedOut: false };
    }
    let operation = managerCloseOperations.get(manager);
    if (!operation) {
        operation = Promise.resolve()
            .then(() => manager.close())
            .then(
                () => ({ closed: true, timedOut: false }),
                (error) => ({
                    closed: false,
                    timedOut: false,
                    error,
                    unresolvedCleanup: manager.getUnresolvedCleanup?.(),
                }),
            );
        managerCloseOperations.set(manager, operation);
        operation.finally(() => {
            if (managerCloseOperations.get(manager) === operation) {
                managerCloseOperations.delete(manager);
            }
        });
    }
    let timer;
    const timeout = new Promise((resolve) => {
        timer = setTimeout(() => resolve({
            closed: false,
            timedOut: true,
            unresolvedCleanup: manager.getUnresolvedCleanup?.(),
        }), timeoutMs);
        timer.unref?.();
    });
    const result = await Promise.race([operation, timeout]);
    clearTimeout(timer);
    return result;
}

export function prepareDaemonCloseResponse(response, manager) {
    if (response?.success === true) return response;
    return {
        ...response,
        data: {
            ...(response?.data ?? {}),
            unresolvedCleanup: manager?.getUnresolvedCleanup?.() ?? null,
        },
    };
}

export function closeResponseAllowsDaemonShutdown(response) {
    return response?.success === true;
}
// Default stream port (can be overridden with AGENT_BROWSER_STREAM_PORT)
const DEFAULT_STREAM_PORT = 9223;
/**
 * Save state to file with optional encryption.
 */
async function saveStateToFile(browser, filepath) {
    const context = browser.getContext();
    if (!context) {
        throw new Error('No browser context available');
    }
    const state = await context.storageState();
    const jsonData = JSON.stringify(state, null, 2);
    const key = getEncryptionKey();
    if (key) {
        const encrypted = encryptData(jsonData, key);
        fs.writeFileSync(filepath, JSON.stringify(encrypted, null, 2));
        return { encrypted: true };
    }
    fs.writeFileSync(filepath, jsonData);
    return { encrypted: false };
}
const AUTO_EXPIRE_ENV = 'AGENT_BROWSER_STATE_EXPIRE_DAYS';
const DEFAULT_EXPIRE_DAYS = 30;
function runCleanupExpiredStates() {
    const expireDaysStr = process.env[AUTO_EXPIRE_ENV];
    const expireDays = expireDaysStr ? parseInt(expireDaysStr, 10) : DEFAULT_EXPIRE_DAYS;
    if (isNaN(expireDays) || expireDays <= 0) {
        return;
    }
    try {
        const deleted = cleanupExpiredStates(expireDays);
        if (deleted.length > 0 && process.env.AGENT_BROWSER_DEBUG === '1') {
            console.error(`[DEBUG] Auto-expired ${deleted.length} state file(s) older than ${expireDays} days`);
        }
    }
    catch (err) {
        if (process.env.AGENT_BROWSER_DEBUG === '1') {
            console.error(renderFatalDiagnostic('Daemon failure', err));
        }
    }
}
/**
 * Get the validated session name and auto-state file path.
 * Centralizes session name validation to prevent path traversal.
 */
function getSessionAutoStatePath() {
    const sessionNameRaw = process.env.AGENT_BROWSER_SESSION_NAME;
    if (!sessionNameRaw)
        return undefined;
    if (!isValidSessionName(sessionNameRaw)) {
        if (process.env.AGENT_BROWSER_DEBUG === '1') {
            console.error('[SECURITY] Invalid session name rejected');
        }
        return undefined;
    }
    const sessionId = process.env.AGENT_BROWSER_SESSION || 'default';
    try {
        const autoStatePath = getAutoStateFilePath(sessionNameRaw, sessionId);
        return autoStatePath && fs.existsSync(autoStatePath) ? autoStatePath : undefined;
    }
    catch {
        return undefined;
    }
}
/**
 * Get the auto-state file path for saving (creates sessions dir if needed).
 * Returns undefined if no valid session name is configured.
 */
function getSessionSaveStatePath() {
    const sessionNameRaw = process.env.AGENT_BROWSER_SESSION_NAME;
    if (!sessionNameRaw)
        return undefined;
    if (!isValidSessionName(sessionNameRaw))
        return undefined;
    const sessionId = process.env.AGENT_BROWSER_SESSION || 'default';
    try {
        return getAutoStateFilePath(sessionNameRaw, sessionId) ?? undefined;
    }
    catch {
        return undefined;
    }
}
function validatedSession(session = currentSession) {
    if (typeof session !== 'string' || !isValidSessionName(session)) {
        throw daemonIdentityFailure('DAEMON_SESSION_INVALID');
    }
    return session;
}

function assertNoSymlinkPathComponents(absolutePath) {
    const parsed = path.parse(absolutePath);
    let cursor = parsed.root;
    for (const component of absolutePath.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
        cursor = path.join(cursor, component);
        const stat = fs.lstatSync(cursor);
        if (stat.isSymbolicLink()) {
            throw daemonIdentityFailure('DAEMON_SOCKET_ROOT_SYMLINK');
        }
    }
}

function ensureSecureSocketRoot() {
    const configuredRoot = getSocketDir();
    if (typeof configuredRoot !== 'string' || !path.isAbsolute(configuredRoot) ||
        path.resolve(configuredRoot) !== configuredRoot) {
        throw daemonIdentityFailure('DAEMON_SOCKET_ROOT_NOT_CANONICAL');
    }
    if (isWSL && /^\/mnt\/[a-z](?:\/|$)/i.test(configuredRoot)) {
        throw daemonIdentityFailure('DAEMON_SOCKET_ROOT_NOT_LOCAL');
    }
    if (!fs.existsSync(configuredRoot)) {
        const parent = path.dirname(configuredRoot);
        assertNoSymlinkPathComponents(parent);
        if (fs.realpathSync(parent) !== parent) {
            throw daemonIdentityFailure('DAEMON_SOCKET_ROOT_NOT_CANONICAL');
        }
        fs.mkdirSync(configuredRoot, { mode: 0o700, recursive: false });
    }
    assertNoSymlinkPathComponents(configuredRoot);
    const stat = fs.lstatSync(configuredRoot, { bigint: true });
    const uid = process.geteuid?.() ?? process.getuid?.();
    const ownerMatches = Number.isSafeInteger(uid)
        ? stat.uid === BigInt(uid)
        : process.platform === 'win32';
    if (!stat.isDirectory() || stat.isSymbolicLink() ||
        (stat.mode & 0o777n) !== 0o700n ||
        !ownerMatches) {
        throw daemonIdentityFailure('DAEMON_SOCKET_ROOT_PERMISSIONS');
    }
    if (fs.realpathSync(configuredRoot) !== configuredRoot) {
        throw daemonIdentityFailure('DAEMON_SOCKET_ROOT_NOT_CANONICAL');
    }
    secureSocketRoot = {
        path: configuredRoot,
        dev: stat.dev,
        ino: stat.ino,
    };
    return configuredRoot;
}

function assertSecureSocketRootUnchanged() {
    const ownedRoot = secureSocketRoot;
    if (!ownedRoot) {
        throw daemonIdentityFailure('DAEMON_SOCKET_ROOT_UNVERIFIED');
    }
    const stat = fs.lstatSync(ownedRoot.path, { bigint: true });
    const uid = process.geteuid?.() ?? process.getuid?.();
    const ownerMatches = Number.isSafeInteger(uid)
        ? stat.uid === BigInt(uid)
        : process.platform === 'win32';
    if (!stat.isDirectory() || stat.isSymbolicLink() ||
        stat.dev !== ownedRoot.dev || stat.ino !== ownedRoot.ino ||
        (stat.mode & 0o777n) !== 0o700n ||
        !ownerMatches) {
        throw daemonIdentityFailure('DAEMON_SOCKET_ROOT_CHANGED');
    }
}
/**
 * Set the current session
 */
export function setSession(session) {
    currentSession = validatedSession(session);
}
/**
 * Get the current session
 */
export function getSession() {
    return currentSession;
}
/**
 * Get port number for TCP mode (Windows)
 * Uses a hash of the session name to get a consistent port
 */
function getPortForSession(session) {
    let hash = 0;
    for (let i = 0; i < session.length; i++) {
        hash = (hash << 5) - hash + session.charCodeAt(i);
        hash |= 0;
    }
    // Port range 49152-65535 (dynamic/private ports)
    return 49152 + (Math.abs(hash) % 16383);
}
/**
 * Get the base directory for socket/pid files.
 * Priority: AGENT_BROWSER_SOCKET_DIR > XDG_RUNTIME_DIR > ~/.agent-browser > tmpdir
 */
export function getAppDir() {
    // 1. XDG_RUNTIME_DIR (Linux standard)
    if (process.env.XDG_RUNTIME_DIR) {
        return path.join(process.env.XDG_RUNTIME_DIR, 'agent-browser');
    }
    // 2. Home directory fallback (like Docker Desktop's ~/.docker/run/)
    const homeDir = os.homedir();
    if (homeDir) {
        return path.join(homeDir, '.agent-browser');
    }
    // 3. Last resort: temp dir
    return path.join(os.tmpdir(), 'agent-browser');
}
export function getSocketDir() {
    // Allow explicit override for socket directory
    if (process.env.AGENT_BROWSER_SOCKET_DIR) {
        return process.env.AGENT_BROWSER_SOCKET_DIR;
    }
    return getAppDir();
}
/**
 * Get the socket path for the current session (Unix) or port (Windows)
 */
export function getSocketPath(session) {
    const sess = validatedSession(session ?? currentSession);
    if (isWindows) {
        return String(getPortForSession(sess));
    }
    return path.join(getSocketDir(), `${sess}.sock`);
}
/**
 * Get the port file path for Windows (stores the port number)
 */
export function getPortFile(session) {
    const sess = validatedSession(session ?? currentSession);
    return path.join(getSocketDir(), `${sess}.port`);
}
/**
 * Get the PID file path for the current session
 */
export function getPidFile(session) {
    const sess = validatedSession(session ?? currentSession);
    return path.join(getSocketDir(), `${sess}.pid`);
}
function getDaemonIdentityReceiptFile(session) {
    const sess = validatedSession(session ?? currentSession);
    return path.join(getSocketDir(), `${sess}${DAEMON_IDENTITY_SUFFIX}`);
}
function daemonIdentityFailure(code) {
    const error = new Error(code);
    error.code = code;
    return error;
}
function assertDirectSocketArtifact(artifactPath) {
    assertSecureSocketRootUnchanged();
    if (path.dirname(artifactPath) !== secureSocketRoot.path || path.resolve(artifactPath) !== artifactPath) {
        throw daemonIdentityFailure('DAEMON_ARTIFACT_PATH_INVALID');
    }
}
function artifactKindMatches(stat, kind) {
    if (kind === 'socket')
        return stat.isSocket();
    return stat.isFile();
}
function rememberOwnedArtifact(artifactPath, kind, contents) {
    assertDirectSocketArtifact(artifactPath);
    const stat = fs.lstatSync(artifactPath, { bigint: true });
    if (stat.isSymbolicLink() || !artifactKindMatches(stat, kind)) {
        throw daemonIdentityFailure('DAEMON_ARTIFACT_TYPE_INVALID');
    }
    ownedDaemonArtifacts.set(artifactPath, {
        path: artifactPath,
        kind,
        contents,
        dev: stat.dev,
        ino: stat.ino,
    });
    return stat;
}
function writeOwnedArtifact(artifactPath, contents, mode = 0o600) {
    assertDirectSocketArtifact(artifactPath);
    let fd;
    try {
        fd = fs.openSync(artifactPath, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY, mode);
        fs.fchmodSync(fd, mode);
        fs.writeFileSync(fd, contents, 'utf8');
        fs.fsyncSync(fd);
        fs.closeSync(fd);
        fd = undefined;
        const stat = rememberOwnedArtifact(artifactPath, 'file', contents);
        if ((stat.mode & 0o777n) !== BigInt(mode)) {
            throw daemonIdentityFailure('DAEMON_ARTIFACT_PERMISSIONS');
        }
    }
    catch (error) {
        if (fd !== undefined) {
            try {
                fs.closeSync(fd);
            }
            catch { }
        }
        throw error;
    }
}
function cleanupOwnedArtifact(artifactPath) {
    const owned = ownedDaemonArtifacts.get(artifactPath);
    if (!owned)
        return true;
    try {
        assertDirectSocketArtifact(artifactPath);
        const stat = fs.lstatSync(artifactPath, { bigint: true });
        if (stat.isSymbolicLink() || !artifactKindMatches(stat, owned.kind) ||
            stat.dev !== owned.dev || stat.ino !== owned.ino) {
            ownedDaemonArtifacts.delete(artifactPath);
            return true;
        }
        if (owned.contents !== undefined && fs.readFileSync(artifactPath, 'utf8') !== owned.contents) {
            return false;
        }
        fs.unlinkSync(artifactPath);
        ownedDaemonArtifacts.delete(artifactPath);
        return true;
    }
    catch (error) {
        if (error?.code === 'ENOENT') {
            ownedDaemonArtifacts.delete(artifactPath);
            return true;
        }
        return false;
    }
}
function sessionArtifactPaths(session = currentSession) {
    const sess = validatedSession(session);
    const paths = [
        getPidFile(sess),
        getStreamPortFile(sess),
        getDaemonIdentityReceiptFile(sess),
    ];
    paths.push(isWindows ? getPortFile(sess) : getSocketPath(sess));
    return paths;
}
function assertSessionNamespaceVacant(session = currentSession) {
    for (const artifactPath of sessionArtifactPaths(session)) {
        assertDirectSocketArtifact(artifactPath);
        try {
            fs.lstatSync(artifactPath);
            throw daemonIdentityFailure('DAEMON_SESSION_ARTIFACT_EXISTS');
        }
        catch (error) {
            if (error?.code !== 'ENOENT')
                throw error;
        }
    }
}
function assertReceiptField(value, name) {
    if (value.includes('\t') || value.includes('\r') || value.includes('\n')) {
        throw daemonIdentityFailure(`DAEMON_IDENTITY_INVALID_${name.replaceAll(' ', '_').toUpperCase()}`);
    }
    return value;
}
function getLinuxProcessStartTicks() {
    if (process.platform !== 'linux') {
        throw daemonIdentityFailure('DAEMON_IDENTITY_UNSUPPORTED_PLATFORM');
    }
    const procStat = fs.readFileSync('/proc/self/stat', 'utf8');
    const commandEnd = procStat.lastIndexOf(') ');
    if (commandEnd < 0) {
        throw daemonIdentityFailure('DAEMON_IDENTITY_PROC_PARSE');
    }
    // After "pid (comm) ", index 0 is proc field 3; starttime is field 22.
    const fields = procStat.slice(commandEnd + 2).trim().split(/\s+/);
    const startTicks = fields[19];
    if (!startTicks || !/^\d+$/.test(startTicks)) {
        throw daemonIdentityFailure('DAEMON_IDENTITY_PROC_START');
    }
    return startTicks;
}
function toPosixPath(value) {
    return value.split(path.sep).join('/');
}
function listCanonicalJavaScriptFiles(runtimeRoot) {
    const distRoot = path.resolve(runtimeRoot, 'dist');
    const files = [];
    const walk = (directory) => {
        const entries = fs.readdirSync(directory, { withFileTypes: true })
            .sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
        for (const entry of entries) {
            const absolutePath = path.join(directory, entry.name);
            if (entry.isSymbolicLink()) {
                throw daemonIdentityFailure('DAEMON_CANONICAL_DIST_SYMLINK');
            }
            if (entry.isDirectory()) {
                walk(absolutePath);
            }
            else if (entry.isFile() && entry.name.endsWith('.js')) {
                files.push(toPosixPath(path.relative(runtimeRoot, absolutePath)));
            }
        }
    };
    walk(distRoot);
    return files.sort();
}
function verifyCanonicalRuntimeGraph(runtimeRoot) {
    const manifestPath = process.env[DAEMON_CANONICAL_MANIFEST_ENV] ||
        path.join(runtimeRoot, 'scripts', 'canonical-dist.json');
    const manifestStat = fs.lstatSync(manifestPath);
    if (!manifestStat.isFile() || manifestStat.isSymbolicLink()) {
        throw daemonIdentityFailure('DAEMON_CANONICAL_MANIFEST_FILE');
    }
    const manifestBytes = fs.readFileSync(manifestPath);
    const manifestSha256 = createHash('sha256').update(manifestBytes).digest('hex');
    const expectedManifestSha256 = process.env[DAEMON_EXPECTED_MANIFEST_SHA256_ENV];
    if (!expectedManifestSha256 || !/^[0-9a-f]{64}$/.test(expectedManifestSha256)) {
        throw daemonIdentityFailure('DAEMON_IDENTITY_EXPECTED_MANIFEST_MISSING');
    }
    if (manifestSha256 !== expectedManifestSha256) {
        throw daemonIdentityFailure('DAEMON_CANONICAL_MANIFEST_CHANGED_DURING_STARTUP');
    }
    let manifest;
    try {
        manifest = JSON.parse(manifestBytes.toString('utf8'));
    }
    catch {
        throw daemonIdentityFailure('DAEMON_CANONICAL_MANIFEST_JSON');
    }
    if (manifest?.schema !== CANONICAL_DIST_SCHEMA ||
        manifest?.authority !== CANONICAL_DIST_AUTHORITY ||
        manifest?.algorithm !== 'sha256' ||
        !manifest.files || Array.isArray(manifest.files) || typeof manifest.files !== 'object') {
        throw daemonIdentityFailure('DAEMON_CANONICAL_MANIFEST_CONTRACT');
    }
    const declaredPaths = Object.keys(manifest.files);
    const sortedDeclaredPaths = [...declaredPaths].sort();
    if (JSON.stringify(declaredPaths) !== JSON.stringify(sortedDeclaredPaths) ||
        JSON.stringify(declaredPaths) !== JSON.stringify(listCanonicalJavaScriptFiles(runtimeRoot))) {
        throw daemonIdentityFailure('DAEMON_CANONICAL_FILE_SET');
    }
    const distPrefix = `${path.resolve(runtimeRoot, 'dist')}${path.sep}`;
    const graphHash = createHash('sha256');
    for (const relativePath of declaredPaths) {
        const expectedHash = manifest.files[relativePath];
        const absolutePath = path.resolve(runtimeRoot, ...relativePath.split('/'));
        if (!relativePath.startsWith('dist/') || !relativePath.endsWith('.js') ||
            !absolutePath.startsWith(distPrefix) || !/^[0-9a-f]{64}$/.test(expectedHash)) {
            throw daemonIdentityFailure('DAEMON_CANONICAL_MANIFEST_ENTRY');
        }
        const fileStat = fs.lstatSync(absolutePath);
        if (!fileStat.isFile() || fileStat.isSymbolicLink()) {
            throw daemonIdentityFailure('DAEMON_CANONICAL_RUNTIME_FILE');
        }
        const actualHash = createHash('sha256').update(fs.readFileSync(absolutePath)).digest('hex');
        if (actualHash !== expectedHash) {
            throw daemonIdentityFailure('DAEMON_CANONICAL_GRAPH_MISMATCH');
        }
        graphHash.update(relativePath, 'utf8');
        graphHash.update('\0', 'utf8');
        graphHash.update(actualHash, 'ascii');
        graphHash.update('\n', 'utf8');
    }
    return {
        manifestSha256,
        graphSha256: graphHash.digest('hex'),
    };
}
function writeDaemonIdentityReceipt(server) {
    if (process.env[DAEMON_IDENTITY_REQUIRED_ENV] !== '1') {
        return;
    }
    if (process.platform !== 'linux') {
        throw daemonIdentityFailure('DAEMON_IDENTITY_UNSUPPORTED_PLATFORM');
    }
    const sourcePath = fileURLToPath(import.meta.url);
    const runtimeRoot = assertReceiptField(process.env.AGENT_BROWSER_HOME || '', 'runtime root');
    if (!runtimeRoot) {
        throw daemonIdentityFailure('DAEMON_IDENTITY_RUNTIME_ROOT_MISSING');
    }
    // The wrapper fingerprints the canonical manifest before launch. Startup
    // then verifies every declared executable JS byte before publishing the
    // graph/capability receipt, closing both stale imports and update races.
    const canonicalGraph = verifyCanonicalRuntimeGraph(runtimeRoot);
    const uid = process.geteuid?.() ?? process.getuid?.();
    if (!Number.isSafeInteger(uid) || uid < 0) {
        throw daemonIdentityFailure('DAEMON_IDENTITY_UID_UNAVAILABLE');
    }
    const executableStat = fs.statSync('/proc/self/exe', { bigint: true });
    const sourceStat = fs.statSync(sourcePath, { bigint: true });
    const socketRoot = assertReceiptField(getSocketDir(), 'socket root');
    const connection = getConnectionInfo();
    const socketKind = connection.type;
    const socketEndpoint = connection.type === 'unix' ? connection.path : String(connection.port);
    const boundAddress = server.address();
    let socketDev = 0n;
    let socketIno = 0n;
    if (connection.type === 'unix') {
        if (boundAddress !== socketEndpoint) {
            throw daemonIdentityFailure('DAEMON_IDENTITY_SOCKET_BINDING');
        }
        const socketStat = fs.lstatSync(socketEndpoint, { bigint: true });
        if (!socketStat.isSocket() || socketStat.isSymbolicLink()) {
            throw daemonIdentityFailure('DAEMON_IDENTITY_SOCKET_TYPE');
        }
        socketDev = socketStat.dev;
        socketIno = socketStat.ino;
    }
    else if (!boundAddress || typeof boundAddress === 'string' ||
        boundAddress.address !== '127.0.0.1' || boundAddress.port !== connection.port) {
        throw daemonIdentityFailure('DAEMON_IDENTITY_TCP_BINDING');
    }
    const fields = [
        DAEMON_IDENTITY_SCHEMA,
        DAEMON_RUNTIME_VERSION,
        DAEMON_PROTOCOL_IDENTITY,
        DAEMON_CAPABILITIES,
        assertReceiptField(currentSession, 'session'),
        String(process.pid),
        getLinuxProcessStartTicks(),
        String(uid),
        String(executableStat.dev),
        String(executableStat.ino),
        socketRoot,
        socketKind,
        assertReceiptField(socketEndpoint, 'socket endpoint'),
        String(socketDev),
        String(socketIno),
        runtimeRoot,
        canonicalGraph.manifestSha256,
        canonicalGraph.graphSha256,
        String(sourceStat.dev),
        String(sourceStat.ino),
        String(sourceStat.size),
    ];
    const contents = `${fields.join('\t')}\n`;
    const receiptPath = getDaemonIdentityReceiptFile();
    const temporaryPath = `${receiptPath}.${process.pid}.${randomBytes(12).toString('hex')}.tmp`;
    let fd;
    try {
        fd = fs.openSync(temporaryPath, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY, 0o600);
        fs.fchmodSync(fd, 0o600);
        fs.writeFileSync(fd, contents, 'utf8');
        fs.fsyncSync(fd);
        fs.closeSync(fd);
        fd = undefined;
        // link(2) publishes without replacing an identity from another daemon.
        fs.linkSync(temporaryPath, receiptPath);
        fs.unlinkSync(temporaryPath);
        const receiptStat = fs.lstatSync(receiptPath, { bigint: true });
        if (!receiptStat.isFile() || receiptStat.isSymbolicLink() || (receiptStat.mode & 0o777n) !== 0o600n) {
            throw daemonIdentityFailure('DAEMON_IDENTITY_RECEIPT_PERMISSIONS');
        }
        ownedDaemonIdentityReceipt = {
            session: currentSession,
            path: receiptPath,
            contents,
            dev: receiptStat.dev,
            ino: receiptStat.ino,
        };
        ownedDaemonArtifacts.set(receiptPath, {
            path: receiptPath,
            kind: 'file',
            contents,
            dev: receiptStat.dev,
            ino: receiptStat.ino,
        });
    }
    catch (error) {
        if (fd !== undefined) {
            try {
                fs.closeSync(fd);
            }
            catch { }
        }
        try {
            if (fs.existsSync(temporaryPath))
                fs.unlinkSync(temporaryPath);
        }
        catch { }
        throw error;
    }
}
function cleanupOwnedDaemonIdentityReceipt(session) {
    const owned = ownedDaemonIdentityReceipt;
    if (!owned || (session ?? currentSession) !== owned.session) {
        return;
    }
    try {
        const receiptStat = fs.lstatSync(owned.path, { bigint: true });
        if (!receiptStat.isFile() || receiptStat.isSymbolicLink() ||
            receiptStat.dev !== owned.dev || receiptStat.ino !== owned.ino) {
            ownedDaemonArtifacts.delete(owned.path);
            ownedDaemonIdentityReceipt = null;
            return;
        }
        if (fs.readFileSync(owned.path, 'utf8') === owned.contents) {
            fs.unlinkSync(owned.path);
            ownedDaemonArtifacts.delete(owned.path);
            ownedDaemonIdentityReceipt = null;
        }
    }
    catch {
        // A missing or replaced receipt is not owned by this daemon.
        ownedDaemonArtifacts.delete(owned.path);
        ownedDaemonIdentityReceipt = null;
    }
}
/**
 * Check if daemon is running for the current session
 */
export function isDaemonRunning(session) {
    const pidFile = getPidFile(session);
    if (!fs.existsSync(pidFile))
        return false;
    try {
        const pid = parseInt(fs.readFileSync(pidFile, 'utf8').trim(), 10);
        // Check if process exists (works on both Unix and Windows)
        process.kill(pid, 0);
        return true;
    }
    catch {
        // A dead PID is not proof that this process owns the namespace.
        return false;
    }
}
/**
 * Get connection info for the current session
 * Returns { type: 'unix', path: string } or { type: 'tcp', port: number }
 */
export function getConnectionInfo(session) {
    const sess = validatedSession(session ?? currentSession);
    if (isWindows) {
        return { type: 'tcp', port: getPortForSession(sess) };
    }
    return { type: 'unix', path: path.join(getSocketDir(), `${sess}.sock`) };
}
/**
 * Clean up socket and PID file for the current session
 */
export function cleanupSocket(session) {
    const sess = validatedSession(session ?? currentSession);
    const unresolved = [];
    for (const artifactPath of sessionArtifactPaths(sess)) {
        if (artifactPath === getDaemonIdentityReceiptFile(sess))
            continue;
        if (!cleanupOwnedArtifact(artifactPath))
            unresolved.push(path.basename(artifactPath));
    }
    cleanupOwnedDaemonIdentityReceipt(sess);
    if (ownedDaemonIdentityReceipt?.session === sess)
        unresolved.push(path.basename(ownedDaemonIdentityReceipt.path));
    return { cleaned: unresolved.length === 0, unresolved };
}
/**
 * Get the stream port file path
 */
export function getStreamPortFile(session) {
    const sess = validatedSession(session ?? currentSession);
    return path.join(getSocketDir(), `${sess}.stream`);
}
/**
 * Start the daemon server
 * @param options.streamPort Port for WebSocket stream server (0 to disable)
 * The desktop package rejects the legacy iOS provider before any socket or browser side effect.
 */
export async function startDaemon(options) {
    const provider = options?.provider ?? process.env.AGENT_BROWSER_PROVIDER;
    if (provider === 'ios') {
        throw new Error('The iOS provider is not available in this desktop raw-CDP package');
    }
    // Session and root authority are established before any namespaced read,
    // write, cleanup, listener, or manager can act.
    currentSession = validatedSession(currentSession);
    ensureSecureSocketRoot();
    assertSessionNamespaceVacant();
    // Clean up expired state files on startup
    runCleanupExpiredStates();
    const manager = new BrowserManager();
    let shuttingDown = false;
    let identityReady = false;
    let shutdownPromise = null;
    const activeSockets = new Set();
    // Start stream server if port is specified (or use default if env var is set)
    const streamPort = options?.streamPort ??
        (process.env.AGENT_BROWSER_STREAM_PORT
            ? parseInt(process.env.AGENT_BROWSER_STREAM_PORT, 10)
            : 0);
    if (streamPort > 0) {
        streamServer = new StreamServer(manager, streamPort);
        await streamServer.start();
        // Write stream port to file for clients to discover
        const streamPortFile = getStreamPortFile();
        writeOwnedArtifact(streamPortFile, streamPort.toString());
    }
    const server = net.createServer((socket) => {
        activeSockets.add(socket);
        socket.once('close', () => activeSockets.delete(socket));
        if (!identityReady || shuttingDown) {
            socket.destroy();
            return;
        }
        let buffer = '';
        let httpChecked = false;
        let inputRejected = false;
        const decoder = new TextDecoder('utf-8', { fatal: true });
        const rejectInvalidUtf8 = () => {
            if (inputRejected)
                return;
            inputRejected = true;
            buffer = '';
            const response = errorResponse('error', 'Invalid UTF-8 input');
            if (!socket.destroyed) {
                socket.end(serializeDaemonResponse(response, {}, manager) + '\n');
            }
        };
        socket.on('data', async (data) => {
            if (inputRejected)
                return;
            if (!identityReady || shuttingDown) {
                socket.destroy();
                return;
            }
            try {
                buffer += decoder.decode(data, { stream: true });
            }
            catch {
                rejectInvalidUtf8();
                return;
            }
            // Security: Detect and reject HTTP requests to prevent cross-origin attacks.
            // Browsers using fetch() must send HTTP headers (e.g., "POST / HTTP/1.1"),
            // while legitimate clients send raw JSON starting with "{".
            if (!httpChecked) {
                httpChecked = true;
                const trimmed = buffer.trimStart();
                if (/^(GET|POST|PUT|DELETE|HEAD|OPTIONS|PATCH|CONNECT|TRACE)\s/i.test(trimmed)) {
                    socket.destroy();
                    return;
                }
            }
            // Process complete lines
            while (buffer.includes('\n')) {
                if (!identityReady || shuttingDown) {
                    socket.destroy();
                    return;
                }
                const newlineIdx = buffer.indexOf('\n');
                const line = buffer.substring(0, newlineIdx);
                buffer = buffer.substring(newlineIdx + 1);
                if (!line.trim())
                    continue;
                let responseControls = {};
                try {
                    const parseResult = parseCommand(line);
                    if (!parseResult.success) {
                        responseControls = parseResult.outputControls;
                        const resp = errorResponse(parseResult.id ?? 'unknown', parseResult.error);
                        resp.error = renderActionError(resp.error);
                        socket.write(serializeDaemonResponse(resp, responseControls, manager) + '\n');
                        continue;
                    }
                    responseControls = parseResult.command;
                    // Auto-launch if not already launched and this isn't a launch/close command
                    if (!manager.isLaunched() &&
                        parseResult.command.action !== 'launch' &&
                        parseResult.command.action !== 'close') {
                        if (manager instanceof BrowserManager) {
                            // Auto-launch desktop browser
                            const extensions = process.env.AGENT_BROWSER_EXTENSIONS
                                ? process.env.AGENT_BROWSER_EXTENSIONS.split(',')
                                    .map((p) => p.trim())
                                    .filter(Boolean)
                                : undefined;
                            // Parse args from env (comma or newline separated)
                            const argsEnv = process.env.AGENT_BROWSER_ARGS;
                            const args = argsEnv
                                ? argsEnv
                                    .split(/[,\n]/)
                                    .map((a) => a.trim())
                                    .filter((a) => a.length > 0)
                                : undefined;
                            // Parse proxy from env
                            const proxyServer = process.env.AGENT_BROWSER_PROXY;
                            const proxyBypass = process.env.AGENT_BROWSER_PROXY_BYPASS;
                            const proxy = proxyServer
                                ? {
                                    server: proxyServer,
                                    ...(proxyBypass && { bypass: proxyBypass }),
                                }
                                : undefined;
                            const ignoreHTTPSErrors = process.env.AGENT_BROWSER_IGNORE_HTTPS_ERRORS === '1';
                            const allowFileAccess = process.env.AGENT_BROWSER_ALLOW_FILE_ACCESS === '1';
                            await manager.launch({
                                id: 'auto',
                                action: 'launch',
                                headless: process.env.AGENT_BROWSER_HEADED !== '1',
                                executablePath: process.env.AGENT_BROWSER_EXECUTABLE_PATH || (() => {
                                    if (!isWSL) return undefined;
                                    const winChrome = [
                                        '/mnt/c/Program Files/Google/Chrome/Application/chrome.exe',
                                        '/mnt/c/Program Files (x86)/Google/Chrome/Application/chrome.exe',
                                    ];
                                    for (const p of winChrome) { if (fs.existsSync(p)) return p; }
                                    return undefined;
                                })(),
                                extensions: extensions,
                                profile: process.env.AGENT_BROWSER_PROFILE,
                                storageState: process.env.AGENT_BROWSER_STATE,
                                args,
                                userAgent: process.env.AGENT_BROWSER_USER_AGENT,
                                proxy,
                                ignoreHTTPSErrors: ignoreHTTPSErrors,
                                allowFileAccess: allowFileAccess,
                                autoStateFilePath: getSessionAutoStatePath(),
                            });
                        }
                    }
                    // Recover from stale state: browser is launched but all pages were closed
                    if (manager instanceof BrowserManager &&
                        manager.isLaunched() &&
                        (!manager.hasPages() || manager.needsPageRecovery()) &&
                        parseResult.command.action !== 'launch' &&
                        parseResult.command.action !== 'close') {
                        await manager.ensurePage();
                    }
                    // Handle explicit launch with auto-load state
                    if (parseResult.command.action === 'launch' &&
                        manager instanceof BrowserManager &&
                        !parseResult.command.autoStateFilePath) {
                        const autoStatePath = getSessionAutoStatePath();
                        if (autoStatePath) {
                            parseResult.command.autoStateFilePath = autoStatePath;
                        }
                    }
                    // Handle close command specially - shuts down daemon
                    if (parseResult.command.action === 'close') {
                        // Auto-save state before closing
                        if (manager instanceof BrowserManager && manager.isLaunched()) {
                            const savePath = getSessionSaveStatePath();
                            if (savePath) {
                                try {
                                    const { encrypted } = await saveStateToFile(manager, savePath);
                                    fs.chmodSync(savePath, 0o600);
                                    if (process.env.AGENT_BROWSER_DEBUG === '1') {
                                        console.error(`Auto-saved session state${encrypted ? ' (encrypted)' : ''}`);
                                    }
                                }
                                catch (err) {
                                    if (process.env.AGENT_BROWSER_DEBUG === '1') {
                                        console.error(renderFatalDiagnostic('Daemon failure', err));
                                    }
                                }
                            }
                        }
                        let response = await executeCommand(parseResult.command, manager);
                        response = prepareDaemonCloseResponse(response, manager);
                        socket.write(serializeDaemonResponse(response, responseControls, manager) + '\n');
                        if (closeResponseAllowsDaemonShutdown(response) && !shuttingDown) {
                            shuttingDown = true;
                            identityReady = false;
                            try { server.close(); } catch { }
                            setTimeout(() => {
                                cleanupSocket();
                                process.exit(0);
                            }, 100);
                        }
                        return;
                    }
                    const response = await executeCommand(parseResult.command, manager);
                    // Add any launch warnings to the response
                    if (manager instanceof BrowserManager) {
                        const warnings = manager.getAndClearWarnings();
                        if (warnings.length > 0 && response.success && response.data) {
                            response.data.warnings = warnings;
                        }
                    }
                    socket.write(serializeDaemonResponse(response, responseControls, manager) + '\n');
                }
                catch (err) {
                    const message = renderActionError(err);
                    socket.write(serializeDaemonResponse(errorResponse('error', message), responseControls, manager) + '\n');
                }
            }
        });
        socket.on('error', () => {
            // Client disconnected, ignore
        });
        socket.on('end', () => {
            if (inputRejected)
                return;
            try {
                buffer += decoder.decode();
            }
            catch {
                rejectInvalidUtf8();
            }
        });
    });
    const stopAcceptingSynchronously = () => {
        identityReady = false;
        shuttingDown = true;
        try { server.close(); } catch { }
        for (const socket of activeSockets)
            socket.destroy();
    };
    const shutdown = async (exitCode = 0, label, error) => {
        if (shutdownPromise)
            return shutdownPromise;
        // This gate is deliberately synchronous: no manager, stream, or artifact
        // cleanup may await while an unattested listener can still run a command.
        stopAcceptingSynchronously();
        shutdownPromise = (async () => {
            if (label && error)
                console.error(renderFatalDiagnostic(label, error));
            // Stop stream server if running
            if (streamServer) {
                let stoppingStream;
                try {
                    stoppingStream = Promise.resolve(streamServer.stop()).catch(() => {});
                } catch {
                    stoppingStream = Promise.resolve();
                }
                await Promise.race([
                    stoppingStream,
                    new Promise((resolve) => setTimeout(resolve, 500)),
                ]);
                streamServer = null;
            }
            const cleanupResult = await closeManagerBounded(manager, 1000).catch((cleanupError) => ({
                closed: false,
                timedOut: false,
                error: cleanupError,
                unresolvedCleanup: manager.getUnresolvedCleanup?.(),
            }));
            if (!cleanupResult.closed) {
                const unresolved = cleanupResult.unresolvedCleanup;
                const targetCount = Array.isArray(unresolved?.targetIds) ? unresolved.targetIds.length : 0;
                const pendingCount = Array.isArray(unresolved?.pendingTargetIds) ? unresolved.pendingTargetIds.length : 0;
                console.error(`[agent-browser cleanup unresolved] timedOut=${cleanupResult.timedOut === true} targets=${targetCount} pending=${pendingCount}`);
            }
            const artifactCleanup = cleanupSocket();
            if (!artifactCleanup.cleaned)
                console.error(`[agent-browser artifact cleanup unresolved] count=${artifactCleanup.unresolved.length}`);
            process.exit(exitCode);
        })();
        return shutdownPromise;
    };
    server.on('error', (err) => void shutdown(1, 'Server error', err));
    // Handle shutdown signals
    process.on('SIGINT', () => void shutdown(0));
    process.on('SIGTERM', () => void shutdown(0));
    process.on('SIGHUP', () => void shutdown(0));
    // Handle unexpected errors - always cleanup
    process.on('uncaughtException', (err) => {
        void shutdown(1, 'Uncaught exception', err);
    });
    process.on('unhandledRejection', (reason) => {
        void shutdown(1, 'Unhandled rejection', reason);
    });
    // Cleanup on normal exit
    process.on('exit', () => {
        try { cleanupSocket(); } catch { }
    });
    const pidFile = getPidFile();
    writeOwnedArtifact(pidFile, process.pid.toString());
    const publishIdentity = () => {
        try {
            if (!isWindows)
                rememberOwnedArtifact(getSocketPath(), 'socket');
            writeDaemonIdentityReceipt(server);
            if (process.env[DAEMON_IDENTITY_REQUIRED_ENV] === '1' && !ownedDaemonIdentityReceipt)
                throw daemonIdentityFailure('DAEMON_IDENTITY_RECEIPT_NOT_PUBLISHED');
            identityReady = true;
        }
        catch (error) {
            stopAcceptingSynchronously();
            void shutdown(1, 'Daemon identity error', error);
        }
    };
    if (isWindows) {
        // Windows: use TCP socket on localhost
        const port = getPortForSession(currentSession);
        writeOwnedArtifact(getPortFile(), port.toString());
        server.listen(port, '127.0.0.1', publishIdentity);
    }
    else {
        // Unix: use Unix domain socket
        server.listen(getSocketPath(), publishIdentity);
    }
    // Keep process alive
    process.stdin.resume();
}
// Run daemon if this is the entry point
if (process.argv[1]?.endsWith('daemon.js') || process.env.AGENT_BROWSER_DAEMON === '1') {
    startDaemon().catch((err) => {
        console.error(renderFatalDiagnostic('Daemon error', err));
        try { cleanupSocket(); } catch { }
        process.exit(1);
    });
}
