# Native PDF worker protocol, version 1

Preparation also fills missing annotation descriptions on eligible simple text
links using verified original tagged text, up to 200 per document. Additional
links remain unchanged for normal validation and review. Untagged sources are
ineligible for this repair. Existing description properties are
preserved, including empty values. Ambiguous ownership, unsupported structures,
text overrides or uninformative labels prevent this automatic repair. It adds
no model operation and changes no link action, destination or visible content.
Changes include a page and tag location; saved-output checks independently
verify the source-derived description. Discovery is capped at 200 paint checks
and one million scanned page operations, with parsed page streams reused.

The private service accepts `Authorization: Bearer NATIVE_PDF_API_KEY`. It has
no public route, storage credentials or model credentials.
`GET /health` requires authentication. `POST /prepare` takes `application/pdf`
bytes; `POST /repair` takes JSON. `POST /repair-stored` accepts the narrow signed
reference below for repair JSON above the platform request limit. All return
the same JSON shape:

```json
{
  "schemaVersion": 1,
  "sourceSha256": "64 lowercase hexadecimal characters",
  "candidateSha256": "64 lowercase hexadecimal characters",
  "pdfBase64": "saved, reopened native PDF",
  "pageCount": 1,
  "inventory": {
    "tagged": true, "language": "", "title": "",
    "tags": [{
      "id": "tag-1", "parentId": null, "children": [],
      "role": "P", "sourceRole": "P", "pageNumber": 1,
      "text": "Source text", "mcids": [0], "attributes": [],
      "content": [], "contentSequence": [],
      "editable": {"role": true, "alt": false, "tableHeader": false},
      "snapshot": {"role": "P", "pageNumber": 1, "text": "Source text", "mcids": [0], "alt": null}
    }],
    "page_content": [], "forms": {}, "findings": []
  },
  "findings": [{"code": "code", "severity": "warning", "message": "plain language", "pageNumber": 1, "tagId": "tag-1"}],
  "changes": [{"code": "code", "message": "plain language", "pageNumber": 1, "tagId": "tag-1"}],
  "machineChecks": {
    "preservationPassed": true, "inspectionComplete": true,
    "structurePassed": true, "pixelsIdentical": true,
    "targetStandard": "PDF/UA-1 (ISO 14289-1:2014)",
    "veraPdf": {"completed": true, "compliant": false, "failedRules": 1, "failedChecks": 1},
    "conformanceClaim": false
  }
}
```

`alt`, native language, native IDs, ordered content references and table
attributes are present when saved in the actual PDF. `pageNumber` may be null
on document/grouping tags. `page_content` contains every page's excluded text
and completeness flags. No tag/text inventory is silently truncated. The
auditor must cover every page/tag and assess excluded text. Forms remain
interactive and are inventoried; this version does not edit form behavior.

The repair request is exactly:

```json
{
  "sourcePdfBase64": "immutable original",
  "candidatePdfBase64": "prepare response PDF",
  "plan": {
    "schemaVersion": 1,
    "candidateSha256": "hash of candidatePdfBase64",
    "language": "en-US",
    "title": "A title grounded in the visible document",
    "operations": [
      {"type": "set_role", "tagId": "tag-1", "expected": {"role": "P", "pageNumber": 1, "text": "Source text", "mcids": [0], "alt": null}, "role": "H1"},
      {"type": "set_alt", "tagId": "tag-2", "expected": {"role": "Figure", "pageNumber": 1, "text": "", "mcids": [1], "alt": "image 1"}, "alt": "A meaningful source-grounded description"},
      {"type": "set_table_header", "tagId": "tag-4", "expected": {"role": "TD", "pageNumber": 1, "text": "Week", "mcids": [2], "alt": null}, "scope": "Column"}
    ]
  }
}
```

`language` and `title` are optional and apply only when the native document
value is missing. Operations require the exact supplied `snapshot`; at most
500 distinct target tags may change. Only targets marked `editable` may be
changed. Role changes permit `P`, `H`, `H1`-`H6`, `Caption`, and `Note` on
resolved text blocks, including source roles correctly mapped to those roles.
Inline `Span` and valid `Link` descendants may remain inside a block; nested
blocks, tables and figures are excluded. Every content and annotation reference
must resolve with verified ownership, on one physical page. A block permits
at most 128 nodes, 16 levels and 20,000 text characters. Only its role changes;
inline runs, links, ActualText, native attributes and painting remain intact.
Figure descriptions can fill missing descriptions or replace
an autotagger placeholder only when the original had no authored description
on that content. Existing authored descriptions and ActualText are preserved.
Simple table cells may gain `TH` plus `Scope` (`Column` or `Row`); merged or
complex cells are left for review. No arbitrary PDF/XML/paths are accepted.

For large repair bodies, the app uploads those exact JSON bytes to a tracked,
short-lived private storage object, then sends this exact envelope to
`POST /repair-stored` with `Content-Type: application/json`:

```json
{
  "requestUrl": "https://PROJECT.supabase.co/storage/v1/object/sign/documents/SESSION_UUID/DOCUMENT_UUID/JOB_UUID/native-pdf-request-REQUEST_UUID.json?token=SIGNED_JWT",
  "requestSha256": "64 lowercase hexadecimal characters",
  "requestBytes": 11138229
}
```

The envelope is limited to 16 KiB. The URL must exactly match the configured
`SUPABASE_URL` HTTPS origin and the UUID-based path shown above. Only the JWT
`token` query parameter is allowed. Ports, credentials, fragments, percent
escapes, whitespace, backslashes and redirects are rejected. A separate
transport subprocess fetches at most 12 MiB with verified TLS and no proxy or
application credentials, checks exact size and SHA256, and exits within 15
seconds. The supervisor checks the saved bytes again before passing only the
repair JSON to the PDF processor. Transport files are deleted in all outcomes;
the app deletes the remote object and tracks failed cleanup for its purge.

Bounds: 4 MiB PDF input and candidate, 60 pages, 5,000 tags, 500,000 text
characters, 12 MiB repair JSON, 16 KiB stored-reference HTTP body, 16 MiB
response, one active job per process, 90 seconds per worker request including
the signed-object download. Busy jobs fail immediately with HTTP 503.
All request-local files are deleted after success or failure, including Java
scratch files pinned by `-Djava.io.tmpdir`. An isolated
processor receives only fixed runtime paths, no application secrets. Process
timeouts and OS resource limits supplement the container's memory limits;
they do not constitute an OS sandbox. Existing tags are preserved; only
untagged PDFs go through OpenDataLoader. Every `page_content` row includes
`selectableTextPresent` and `requiresVisualTextReview`. The mandatory auditor
determines whether visible words need OCR or the page contains a graphic with
an adequate description. The absence of selectable text alone is evidence,
not an automatic defect or a mandatory faculty review item.

Native inspection must be complete before any candidate is returned. Known
machine defects are returned as findings; incomplete evidence is a controlled
failure. The worker does not run generic OCR, font substitution or form editing.

Failures return `{"error":{"code":"controlled_code"}}`, never native tool
stderr, source text or filesystem paths. HTTP 400 means unsupported input or
plan; 422 means unsafe preservation or incomplete evidence; 503 means capacity
or toolchain unavailable; 504 means the worker deadline expired.

veraPDF checks the **actual delivered file**, without adding a PDF/UA claim to
satisfy the checker. Its failures remain visible independently of the model
audit. Machine and semantic findings never become a certificate.
