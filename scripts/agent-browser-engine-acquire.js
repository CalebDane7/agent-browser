#!/usr/bin/env node

import { createHash, randomBytes } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import {
  chmod,
  link,
  lstat,
  mkdir,
  open,
  readFile,
  unlink,
} from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual, TextDecoder } from "node:util";
import { gunzipSync } from "node:zlib";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const DEFAULT_MANIFEST_PATH = join(
  SCRIPT_DIR,
  "pinned-agent-browser-engine.json",
);
const MAX_ARCHIVE_BYTES = 64 * 1024 * 1024;
const UTF8 = new TextDecoder("utf-8", { fatal: true });

// WHY: npm contains the upstream executable, while the wrapper selects a
// source-patched executable. Giving the archive the local output's digest
// rejects a valid archive and cannot reproduce the selected runtime.
export const OFFICIAL_ARCHIVE_ENGINE = Object.freeze({
  platform: "linux-x64",
  archivePath: "package/bin/agent-browser-linux-x64",
  size: 14156776,
  sha256: "56d15181e51e00213f907fcf39707cfc76bfa804ff20f5a9373661c73f96de5e",
});

// WHY: the manifest is an input beside this script, not independent pin
// authority. Keep the authorized values here too so editing JSON cannot float
// the donor, platform, archive, or license set.
export const EXPECTED_PIN = Object.freeze({
  schema: "agent-browser-engine-pin.v1",
  name: "agent-browser",
  version: "0.36.0",
  tag: "v0.36.0",
  commit: "eb05921bad874cd2a1b4fa5d1149f1ed26576cae",
  repository: "https://github.com/vercel-labs/agent-browser",
  release: "https://github.com/vercel-labs/agent-browser/releases/tag/v0.36.0",
  license: "Apache-2.0",
  npm: {
    tarballUrl:
      "https://registry.npmjs.org/agent-browser/-/agent-browser-0.36.0.tgz",
    shasumSha1: "e672393279a620fb6c79f6c00797908631450a04",
    integritySha512:
      "sha512-Ljjj4nRKUEqtrFF0pgev8lxTfC79tNgPj67sNi6BLnUAWIG8y9Cu2VQIeZ0MY3N2fTQagoBlfQ/pUY/4NWPD3w==",
    fileCount: 50,
    unpackedSize: 92964198,
  },
  engine: {
    platform: "linux-x64",
    archivePath: "package/bin/agent-browser-linux-x64",
    outputName: "agent-browser-v0.36.0-linux-x64",
    size: 12076512,
    sha256:
      "6612815bd78804803f9d1a0272528d1c6fa555f9a6d994511126ed9eed8c7f23",
    releaseUrl:
      "https://github.com/vercel-labs/agent-browser/releases/download/v0.36.0/agent-browser-linux-x64",
    localBuild: {
      baseCommit: "eb05921bad874cd2a1b4fa5d1149f1ed26576cae",
      patchSha256: "3ae199addcad94218f17c6a1d68c19660377d3938a1ba2f9d900a84fbe36d33f",
      sourceFileSha256: "6c089d03bfec21c867b9aa81dbd0bf58533b6604382dfa255c554a0e7de4f843",
      guard: "test_liveness_method_matches_connection_scope",
      cargoLockSha256: "0fe5b217b90d08750adb87a1618ff7efc5405c861b8d49da9aa2b869c68fcf02",
      // Legacy fields retain the first patch, final browser.rs, and its guard.
      // The ordered list is the complete source-patch input, not just liveness.
      patches: [
        {
          path: "patches/agent-browser-v0.36.0-direct-page-liveness.patch",
          sha256: "3ae199addcad94218f17c6a1d68c19660377d3938a1ba2f9d900a84fbe36d33f"
        },
        {
          path: "patches/agent-browser-v0.36.0-full-page-css-metrics.patch",
          sha256: "15fd4e3ff0caac3373902641d14ebd8240dda0d71f2242df435532a009e09fe9"
        },
        {
          path: "patches/agent-browser-v0.36.0-direct-page-diagnostic-events.patch",
          sha256: "5d7d61fd22f7ce5a58c65802ec81bbb26b77d142498ac19439844e0dc0c17b29"
        },
        {
          path: "patches/agent-browser-v0.36.0-bounded-json-output.patch",
          sha256: "ecaf08e22c646995a8ba407acf1ff6b7cf34c748a4478627a2c125c0317b59dc"
        },
        {
          path: "patches/agent-browser-v0.36.0-object-id-upload.patch",
          sha256: "0f07af0901941d3f90f39e24d533373895e0d22ad384b9441ca96acbbf10ea1e"
        },
        {
          path: "patches/agent-browser-v0.36.0-private-upload-paths.patch",
          sha256: "31b97f5c30f651ab99e0057c41e74b29efbede9d37f2d3259758d47ccdf78498"
        },
        {
          path: "patches/agent-browser-v0.36.0-private-shared-command.patch",
          sha256: "d1d183b68c101150806cf10d3f34bfbd13e43f50b70dcb37a7c50374022de4c5"
        },
        {
          path: "patches/agent-browser-v0.36.0-errors-clear.patch",
          sha256: "df8803e3650a9c442e93a591e36ef9233ff24c1030220cd40c5df50d11613326"
        }
      ],
    },
  },
  referenceEngines: [
    {
      platform: "win32-x64",
      archivePath: "package/bin/agent-browser-win32-x64.exe",
      size: 13837312,
      sha256:
        "412ff72737a109e93f5304b0ff76c988fb6f1f451d0fc7e010577922bcc20ff3",
      releaseUrl:
        "https://github.com/vercel-labs/agent-browser/releases/download/v0.36.0/agent-browser-win32-x64.exe",
    },
  ],
  licenses: [
    {
      archivePath: "package/LICENSE",
      outputName: "LICENSE.agent-browser",
    },
    {
      archivePath: "package/cli/src/native/a11y/LICENSE-axe-core.txt",
      outputName: "LICENSE-axe-core.txt",
    },
    {
      archivePath:
        "package/cli/src/native/a11y/LICENSE-axe-core-THIRD-PARTY.txt",
      outputName: "LICENSE-axe-core-THIRD-PARTY.txt",
    },
  ],
  integration: {
    providerName: "private-cws",
    pluginProtocol: "agent-browser.plugin.v1",
    pluginCapability: "browser.provider",
    transport: "direct-page",
    pageCapabilityPath: "/page/<64-lowercase-hex>",
    opaqueIdEncoding: "64-lowercase-hex",
    forbiddenMethodPrefixes: ["Target.", "WebMCP."],
  },
});

class AcquisitionFailure extends Error {
  constructor(code) {
    super(code);
    this.name = "AcquisitionFailure";
    this.code = code;
  }
}

function reject(code) {
  throw new AcquisitionFailure(code);
}

function digest(bytes, algorithm, encoding = "hex") {
  return createHash(algorithm).update(bytes).digest(encoding);
}

function decodeUtf8(bytes, code) {
  try {
    return UTF8.decode(bytes);
  } catch {
    reject(code);
  }
}

function parseJson(bytes, code) {
  try {
    return JSON.parse(decodeUtf8(bytes, code));
  } catch (error) {
    if (error instanceof AcquisitionFailure) throw error;
    reject(code);
  }
}

export function validatePinnedManifest(value) {
  if (!isDeepStrictEqual(value, EXPECTED_PIN)) reject("pin_manifest_mismatch");
  return value;
}

export function verifyLocalBuildPatch(bytes, index = 0) {
  const expected = Number.isInteger(index) && index >= 0
    ? EXPECTED_PIN.engine.localBuild.patches[index]
    : null;
  if (
    !expected ||
    !Buffer.isBuffer(bytes) ||
    digest(bytes, "sha256") !== expected.sha256
  ) {
    reject("local_patch_integrity_mismatch");
  }
  return bytes;
}

export function verifyLocalBuildPatches(patches) {
  if (!Array.isArray(patches) ||
      patches.length !== EXPECTED_PIN.engine.localBuild.patches.length) {
    reject("local_patch_integrity_mismatch");
  }
  for (let index = 0; index < patches.length; index += 1) {
    verifyLocalBuildPatch(patches[index], index);
  }
  return patches;
}

export function verifyLocalEngine(bytes) {
  if (
    !Buffer.isBuffer(bytes) ||
    bytes.length !== EXPECTED_PIN.engine.size ||
    digest(bytes, "sha256") !== EXPECTED_PIN.engine.sha256
  ) {
    reject("local_engine_integrity_mismatch");
  }
  return bytes;
}

async function readLocalEngine(pathname) {
  if (typeof pathname !== "string" || !isAbsolute(pathname)) {
    reject("local_engine_required");
  }
  let handle;
  try {
    handle = await open(pathname, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    const info = await handle.stat();
    if (!info.isFile() || info.size !== EXPECTED_PIN.engine.size) {
      reject("local_engine_integrity_mismatch");
    }
    return verifyLocalEngine(await handle.readFile());
  } catch (error) {
    if (error instanceof AcquisitionFailure) throw error;
    reject("local_engine_unavailable");
  } finally {
    await handle?.close();
  }
}

function parseOctal(field, code) {
  const nul = field.indexOf(0);
  const raw = field
    .subarray(0, nul === -1 ? field.length : nul)
    .toString("ascii")
    .trim();
  if (raw === "") return 0;
  if (!/^[0-7]+$/.test(raw)) reject(code);
  const value = Number.parseInt(raw, 8);
  if (!Number.isSafeInteger(value) || value < 0) reject(code);
  return value;
}

function headerString(field) {
  const nul = field.indexOf(0);
  return decodeUtf8(
    field.subarray(0, nul === -1 ? field.length : nul),
    "tar_header_invalid",
  );
}

function validateTarPath(pathname) {
  if (
    pathname.length === 0 ||
    pathname.startsWith("/") ||
    pathname.includes("\\") ||
    Buffer.byteLength(pathname, "utf8") > 1_024 ||
    pathname.split("/").some((part) => part === "" || part === "." || part === "..")
  ) {
    reject("tar_path_invalid");
  }
  return pathname;
}

function parsePax(bytes) {
  const fields = {};
  let offset = 0;
  while (offset < bytes.length) {
    const space = bytes.indexOf(0x20, offset);
    if (space === -1) reject("tar_pax_invalid");
    const lengthText = bytes.subarray(offset, space).toString("ascii");
    if (!/^[1-9][0-9]*$/.test(lengthText)) reject("tar_pax_invalid");
    const length = Number(lengthText);
    const end = offset + length;
    if (!Number.isSafeInteger(length) || end > bytes.length || bytes[end - 1] !== 0x0a) {
      reject("tar_pax_invalid");
    }
    const record = bytes.subarray(space + 1, end - 1);
    const equals = record.indexOf(0x3d);
    if (equals <= 0) reject("tar_pax_invalid");
    const key = decodeUtf8(record.subarray(0, equals), "tar_pax_invalid");
    const value = decodeUtf8(record.subarray(equals + 1), "tar_pax_invalid");
    fields[key] = value;
    offset = end;
  }
  return fields;
}

function headerChecksum(header) {
  let sum = 0;
  for (let index = 0; index < header.length; index += 1) {
    sum += index >= 148 && index < 156 ? 0x20 : header[index];
  }
  return sum;
}

export function parseTar(tarBytes, wantedPaths = new Set()) {
  if (!Buffer.isBuffer(tarBytes) || tarBytes.length % 512 !== 0) {
    reject("tar_invalid");
  }
  const wanted = new Set(wantedPaths);
  const selected = new Map();
  const seenPaths = new Set();
  let regularFileCount = 0;
  let unpackedSize = 0;
  let offset = 0;
  let localPax = {};
  let globalPax = {};
  let longName = null;

  while (offset + 512 <= tarBytes.length) {
    const header = tarBytes.subarray(offset, offset + 512);
    offset += 512;
    if (header.every((byte) => byte === 0)) {
      if (!tarBytes.subarray(offset).every((byte) => byte === 0)) {
        reject("tar_trailing_data");
      }
      return { selected, regularFileCount, unpackedSize };
    }

    const storedChecksum = parseOctal(
      header.subarray(148, 156),
      "tar_header_invalid",
    );
    if (storedChecksum !== headerChecksum(header)) reject("tar_header_invalid");
    const size = parseOctal(header.subarray(124, 136), "tar_header_invalid");
    const paddedSize = Math.ceil(size / 512) * 512;
    if (
      !Number.isSafeInteger(paddedSize) ||
      offset + paddedSize > tarBytes.length
    ) {
      reject("tar_truncated");
    }
    const payload = tarBytes.subarray(offset, offset + size);
    offset += paddedSize;

    const type = header[156];
    if (type === 0x78) {
      localPax = parsePax(payload);
      continue;
    }
    if (type === 0x67) {
      globalPax = { ...globalPax, ...parsePax(payload) };
      continue;
    }
    if (type === 0x4c) {
      longName = decodeUtf8(payload, "tar_header_invalid").replace(/[\0\n]+$/u, "");
      continue;
    }

    const name = headerString(header.subarray(0, 100));
    const prefix = headerString(header.subarray(345, 500));
    const headerPath = prefix ? `${prefix}/${name}` : name;
    const pathname = validateTarPath(
      localPax.path ?? globalPax.path ?? longName ?? headerPath,
    );
    localPax = {};
    longName = null;

    if (type !== 0 && type !== 0x30) continue;
    if (seenPaths.has(pathname)) reject("tar_duplicate_path");
    seenPaths.add(pathname);
    regularFileCount += 1;
    unpackedSize += size;
    if (!Number.isSafeInteger(unpackedSize)) reject("tar_invalid");
    if (wanted.has(pathname)) selected.set(pathname, Buffer.from(payload));
  }

  reject("tar_truncated");
}

export function verifyArchive(archiveBytes, manifest = EXPECTED_PIN) {
  // A localBuild pin identifies the separately supplied executable. The npm
  // archive still contains the official engine; never treat it as a source for
  // the patched artifact or compare it against the local artifact's hash.
  const archiveEngine = manifest.engine.localBuild
    ? OFFICIAL_ARCHIVE_ENGINE
    : manifest.engine;
  if (!Buffer.isBuffer(archiveBytes) || archiveBytes.length > MAX_ARCHIVE_BYTES) {
    reject("archive_too_large");
  }
  const sha1 = digest(archiveBytes, "sha1");
  const sha512Base64 = digest(archiveBytes, "sha512", "base64");
  const integrity = `sha512-${sha512Base64}`;
  if (
    sha1 !== manifest.npm.shasumSha1 ||
    integrity !== manifest.npm.integritySha512
  ) {
    reject("archive_integrity_mismatch");
  }

  let tarBytes;
  try {
    tarBytes = gunzipSync(archiveBytes, {
      maxOutputLength: manifest.npm.unpackedSize + 8 * 1024 * 1024,
    });
  } catch {
    reject("archive_gzip_invalid");
  }

  const packageJsonPath = "package/package.json";
  const wanted = new Set([
    packageJsonPath,
    archiveEngine.archivePath,
    ...(manifest.referenceEngines ?? []).map((entry) => entry.archivePath),
    ...manifest.licenses.map((entry) => entry.archivePath),
  ]);
  const parsed = parseTar(tarBytes, wanted);
  if (
    parsed.regularFileCount !== manifest.npm.fileCount ||
    parsed.unpackedSize !== manifest.npm.unpackedSize
  ) {
    reject("archive_inventory_mismatch");
  }
  for (const pathname of wanted) {
    if (!parsed.selected.has(pathname)) reject("archive_file_missing");
  }

  const packageJson = parseJson(
    parsed.selected.get(packageJsonPath),
    "package_identity_mismatch",
  );
  const repository =
    typeof packageJson.repository === "string"
      ? packageJson.repository
      : packageJson.repository?.url;
  if (
    packageJson.name !== manifest.name ||
    packageJson.version !== manifest.version ||
    packageJson.license !== manifest.license ||
    repository !== `git+${manifest.repository}.git`
  ) {
    reject("package_identity_mismatch");
  }

  const engine = parsed.selected.get(archiveEngine.archivePath);
  if (
    engine.length !== archiveEngine.size ||
    digest(engine, "sha256") !== archiveEngine.sha256
  ) {
    reject("engine_integrity_mismatch");
  }
  const referenceEngines = (manifest.referenceEngines ?? []).map((entry) => {
    const bytes = parsed.selected.get(entry.archivePath);
    if (
      bytes.length !== entry.size ||
      digest(bytes, "sha256") !== entry.sha256
    ) {
      reject("reference_engine_integrity_mismatch");
    }
    return {
      platform: entry.platform,
      size: bytes.length,
      sha256: digest(bytes, "sha256"),
    };
  });
  const licenses = manifest.licenses.map((entry) => {
    const bytes = parsed.selected.get(entry.archivePath);
    if (bytes.length === 0) reject("license_empty");
    return {
      ...entry,
      bytes,
      size: bytes.length,
      sha256: digest(bytes, "sha256"),
    };
  });

  return {
    archive: {
      bytes: archiveBytes,
      size: archiveBytes.length,
      sha1,
      integrity,
    },
    engine,
    referenceEngines,
    licenses,
    inventory: {
      fileCount: parsed.regularFileCount,
      unpackedSize: parsed.unpackedSize,
    },
  };
}

async function downloadPinnedArchive(url) {
  let response;
  try {
    response = await fetch(url, {
      redirect: "error",
      signal: AbortSignal.timeout(120_000),
      headers: { accept: "application/octet-stream" },
    });
  } catch {
    reject("download_failed");
  }
  if (!response.ok || response.url !== url || response.body === null) {
    reject("download_failed");
  }
  const declaredLength = Number(response.headers.get("content-length"));
  if (
    Number.isFinite(declaredLength) &&
    (declaredLength < 1 || declaredLength > MAX_ARCHIVE_BYTES)
  ) {
    reject("archive_too_large");
  }

  const chunks = [];
  let total = 0;
  try {
    for await (const chunk of response.body) {
      const bytes = Buffer.from(chunk);
      total += bytes.length;
      if (total > MAX_ARCHIVE_BYTES) reject("archive_too_large");
      chunks.push(bytes);
    }
  } catch (error) {
    if (error instanceof AcquisitionFailure) throw error;
    reject("download_failed");
  }
  if (total === 0) reject("download_failed");
  return Buffer.concat(chunks, total);
}

async function prepareOutputDirectory(outputDir) {
  if (!isAbsolute(outputDir) || outputDir.includes("\0")) {
    reject("output_directory_invalid");
  }
  await mkdir(outputDir, { recursive: true, mode: 0o700 });
  const info = await lstat(outputDir);
  const uid = typeof process.getuid === "function" ? process.getuid() : null;
  if (!info.isDirectory() || info.isSymbolicLink() || (uid !== null && info.uid !== uid)) {
    reject("output_directory_insecure");
  }
  await chmod(outputDir, 0o700);
}

async function writeNewOrExact(pathname, bytes, mode) {
  try {
    const existingInfo = await lstat(pathname);
    if (!existingInfo.isFile() || existingInfo.isSymbolicLink()) {
      reject("artifact_conflict");
    }
    const existing = await readFile(pathname);
    if (!existing.equals(bytes)) reject("artifact_conflict");
    return "reused";
  } catch (error) {
    if (error instanceof AcquisitionFailure) throw error;
    if (error?.code !== "ENOENT") reject("artifact_write_failed");
  }

  const temporary = join(
    dirname(pathname),
    `.${pathname.split("/").pop()}.${process.pid}.${randomBytes(8).toString("hex")}`,
  );
  let handle;
  try {
    handle = await open(
      temporary,
      fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL,
      mode,
    );
    await handle.writeFile(bytes);
    await handle.sync();
    await handle.close();
    handle = null;
    await link(temporary, pathname);
    await unlink(temporary);
    return "created";
  } catch (error) {
    await handle?.close().catch(() => {});
    await unlink(temporary).catch(() => {});
    if (error?.code === "EEXIST") {
      const existing = await readFile(pathname).catch(() => null);
      if (existing?.equals(bytes)) return "reused";
      reject("artifact_conflict");
    }
    if (error instanceof AcquisitionFailure) throw error;
    reject("artifact_write_failed");
  }
}

export function stableReceipt(manifest, verified) {
  return {
    schema: "agent-browser-engine-acquisition.v2",
    package: {
      name: manifest.name,
      version: manifest.version,
      tag: manifest.tag,
      commit: manifest.commit,
      repository: manifest.repository,
      license: manifest.license,
    },
    archive: {
      outputName: `agent-browser-${manifest.version}.tgz`,
      size: verified.archive.size,
      shasumSha1: verified.archive.sha1,
      integritySha512: verified.archive.integrity,
      fileCount: verified.inventory.fileCount,
      unpackedSize: verified.inventory.unpackedSize,
    },
    engine: {
      outputName: manifest.engine.outputName,
      platform: manifest.engine.platform,
      size: verified.engine.length,
      sha256: digest(verified.engine, "sha256"),
      origin: "local-build",
    },
    localBuild: {
      ...manifest.engine.localBuild,
      artifactVerification: "sha256-and-size",
      cleanRebuildVerified: false,
    },
    archiveEngine: {
      ...OFFICIAL_ARCHIVE_ENGINE,
      selected: false,
    },
    referenceEngines: verified.referenceEngines.map((entry) => ({
      ...entry,
      selected: false,
    })),
    licenses: verified.licenses.map(({ outputName, size, sha256 }) => ({
      outputName,
      size,
      sha256,
    })),
  };
}

function canonicalValue(value) {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value === null || typeof value !== "object") return value;
  const result = {};
  for (const key of Object.keys(value).sort()) result[key] = canonicalValue(value[key]);
  return result;
}

export async function acquirePinnedEngine(
  outputDir,
  manifestPath = DEFAULT_MANIFEST_PATH,
  localEnginePath,
) {
  if (resolve(manifestPath) !== resolve(DEFAULT_MANIFEST_PATH)) {
    reject("pin_manifest_path_forbidden");
  }
  const manifest = validatePinnedManifest(
    parseJson(await readFile(DEFAULT_MANIFEST_PATH), "pin_manifest_invalid"),
  );
  // Reject missing/wrong local artifacts before downloading or creating output.
  // The supplied executable's hash establishes artifact identity, not a fresh
  // source rebuild. The separately shipped recipe preserves those inputs.
  // WHY: one valid liveness patch cannot vouch for the later screenshot,
  // diagnostics, output, upload, shared-command and errors-clear repairs.
  // Paths, order, count and hashes come from independent constants, not input.
  verifyLocalBuildPatches(await Promise.all(
    EXPECTED_PIN.engine.localBuild.patches.map(({ path }) => readFile(join(SCRIPT_DIR, path))),
  ));
  const engine = await readLocalEngine(localEnginePath);
  const official = verifyArchive(
    await downloadPinnedArchive(manifest.npm.tarballUrl),
    manifest,
  );
  const verified = { ...official, engine };
  await prepareOutputDirectory(outputDir);
  const receipt = stableReceipt(manifest, verified);
  const receiptBytes = Buffer.from(
    `${JSON.stringify(canonicalValue(receipt), null, 2)}\n`,
    "utf8",
  );

  const artifacts = [
    {
      name: receipt.archive.outputName,
      bytes: verified.archive.bytes,
      mode: 0o400,
    },
    { name: manifest.engine.outputName, bytes: verified.engine, mode: 0o500 },
    ...verified.licenses.map((entry) => ({
      name: entry.outputName,
      bytes: entry.bytes,
      mode: 0o400,
    })),
    {
      name: "agent-browser-engine-acquisition.json",
      bytes: receiptBytes,
      mode: 0o400,
    },
  ];
  const writes = [];
  for (const artifact of artifacts) {
    writes.push({
      name: artifact.name,
      status: await writeNewOrExact(
        join(outputDir, artifact.name),
        artifact.bytes,
        artifact.mode,
      ),
    });
  }
  return { receipt, writes };
}

function parseArguments(argv) {
  if (
    argv.length !== 4 ||
    argv[0] !== "--output-dir" ||
    argv[2] !== "--local-engine"
  ) {
    reject("usage: --output-dir ABSOLUTE_PATH --local-engine ABSOLUTE_PATH");
  }
  return { outputDir: argv[1], localEnginePath: argv[3] };
}

async function main() {
  try {
    const { outputDir, localEnginePath } = parseArguments(process.argv.slice(2));
    const result = await acquirePinnedEngine(outputDir, undefined, localEnginePath);
    process.stdout.write(`${JSON.stringify(result.receipt)}\n`);
  } catch (error) {
    const code = error instanceof AcquisitionFailure ? error.code : "acquisition_failed";
    process.stderr.write(`${code}\n`);
    process.exitCode = 1;
  }
}

const entryPath = process.argv[1] ? resolve(process.argv[1]) : "";
if (entryPath && fileURLToPath(import.meta.url) === entryPath) {
  await main();
}
