from email.message import Message
import hashlib
import io
import json
import os
from pathlib import Path
import ssl
import tempfile
import unittest
from unittest.mock import patch

import server
import stored_transport as transport

ORIGIN = "https://example-project.supabase.co"
IDENTITY = "11111111-2222-4333-8444-555555555555"
URL = ORIGIN + "/storage/v1/object/sign/documents/" + "/".join([IDENTITY] * 3) + "/native-pdf-request-" + IDENTITY + ".json?token=eyJtest.eyJpayload.signature"


def reference(payload=b"private synthetic repair", **overrides):
    value = {"requestUrl": URL, "requestSha256": hashlib.sha256(payload).hexdigest(), "requestBytes": len(payload)}
    value.update(overrides)
    return json.dumps(value).encode()


class Response:
    def __init__(self, payload, status=200, headers=()):
        self.status = status
        self.headers = Message()
        for name, value in headers:
            self.headers[name] = value
        self.stream = io.BytesIO(payload)
        self.total_read = 0

    def getheader(self, name, default=None):
        return self.headers.get(name, default)

    def read(self, maximum):
        value = self.stream.read(maximum)
        self.total_read += len(value)
        return value


class Connection:
    def __init__(self, response):
        self.response = response
        self.calls = []
        self.closed = False

    def request(self, *args, **kwargs):
        self.calls.append((args, kwargs))

    def getresponse(self):
        return self.response

    def close(self):
        self.closed = True


class StoredTransportTests(unittest.TestCase):
    def test_only_exact_private_signed_path_and_schema_are_accepted(self):
        value, host, target = transport.validate_reference(reference(), ORIGIN)
        self.assertEqual("example-project.supabase.co", host)
        self.assertEqual(URL[len(ORIGIN):], target)
        self.assertEqual(len(b"private synthetic repair"), value["requestBytes"])
        rejected = [
            URL.replace(ORIGIN, "http://example-project.supabase.co"),
            URL.replace(ORIGIN, "https://evil.example"),
            URL.replace(ORIGIN, ORIGIN + ".evil.example"),
            URL.replace(ORIGIN, "https://user@example-project.supabase.co"),
            URL.replace(ORIGIN, ORIGIN + ":443"),
            URL.replace("/sign/", "/public/"),
            URL.replace("/documents/", "/other/"),
            URL.replace("native-pdf-request-", "review-"),
            URL.replace("/documents/", "/documents/../documents/"),
            URL.replace("/documents/", "/documents%2f"),
            URL.replace("/documents/", "/documents\\"),
            URL + "#fragment", URL + "&download=1", URL + "&token=another.value.sig",
            URL.replace("?token=", "?access_token="), URL + "=", URL + "\n", URL.replace("signature", "sign ature"),
        ]
        for url in rejected:
            with self.subTest(url=url), self.assertRaises(transport.TransportError), patch.object(transport.http.client, "HTTPSConnection") as connection:
                transport.fetch_request(reference(requestUrl=url), ORIGIN)
            connection.assert_not_called()
        for changes in ({"requestBytes": True}, {"requestBytes": 0}, {"requestBytes": transport.MAX_REQUEST + 1},
                        {"requestSha256": "Z" * 64}, {"extra": "ignored?"}):
            with self.subTest(changes=changes), self.assertRaises(transport.TransportError):
                transport.validate_reference(reference(**changes), ORIGIN)
        duplicated = reference().replace(b'{', b'{"requestBytes":9,', 1)
        with self.assertRaises(transport.TransportError):
            transport.validate_reference(duplicated, ORIGIN)
        with self.assertRaises(transport.TransportError):
            transport.validate_reference(b" " * (transport.MAX_REFERENCE + 1), ORIGIN)

    def test_configuration_cannot_contain_path_port_credentials_or_query(self):
        for origin in ("", "http://example.supabase.co", ORIGIN + "/", ORIGIN + ":443", ORIGIN + "?token=private",
                       "https://secret@example.supabase.co", "https://localhost", ORIGIN + "/path"):
            with self.subTest(origin=origin), self.assertRaises(transport.TransportError):
                transport.validate_reference(reference(), origin)

    def test_download_uses_verified_tls_without_proxy_or_credential_headers(self):
        payload = b'{"synthetic":true}'
        response = Response(payload, headers=[("Content-Length", str(len(payload)))])
        connection = Connection(response)
        with patch.dict(os.environ, {"HTTPS_PROXY": "http://proxy.invalid", "SUPABASE_SERVICE_ROLE_KEY": "private"}), patch.object(transport.http.client, "HTTPSConnection", return_value=connection) as create:
            self.assertEqual(payload, transport.fetch_request(reference(payload), ORIGIN))
        self.assertEqual(("example-project.supabase.co",), create.call_args.args)
        context = create.call_args.kwargs["context"]
        self.assertTrue(context.check_hostname)
        self.assertEqual(ssl.CERT_REQUIRED, context.verify_mode)
        self.assertEqual(1, len(connection.calls))
        self.assertEqual({"Accept": "application/json", "Accept-Encoding": "identity"}, connection.calls[0][1]["headers"])
        self.assertTrue(connection.closed)

    def test_redirects_and_remote_error_responses_are_never_followed(self):
        for status in (301, 302, 307, 308, 403, 404, 500):
            connection = Connection(Response(b"untrusted remote error", status, [("Location", "https://evil.example")]))
            with self.subTest(status=status), patch.object(transport.http.client, "HTTPSConnection", return_value=connection) as create, self.assertRaises(transport.TransportError):
                transport.fetch_request(reference(), ORIGIN)
            self.assertEqual(1, create.call_count)
            self.assertEqual(0, connection.response.total_read)
            self.assertTrue(connection.closed)

    def test_length_encoding_and_duplicate_headers_are_rejected_before_body(self):
        for headers in ([('Content-Length', '999999999999')], [('Content-Length', '3')],
                        [('Content-Length', '24'), ('Content-Length', '24')], [('Content-Encoding', 'gzip')]):
            connection = Connection(Response(b"private synthetic repair", headers=headers))
            with self.subTest(headers=headers), patch.object(transport.http.client, "HTTPSConnection", return_value=connection), self.assertRaises(transport.TransportError):
                transport.fetch_request(reference(), ORIGIN)
            self.assertEqual(0, connection.response.total_read)

    def test_actual_stream_limit_is_enforced_without_a_content_length(self):
        connection = Connection(Response(b"x" * 100_000))
        with patch.object(transport, "MAX_REQUEST", 32), patch.object(transport.http.client, "HTTPSConnection", return_value=connection), self.assertRaises(transport.TransportError) as result:
            transport.fetch_request(reference(b"x" * 32), ORIGIN)
        self.assertEqual("pdf_complexity_limit", result.exception.code)
        self.assertEqual(33, connection.response.total_read)
        self.assertTrue(connection.closed)

    def test_hash_and_exact_size_mismatch_fail_closed(self):
        for payload in (b"different same length!!!!", b"short"):
            connection = Connection(Response(payload))
            with self.subTest(payload=payload), patch.object(transport.http.client, "HTTPSConnection", return_value=connection), self.assertRaises(transport.TransportError):
                transport.fetch_request(reference(), ORIGIN)
            self.assertTrue(connection.closed)

    def test_elapsed_deadline_and_socket_timeout_are_controlled(self):
        connection = Connection(Response(b"private synthetic repair"))
        with patch.object(transport.time, "monotonic", side_effect=[0, 16]), patch.object(transport.http.client, "HTTPSConnection", return_value=connection), self.assertRaises(transport.TransportError) as result:
            transport.fetch_request(reference(), ORIGIN)
        self.assertEqual("native_pdf_timeout", result.exception.code)
        self.assertTrue(connection.closed)
        with patch.object(connection, "request", side_effect=TimeoutError("signed URL secret")), patch.object(transport.http.client, "HTTPSConnection", return_value=connection), self.assertRaises(transport.TransportError) as result:
            transport.fetch_request(reference(), ORIGIN)
        self.assertEqual("native_pdf_timeout", str(result.exception))


class StoredTransportProcessTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.folder = Path(temporary.name)
        self.helper = self.folder / "download.py"
        self.marker = self.folder / "evidence.json"

    def test_download_child_has_no_application_secrets_and_temp_files_are_removed(self):
        payload = b"private synthetic repair"
        self.helper.write_text('''import json,os,pathlib,sys
folder=pathlib.Path(sys.argv[1]).parent
pathlib.Path(sys.argv[2]).write_bytes(b"private synthetic repair")
pathlib.Path(''' + repr(str(self.marker)) + ''').write_text(json.dumps({"folder":str(folder),"secrets":[name for name in ("LITELLM_API_KEY","SUPABASE_SERVICE_ROLE_KEY","SUPABASE_URL","NATIVE_PDF_API_KEY","JAVA_TOOL_OPTIONS","PYTHONPATH","HTTPS_PROXY","SSL_CERT_FILE") if name in os.environ]}))
''')
        credentials = {name: "private" for name in ("LITELLM_API_KEY", "SUPABASE_SERVICE_ROLE_KEY", "SUPABASE_URL", "NATIVE_PDF_API_KEY", "JAVA_TOOL_OPTIONS", "PYTHONPATH", "HTTPS_PROXY", "SSL_CERT_FILE")}
        with patch.object(server, "TRANSPORT", self.helper), patch.dict(os.environ, credentials):
            self.assertEqual(payload, server.fetch_stored(reference(payload), ORIGIN))
        evidence = json.loads(self.marker.read_text())
        self.assertEqual([], evidence["secrets"])
        self.assertFalse(Path(evidence["folder"]).exists())

    def test_stalled_download_is_killed_and_temp_directory_removed(self):
        self.helper.write_text('import pathlib,sys,time; pathlib.Path(' + repr(str(self.marker)) + ').write_text(str(pathlib.Path(sys.argv[1]).parent)); time.sleep(5)')
        with patch.object(server, "TRANSPORT", self.helper), self.assertRaises(transport.TransportError) as result:
            server.fetch_stored(reference(), ORIGIN, timeout=0.3)
        self.assertEqual("native_pdf_timeout", result.exception.code)
        self.assertFalse(Path(self.marker.read_text()).exists())

    def test_saved_child_bytes_are_checked_again_before_pdf_processing(self):
        self.helper.write_text('import pathlib,sys; pathlib.Path(sys.argv[2]).write_bytes(b"unexpected")')
        with patch.object(server, "TRANSPORT", self.helper), self.assertRaises(transport.TransportError):
            server.fetch_stored(reference(), ORIGIN)


if __name__ == "__main__":
    unittest.main()
