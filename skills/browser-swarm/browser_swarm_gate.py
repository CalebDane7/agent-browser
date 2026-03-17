#!/usr/bin/env python3
"""
Browser Swarm Gate — PreToolUse hook for Bash.

Detects sequential agent-browser browsing (3+ opens without ab-swarm-setup)
and BLOCKS with a redirect to browser-swarm skill.

Fail-open on ALL errors. Never blocks incorrectly.
State: ~/.ai-controller/browser-swarm-state/{session_id}.json
"""

import json
import random
import sys
import time
from datetime import datetime, timedelta
from pathlib import Path

STATE_DIR = Path.home() / ".ai-controller" / "browser-swarm-state"
LOG_FILE = Path.home() / ".ai-controller" / "logs" / "browser-swarm-gate.log"

# Threshold: block after this many sequential agent-browser opens
SEQUENTIAL_OPEN_THRESHOLD = 3


def _log(msg: str):
    """Append to log file. Never raises."""
    try:
        LOG_FILE.parent.mkdir(parents=True, exist_ok=True)
        ts = datetime.now().strftime("%H:%M:%S")
        with open(LOG_FILE, "a") as f:
            f.write(f"[{ts}] {msg}\n")
    except Exception:
        pass


def _approve(reason: str = ""):
    """Output approve decision and exit."""
    print(json.dumps({}))


def _approve_with_context(context: str):
    """Output approve with additionalContext."""
    print(json.dumps({
        "hookSpecificOutput": {
            "hookEventName": "PreToolUse",
            "additionalContext": context,
        },
    }))


def _block(reason: str, context: str):
    """Output block decision."""
    print(json.dumps({
        "decision": "block",
        "reason": reason,
        "hookSpecificOutput": {
            "hookEventName": "PreToolUse",
            "additionalContext": context,
        },
    }))


def _load_state(session_id: str) -> dict:
    """Load gate state. Returns fresh state if missing."""
    STATE_DIR.mkdir(parents=True, exist_ok=True)
    fp = STATE_DIR / f"{session_id}.json"
    if fp.exists():
        try:
            return json.loads(fp.read_text())
        except Exception:
            pass
    return {
        "session_id": session_id,
        "sequential_opens": 0,
        "swarm_active": False,
        "urls_opened": [],
        "created_at": datetime.now().isoformat(),
    }


def _save_state(session_id: str, state: dict) -> None:
    """Save gate state."""
    STATE_DIR.mkdir(parents=True, exist_ok=True)
    (STATE_DIR / f"{session_id}.json").write_text(json.dumps(state, indent=2))


def _cleanup_stale():
    """Remove state files older than 24 hours. Never raises."""
    try:
        cutoff = datetime.now() - timedelta(hours=24)
        for f in STATE_DIR.iterdir():
            if f.suffix == ".json" and f.stat().st_mtime < cutoff.timestamp():
                f.unlink(missing_ok=True)
    except Exception:
        pass


def _is_agent_browser_open(command: str) -> bool:
    """Check if a Bash command is an agent-browser open command.

    Matches:
      agent-browser open URL
      agent-browser --session NAME open URL
      agent-browser connect PORT && agent-browser open URL
    """
    # Import the proven parser functions (same as browser_flow_tracker.py)
    try:
        sys.path.insert(0, str(Path.home() / ".ai-controller" / "hooks"))
        from browser_command_parser import parse_all_commands
        for parsed in parse_all_commands(command):
            if parsed.get("subcommand") == "open":
                return True
    except ImportError:
        # Fallback: simple regex if parser unavailable
        import re
        if re.search(r'\bagent-browser\b.*\bopen\b', command):
            return True
    return False


def _is_ab_swarm_setup(command: str) -> bool:
    """Check if command uses ab-swarm-setup."""
    return "ab-swarm-setup" in command


def _is_ab_parallel(command: str) -> bool:
    """Check if command uses ab-parallel."""
    return "ab-parallel" in command


def _is_agent_browser_command(command: str) -> bool:
    """Check if command involves agent-browser at all."""
    return "agent-browser" in command


def main():
    # Periodic cleanup (10% chance)
    if random.random() < 0.1:
        _cleanup_stale()

    # Parse stdin
    try:
        input_data = json.loads(sys.stdin.read())
    except Exception:
        _approve()
        return

    # Maintenance mode bypass
    if (Path.home() / ".ai-controller" / "MAINTENANCE_MODE").exists():
        _approve()
        return

    # Only handle Bash tool
    tool_name = input_data.get("tool_name", "")
    if tool_name != "Bash":
        _approve()
        return

    tool_input = input_data.get("tool_input", {})
    command = str(tool_input.get("command", ""))

    # Skip non-browser commands entirely
    if not _is_agent_browser_command(command) and not _is_ab_swarm_setup(command) and not _is_ab_parallel(command):
        _approve()
        return

    session_id = input_data.get("session_id", "")
    if not session_id:
        _approve()
        return

    state = _load_state(session_id)

    # ab-swarm-setup or ab-parallel = parallel tool, mark swarm active
    if _is_ab_swarm_setup(command) or _is_ab_parallel(command):
        state["swarm_active"] = True
        state["sequential_opens"] = 0  # Reset counter
        _save_state(session_id, state)
        _log(f"SWARM_ACTIVE: {command[:80]}")
        _approve()
        return

    # If swarm is already active, allow everything
    if state.get("swarm_active"):
        _approve()
        return

    # Check if this is an agent-browser open command
    if _is_agent_browser_open(command):
        state["sequential_opens"] = state.get("sequential_opens", 0) + 1
        count = state["sequential_opens"]

        # Track URL
        url = command.split("open")[-1].strip().split()[0] if "open" in command else ""
        if url and url not in state.get("urls_opened", []):
            state.setdefault("urls_opened", []).append(url)

        _save_state(session_id, state)

        if count >= SEQUENTIAL_OPEN_THRESHOLD:
            _log(f"BLOCKED: {count} sequential opens without swarm")
            _block(
                f"Sequential browsing detected ({count} opens)",
                (
                    f"BLOCKED: You've opened {count} URLs sequentially without using browser-swarm. "
                    f"This is slow — use the browser-swarm skill for parallel research instead.\n\n"
                    f"Quick fix:\n"
                    f"1. Invoke the browser-swarm skill (Skill tool)\n"
                    f"2. Use ab-swarm-setup to open ALL tabs at once:\n"
                    f"   ab-swarm-setup r-1=URL1 r-2=URL2 ... r-N=URLN\n"
                    f"3. Dispatch parallel agents in ONE message with run_in_background: true\n\n"
                    f"URLs opened so far: {', '.join(state.get('urls_opened', [])[:5])}\n"
                    f"Each agent gets its own --session name and operates independently."
                ),
            )
            return

        _log(f"ALLOW: open #{count} (threshold={SEQUENTIAL_OPEN_THRESHOLD})")
        _approve()
        return

    # All other agent-browser commands (snapshot, click, screenshot, etc.) — always allow
    _approve()


if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        # FAIL-OPEN: never block on errors
        _log(f"FATAL ERROR (fail-open): {e}")
        print(json.dumps({}))
