"""Each PDF request owns one time budget and its native child processes."""
import contextlib
from email.message import Message
import io
import os
from pathlib import Path
import signal
import sys
import tempfile
import threading
import time
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

import server


class RequestDeadlineTests(unittest.TestCase):
    def setUp(self):
        # Keep the fake clock's absolute-deadline scenarios independent of the
        # production budget while preserving their exact expiration boundaries.
        deadline = patch.object(server, 'DEADLINE', 90)
        deadline.start()
        self.addCleanup(deadline.stop)

    def request(self, path, *, chunks=(b"body",), seconds_per_read=30, fetch_seconds=0, length=None):
        clock = [100.0]
        pending = list(chunks)

        def read_chunk(size):
            clock[0] += seconds_per_read
            return pending.pop(0) if pending else b""

        def read_all(size):
            result = b""
            while pending and len(result) < size:
                result += read_chunk(size - len(result))
            return result

        def fetch_payload(*args, **kwargs):
            clock[0] += fetch_seconds
            return b"verified"

        handler = object.__new__(server.Handler)
        handler.path = path
        handler.headers = Message()
        handler.headers["Content-Type"] = "application/pdf" if path == "/prepare" else "application/json"
        handler.headers["Content-Length"] = str(length if length is not None else sum(map(len, chunks)))
        handler.authorized = lambda: True
        handler.rfile = SimpleNamespace(read=read_all, read1=read_chunk)
        handler.connection = SimpleNamespace(settimeout=Mock())
        handler.server = SimpleNamespace(toolchain="fixed-tools", storage_origin="https://example.test")
        handler.send_json = Mock()
        active = threading.BoundedSemaphore(1)
        with (patch.object(server.time, "monotonic", side_effect=lambda: clock[0]),
              patch.object(server, "ACTIVE", active),
              patch.object(server, "fetch_stored", side_effect=fetch_payload) as fetch,
              patch.object(server, "execute", return_value=(200, {"ok": True})) as execute):
            handler.do_POST()
        self.assertTrue(active.acquire(blocking=False), "Every terminal outcome must release the request slot")
        return handler, fetch, execute

    def test_all_routes_share_body_read_and_processor_budget(self):
        for path in ("/prepare", "/repair", "/repair-stored"):
            with self.subTest(path=path):
                handler, fetch, execute = self.request(path)
                self.assertEqual(60, execute.call_args.kwargs.get("timeout"))
                self.assertEqual("prepare" if path == "/prepare" else "repair", execute.call_args.args[0])
                if path == "/repair-stored":
                    self.assertEqual(60, fetch.call_args.kwargs["timeout"])
                else:
                    fetch.assert_not_called()
                handler.send_json.assert_called_once_with(200, {"ok": True})

    def test_expired_intake_never_starts_fetch_or_pdf_processor(self):
        for path in ("/prepare", "/repair", "/repair-stored"):
            for elapsed in (90, 91):
                with self.subTest(path=path, elapsed=elapsed):
                    handler, fetch, execute = self.request(path, seconds_per_read=elapsed)
                    fetch.assert_not_called()
                    execute.assert_not_called()
                    handler.send_json.assert_called_once_with(504, {"error": {"code": "native_pdf_timeout"}})

    def test_stored_download_reduces_processor_budget_and_cannot_restart_it(self):
        for elapsed in (20, 60):
            with self.subTest(elapsed=elapsed):
                handler, fetch, execute = self.request("/repair-stored", fetch_seconds=elapsed)
                self.assertEqual(60, fetch.call_args.kwargs["timeout"])
                if elapsed == 20:
                    self.assertEqual(40, execute.call_args.kwargs["timeout"])
                else:
                    execute.assert_not_called()
                    handler.send_json.assert_called_once_with(504, {"error": {"code": "native_pdf_timeout"}})

    def test_trickling_body_cannot_reset_the_absolute_deadline(self):
        handler, fetch, execute = self.request("/prepare", chunks=(b"a", b"b", b"c", b"d"), seconds_per_read=31)
        fetch.assert_not_called()
        execute.assert_not_called()
        self.assertEqual([10, 10, 10], [call.args[0] for call in handler.connection.settimeout.call_args_list])
        handler.send_json.assert_called_once_with(504, {"error": {"code": "native_pdf_timeout"}})

    def test_socket_inactivity_timeout_cannot_exceed_the_remaining_budget(self):
        handler, _, execute = self.request("/prepare", chunks=(b"a", b"b", b"c"), seconds_per_read=44)
        execute.assert_not_called()
        self.assertEqual([10, 10, 2], [call.args[0] for call in handler.connection.settimeout.call_args_list])
        handler.send_json.assert_called_once_with(504, {"error": {"code": "native_pdf_timeout"}})

    def test_truncated_body_is_invalid_and_does_not_start_processing(self):
        handler, fetch, execute = self.request("/repair", chunks=(b"short",), seconds_per_read=1, length=10)
        fetch.assert_not_called()
        execute.assert_not_called()
        handler.send_json.assert_called_once_with(400, {"error": {"code": "pdf_invalid"}})


class ProcessorLifecycleTests(unittest.TestCase):
    def test_posix_cleanup_runs_before_result_read_for_every_terminal_exit(self):
        for exit_code in (0, 7, -9):
            with self.subTest(exit_code=exit_code), tempfile.TemporaryDirectory() as temporary:
                process = SimpleNamespace(returncode=exit_code, stdout=io.BytesIO(), stderr=io.BytesIO(), wait=Mock())
                with (patch.object(server.subprocess, "Popen", return_value=process),
                      patch.object(server, "POSIX_PROCESS_GROUPS", True, create=True),
                      patch.object(server, "kill_tree") as cleanup,
                      contextlib.redirect_stderr(io.StringIO())):
                    def check_cleanup_before_result_read(path):
                        cleanup.assert_called_once_with(process)
                        return False

                    with patch.object(Path, "is_file", autospec=True, side_effect=check_cleanup_before_result_read):
                        server.execute("prepare", b"synthetic", Path(temporary) / "tools.json")
                cleanup.assert_called_once_with(process)

    @unittest.skipUnless(sys.platform.startswith("linux"), "Linux production process-group containment")
    def test_exited_processor_cannot_leave_a_live_native_descendant(self):
        # The helper uses only synthetic files. Its child deliberately inherits
        # output pipes, modeling a native parser that outlives a crashed worker.
        for exit_code in (0, 7):
            with self.subTest(exit_code=exit_code), tempfile.TemporaryDirectory() as temporary:
                folder = Path(temporary)
                pid_file = folder / "descendant.pid"
                helper = folder / "processor.py"
                helper.write_text(
                    "import os,pathlib,subprocess,sys,time\n"
                    "child = subprocess.Popen([sys.executable, '-c', 'import time;time.sleep(30)'])\n"
                    f"pathlib.Path({str(pid_file)!r}).write_text(str(child.pid))\n"
                    "pathlib.Path(sys.argv[5]).write_text('{\"ok\":true}')\n"
                    f"os._exit({exit_code})\n", encoding="utf-8")
                descendant = None
                try:
                    with patch.object(server, "PROCESSOR", helper), contextlib.redirect_stderr(io.StringIO()):
                        result = server.execute("prepare", b"synthetic", folder / "tools.json", timeout=5)
                    descendant = int(pid_file.read_text())
                    # An orphan can briefly remain a zombie until init reaps it;
                    # neither an absent process nor a zombie can keep working.
                    state_path = Path(f"/proc/{descendant}/stat")
                    deadline = time.monotonic() + 2
                    while state_path.exists() and state_path.read_text().split(") ", 1)[1][0] != "Z":
                        if time.monotonic() >= deadline:
                            self.fail("Native descendant survived the completed PDF request")
                        time.sleep(0.01)
                    self.assertEqual(200 if exit_code == 0 else 503, result[0])
                finally:
                    if descendant is None and pid_file.exists():
                        descendant = int(pid_file.read_text())
                    if descendant is not None:
                        try:
                            os.kill(descendant, signal.SIGKILL)
                        except ProcessLookupError:
                            pass


if __name__ == "__main__":
    unittest.main()
