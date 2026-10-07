#!/usr/bin/env python3
"""Install one local CodexTaskCtl dispatcher LaunchAgent, without changing Codex."""
from __future__ import annotations

import argparse
import os
import plistlib
import shutil
import subprocess
from pathlib import Path

LABEL = "com.maricoxu.codextaskctl.dispatcher"

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--workspace", required=True)
    parser.add_argument("--keyword", default="")
    parser.add_argument("--list", default="延后交给 Codex")
    parser.add_argument("--list-id", default="")
    parser.add_argument("--interval-seconds", type=int, default=600)
    parser.add_argument("--uninstall", action="store_true")
    args = parser.parse_args()
    workspace = Path(args.workspace).expanduser().resolve()
    if not workspace.is_dir():
        parser.error("workspace must be an existing directory")
    home = Path.home()
    agent = home / "Library/LaunchAgents" / (LABEL + ".plist")
    subprocess.run(["launchctl", "bootout", f"gui/{os.getuid()}/{LABEL}"], check=False, capture_output=True)
    if args.uninstall:
        agent.unlink(missing_ok=True)
        print("Uninstalled", LABEL)
        return
    node = shutil.which("node")
    codex = shutil.which("codex")
    if not node or not codex:
        parser.error("node and codex must be in PATH")
    source = Path(__file__).resolve().parent / "codextaskctl-dispatcher.mjs"
    if not source.exists():
        parser.error("dispatcher source not found")
    state_dir = home / ".config/remctl/desktop"
    state_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
    agent.parent.mkdir(parents=True, exist_ok=True)
    list_args = ["--list-id", str(args.list_id)] if args.list_id else ["--list", args.list]
    agent.write_bytes(plistlib.dumps({
        "Label": LABEL,
        "ProgramArguments": [node, str(source), "--keyword", args.keyword, *list_args,
            "--workspace", str(workspace), "--state", str(state_dir / "dispatcher-state.json"), "--codex", codex,
            "--interval-ms", str(max(60, args.interval_seconds) * 1000)],
        "RunAtLoad": True,
        "KeepAlive": True,
        "WorkingDirectory": str(workspace),
        "EnvironmentVariables": {"PATH": os.environ.get("PATH", "/usr/bin:/bin"), "CODEX_TASKCTL_WORKSPACE": str(workspace)},
        "StandardOutPath": str(state_dir / "dispatcher.log"),
        "StandardErrorPath": str(state_dir / "dispatcher-error.log"),
    }))
    subprocess.run(["launchctl", "bootstrap", f"gui/{os.getuid()}", str(agent)], check=True)
    print("Installed", agent)

if __name__ == "__main__":
    main()
