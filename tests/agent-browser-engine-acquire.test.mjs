import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { access, link, lstat, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import test from "node:test";
import {
  acquirePinnedEngine,
  EXPECTED_PIN,
  OFFICIAL_ARCHIVE_ENGINE,
  validatePinnedManifest,
  verifyArchive,
  verifyLocalBuildPatch,
  verifyLocalBuildPatches,
  verifyLocalEngine,
} from "../scripts/agent-browser-engine-acquire.js";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const CLI = join(ROOT, "scripts/agent-browser-engine-acquire.js");
const sha = (bytes, algorithm = "sha256", encoding = "hex") =>
  createHash(algorithm).update(bytes).digest(encoding);

async function temporary(t) {
  const directory = await mkdtemp(join(ROOT, ".engine-acquire-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

function stubFetch(t, callback) {
  const previous = globalThis.fetch;
  globalThis.fetch = callback;
  t.after(() => { globalThis.fetch = previous; });
}

// Controlled archive fixtures independently choose bytes and expected digests.
// Production acquisition always validates the immutable pin before fetching.
function fixture(license = "fixture license\n") {
  const manifest = structuredClone(EXPECTED_PIN);
  const engine = Buffer.from("official fixture engine\n");
  const reference = Buffer.from("reference fixture engine\n");
  manifest.engine = {
    ...OFFICIAL_ARCHIVE_ENGINE, size: engine.length, sha256: sha(engine),
  };
  manifest.referenceEngines[0].size = reference.length;
  manifest.referenceEngines[0].sha256 = sha(reference);
  const files = [
    ["package/package.json", Buffer.from(JSON.stringify({
      name: manifest.name, version: manifest.version, license: manifest.license,
      repository: { url: `git+${manifest.repository}.git` },
    }))],
    [manifest.engine.archivePath, engine],
    [manifest.referenceEngines[0].archivePath, reference],
    ...manifest.licenses.map(({ archivePath }) => [archivePath, Buffer.from(license)]),
  ];
  const parts = [];
  for (const [pathname, bytes] of files) {
    const header = Buffer.alloc(512);
    header.write(pathname);
    header.write(`${bytes.length.toString(8).padStart(11, "0")}\0`, 124);
    header.fill(0x20, 148, 156);
    header[156] = 0x30;
    const checksum = header.reduce((total, byte) => total + byte, 0);
    header.write(`${checksum.toString(8).padStart(6, "0")}\0 `, 148);
    parts.push(header, bytes, Buffer.alloc((512 - bytes.length % 512) % 512));
  }
  parts.push(Buffer.alloc(1024));
  const archive = gzipSync(Buffer.concat(parts));
  manifest.npm = {
    ...manifest.npm,
    shasumSha1: sha(archive, "sha1"),
    integritySha512: `sha512-${sha(archive, "sha512", "base64")}`,
    fileCount: files.length,
    unpackedSize: files.reduce((total, [, bytes]) => total + bytes.length, 0),
  };
  return { archive, manifest, engine };
}

test("pin and all eight ordered patches cannot float to an upstream or different local artifact", async () => {
  const manifest = JSON.parse(await readFile(join(ROOT, "scripts/pinned-agent-browser-engine.json")));
  validatePinnedManifest(manifest);
  const floated = structuredClone(manifest);
  Object.assign(floated.engine, OFFICIAL_ARCHIVE_ENGINE);
  assert.throws(() => validatePinnedManifest(floated), { code: "pin_manifest_mismatch" });
  const patches = await Promise.all(EXPECTED_PIN.engine.localBuild.patches.map(({ path }) =>
    readFile(join(ROOT, "scripts", path))));
  assert.equal(patches.length, 8);
  verifyLocalBuildPatch(patches[0]); // Existing single-patch API remains first-patch scoped.
  verifyLocalBuildPatches(patches);
  for (let index = 0; index < patches.length; index += 1) {
    const changed = [...patches];
    changed[index] = Buffer.concat([changed[index], Buffer.from("\n")]);
    assert.throws(() => verifyLocalBuildPatches(changed), { code: "local_patch_integrity_mismatch" });
    const floatedPatch = structuredClone(manifest);
    floatedPatch.engine.localBuild.patches[index].sha256 = sha(changed[index]);
    assert.throws(() => validatePinnedManifest(floatedPatch), { code: "pin_manifest_mismatch" });
  }
  for (const changed of [patches.slice(0, -1), [...patches, patches[0]], [...patches].reverse()]) {
    assert.throws(() => verifyLocalBuildPatches(changed), { code: "local_patch_integrity_mismatch" });
  }
  const reordered = structuredClone(manifest);
  reordered.engine.localBuild.patches.reverse();
  assert.throws(() => validatePinnedManifest(reordered), { code: "pin_manifest_mismatch" });
});

test("archive and license integrity stay separate from the selected local engine", () => {
  const { archive, manifest, engine } = fixture();
  const verified = verifyArchive(archive, manifest);
  assert.deepEqual(verified.engine, engine);
  assert.equal(verified.licenses.length, 3);
  assert.ok(verified.licenses.every((entry) => entry.sha256 === sha(Buffer.from("fixture license\n"))));
  assert.throws(() => verifyLocalEngine(engine), { code: "local_engine_integrity_mismatch" });
  assert.throws(() => verifyArchive(fixture("changed license\n").archive, manifest),
    { code: "archive_integrity_mismatch" });
  const wrongEngine = structuredClone(manifest);
  wrongEngine.engine.sha256 = "0".repeat(64);
  assert.throws(() => verifyArchive(archive, wrongEngine), { code: "engine_integrity_mismatch" });
});

test("a localBuild pin cannot redefine the official archive engine", () => {
  const { archive, manifest } = fixture();
  manifest.engine.localBuild = structuredClone(EXPECTED_PIN.engine.localBuild);
  // The synthetic archive hash is valid, but it cannot stand in for the official
  // engine merely by supplying a different selected-engine hash in the manifest.
  assert.throws(() => verifyArchive(archive, manifest), { code: "engine_integrity_mismatch" });
});

test("missing and wrong local artifacts fail before fetch or output writes", async (t) => {
  const directory = await temporary(t);
  const output = join(directory, "must-not-exist");
  let requests = 0;
  stubFetch(t, async () => { requests += 1; throw new Error("unexpected fetch"); });
  await assert.rejects(acquirePinnedEngine(output), { code: "local_engine_required" });
  await assert.rejects(acquirePinnedEngine(output, undefined, "relative-engine"),
    { code: "local_engine_required" });
  const wrong = join(directory, "wrong-engine");
  // Same size closes the hash boundary independently of the early size check.
  await writeFile(wrong, Buffer.alloc(EXPECTED_PIN.engine.size));
  await assert.rejects(acquirePinnedEngine(output, undefined, wrong),
    { code: "local_engine_integrity_mismatch" });
  assert.equal(requests, 0);
  await assert.rejects(access(output), { code: "ENOENT" });
});

test("CLI requires a supplied local engine and rejects a wrong file without output", async (t) => {
  const directory = await temporary(t);
  const output = join(directory, "must-not-exist");
  const missing = spawnSync(process.execPath, [CLI, "--output-dir", output], { encoding: "utf8" });
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /usage: --output-dir ABSOLUTE_PATH --local-engine ABSOLUTE_PATH/);
  const wrong = join(directory, "wrong-engine");
  await writeFile(wrong, "not the local engine");
  const rejected = spawnSync(process.execPath,
    [CLI, "--output-dir", output, "--local-engine", wrong], { encoding: "utf8" });
  assert.equal(rejected.status, 1);
  assert.match(rejected.stderr, /local_engine_integrity_mismatch/);
  assert.equal(rejected.stdout, "");
  await assert.rejects(access(output), { code: "ENOENT" });
});

const localEngine = process.env.ENGINE_ACQUIRE_LOCAL_ENGINE;
const officialArchive = process.env.ENGINE_ACQUIRE_OFFICIAL_ARCHIVE;
test("existing pinned inputs emit the local artifact and an explicitly unselected official engine", {
  skip: !localEngine || !officialArchive ? "set ENGINE_ACQUIRE_LOCAL_ENGINE and ENGINE_ACQUIRE_OFFICIAL_ARCHIVE for artifact proof" : false,
}, async (t) => {
  // Budget: one temporary output, under 13 MiB of new data for this pin. Reuse
  // the exact existing archive inode: never download or copy the 39 MiB archive.
  // Cleanup removes the temporary link, not the original archive or its bytes.
  const directory = await temporary(t);
  const archive = await readFile(officialArchive);
  const supplied = verifyLocalEngine(await readFile(localEngine));
  const official = verifyArchive(archive);
  assert.throws(() => verifyLocalEngine(official.engine), { code: "local_engine_integrity_mismatch" });
  assert.notEqual(sha(supplied), sha(official.engine));
  let requests = 0;
  stubFetch(t, async (url) => {
    requests += 1;
    assert.equal(url, EXPECTED_PIN.npm.tarballUrl);
    return { ok: true, url, body: [archive], headers: new Headers({ "content-length": String(archive.length) }) };
  });
  const output = join(directory, "artifacts");
  await mkdir(output, { mode: 0o700 });
  const archiveOutput = join(output, `agent-browser-${EXPECTED_PIN.version}.tgz`);
  const archiveBefore = await lstat(officialArchive);
  assert.equal(archiveBefore.dev, (await lstat(output)).dev, "archive reuse requires the same filesystem; no copy fallback");
  assert.ok(EXPECTED_PIN.engine.size + 128 * 1024 < 50 * 1024 * 1024);
  await link(officialArchive, archiveOutput);
  assert.equal((await lstat(archiveOutput)).ino, archiveBefore.ino);
  const { receipt, writes } = await acquirePinnedEngine(output, undefined, localEngine);
  assert.equal(requests, 1);
  assert.ok(writes.every(({ name, status }) => status === (name === receipt.archive.outputName ? "reused" : "created")));
  assert.deepEqual(await readFile(join(output, EXPECTED_PIN.engine.outputName)), supplied);
  assert.equal(receipt.engine.sha256, EXPECTED_PIN.engine.sha256);
  assert.equal(receipt.engine.origin, "local-build");
  assert.equal(receipt.localBuild.cleanRebuildVerified, false);
  assert.deepEqual(receipt.localBuild.patches, EXPECTED_PIN.engine.localBuild.patches);
  assert.equal(receipt.localBuild.cargoLockSha256, EXPECTED_PIN.engine.localBuild.cargoLockSha256);
  assert.equal(receipt.archiveEngine.sha256, OFFICIAL_ARCHIVE_ENGINE.sha256);
  assert.equal(receipt.archiveEngine.selected, false);
  assert.deepEqual(receipt.licenses, official.licenses.map(({ outputName, size, sha256 }) => ({ outputName, size, sha256 })));
  for (const license of receipt.licenses) {
    assert.equal(sha(await readFile(join(output, license.outputName))), license.sha256);
  }
  assert.deepEqual(JSON.parse(await readFile(join(output, "agent-browser-engine-acquisition.json"))), receipt);
  const archiveAfter = await lstat(officialArchive);
  assert.equal(archiveAfter.ino, archiveBefore.ino);
  assert.equal(archiveAfter.size, archiveBefore.size);
  assert.equal(archiveAfter.mode, archiveBefore.mode);
});
