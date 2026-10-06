"""Local server: serves dist/ and routes /api/* to the same code Vercel runs.

Usage: python local_server.py [port]
Reads ANTHROPIC_API_KEY from the environment or from a .env file next to this
script. Without a key, the site still runs in offline mode.
"""

import importlib.util
import os
import sys
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parent


def load_env_file() -> None:
    env_path = ROOT / ".env"
    if not env_path.exists():
        return
    for line in env_path.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        os.environ.setdefault(key.strip(), value.strip().strip('"').strip("'"))


load_env_file()
spec = importlib.util.spec_from_file_location("rewardslab_api", ROOT / "api" / "index.py")
api = importlib.util.module_from_spec(spec)
spec.loader.exec_module(api)


class Handler(SimpleHTTPRequestHandler):
    def _send_api(self, status: int, data: dict) -> None:
        import json

        encoded = json.dumps(data).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(encoded)))
        self.end_headers()
        self.wfile.write(encoded)

    def do_GET(self) -> None:
        if self.path.startswith("/api/"):
            self._send_api(*api.handle_api("GET", self.path, b""))
        else:
            super().do_GET()

    def do_POST(self) -> None:
        if not self.path.startswith("/api/"):
            self.send_error(404)
            return
        length = int(self.headers.get("Content-Length") or 0)
        if length > api.MAX_BODY_BYTES:
            self._send_api(413, {"error": "Request is too large."})
            return
        self._send_api(*api.handle_api("POST", self.path, self.rfile.read(length)))


def main() -> None:
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8080
    handler = partial(Handler, directory=str(ROOT / "dist"))
    server = ThreadingHTTPServer(("127.0.0.1", port), handler)
    mode = f"live AI ({api.MODEL})" if api.live_enabled() else "offline mode (no ANTHROPIC_API_KEY found)"
    print(f"RewardsLab AI running at http://localhost:{port} in {mode}. Press Control-C to stop.")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
