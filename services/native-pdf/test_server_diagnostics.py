"""Supervisor diagnostics retain causes without retaining document content."""
import contextlib
import io
import json
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

import server


SENTINEL = "private-document-api-key-and-signed-url-sentinel"
FAILURE = (503, {"error": {"code": "native_pdf_worker_failed"}})


class SupervisorDiagnosticsTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.folder = Path(temporary.name)
        self.helper = self.folder / "processor.py"

    def run_child(self, script, mode="prepare", **options):
        self.helper.write_text("import sys,json,pathlib\n" + script, encoding="utf-8")
        captured = io.StringIO()
        with patch.object(server, "PROCESSOR", self.helper), contextlib.redirect_stderr(captured):
            response = server.execute(mode, SENTINEL.encode(), self.folder / (SENTINEL + ".json"), **options)
        return response, captured.getvalue()

    def assert_diagnostic(self, log, reason, code="native_pdf_worker_failed", mode="prepare", exit_code=0):
        self.assertEqual(1, len(log.splitlines()))
        self.assertLess(len(log), 300)
        self.assertNotIn(SENTINEL, log)
        self.assertNotIn(str(self.folder), log)
        item = json.loads(log)
        expected_keys = {"event", "mode", "errorCode", "elapsedMs", "processExitCode", "reason"}
        if exit_code is not None and exit_code < 0:
            expected_keys.add("signal")
            self.assertEqual(-exit_code, item["signal"])
        self.assertEqual(expected_keys, set(item))
        self.assertEqual("native_pdf_process_failure", item["event"])
        self.assertEqual(mode, item["mode"])
        self.assertEqual(code, item["errorCode"])
        self.assertEqual(reason, item["reason"])
        self.assertEqual(exit_code, item["processExitCode"])
        self.assertIs(type(item["elapsedMs"]), int)
        self.assertGreaterEqual(item["elapsedMs"], 0)
        self.assertLessEqual(item["elapsedMs"], 86_400_000)
        return item

    def test_known_failure_logs_code_and_exit_without_child_details(self):
        code = "native_pdf_preservation"
        payload = {"error": {"code": code, "message": SENTINEL}, "source": SENTINEL}
        response, log = self.run_child(
            f"print({SENTINEL!r},file=sys.stderr)\nprint({json.dumps(payload)!r})\nsys.exit(7)", mode="repair")
        self.assertEqual((422, {"error": {"code": code}}), response)
        self.assert_diagnostic(log, "nonzero_exit", code, mode="repair", exit_code=7)

    def test_unknown_and_non_string_error_codes_never_escape(self):
        for value in (SENTINEL, [SENTINEL], {SENTINEL: True}, None):
            with self.subTest(value=value):
                payload = json.dumps({"error": {"code": value, "message": SENTINEL}})
                response, log = self.run_child(f"print({payload!r})\nprint({SENTINEL!r},file=sys.stderr)\nsys.exit(1)")
                self.assertEqual(FAILURE, response)
                self.assert_diagnostic(log, "nonzero_exit", exit_code=1)

    def test_missing_result_does_not_log_stdout_or_stderr(self):
        response, log = self.run_child(f"print({SENTINEL!r})\nprint({SENTINEL!r},file=sys.stderr)")
        self.assertEqual(FAILURE, response)
        self.assert_diagnostic(log, "missing_result")

    def test_invalid_and_empty_result_do_not_log_saved_data(self):
        for value in (SENTINEL, ""):
            with self.subTest(value=value):
                response, log = self.run_child(f"pathlib.Path(sys.argv[5]).write_text({value!r})")
                self.assertEqual(FAILURE, response)
                self.assert_diagnostic(log, "invalid_result")

    def test_oversized_saved_result_has_distinct_bounded_reason(self):
        with patch.object(server, "MAX_RESULT", 20):
            response, log = self.run_child(f"pathlib.Path(sys.argv[5]).write_text({SENTINEL!r})")
        self.assertEqual(FAILURE, response)
        self.assert_diagnostic(log, "output_limit")

    def test_oversized_stdout_and_stderr_are_never_logged(self):
        for stream in ("sys.stdout", "sys.stderr"):
            with self.subTest(stream=stream):
                response, log = self.run_child(f"print({SENTINEL!r}*1000,file={stream})")
                self.assertEqual(FAILURE, response)
                self.assert_diagnostic(log, "output_limit")

    def test_success_does_not_log_document_result_or_child_output(self):
        response, log = self.run_child(f"print({SENTINEL!r})\nprint({SENTINEL!r},file=sys.stderr)\npathlib.Path(sys.argv[5]).write_text('{{\"ok\":true}}')")
        self.assertEqual((200, {"ok": True}), response)
        self.assertEqual("", log)

    def test_negative_exit_preserves_signal_number_without_stream_text(self):
        class Process:
            returncode = -24
            stdout = io.BytesIO(SENTINEL.encode())
            stderr = io.BytesIO(SENTINEL.encode())

            def wait(self, timeout=None):
                return self.returncode

        captured = io.StringIO()
        with patch.object(server.subprocess, "Popen", return_value=Process()), contextlib.redirect_stderr(captured):
            response = server.execute("repair", SENTINEL.encode(), self.folder / "tools.json")
        self.assertEqual(FAILURE, response)
        self.assert_diagnostic(captured.getvalue(), "nonzero_exit", mode="repair", exit_code=-24)

    def test_timeout_reports_killed_process_without_exception_message(self):
        class Process:
            returncode = None
            stdout = io.BytesIO(SENTINEL.encode())
            stderr = io.BytesIO(SENTINEL.encode())

            def wait(self, timeout=None):
                raise subprocess.TimeoutExpired(SENTINEL, timeout, output=SENTINEL, stderr=SENTINEL)

        process = Process()

        def kill(child):
            child.returncode = -9

        captured = io.StringIO()
        with patch.object(server.subprocess, "Popen", return_value=process), patch.object(server, "kill_tree", side_effect=kill) as killed, contextlib.redirect_stderr(captured):
            response = server.execute("prepare", SENTINEL.encode(), self.folder / "tools.json")
        self.assertEqual((504, {"error": {"code": "native_pdf_timeout"}}), response)
        killed.assert_called_once_with(process)
        self.assert_diagnostic(captured.getvalue(), "timeout", "native_pdf_timeout", exit_code=-9)

    def test_emitter_bounds_values_and_never_serializes_unknown_objects(self):
        class Unsafe:
            def __str__(self):
                raise AssertionError("Object must not be stringified")

        for elapsed in (float("nan"), float("inf"), -1, 10 ** 1000, Unsafe()):
            captured = io.StringIO()
            with contextlib.redirect_stderr(captured):
                server.log_execution_failure(Unsafe(), [SENTINEL], elapsed, Unsafe(), {SENTINEL: True})
            self.assert_diagnostic(captured.getvalue(), "invalid_result", mode="unknown", exit_code=None)

    def test_closed_log_stream_cannot_change_public_failure_response(self):
        captured = io.StringIO()
        captured.close()
        self.helper.write_text("import sys;sys.exit(1)", encoding="utf-8")
        with patch.object(server, "PROCESSOR", self.helper), contextlib.redirect_stderr(captured):
            response = server.execute("prepare", SENTINEL.encode(), self.folder / "tools.json")
        self.assertEqual(FAILURE, response)


if __name__ == "__main__":
    unittest.main()
