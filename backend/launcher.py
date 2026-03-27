"""
Launcher for scrybe MCP server.
- If the HTTP server isn't running, starts it as a detached background process.
- Then runs an in-process stdio<->SSE proxy so Claude Code connects normally.
"""
import pathlib
import socket
import subprocess
import sys
import time

PORT = 8765
_URL = f"http://127.0.0.1:{PORT}/sse"
_FASTMCP = str(pathlib.Path(sys.executable).with_name("fastmcp.exe"))


def _is_running() -> bool:
    with socket.socket() as s:
        return s.connect_ex(("127.0.0.1", PORT)) == 0


if not _is_running():
    subprocess.Popen(
        [
            sys.executable, "-m", "backend.mcp_server",
            "--transport", "sse", "--port", str(PORT),
        ],
        stdin=subprocess.DEVNULL,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        creationflags=(
            subprocess.CREATE_NO_WINDOW
            | subprocess.CREATE_NEW_PROCESS_GROUP
        ),
    )
    for _ in range(100):  # wait up to 10 s
        if _is_running():
            break
        time.sleep(0.1)
    else:
        print(
            "scrybe: failed to start HTTP server on port 8765",
            file=sys.stderr,
        )
        sys.exit(1)

from fastmcp.cli.cli import app  # noqa: E402
app(["run", _URL, "--transport", "stdio", "--no-banner"])
