"""Exercise the installed Linux tools and private HTTP boundary during a build.

The only document and authentication key are synthetic and ephemeral. No model,
application environment, storage, source fixtures or network downloads are used.
The HTTP supervisor launches the same bounded child processes as production.
"""
from __future__ import annotations

import argparse
import base64
import hashlib
import http.client
import io
import json
import os
from pathlib import Path
import secrets
import threading

from pypdf import PdfReader, PdfWriter
from pypdf.generic import DecodedStreamObject, DictionaryObject, NameObject

import server


def synthetic_pdf():
    writer = PdfWriter()
    page = writer.add_blank_page(612, 792)
    font = writer._add_object(DictionaryObject({
        NameObject("/Type"): NameObject("/Font"),
        NameObject("/Subtype"): NameObject("/Type1"),
        NameObject("/BaseFont"): NameObject("/Helvetica"),
        NameObject("/Encoding"): NameObject("/WinAnsiEncoding"),
    }))
    page[NameObject("/Resources")] = DictionaryObject({
        NameObject("/Font"): DictionaryObject({NameObject("/F1"): font}),
    })
    content = DecodedStreamObject()
    content.set_data(b"BT /F1 18 Tf 72 720 Td (Native PDF build check) Tj ET\n"
                     b"BT /F1 12 Tf 72 680 Td (This synthetic page tests preserved text and layout.) Tj ET\n")
    page[NameObject("/Contents")] = writer._add_object(content)
    result = io.BytesIO()
    writer.write(result)
    return result.getvalue()


def require(condition, message):
    if not condition:
        raise RuntimeError(message)


def request(service, path, body=None, *, authorized=True, method="POST"):
    connection = http.client.HTTPConnection("127.0.0.1", service.server_port, timeout=100)
    headers = {"Content-Type": "application/json" if path == "/repair" else "application/pdf"}
    if authorized:
        headers["Authorization"] = "Bearer " + service.api_key
    try:
        connection.request(method, path, body, headers)
        response = connection.getresponse()
        data = response.read(server.MAX_RESULT + 1)
        require(len(data) <= server.MAX_RESULT, "Smoke response exceeded its limit")
        require(response.getheader("Cache-Control") == "no-store", "Missing private response cache policy")
        return response.status, json.loads(data)
    finally:
        connection.close()


def assert_result(result, source):
    require(result["pageCount"] == 1, "Synthetic page count changed")
    require(result["sourceSha256"] == hashlib.sha256(source).hexdigest(), "Original identity changed")
    candidate = base64.b64decode(result["pdfBase64"], validate=True)
    require(result["candidateSha256"] == hashlib.sha256(candidate).hexdigest(), "Output identity mismatch")
    checks = result["machineChecks"]
    for key in ("preservationPassed", "inspectionComplete", "pixelsIdentical"):
        require(checks[key] is True, "Synthetic document failed " + key)
    require(checks["conformanceClaim"] is False, "Build test must not claim PDF/UA conformance")
    require(checks["veraPdf"]["completed"] is True, "Installed veraPDF did not complete")
    require(result["inventory"]["checks_complete"] is True, "Tag inspection was incomplete")
    require("Native PDF build check" in PdfReader(io.BytesIO(candidate)).pages[0].extract_text(),
            "Synthetic text was lost")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--toolchain", type=Path, default=Path("/opt/native-pdf/toolchain.json"))
    parser.add_argument("--require-linux", action="store_true")
    args = parser.parse_args()
    if args.require_linux:
        require(os.name == "posix" and os.getuid() != 0, "Build smoke must run as the Linux application user")
    service = server.Server(("127.0.0.1", 0), server.Handler)
    service.api_key = secrets.token_hex(32)
    service.toolchain = args.toolchain.resolve()
    thread = threading.Thread(target=service.serve_forever, daemon=True)
    thread.start()
    try:
        source = synthetic_pdf()
        require("/StructTreeRoot" not in PdfReader(io.BytesIO(source)).trailer["/Root"], "Smoke input must be untagged")
        require(request(service, "/health", authorized=False, method="GET")[0] == 401,
                "Unauthenticated health request was accepted")
        require(request(service, "/prepare", source, authorized=False)[0] == 401,
                "Unauthenticated document request was accepted")
        require(request(service, "/health", method="GET") == (200, {"status": "ok", "protocolVersion": 1}),
                "Authenticated service health failed")
        status, prepared = request(service, "/prepare", source)
        require(status == 200, "Installed prepare failed: " + str(prepared.get("error", {}).get("code", status)))
        assert_result(prepared, source)
        require(any(change["code"] == "native_tags_added" for change in prepared["changes"]),
                "Installed OpenDataLoader did not add tags")
        tags = [tag for tag in prepared["inventory"]["tags"] if tag["editable"]["role"]]
        require(bool(tags), "No ordinary text block was available for native repair")
        tag = tags[0]
        target_role = "P" if tag["role"] == "H1" else "H1"
        payload = {"sourcePdfBase64": base64.b64encode(source).decode("ascii"),
                   "candidatePdfBase64": prepared["pdfBase64"],
                   "plan": {"schemaVersion": 1, "candidateSha256": prepared["candidateSha256"],
                            "language": "en-US", "title": "Native PDF build check",
                            "operations": [{"type": "set_role", "tagId": tag["id"],
                                            "expected": tag["snapshot"], "role": target_role}]}}
        status, repaired = request(service, "/repair", json.dumps(payload).encode())
        require(status == 200, "Installed repair failed: " + str(repaired.get("error", {}).get("code", status)))
        assert_result(repaired, source)
        require(any(item["id"] == tag["id"] and item["role"] == target_role
                    for item in repaired["inventory"]["tags"]), "Requested native tag edit was not saved")
        require(any(change["code"] == "set_role" for change in repaired["changes"]), "Native edit was not recorded")
        # Counts, tool versions and success states are safe build diagnostics.
        print("Native PDF build smoke passed: authenticated HTTP, OpenDataLoader tagging, "
              "native repair, veraPDF validation, identical page pixels and preserved content.")
    finally:
        service.shutdown()
        service.server_close()
        thread.join(timeout=5)


if __name__ == "__main__":
    main()
