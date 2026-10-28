import http.client
import json
import os
from pathlib import Path
import tempfile
import threading
import unittest
from unittest.mock import patch

import server
import stored_transport


class HttpBoundaryTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = server.Server(("127.0.0.1", 0), server.Handler)
        cls.server.api_key = "synthetic-test-key-" + "x" * 32
        cls.server.toolchain = Path("fixed-test-toolchain.json")
        cls.server.storage_origin = "https://example-project.supabase.co"
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()
        cls.thread.join(timeout=5)

    def request(self, path, body=None, headers=None, method="POST"):
        connection = http.client.HTTPConnection("127.0.0.1", self.server.server_port, timeout=5)
        self.addCleanup(connection.close)
        current = {"Authorization": "Bearer " + self.server.api_key, "Content-Type": "application/pdf"}
        if headers:
            current.update(headers)
        connection.request(method, path, body, current)
        response = connection.getresponse()
        return response.status, json.loads(response.read()), dict(response.getheaders())

    def test_health_requires_auth_and_never_reports_paths_or_credentials(self):
        status, body, headers = self.request("/health", method="GET")
        self.assertEqual(200, status)
        self.assertEqual({"status": "ok", "protocolVersion": 1}, body)
        self.assertEqual("no-store", headers["Cache-Control"])
        for key in ("Bearer bad-key", "Basic test"):
            self.assertEqual(401, self.request("/health", method="GET", headers={"Authorization": key})[0])

    def test_unauthorized_document_body_never_reaches_processor(self):
        with patch.object(server, "execute") as execute:
            status, _, _ = self.request("/prepare", b"private-data", {"Authorization": "Bearer incorrect"})
            self.assertEqual(401, status)
            execute.assert_not_called()

    def test_invalid_content_type_length_transfer_encoding_and_path_rejected(self):
        variants = [
            ("/prepare", {"Content-Type": "text/plain"}, 400),
            ("/prepare", {"Content-Length": str(server.MAX_PDF + 1)}, 400),
            ("/prepare", {"Content-Length": "-1"}, 400),
            ("/prepare", {"Transfer-Encoding": "chunked"}, 400),
            ("/prepare?download=http://example.org", {}, 404),
            ("/repair", {"Content-Type": "application/pdf"}, 400),
            ("/repair-stored", {"Content-Type": "application/json", "Content-Length": str(stored_transport.MAX_REFERENCE + 1)}, 400),
        ]
        with patch.object(server, "execute") as execute:
            for path, headers, expected in variants:
                with self.subTest(path=path, headers=headers):
                    self.assertEqual(expected, self.request(path, b"data", headers)[0])
            execute.assert_not_called()

    def test_request_passes_only_fixed_mode_body_and_server_toolchain(self):
        with patch.object(server, "execute", return_value=(200, {"ok": True})) as execute:
            status, body, _ = self.request("/prepare", b"%PDF-1.7 synthetic")
            self.assertEqual((200, {"ok": True}), (status, body))
            self.assertEqual(("prepare", b"%PDF-1.7 synthetic", self.server.toolchain), execute.call_args.args)
            self.assertGreater(execute.call_args.kwargs["timeout"], 0)
            self.assertLessEqual(execute.call_args.kwargs["timeout"], server.DEADLINE)

    def test_stored_repair_only_passes_verified_payload_to_pdf_child_with_remaining_deadline(self):
        reference, payload = b'{"signedReference":"synthetic"}', b'{"source":"synthetic verified request"}'
        with patch.object(server, "fetch_stored", return_value=payload) as fetch, patch.object(server, "execute", return_value=(200, {"ok": True})) as execute:
            status, body, _ = self.request("/repair-stored", reference, {"Content-Type": "application/json"})
        self.assertEqual((200, {"ok": True}), (status, body))
        self.assertEqual((reference, self.server.storage_origin), fetch.call_args.args)
        self.assertEqual(("repair", payload, self.server.toolchain), execute.call_args.args)
        self.assertGreater(execute.call_args.kwargs["timeout"], 0)
        self.assertLessEqual(execute.call_args.kwargs["timeout"], server.DEADLINE)

    def test_stored_reference_failure_never_starts_pdf_processing(self):
        with patch.object(server, "fetch_stored", side_effect=stored_transport.TransportError("native_pdf_invalid_plan")), patch.object(server, "execute") as execute:
            status, body, _ = self.request("/repair-stored", b'{}', {"Content-Type": "application/json"})
        self.assertEqual((400, {"error": {"code": "native_pdf_invalid_plan"}}), (status, body))
        execute.assert_not_called()

    def test_parallel_job_is_rejected_and_slot_released_after_error(self):
        server.ACTIVE.acquire()
        try:
            with patch.object(server, "execute") as execute:
                self.assertEqual(503, self.request("/prepare", b"%PDF-")[0])
                execute.assert_not_called()
        finally:
            server.ACTIVE.release()
        with patch.object(server, "execute", side_effect=ValueError("private document text")):
            status, body, _ = self.request("/prepare", b"%PDF-")
            self.assertEqual((503, {"error": {"code": "native_pdf_worker_failed"}}), (status, body))
        self.assertTrue(server.ACTIVE.acquire(blocking=False))
        server.ACTIVE.release()

    def test_duplicate_authorization_and_length_are_not_ambiguous(self):
        for header, values in (("Authorization", ["Bearer " + self.server.api_key, "Bearer " + self.server.api_key]), ("Content-Length", ["5", "5"])):
            connection = http.client.HTTPConnection("127.0.0.1", self.server.server_port, timeout=5)
            self.addCleanup(connection.close)
            connection.putrequest("POST", "/prepare")
            connection.putheader("Content-Type", "application/pdf")
            if header != "Authorization":
                connection.putheader("Authorization", "Bearer " + self.server.api_key)
            else:
                connection.putheader("Content-Length", "5")
            for value in values:
                connection.putheader(header, value)
            connection.endheaders(b"%PDF-")
            self.assertEqual(401 if header == "Authorization" else 400, connection.getresponse().status)


class ProcessorIsolationTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.folder = Path(temporary.name)
        self.helper = self.folder / "processor.py"

    def test_processor_does_not_receive_app_credentials_and_workspace_is_removed(self):
        self.helper.write_text('''import json,os,pathlib,sys
request=pathlib.Path(sys.argv[2]); folder=pathlib.Path(sys.argv[3]); result=pathlib.Path(sys.argv[5])
result.write_text(json.dumps({"workspace":str(folder),"sourceExists":request.is_file(),"secrets":[name for name in ("LITELLM_API_KEY","SUPABASE_SERVICE_ROLE_KEY","NATIVE_PDF_API_KEY","JAVA_TOOL_OPTIONS","PYTHONPATH","HTTPS_PROXY") if name in os.environ]}))
''')
        with patch.object(server, "PROCESSOR", self.helper), patch.dict(os.environ, {"LITELLM_API_KEY": "secret", "SUPABASE_SERVICE_ROLE_KEY": "secret", "NATIVE_PDF_API_KEY": "secret", "JAVA_TOOL_OPTIONS": "unsafe", "PYTHONPATH": "unsafe", "HTTPS_PROXY": "unsafe"}):
            status, result = server.execute("prepare", b"private data", self.folder / "tools.json")
        self.assertEqual(200, status)
        self.assertEqual([], result["secrets"])
        self.assertTrue(result["sourceExists"])
        self.assertFalse(Path(result["workspace"]).exists())

    def test_processor_error_is_controlled_and_stderr_never_returned(self):
        self.helper.write_text('import sys; print("private data",file=sys.stderr); print(\'{"error":{"code":"private document name"}}\');sys.exit(1)')
        with patch.object(server, "PROCESSOR", self.helper):
            self.assertEqual((503, {"error": {"code": "native_pdf_worker_failed"}}), server.execute("prepare", b"private", self.folder / "tools.json"))

    def test_oversize_child_logging_is_bounded_and_not_returned(self):
        self.helper.write_text('print("x"*100000)')
        with patch.object(server, "PROCESSOR", self.helper):
            self.assertEqual((503, {"error": {"code": "native_pdf_worker_failed"}}), server.execute("prepare", b"private", self.folder / "tools.json"))

    def test_timeout_stops_process_and_cleans_temporary_files(self):
        marker = self.folder / "workspace.txt"
        self.helper.write_text('import pathlib,sys,time; pathlib.Path(' + repr(str(marker)) + ').write_text(sys.argv[3]);time.sleep(5)')
        with patch.object(server, "PROCESSOR", self.helper), patch.object(server, "DEADLINE", 0.3):
            self.assertEqual((504, {"error": {"code": "native_pdf_timeout"}}), server.execute("prepare", b"private", self.folder / "tools.json"))
        self.assertFalse(Path(marker.read_text()).exists())


if __name__ == "__main__":
    unittest.main()
