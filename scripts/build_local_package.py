"""Build a relocatable Mac package from the checked-out files, not stale git HEAD."""
import hashlib
import json
import platform
import shutil
import subprocess
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]

def main():
    version = json.loads((ROOT / "plugins/remctl/plugin.json").read_text())["version"]
    inputs = [ROOT / "remctl_workspace.html", ROOT / "capture-bar/CodexTaskCtlCaptureBar.swift",
              ROOT / "scripts/install_local_package.py", ROOT / "scripts/start_plugin.py",
              ROOT / "scripts/codextaskctl-dispatcher.mjs", ROOT / "scripts/install_dispatcher_launchagent.py",
              ROOT / "remote/codextaskctl-relay.mjs", ROOT / "remote/codextaskctl-agent.mjs",
              ROOT / "plugins/remctl/mcp.json", ROOT / "plugins/remctl/plugin.json", ROOT / "plugins/remctl/launch.sh"]
    inputs += sorted(ROOT.glob("remctl_*.py"))
    inputs += sorted((ROOT / "plugins/remctl/skills").rglob("SKILL.md"))
    inputs += sorted((ROOT / "remote").glob("*.mjs"))
    digest = hashlib.sha256(b"".join(p.read_bytes() for p in inputs)).hexdigest()[:12]
    name = "CodexTaskCtl-" + version + "-" + platform.machine() + "-" + digest
    stage = ROOT / "dist" / name
    if stage.exists():
        shutil.rmtree(stage) # Only our deterministic generated build directory.
    plugin = stage / "plugins/remctl"
    shutil.copytree(ROOT / "plugins/remctl", plugin, ignore=shutil.ignore_patterns("runtime", "__pycache__"))
    runtime = plugin / "runtime"
    runtime.mkdir()
    for source in [*ROOT.glob("remctl_*.py"), ROOT / "remctl_workspace.html", ROOT / "remctl_mcp_widget.html"]:
        shutil.copy2(source, runtime / source.name)
    shutil.copy2(ROOT / "scripts/codextaskctl-dispatcher.mjs", runtime / "codextaskctl-dispatcher.mjs")
    shutil.copy2(ROOT / "scripts/start_plugin.py", runtime / "start_plugin.py")
    shutil.copytree(ROOT / ".agents", stage / ".agents")
    shutil.copytree(ROOT / "remote", stage / "remote")
    app = stage / "CodexTaskCtl Capture.app"
    binary = app / "Contents/MacOS/CodexTaskCtl Capture"
    binary.parent.mkdir(parents=True)
    shutil.copy2(ROOT / "capture-bar/Info.plist", app / "Contents/Info.plist")
    subprocess.run(["swiftc", str(ROOT / "capture-bar/CodexTaskCtlCaptureBar.swift"), "-o", str(binary),
                    "-framework", "AppKit", "-framework", "Carbon"], check=True)
    subprocess.run([str(binary), "--self-test"], check=True)
    subprocess.run(["codesign", "--force", "--sign", "-", str(app)], check=True)
    for source, dest in [
        ("scripts/install_local_package.py", "install.py"),
        ("capture-bar/open.sh", "Open Capture.command"),
        ("LICENSE", "LICENSE"),
        ("docs/codextaskctl-local-release.md", "README.md"),
        ("scripts/codextaskctl-dispatcher.mjs", "codextaskctl-dispatcher.mjs"),
        ("scripts/install_dispatcher_launchagent.py", "install_dispatcher_launchagent.py"),
        ("docs/codextaskctl-dispatcher-mvp.md", "DISPATCHER-MVP.md"),
    ]:
        shutil.copy2(ROOT / source, stage / dest)
    (stage / "Install.command").write_text(
        '#!/bin/sh\nset -eu\nHERE=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)\n'
        'HOST="$HOME/Applications/RemCTL Capability Host.app/Contents/Resources"\n'
        'PYTHON=$(cat "$HOST/remctl-capability-python-path")\n'
        'exec "$PYTHON" "$HERE/install.py" "$@"\n')
    (stage / "Install.command").chmod(0o755)
    (stage / "Open Capture.command").chmod(0o755)
    (plugin / "launch.sh").chmod(0o755)
    files = {str(p.relative_to(stage)): hashlib.sha256(p.read_bytes()).hexdigest()
             for p in sorted(stage.rglob("*")) if p.is_file()}
    (stage / "manifest.json").write_text(json.dumps({"version":version, "build":digest,
        "architecture":platform.machine(), "files":files}, indent=2) + "\n")
    archive = ROOT / "dist" / (name + ".zip")
    with zipfile.ZipFile(archive, "w", zipfile.ZIP_DEFLATED) as z:
        for p in sorted(stage.rglob("*")):
            if p.is_file(): z.write(p, name + "/" + str(p.relative_to(stage)))
    (ROOT / "dist/latest-package.txt").write_text(str(stage) + "\n")
    print(archive)
    print("SHA256", hashlib.sha256(archive.read_bytes()).hexdigest())

if __name__ == "__main__":
    main()
