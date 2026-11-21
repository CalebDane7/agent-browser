// WHY: regression guard for the 2026-09-17 blank-tab fault. An agent binary replaced by an
// auto-update shows "(deleted)" in /proc/<pid>/exe; ownership must still resolve to that agent,
// not to the short-lived tool shell, or every tool call gets a fresh about:blank task tab.
import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveInvokingOwner } from "../scripts/agent-browser-owner.js";

function proc(root, pid, name, ppid, exe) {
  const dir = join(root, String(pid)); mkdirSync(dir, { recursive: true });
  const fields = ["S", String(ppid), ...Array(17).fill("0"), String(1000 + pid)];
  writeFileSync(join(dir, "stat"), `${pid} (${name}) ${fields.join(" ")}\n`);
  const uid = process.getuid();
  writeFileSync(join(dir, "status"), `Name:\t${name}\nUid:\t${uid}\t${uid}\t${uid}\t${uid}\n`);
  symlinkSync(exe, join(dir, "exe"));
}
function fixture(agentExe) {
  const root = mkdtempSync(join(tmpdir(), "ab-owner-"));
  mkdirSync(join(root, "sys/kernel/random"), { recursive: true });
  writeFileSync(join(root, "sys/kernel/random/boot_id"), "11111111-2222-3333-4444-555555555555\n");
  proc(root, 100, "claude", 1, agentExe);
  proc(root, 200, "bash", 100, "/usr/bin/bash");
  return root;
}

describe("resolveInvokingOwner with replaced agent binaries", () => {
  it("resolves a running Claude whose binary was replaced by an update", () => {
    const root = fixture("/home/u/.npm-global/lib/node_modules/@anthropic-ai/.claude-code-x/bin/claude.exe (deleted)");
    try {
      const owner = resolveInvokingOwner({ env: {}, ppid: 200, procRoot: root });
      expect(owner.agentKind).toBe("claude");
      expect(owner.pid).toBe(100);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  it("still resolves an unreplaced Claude binary", () => {
    const root = fixture("/home/u/bin/claude");
    try {
      const owner = resolveInvokingOwner({ env: {}, ppid: 200, procRoot: root });
      expect(owner.agentKind).toBe("claude");
      expect(owner.pid).toBe(100);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  it("does not treat a replaced non-agent binary as an agent", () => {
    const root = fixture("/usr/bin/python3 (deleted)");
    try {
      const owner = resolveInvokingOwner({ env: {}, ppid: 200, procRoot: root });
      expect(owner.agentKind).toBe("caller");
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
