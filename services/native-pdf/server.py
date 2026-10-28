"""Private, authenticated native-PDF HTTP supervisor; one isolated job at a time."""
from __future__ import annotations

import argparse
import hashlib
import hmac
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import math
import os
from pathlib import Path
import signal
import subprocess
import sys
import tempfile
import threading
import time

import stored_transport

MAX_PDF = 4 * 1024 * 1024
MAX_BODY = 12 * 1024 * 1024
MAX_RESULT = 16 * 1024 * 1024
DEADLINE = 90
POSIX_PROCESS_GROUPS = os.name == "posix"
PROCESSOR = Path(__file__).with_name("worker.py")
TRANSPORT = Path(__file__).with_name("stored_transport.py")
ACTIVE = threading.BoundedSemaphore(1)
CONNECTIONS = threading.BoundedSemaphore(8)
ERROR_STATUS = {"pdf_invalid": 400, "pdf_password": 400, "pdf_page_limit": 400,
                "pdf_complexity_limit": 400, "pdf_output_limit": 400,
                "native_pdf_unsupported": 400, "native_pdf_invalid_plan": 400,
                "native_pdf_preservation": 422, "native_pdf_worker_failed": 503,
                "native_pdf_timeout": 504, "native_pdf_busy": 503}
FAILURE_REASONS = frozenset(("timeout", "cpu_limit", "output_limit", "nonzero_exit", "missing_result", "invalid_result"))


def log_execution_failure(mode, error_code, elapsed_ms, process_exit_code, reason):
    """Log only bounded supervisor facts, never document/processor output."""
    safe_mode = mode if type(mode) is str and mode in ("prepare", "repair") else "unknown"
    safe_code = error_code if type(error_code) is str and error_code in ERROR_STATUS else "native_pdf_worker_failed"
    safe_reason = reason if type(reason) is str and reason in FAILURE_REASONS else "invalid_result"
    safe_elapsed = 0
    if type(elapsed_ms) is int or type(elapsed_ms) is float and math.isfinite(elapsed_ms):
        safe_elapsed = int(max(0, min(elapsed_ms, 86_400_000)))
    safe_exit = (process_exit_code if type(process_exit_code) is int
                 and -2_147_483_648 <= process_exit_code <= 4_294_967_295 else None)
    entry = {"event": "native_pdf_process_failure", "mode": safe_mode, "errorCode": safe_code,
             "elapsedMs": safe_elapsed, "processExitCode": safe_exit, "reason": safe_reason}
    if safe_exit is not None and safe_exit < 0:
        entry["signal"] = -safe_exit
    try:
        print(json.dumps(entry, ensure_ascii=True, separators=(",", ":"), allow_nan=False), file=sys.stderr, flush=True)
    except (OSError, ValueError):
        # Diagnostic availability must not change the controlled HTTP response.
        pass


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


def execute(mode, body, toolchain, *, timeout=None):
    started = time.monotonic()
    deadline = started + (DEADLINE if timeout is None else min(DEADLINE, max(0, timeout)))

    def failure(reason, process, code="native_pdf_worker_failed"):
        log_execution_failure(mode, code, (time.monotonic() - started) * 1000,
                              process.returncode, reason)
        return ERROR_STATUS[code], {"error": {"code": code}}

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
                                   env=environment, cwd=folder, start_new_session=POSIX_PROCESS_GROUPS,
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
        terminal_failure = None
        try:
            process.wait(timeout=max(0, deadline - time.monotonic()))
            cpu_signal = getattr(signal, "SIGXCPU", None)
            if cpu_signal is not None and process.returncode == -cpu_signal:
                terminal_failure = "cpu_limit"
        except subprocess.TimeoutExpired:
            terminal_failure = "timeout"
        finally:
            try:
                # On Linux, the request owns the new session/process group even
                # after its leader exits. Kill leftover native descendants on
                # success and failure before draining pipes or deleting files.
                # Windows taskkill cannot recover an already orphaned tree;
                # retain its existing timeout cleanup without that claim.
                # https://docs.python.org/3.12/library/subprocess.html#subprocess.Popen
                # https://docs.python.org/3.12/library/os.html#os.killpg
                if POSIX_PROCESS_GROUPS or terminal_failure is not None:
                    kill_tree(process)
            finally:
                for thread in threads:
                    thread.join(timeout=5)
        if terminal_failure is not None:
            return failure(terminal_failure, process, "native_pdf_timeout")
        if excessive.is_set():
            return failure("output_limit", process)
        if process.returncode != 0:
            try:
                error = json.loads(output[0])["error"]["code"]
            except Exception:
                error = "native_pdf_worker_failed"
            error = error if type(error) is str and error in ERROR_STATUS else "native_pdf_worker_failed"
            return failure("nonzero_exit", process, error)
        if not result.is_file():
            return failure("missing_result", process)
        result_size = result.stat().st_size
        if result_size > MAX_RESULT:
            return failure("output_limit", process)
        if result_size == 0:
            return failure("invalid_result", process)
        try:
            return 200, json.loads(result.read_bytes())
        except Exception:
            return failure("invalid_result", process)


def fetch_stored(body, origin, *, timeout=stored_transport.FETCH_DEADLINE, bucket="documents"):
    """Fetch separately so no signed URL reaches a PDF document processor."""
    stored_transport.validate_reference(body, origin, bucket)
    with tempfile.TemporaryDirectory(prefix="native-pdf-transport-") as temporary:
        folder = Path(temporary)
        request, result = folder / "reference.json", folder / "request.json"
        request.write_bytes(body)
        environment = child_environment()
        environment.update(TMPDIR=str(folder), TEMP=str(folder), TMP=str(folder), HOME=str(folder))
        process = subprocess.Popen([sys.executable, str(TRANSPORT), str(request), str(result), origin, bucket],
                                   stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                                   env=environment, cwd=folder, start_new_session=os.name == "posix",
                                   creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
        try:
            process.wait(timeout=max(0.01, min(stored_transport.FETCH_DEADLINE, timeout)))
        except subprocess.TimeoutExpired:
            kill_tree(process)
            raise stored_transport.TransportError("native_pdf_timeout") from None
        if process.returncode != 0:
            code = next((key for key, value in stored_transport.EXIT_CODES.items() if value == process.returncode), "native_pdf_worker_failed")
            raise stored_transport.TransportError(code)
        if not result.is_file() or not 0 < result.stat().st_size <= MAX_BODY:
            raise stored_transport.TransportError("pdf_complexity_limit")
        payload = result.read_bytes()
        # Independently verify the saved transport child's exact bytes.
        reference, _, _ = stored_transport.validate_reference(body, origin, bucket)
        if len(payload) != reference["requestBytes"] or hashlib.sha256(payload).hexdigest() != reference["requestSha256"]:
            raise stored_transport.TransportError()
        return payload


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

    @staticmethod
    def remaining_time(deadline):
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise TimeoutError
        return remaining

    def read_body(self, length, deadline):
        body = bytearray()
        while len(body) < length:
            self.connection.settimeout(min(10, self.remaining_time(deadline)))
            # read1 performs at most one underlying read, so trickling bytes
            # cannot reset the absolute request budget inside a buffered read.
            # https://docs.python.org/3.12/library/io.html#io.BufferedReader.read1
            block = self.rfile.read1(min(65536, length - len(body)))
            self.remaining_time(deadline)
            if not block:
                break
            body.extend(block)
        return bytes(body)

    def do_GET(self):
        if not self.authorized():
            return self.send_json(401, {"error": {"code": "unauthorized"}})
        if self.path != "/health":
            return self.send_json(404, {"error": {"code": "not_found"}})
        return self.send_json(200, {"status": "ok", "protocolVersion": 1})

    def do_POST(self):
        if not self.authorized():
            return self.send_json(401, {"error": {"code": "unauthorized"}})
        if self.path not in ("/prepare", "/repair", "/repair-stored"):
            return self.send_json(404, {"error": {"code": "not_found"}})
        lengths = self.headers.get_all("Content-Length", [])
        maximum = MAX_PDF if self.path == "/prepare" else stored_transport.MAX_REFERENCE if self.path == "/repair-stored" else MAX_BODY
        content_type = self.headers.get("Content-Type", "").split(";", 1)[0].strip().lower()
        expected_type = "application/pdf" if self.path == "/prepare" else "application/json"
        if (self.headers.get("Transfer-Encoding") is not None or len(lengths) != 1
                or not lengths[0].isascii() or not lengths[0].isdigit()
                or len(lengths[0]) > 10 or not 1 <= int(lengths[0]) <= maximum or content_type != expected_type):
            return self.send_json(400, {"error": {"code": "pdf_invalid"}})
        if not ACTIVE.acquire(blocking=False):
            return self.send_json(503, {"error": {"code": "native_pdf_busy"}})
        try:
            deadline = time.monotonic() + DEADLINE
            body = self.read_body(int(lengths[0]), deadline)
            if len(body) != int(lengths[0]):
                return self.send_json(400, {"error": {"code": "pdf_invalid"}})
            if self.path == "/repair-stored":
                body = fetch_stored(body, getattr(self.server, "storage_origin", ""), timeout=self.remaining_time(deadline),
                                    bucket=getattr(self.server, "storage_bucket", "documents"))
            mode = "prepare" if self.path == "/prepare" else "repair"
            status, response = execute(mode, body, self.server.toolchain, timeout=self.remaining_time(deadline))
            return self.send_json(status, response)
        except stored_transport.TransportError as error:
            return self.send_json(ERROR_STATUS[error.code], {"error": {"code": error.code}})
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
    server.storage_origin = os.environ.get("SUPABASE_URL", "").rstrip("/")
    server.storage_bucket = os.environ.get("SUPABASE_DOCUMENTS_BUCKET", "").strip() or "documents"
    server.serve_forever(poll_interval=0.5)


if __name__ == "__main__":
    main()
