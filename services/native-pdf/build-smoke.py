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
from pypdf.generic import (ArrayObject, BooleanObject, ByteStringObject, DecodedStreamObject,
                          DictionaryObject, NameObject, NumberObject, TextStringObject)

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


def synthetic_heading_pdf():
    writer = PdfWriter(clone_from=PdfReader(io.BytesIO(synthetic_pdf())))
    page = writer.pages[0]
    font = DictionaryObject({NameObject("/Type"): NameObject("/Font"),
        NameObject("/Subtype"): NameObject("/Type1"), NameObject("/BaseFont"): NameObject("/Helvetica-Bold"),
        NameObject("/Encoding"): NameObject("/WinAnsiEncoding")})
    page["/Resources"]["/Font"][NameObject("/F2")] = writer._add_object(font)
    content = DecodedStreamObject()
    content.set_data(b"BT 72 720 Td /P <</MCID 0>> BDC /F2 12 Tf (Native PDF build check. ) Tj "
                     b"/F1 12 Tf (Instructions stay in the original layout.) Tj EMC ET")
    page[NameObject("/Contents")] = writer._add_object(content)
    root = DictionaryObject({NameObject("/Type"): NameObject("/StructTreeRoot")})
    root_ref = writer._add_object(root)
    paragraph = DictionaryObject({NameObject("/Type"): NameObject("/StructElem"),
        NameObject("/S"): NameObject("/P"), NameObject("/P"): root_ref,
        NameObject("/Pg"): page.indirect_reference, NameObject("/K"): NumberObject(0)})
    paragraph_ref = writer._add_object(paragraph)
    root[NameObject("/K")] = ArrayObject([paragraph_ref])
    root[NameObject("/ParentTree")] = DictionaryObject({NameObject("/Nums"):
        ArrayObject([NumberObject(0), ArrayObject([paragraph_ref])])})
    page[NameObject("/StructParents")] = NumberObject(0)
    writer.root_object[NameObject("/StructTreeRoot")] = root_ref
    writer.root_object[NameObject("/MarkInfo")] = DictionaryObject({NameObject("/Marked"): BooleanObject(True)})
    result = io.BytesIO()
    writer.write(result)
    return result.getvalue()


def synthetic_hybrid_pdf():
    """A wholly synthetic tagged form, including synthetic Reader-rights data."""
    writer = PdfWriter(clone_from=PdfReader(io.BytesIO(synthetic_pdf())))
    page = writer.pages[0]
    content = page["/Contents"]
    content.set_data(b"/P <</MCID 0>> BDC\n" + content.get_data() + b"EMC\n")
    font = page["/Resources"]["/Font"]["/F1"]
    widget = DictionaryObject({NameObject("/Type"): NameObject("/Annot"), NameObject("/Subtype"): NameObject("/Widget"),
        NameObject("/FT"): NameObject("/Tx"), NameObject("/T"): TextStringObject("name[0]"),
        NameObject("/V"): TextStringObject(""), NameObject("/DA"): TextStringObject("/F1 12 Tf 0 g"),
        NameObject("/Rect"): ArrayObject([NumberObject(n) for n in (72, 610, 280, 632)]),
        NameObject("/P"): page.indirect_reference, NameObject("/StructParent"): NumberObject(1)})
    widget_ref = writer._add_object(widget)
    parent = DictionaryObject({NameObject("/T"): TextStringObject("workshop[0]"), NameObject("/Kids"): ArrayObject([widget_ref])})
    parent_ref = writer._add_object(parent)
    widget[NameObject("/Parent")] = parent_ref
    page[NameObject("/Annots")] = ArrayObject([widget_ref])
    packets = ArrayObject()
    for name, value in (
        ("config", '<config xmlns="http://www.xfa.org/schema/xci/3.0/"><acrobat><acrobat7><dynamicRender>forbidden</dynamicRender></acrobat7></acrobat></config>'),
        ("template", '<template xmlns="http://www.xfa.org/schema/xfa-template/3.6/"><subform name="workshop"><field name="name"><ui><textEdit/></ui><assist><speak disable="1">Fictional workshop name</speak></assist></field></subform></template>'),
        ("datasets", '<datasets xmlns="http://www.xfa.org/schema/xfa-data/1.0/"><data><workshop><name/></workshop></data></datasets>'),
    ):
        packet = DecodedStreamObject()
        packet.set_data(value.encode())
        packet[NameObject("/Type")] = NameObject("/EmbeddedFile")
        packets.extend([TextStringObject(name), writer._add_object(packet)])
    writer.root_object[NameObject("/AcroForm")] = DictionaryObject({NameObject("/Fields"): ArrayObject([parent_ref]),
        NameObject("/DA"): TextStringObject("/F1 12 Tf 0 g"), NameObject("/DR"): DictionaryObject({NameObject("/Font"): DictionaryObject({NameObject("/F1"): font})}),
        NameObject("/XFA"): packets, NameObject("/SigFlags"): NumberObject(2)})
    structure = DictionaryObject({NameObject("/Type"): NameObject("/StructTreeRoot")})
    structure_ref = writer._add_object(structure)
    document = DictionaryObject({NameObject("/Type"): NameObject("/StructElem"), NameObject("/S"): NameObject("/Document"), NameObject("/P"): structure_ref})
    document_ref = writer._add_object(document)
    paragraph = DictionaryObject({NameObject("/Type"): NameObject("/StructElem"), NameObject("/S"): NameObject("/P"),
        NameObject("/P"): document_ref, NameObject("/Pg"): page.indirect_reference, NameObject("/K"): NumberObject(0)})
    paragraph_ref = writer._add_object(paragraph)
    form_tag = DictionaryObject({NameObject("/Type"): NameObject("/StructElem"), NameObject("/S"): NameObject("/Form"),
        NameObject("/P"): document_ref, NameObject("/Pg"): page.indirect_reference,
        NameObject("/K"): DictionaryObject({NameObject("/Type"): NameObject("/OBJR"), NameObject("/Obj"): widget_ref, NameObject("/Pg"): page.indirect_reference})})
    form_ref = writer._add_object(form_tag)
    document[NameObject("/K")] = ArrayObject([paragraph_ref, form_ref])
    structure[NameObject("/K")] = document_ref
    structure[NameObject("/ParentTree")] = DictionaryObject({NameObject("/Nums"): ArrayObject([NumberObject(0), ArrayObject([paragraph_ref]), NumberObject(1), form_ref])})
    page[NameObject("/StructParents")] = NumberObject(0)
    writer.root_object[NameObject("/StructTreeRoot")] = structure_ref
    writer.root_object[NameObject("/MarkInfo")] = DictionaryObject({NameObject("/Marked"): BooleanObject(True)})
    writer.root_object[NameObject("/Lang")] = TextStringObject("en-US")
    reference = DictionaryObject({NameObject("/Type"): NameObject("/SigRef"), NameObject("/TransformMethod"): NameObject("/UR3"),
        NameObject("/Data"): writer.root_object.indirect_reference, NameObject("/TransformParams"): DictionaryObject({
            NameObject("/Type"): NameObject("/TransformParams"), NameObject("/V"): NameObject("/2.2"),
            NameObject("/Document"): ArrayObject([NameObject("/FullSave")])})})
    signature = DictionaryObject({NameObject("/Type"): NameObject("/Sig"), NameObject("/Filter"): NameObject("/Adobe.PPKLite"),
        NameObject("/SubFilter"): NameObject("/adbe.pkcs7.detached"), NameObject("/Contents"): ByteStringObject(b"\x9fsynthetic-build-usage-rights"),
        NameObject("/ByteRange"): ArrayObject([NumberObject(n) for n in (0, 10, 40, 10)]), NameObject("/Reference"): ArrayObject([writer._add_object(reference)])})
    writer.root_object[NameObject("/Perms")] = DictionaryObject({NameObject("/UR3"): writer._add_object(signature)})
    result = io.BytesIO()
    writer.write(result)
    return result.getvalue()


def require(condition, message):
    if not condition:
        raise RuntimeError(message)


def request(service, path, body=None, *, authorized=True, method="POST"):
    connection = http.client.HTTPConnection("127.0.0.1", service.server_port, timeout=100)
    headers = {"Content-Type": "application/json" if path.startswith("/repair") else "application/pdf"}
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
    service.storage_origin = "https://synthetic-build-test.supabase.co"
    thread = threading.Thread(target=service.serve_forever, daemon=True)
    thread.start()
    try:
        source = synthetic_pdf()
        require("/StructTreeRoot" not in PdfReader(io.BytesIO(source)).trailer["/Root"], "Smoke input must be untagged")
        require(request(service, "/health", authorized=False, method="GET")[0] == 401,
                "Unauthenticated health request was accepted")
        require(request(service, "/prepare", source, authorized=False)[0] == 401,
                "Unauthenticated document request was accepted")
        require(request(service, "/repair-stored", b"{}", authorized=False)[0] == 401,
                "Unauthenticated stored request was accepted")
        require(request(service, "/repair-stored", b"{}")[0] == 400,
                "Invalid stored reference was accepted")
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
        heading_source = synthetic_heading_pdf()
        status, heading_prepared = request(service, "/prepare", heading_source)
        require(status == 200, "Installed structure preparation failed")
        choices = heading_prepared["inventory"]["structureCandidates"]
        choice = next((item for item in choices if item["kind"] == "split_heading"), None)
        require(choice is not None, "Native heading boundary was not discovered")
        tag = next(item for item in heading_prepared["inventory"]["tags"] if item["id"] == choice["tagId"])
        heading_payload = {"sourcePdfBase64": base64.b64encode(heading_source).decode("ascii"),
            "candidatePdfBase64": heading_prepared["pdfBase64"],
            "plan": {"schemaVersion": 1, "candidateSha256": heading_prepared["candidateSha256"],
                "operations": [{"type": "repair_structure", "tagId": tag["id"], "expected": tag["snapshot"],
                    "candidateId": choice["candidateId"], "role": "H2"}]}}
        status, heading_repaired = request(service, "/repair", json.dumps(heading_payload).encode())
        require(status == 200, "Installed structure repair failed")
        assert_result(heading_repaired, heading_source)
        require(any(item["role"] == "H2" and item["text"].strip() == "Native PDF build check."
                    for item in heading_repaired["inventory"]["tags"]), "Saved heading split was missing")
        hybrid_source = synthetic_hybrid_pdf()
        status, hybrid_prepared = request(service, "/prepare", hybrid_source)
        require(status == 200, "Installed hybrid preparation failed: " + str(hybrid_prepared.get("error", {}).get("code", status)))
        assert_result(hybrid_prepared, hybrid_source)
        hybrid_info = hybrid_prepared["inventory"]["forms"]["hybrid"]
        require(hybrid_info["nativeFieldDescriptionsAdded"] == 1 and hybrid_info["readerUsageRightsRemoved"] is True,
                "Hybrid preparation did not apply its bounded changes")
        hybrid_payload = {"sourcePdfBase64": base64.b64encode(hybrid_source).decode("ascii"),
                          "candidatePdfBase64": hybrid_prepared["pdfBase64"],
                          "plan": {"schemaVersion": 1, "candidateSha256": hybrid_prepared["candidateSha256"], "operations": []}}
        status, hybrid_repaired = request(service, "/repair", json.dumps(hybrid_payload).encode())
        require(status == 200, "Installed hybrid repair failed: " + str(hybrid_repaired.get("error", {}).get("code", status)))
        assert_result(hybrid_repaired, hybrid_source)
        original_hybrid = PdfReader(io.BytesIO(hybrid_source))
        saved_hybrid = PdfReader(io.BytesIO(base64.b64decode(hybrid_repaired["pdfBase64"], validate=True)))
        from form_interaction_fingerprint import form_interaction_fingerprint
        interaction = form_interaction_fingerprint(saved_hybrid)
        require(interaction is not None and interaction["schemaVersion"] == 1
                and len(interaction["sha256"]) == 64, "Saved hybrid interaction fingerprint was unavailable")
        require(hybrid_prepared["inventory"]["forms"]["interactionFingerprint"] == interaction
                and hybrid_repaired["inventory"]["forms"]["interactionFingerprint"] == interaction,
                "Prepare/repair did not fingerprint their actual saved interaction state")
        require("interactionFingerprint" not in prepared["inventory"]["forms"],
                "Unsupported non-hybrid PDF received interaction evidence identity")
        require("/Perms" not in saved_hybrid.trailer["/Root"], "Obsolete Reader rights remained in repaired copy")
        require(saved_hybrid.get_fields()["workshop[0].name[0]"]["/TU"] == "Fictional workshop name", "Authored form label was not saved")
        require(hybrid_info["speechPromptsEnabled"] == ["workshop[0].name[0]"]
                and hybrid_info["verifiedMetadataOnly"] is True,
                "Supported form speech metadata was not repaired and verified")
        require(hybrid_repaired["inventory"]["forms"]["field_count"] == 1
                and hybrid_repaired["inventory"]["forms"]["fields"][0]["speech"]["disabled"] is False,
                "Current terminal field inventory did not include repaired speech")
        original_packets, saved_packets = (pdf.trailer["/Root"]["/AcroForm"]["/XFA"] for pdf in (original_hybrid, saved_hybrid))
        for index in range(1, len(original_packets), 2):
            expected = original_packets[index].get_object().get_data()
            if str(original_packets[index - 1]) == "template":
                expected = expected.replace(b'<speak disable="1">', b'<speak disable="0">')
            require(expected == saved_packets[index].get_object().get_data(),
                    "Hybrid XFA changed beyond the exact authorized speech attribute")
        # Counts, tool versions and success states are safe build diagnostics.
        print("Native PDF build smoke passed: authenticated HTTP, OpenDataLoader tagging, "
              "native repair, static hybrid form preservation, veraPDF validation, identical page pixels and preserved content.")
    finally:
        service.shutdown()
        service.server_close()
        thread.join(timeout=5)


if __name__ == "__main__":
    main()
