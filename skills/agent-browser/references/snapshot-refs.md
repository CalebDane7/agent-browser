# Snapshot And Refs

Snapshots expose compact element references so agents can interact without
dumping the page DOM. Every example below uses one generated, globally unique
session. Keep that variable in the same shell for the whole workflow. For a
non-default profile, repeat its `--account` on every command; for a user-invited
current tab, repeat `--current-tab` too.

## Fast Loop

```bash
IFS= read -r snapshot_uuid </proc/sys/kernel/random/uuid
snapshot_session="snapshot-example-${snapshot_uuid//-/}"
agent-browser --session "$snapshot_session" open https://example.com
agent-browser --session "$snapshot_session" snapshot -i --compact
# act with the returned refs
```

Prefer `-i --compact` first. Use a full snapshot only when structural context is
actually needed.

## Ref Shape

Typical output:

```text
@e1 [heading] "Account settings"
@e2 [textbox] "Display name"
@e3 [button] "Save"
```

Use the ref in the same session that produced it:

```bash
agent-browser --session "$snapshot_session" fill @e2 "New name"
agent-browser --session "$snapshot_session" click @e3
```

Refs are session- and page-state-specific. Never copy one between agents,
sessions, or tabs. Every snapshot replaces the session's ref map, including a
scoped snapshot. Use only refs from the latest successful snapshot.

## Lifecycle

Re-snapshot after navigation, reload, save, dialog, or a material DOM change
before using another ref:

```bash
agent-browser --session "$snapshot_session" snapshot -i --compact
agent-browser --session "$snapshot_session" click @e1
agent-browser --session "$snapshot_session" wait --url "**/next"
agent-browser --session "$snapshot_session" snapshot -i --compact
```

Do not re-snapshot after every keystroke when the page did not materially change.

## Scope Output

Limit large pages to the relevant container:

```bash
agent-browser --session "$snapshot_session" snapshot -i --compact -s "#settings"
# If that snapshot returns the desired element as [ref=e9]:
agent-browser --session "$snapshot_session" get text @e9
```

Snapshot `-s` accepts CSS only, never an `@ref`. A scoped snapshot replaces the
previous ref map; it does not add refs to it.

Avoid `get text body` unless the whole body is genuinely the requested evidence.

Scoped `snapshot -s` still obtains Chrome's full accessibility tree through the
normal CDP protocol carried by the enrolled extension, then filters it in the
engine. For one narrow fact, a CSS-specific `get` or `is` transfers less data
and is usually cheaper. After a size failure, do not repeat the unchanged
snapshot or bypass the wrapper with raw CDP.

## Troubleshooting

For `ref not found`, first ask whether the page changed. If yes, take one fresh
snapshot. If the control is outside the current viewport or appears
asynchronously, use an observable wait or scroll, then snapshot once:

```bash
agent-browser --session "$snapshot_session" wait --text "Continue"
agent-browser --session "$snapshot_session" snapshot -i --compact

agent-browser --session "$snapshot_session" scroll down 800
agent-browser --session "$snapshot_session" snapshot -i --compact
```

If one fresh snapshot still cannot expose the control, use a semantic locator or
one scoped page-local observation. Do not repeat snapshots, switch tabs by index,
or use `eval` to bypass ownership, account, wallet, or secret-state protections.

Close the same generated session promptly on success, failure, or cancellation,
unless its exact tab is still in active collaboration with the user or awaits
genuine user-only input:

```bash
agent-browser --session "$snapshot_session" close
```
