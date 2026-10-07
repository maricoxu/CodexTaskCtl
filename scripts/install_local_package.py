"""Install the packaged client/UI and Capture Bar without altering RemCTL's signed host."""
import argparse
import datetime
import hashlib
import json
import os
import plistlib
import platform
import shutil
import subprocess
import time
from pathlib import Path

def run(*args, check=True):
    return subprocess.run(args, text=True, capture_output=True, check=check)

def verify(root):
    data = json.loads((root / "manifest.json").read_text())
    for name, expected in data["files"].items():
        path = (root / name).resolve()
        if not path.is_relative_to(root.resolve()) or hashlib.sha256(path.read_bytes()).hexdigest() != expected:
            raise ValueError("Package verification failed: " + name)
    return data

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--verify-only", action="store_true")
    options = parser.parse_args()
    root = Path(__file__).resolve().parent
    manifest = verify(root)
    if options.verify_only:
        print("Package verified:", manifest["version"], manifest["build"]); return
    if platform.system() != "Darwin" or platform.machine() != manifest["architecture"]:
        raise RuntimeError("This package requires matching macOS architecture.")
    home = Path.home()
    remctl = home / "bin/remctl"
    health = json.loads(run(str(remctl), "doctor", "--for-agent", "--json").stdout)
    if not health.get("access", {}).get("effective", {}).get("ready"):
        raise RuntimeError("RemCTL Capability Host is not ready; complete its existing onboarding.")
    codex = shutil.which("codex")
    if not codex:
        raise RuntimeError("Codex CLI was not found.")
    base = home / ".local/share/CodexTaskCtl"
    release = base / "releases" / (manifest["version"] + "-" + manifest["build"])
    release.parent.mkdir(parents=True, exist_ok=True)
    if release.exists(): verify(release)
    else: shutil.copytree(root, release)
    verify(release)
    current = base / "current"
    previous = os.readlink(current) if current.is_symlink() else None
    if current.exists() and not current.is_symlink():
        raise RuntimeError("The current release path is not a symlink; refusing to replace it.")
    lines = run(codex, "plugin", "marketplace", "list").stdout.splitlines()
    old_root = next((line.split(None, 1)[1].strip() for line in lines if line.startswith("remctl-local ")), None)
    def point(target):
        pending = base / ("current-" + str(os.getpid()))
        pending.symlink_to(target)
        os.replace(pending, current)
    point(str(release))
    try:
        if old_root:
            run(codex, "plugin", "remove", "remctl@remctl-local", check=False)
            run(codex, "plugin", "marketplace", "remove", "remctl-local")
        run(codex, "plugin", "marketplace", "add", str(current))
        run(codex, "plugin", "add", "remctl@remctl-local")
    except Exception:
        if previous: point(previous)
        else: current.unlink(missing_ok=True)
        if old_root:
            run(codex, "plugin", "marketplace", "remove", "remctl-local", check=False)
            run(codex, "plugin", "marketplace", "add", old_root, check=False)
            run(codex, "plugin", "add", "remctl@remctl-local", check=False)
        raise
    backups = base / "backups"
    backups.mkdir(exist_ok=True)
    app = home / "Applications/CodexTaskCtl Capture.app"
    app.parent.mkdir(exist_ok=True)
    label = "com.maricoxu.codextaskctl.capture-bar"
    agent = home / "Library/LaunchAgents" / (label + ".plist")
    agent.parent.mkdir(parents=True, exist_ok=True)
    run("launchctl", "bootout", "gui/" + str(os.getuid()) + "/" + label, check=False)
    if app.exists():
        app.rename(backups / ("Capture-" + datetime.datetime.now().strftime("%Y%m%d-%H%M%S") + ".app"))
    shutil.copytree(release / app.name, app)
    logs = base / "logs"; logs.mkdir(exist_ok=True)
    agent.write_bytes(plistlib.dumps({"Label":label, "ProgramArguments":[str(app / "Contents/MacOS/CodexTaskCtl Capture")],
        "RunAtLoad":True, "KeepAlive":True, "StandardErrorPath":str(logs / "capture-error.log")}))
    bootstrap_error = None
    for attempt in range(3):
        result = run("launchctl", "bootstrap", "gui/" + str(os.getuid()), str(agent), check=False)
        if result.returncode == 0:
            break
        bootstrap_error = result.stderr.strip() or result.stdout.strip() or "unknown launchctl error"
        time.sleep(0.5 * (attempt + 1))
    else:
        raise RuntimeError("Could not start Capture Bar LaunchAgent: " + bootstrap_error)
    run("launchctl", "print", "gui/" + str(os.getuid()) + "/" + label)
    (base / "last-install.json").write_text(json.dumps({"release":str(release), "previous":previous,
        "previousMarketplace":old_root, "version":manifest["version"], "build":manifest["build"]}, indent=2))
    print("Installed", manifest["version"], manifest["build"])
    print("Plugin client:", current)
    print("Capture app:", app)

if __name__ == "__main__":
    main()
