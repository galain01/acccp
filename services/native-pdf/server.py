"""Private, authenticated native-PDF HTTP supervisor; one isolated job at a time."""
from __future__ import annotations

import argparse
import hmac
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import tempfile
import threading

MAX_PDF = 4 * 1024 * 1024
MAX_BODY = 12 * 1024 * 1024
MAX_RESULT = 16 * 1024 * 1024
DEADLINE = 90
PROCESSOR = Path(__file__).with_name("worker.py")
ACTIVE = threading.BoundedSemaphore(1)
CONNECTIONS = threading.BoundedSemaphore(8)
ERROR_STATUS = {"pdf_invalid": 400, "pdf_password": 400, "pdf_page_limit": 400,
                "pdf_complexity_limit": 400, "pdf_output_limit": 400,
                "native_pdf_unsupported": 400, "native_pdf_invalid_plan": 400,
                "native_pdf_preservation": 422, "native_pdf_worker_failed": 503,
                "native_pdf_timeout": 504, "native_pdf_busy": 503}


def child_environment():
    result = {"PATH": os.defpath, "LANG": "C.UTF-8", "LC_ALL": "C.UTF-8", "TZ": "UTC",
              "PYTHONUNBUFFERED": "1", "PYTHONDONTWRITEBYTECODE": "1"}
    for name in ("SystemRoot", "WINDIR", "TEMP", "TMP"):
        if name in os.environ:
            result[name] = os.environ[name]
    return result


def kill_tree(process):
    if os.name == "posix":
        try:
            os.killpg(process.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
    else:
        # Fixed system program, exact child pid; no shell or document strings.
        taskkill = Path(os.environ.get("SystemRoot", "C:/Windows")) / "System32/taskkill.exe"
        subprocess.run([str(taskkill), "/PID", str(process.pid), "/T", "/F"],
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                       env=child_environment(), timeout=10,
                       creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
    if process.poll() is None:
        process.kill()
    process.wait(timeout=10)


def execute(mode, body, toolchain):
    # Every disk file, including failed outputs and native temporary files,
    # belongs to this request and is removed before the HTTP response finishes.
    with tempfile.TemporaryDirectory(prefix="native-pdf-") as temporary:
        folder = Path(temporary)
        request, result = folder / "request.bin", folder / "result.json"
        request.write_bytes(body)
        environment = child_environment()
        environment.update(TMPDIR=str(folder), TEMP=str(folder), TMP=str(folder), HOME=str(folder))
        process = subprocess.Popen([sys.executable, str(PROCESSOR), mode, str(request), str(folder), str(toolchain), str(result)],
                                   stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                   env=environment, cwd=folder, start_new_session=os.name == "posix",
                                   creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
        output = [bytearray(), bytearray()]
        excessive = threading.Event()
        def collect(stream, number):
            while block := stream.read(2048):
                if len(output[number]) + len(block) > 8192:
                    excessive.set()
                    # Continue draining without retaining document/error data.
                else:
                    output[number].extend(block)
            stream.close()
        threads = [threading.Thread(target=collect, args=(stream, number), daemon=True)
                   for number, stream in enumerate((process.stdout, process.stderr))]
        for thread in threads:
            thread.start()
        try:
            process.wait(timeout=DEADLINE)
        except subprocess.TimeoutExpired:
            kill_tree(process)
            return 504, {"error": {"code": "native_pdf_timeout"}}
        finally:
            for thread in threads:
                thread.join(timeout=5)
        if excessive.is_set():
            return 503, {"error": {"code": "native_pdf_worker_failed"}}
        if process.returncode != 0:
            try:
                error = json.loads(output[0])["error"]["code"]
            except Exception:
                error = "native_pdf_worker_failed"
            error = error if error in ERROR_STATUS else "native_pdf_worker_failed"
            return ERROR_STATUS[error], {"error": {"code": error}}
        if not result.is_file() or not 0 < result.stat().st_size <= MAX_RESULT:
            return 503, {"error": {"code": "native_pdf_worker_failed"}}
        try:
            return 200, json.loads(result.read_bytes())
        except Exception:
            return 503, {"error": {"code": "native_pdf_worker_failed"}}


class Server(ThreadingHTTPServer):
    daemon_threads = True
    request_queue_size = 8

    def process_request(self, request, client_address):
        if not CONNECTIONS.acquire(blocking=False):
            request.close()
            return
        try:
            super().process_request(request, client_address)
        except Exception:
            CONNECTIONS.release()
            raise

    def process_request_thread(self, request, client_address):
        try:
            super().process_request_thread(request, client_address)
        finally:
            CONNECTIONS.release()

    def handle_error(self, request, client_address):
        # Do not print request payloads, paths, source text or authentication.
        pass


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.0"

    def setup(self):
        super().setup()
        self.connection.settimeout(10)

    def log_message(self, *_args):
        pass

    def send_json(self, status, payload):
        data = json.dumps(payload, ensure_ascii=True, separators=(",", ":")).encode()
        if len(data) > MAX_RESULT:
            status, data = 503, b'{"error":{"code":"native_pdf_worker_failed"}}'
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("Connection", "close")
        self.end_headers()
        self.wfile.write(data)
        self.close_connection = True

    def authorized(self):
        values = self.headers.get_all("Authorization", [])
        return len(values) == 1 and hmac.compare_digest(values[0].encode(), ("Bearer " + self.server.api_key).encode())

    def do_GET(self):
        if not self.authorized():
            return self.send_json(401, {"error": {"code": "unauthorized"}})
        if self.path != "/health":
            return self.send_json(404, {"error": {"code": "not_found"}})
        return self.send_json(200, {"status": "ok", "protocolVersion": 1})

    def do_POST(self):
        if not self.authorized():
            return self.send_json(401, {"error": {"code": "unauthorized"}})
        if self.path not in ("/prepare", "/repair"):
            return self.send_json(404, {"error": {"code": "not_found"}})
        lengths = self.headers.get_all("Content-Length", [])
        maximum = MAX_PDF if self.path == "/prepare" else MAX_BODY
        content_type = self.headers.get("Content-Type", "").split(";", 1)[0].strip().lower()
        expected_type = "application/pdf" if self.path == "/prepare" else "application/json"
        if (self.headers.get("Transfer-Encoding") is not None or len(lengths) != 1
                or not lengths[0].isascii() or not lengths[0].isdigit()
                or len(lengths[0]) > 10 or not 1 <= int(lengths[0]) <= maximum or content_type != expected_type):
            return self.send_json(400, {"error": {"code": "pdf_invalid"}})
        if not ACTIVE.acquire(blocking=False):
            return self.send_json(503, {"error": {"code": "native_pdf_busy"}})
        try:
            body = self.rfile.read(int(lengths[0]))
            if len(body) != int(lengths[0]):
                return self.send_json(400, {"error": {"code": "pdf_invalid"}})
            status, response = execute(self.path[1:], body, self.server.toolchain)
            return self.send_json(status, response)
        except (TimeoutError, OSError):
            return self.send_json(504, {"error": {"code": "native_pdf_timeout"}})
        except Exception:
            return self.send_json(503, {"error": {"code": "native_pdf_worker_failed"}})
        finally:
            ACTIVE.release()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--toolchain", type=Path, default=Path("/opt/native-pdf/toolchain.json"))
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8000)
    options = parser.parse_args()
    key = os.environ.get("NATIVE_PDF_API_KEY", "")
    if len(key) < 32 or not key.isascii() or any(char.isspace() for char in key) or not 1 <= options.port <= 65535 or not options.toolchain.is_file():
        raise SystemExit("Native PDF worker configuration is incomplete.")
    server = Server((options.host, options.port), Handler)
    server.api_key, server.toolchain = key, options.toolchain.resolve()
    server.serve_forever(poll_interval=0.5)


if __name__ == "__main__":
    main()
