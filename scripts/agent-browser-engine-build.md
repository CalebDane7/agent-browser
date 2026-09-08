# Selected local engine

The selected Linux engine is a supplied local build, not the executable in the
upstream npm archive or GitHub release. Acquisition requires an absolute
`--local-engine` path. It verifies all eight shipped patches in their pinned
order, then the supplied engine's size and SHA-256, before any download or
output creation. From this fork's root:

```sh
node scripts/agent-browser-engine-acquire.js \
  --output-dir /absolute/new/artifact-directory \
  --local-engine /absolute/supplied/agent-browser-v0.36.0-linux-x64
```

The supplied file must be 12,076,512 bytes with SHA-256
`6612815bd78804803f9d1a0272528d1c6fa555f9a6d994511126ed9eed8c7f23`.
The observed release build produced these bytes and reports version `0.36.0`.
The official npm Linux engine is 14,156,776 bytes with SHA-256
`56d15181e51e00213f907fcf39707cfc76bfa804ff20f5a9373661c73f96de5e`.
The archive is verified independently by its pinned SHA-1 and SHA-512, inventory,
package identity, and engine hashes. License files come from that verified
archive; their SHA-256 values are recorded in the receipt. Preserve
`LICENSE.agent-browser` (Apache-2.0), `LICENSE-axe-core.txt`, and
`LICENSE-axe-core-THIRD-PARTY.txt` with the corresponding artifacts. Neither
upstream URL in the pin provides the selected local binary.

## Source and build inputs

The donor is `vercel-labs/agent-browser` at commit
`eb05921bad874cd2a1b4fa5d1149f1ed26576cae` (`v0.36.0`). Start with an isolated
checkout at that exact commit. Apply all eight patches below in order, running
`patch --batch --fuzz=0 -p1 < PATCH_FILE` from the donor checkout root; replace
`PATCH_FILE` with the full path to that row's file in this fork's `scripts`
directory. Stop if any patch fails. Do not substitute an unbound working tree.

| Order | Patch, relative to this directory | SHA-256 |
| --- | --- | --- |
| 1 | `patches/agent-browser-v0.36.0-direct-page-liveness.patch` | `3ae199addcad94218f17c6a1d68c19660377d3938a1ba2f9d900a84fbe36d33f` |
| 2 | `patches/agent-browser-v0.36.0-full-page-css-metrics.patch` | `15fd4e3ff0caac3373902641d14ebd8240dda0d71f2242df435532a009e09fe9` |
| 3 | `patches/agent-browser-v0.36.0-direct-page-diagnostic-events.patch` | `5d7d61fd22f7ce5a58c65802ec81bbb26b77d142498ac19439844e0dc0c17b29` |
| 4 | `patches/agent-browser-v0.36.0-bounded-json-output.patch` | `ecaf08e22c646995a8ba407acf1ff6b7cf34c748a4478627a2c125c0317b59dc` |
| 5 | `patches/agent-browser-v0.36.0-object-id-upload.patch` | `0f07af0901941d3f90f39e24d533373895e0d22ad384b9441ca96acbbf10ea1e` |
| 6 | `patches/agent-browser-v0.36.0-private-upload-paths.patch` | `31b97f5c30f651ab99e0057c41e74b29efbede9d37f2d3259758d47ccdf78498` |
| 7 | `patches/agent-browser-v0.36.0-private-shared-command.patch` | `d1d183b68c101150806cf10d3f34bfbd13e43f50b70dcb37a7c50374022de4c5` |
| 8 | `patches/agent-browser-v0.36.0-errors-clear.patch` | `df8803e3650a9c442e93a591e36ef9233ff24c1030220cd40c5df50d11613326` |

The ordered list matches `engine.localBuild.patches` in
`pinned-agent-browser-engine.json`. Acquisition independently fixes the same
list; editing the input manifest cannot float a patch or binary pin.

The first patch keeps liveness probes within connection scope: direct-page
connections use `Page.getFrameTree`, while browser connections retain
`Browser.getVersion`. The later patches supply the screenshot, diagnostic
event, bounded-output, upload, private shared-command and isolated errors-clear
source changes.

| Input | SHA-256 |
| --- | --- |
| Final `cli/src/native/browser.rs` | `6c089d03bfec21c867b9aa81dbd0bf58533b6604382dfa255c554a0e7de4f843` |
| Final `cli/src/commands.rs` | `64d547d4b4377178abafce6807fd990c33cb100b1eb4f1a3ded8081b4bda488a` |
| Final `cli/src/native/actions.rs` | `8e6b856ea7369c6dc09b856781a3588045f720dfa442942d3a7a4ab93cd3193f` |
| Unchanged `cli/Cargo.lock` | `0fe5b217b90d08750adb87a1618ff7efc5405c861b8d49da9aa2b869c68fcf02` |

## Observed build

The installed `+stable` toolchain used for the build reports:

```text
rustc 1.98.0 (88d9e12ae 2026-08-18)
commit-hash: 88d9e12ae178fab0fb5cc050a94da85685d449ea
host: x86_64-unknown-linux-gnu
LLVM version: 22.1.8
```

`+stable` selects the installed stable toolchain; check `rustc +stable -vV`
against these values when comparing outputs. From the donor checkout root, the
successful release-build command was:

```sh
cargo +stable build --offline --locked --release --manifest-path cli/Cargo.toml --jobs 2
```

The offline command requires the toolchain and locked dependencies to be
available locally; it does not fetch them. No additional feature flags were
passed. Keep the committed lockfile unchanged. The observed output is
`cli/target/release/agent-browser`. The release profile in the pinned manifest
sets `opt-level = 3`, `lto = true`, `codegen-units = 1`, and `strip = true`.
There was no built dashboard: `cli/build.rs` supplies the 118-byte placeholder
at `packages/dashboard/out/index.html` when that file is absent. Its SHA-256 is
`9d0ef25400d77e3deeb9dc218cb26b02948059ce4a1c5a49e290a76d4297e14c`.
An existing built dashboard changes embedded build inputs.

## Focused native checks

The earlier seven-patch revision's native check run passed 25 tests with 0
failures; 1,317 tests were filtered out. This was not an execution of all 1,342
discovered tests. Its command, from the prepared donor checkout root, was:

```sh
cargo +stable test --offline --locked --release \
  --manifest-path cli/Cargo.toml --jobs 2 --bin agent-browser -- \
  private_ test_json_output_ limited_confirm_json_ only_execution_scoped_ \
  selector_clip_ full_page_clip_ test_upload_parser_ \
  test_upload_direct_page_ test_direct_page_events_ --test-threads=1
```

After applying the eighth patch, the exact errors-clear guard passed: 1 test,
0 failures, with 1,342 other tests filtered out. The release build above then
succeeded on the same source. The focused command was:

```sh
cargo +stable test --offline --locked --release \
  --manifest-path cli/Cargo.toml --jobs 2 --bin agent-browser \
  native::actions::tests::errors_clear_preserves_console_and_neighbor_errors \
  -- --exact --test-threads=1
```

These source inputs, the successful build, and focused checks do not establish
installation, loaded-runtime behavior, or live-browser proof. A clean-room
rebuild and byte-for-byte reproducibility have not been verified; this recipe
does not capture a hermetic host/linker/build-path environment.

Investigate a different build hash against the source, toolchain and build
inputs. An explained changed candidate can have its artifact, manifest and
independent verifier pins updated together; acquisition must still reject an
unexplained or unpinned binary. The acquisition receipt records
`cleanRebuildVerified: false`; successful acquisition proves the supplied
artifact's identity, not clean-room reproducibility or installed behavior.
