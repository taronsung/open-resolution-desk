"""Static file server that mimics GitHub Pages headers for local testing.

Usage: python3 serve.py <directory> <port> [--prefix /repo]
Sends Access-Control-Allow-Origin: * on every response, like GitHub Pages.
With --prefix, the directory is served under that URL path, like a project site.
"""
import functools
import http.server
import sys


class Handler(http.server.SimpleHTTPRequestHandler):
    prefix = ""

    extensions_map = {
        **http.server.SimpleHTTPRequestHandler.extensions_map,
        ".js": "application/javascript",
        ".mjs": "application/javascript",
        ".json": "application/json",
        ".svg": "image/svg+xml",
        ".webmanifest": "application/manifest+json",
    }

    def translate_path(self, path):
        if self.prefix:
            if not path.startswith(self.prefix):
                return "/nonexistent-path"
            path = path[len(self.prefix):] or "/"
        return super().translate_path(path)

    def end_headers(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def log_message(self, fmt, *args):
        pass


def main():
    directory, port = sys.argv[1], int(sys.argv[2])
    prefix = ""
    if "--prefix" in sys.argv:
        prefix = sys.argv[sys.argv.index("--prefix") + 1].rstrip("/")
    Handler.prefix = prefix
    handler = functools.partial(Handler, directory=directory)
    with http.server.ThreadingHTTPServer(("127.0.0.1", port), handler) as httpd:
        httpd.serve_forever()


if __name__ == "__main__":
    main()
