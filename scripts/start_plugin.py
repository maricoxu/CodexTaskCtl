"""Packaged MCP client; all Reminders operations still use the signed installed host."""
import json
from pathlib import Path
from remctl_mcp import serve

if __name__ == "__main__":
    runtime = Path(__file__).resolve().parent
    manifest = json.loads((runtime.parent / "plugin.json").read_text())
    raise SystemExit(serve(
        Path.home() / "bin" / "remctl",
        manifest["version"],
        widget_path=runtime / "remctl_mcp_widget.html",
    ))
