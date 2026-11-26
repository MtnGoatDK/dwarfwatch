"""Serves the Dwarfwatch page with the demo driver (demo.js) injected, and saves the canvas frames it
posts while recording. Python 3, no dependencies.

    python tools/demo/serve.py            then open http://127.0.0.1:4790/?overlay=1#rec

Frames land in tools/demo/frames/ (0000.png, 0001.png, ...); done.txt appears when the run is over.
Without #rec the page loads but doesn't record; call demoGoto(seconds) in its console to preview.
"""
import base64
import http.server
import pathlib
import sys

HERE = pathlib.Path(__file__).resolve().parent
APP = pathlib.Path(sys.argv[1]).resolve() if len(sys.argv) > 1 else HERE.parent.parent  # the repo root
FRAMES = HERE / "frames"


class Handler(http.server.BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def send(self, body, ctype):
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        path = self.path.split("?")[0]
        if path == "/":
            html = (APP / "index.html").read_text(encoding="utf-8")
            html = html.replace('<script src="/mine.js"></script>', '<script src="/demo.js"></script><script src="/mine.js"></script>', 1)
            self.send(html.encode("utf-8"), "text/html; charset=utf-8")
        elif path == "/mine.js":
            self.send((APP / "mine.js").read_bytes(), "text/javascript")
        elif path == "/demo.js":
            self.send((HERE / "demo.js").read_bytes(), "text/javascript")
        else:
            self.send_response(404)
            self.end_headers()

    def do_POST(self):
        body = self.rfile.read(int(self.headers.get("Content-Length", 0))).decode("ascii", "replace")
        if self.path.startswith("/frame"):
            FRAMES.mkdir(exist_ok=True)
            n = int(self.path.split("n=")[1])
            (FRAMES / f"{n:04d}.png").write_bytes(base64.b64decode(body.split(",", 1)[1]))
        elif self.path.startswith("/done"):
            (HERE / "done.txt").write_text(body)
        self.send(b"ok", "text/plain")


if __name__ == "__main__":
    print("Demo page: http://127.0.0.1:4790/?overlay=1#rec  (serving " + str(APP) + ")")
    http.server.ThreadingHTTPServer(("127.0.0.1", 4790), Handler).serve_forever()
