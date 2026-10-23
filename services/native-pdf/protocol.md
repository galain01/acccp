# Native PDF worker protocol, version 1

Catalog `/OpenAction` may be an explicit local page destination or a GoTo
action containing only `/Type` (optional `/Action`), `/S` and `/D`. Named GoTo
destinations must resolve unambiguously. The page, view mode and coordinates
must be valid. Chained, external and executable opening actions remain
unsupported. Saved catalog behavior is independently compared with the source.

`machineChecks.pixelsIdentical` is an honest boolean. When false, a successful
response must include `renderingEquivalence` with method
`identical-paint-multiscale-v1` and one to eight unique physical-page records:
`{pageNumber, changedPixels, totalPixels, verificationScales: [1, 2]}`.
Every record requires identical text, normalized drawing instructions,
resources and behavior, at most 128 changed pixels and 0.01% changed pixels at
scale 1.5, and exact pixel equality at both scales 1 and 2. Existing per-page
render limits apply at every scale. This evidence is produced by the worker,
never accepted from model proposals. Pixel-identical responses omit it.
Other preservation failures and incomplete checks still reject the output.

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
interactive and are inventoried; this version preserves their values,
validation flags and action logic.

Preparation also accepts a bounded subset of static hybrid XFA/AcroForm forms.
The original must have a complete, unambiguous indexed mapping of its named XFA
fields to supported native text and checkbox controls. Dynamic layouts,
external resources and unknown active features are rejected. Only recognized
Adobe viewer bootstrap programs in their expected document-script positions
and recognized XFA checkbox handlers are accepted; the worker preserves their
bytes and never executes them.

For this subset, preparation may remove a verified `UR3` Reader usage-rights
signature from a permissions dictionary containing no other permissions.
It never removes a user signature. It may also copy an existing authored XFA
description into a missing native field `TU`. Supported segmented entries may
gain a source-proven group name in both native and XFA descriptions; other
authored labels remain unchanged. Supported existing direct field speech
prompts may be enabled. These exact accessibility-metadata changes are derived
from the source, not supplied as model operations. XFA data, scripts, bindings,
signature flags, field values, validation flags, widgets and appearances remain
intact. An independent source-bound comparison permits only those exact changes before
the standard preservation checks. `sourceSha256` continues to identify the
immutable uploaded PDF, and the preparation changes appear in `changes`.
`inventory.forms.hybrid` identifies this path as `static-xfa-with-acroform`
and reports preserved form logic, native label additions, verified accessible
name/speech changes, Reader-rights removal and the need for interactive viewer
review. This evidence reaches both model stages alongside the current field
labels and speech settings. A metadata repair must not be represented as
byte-for-byte preservation of the changed XFA template.

`inventory.forms.fields` contains terminal controls only. Each row retains
`name`, `type`, `label`, `required` and `value`, and provides a stable `fieldId`,
sorted `pageNumbers` and `widgets` with `widgetId`, `pageNumber` and `rect`.
Its `speech` object contains `supported`, `text`, `disabled`, `priority` and
`source:"xfa-assist"`. Unsupported or non-XFA speech uses null settings, rather
than falsely indicating enabled speech. Preparation verification includes
`accessibleNameChanges` (`fieldName`, `oldText`, `newText`),
`speechPromptsEnabled`; the auditor compares these records with the current
`fields[].speech` metadata rather than treating a change count as proof of use.

For supported static hybrid forms with complete annotation ownership, both
saved prepare and repair outputs also include
`inventory.forms.interactionFingerprint: {schemaVersion: 1, sha256: "64 lowercase hex"}`.
The worker computes this from the reopened saved file. It binds the complete
native form/XFA graph (including scripts, values, speech and appearances), field
and widget ownership, ordered annotations, tab settings, form tag order and
effective language, and other page/catalog behavior settings. PDF object numbers,
document title/XMP and unrelated heading/list tags are excluded. Unknown behavior
keys are retained; ambiguous, unsupported or over-limit inspection omits the
fingerprint and leaves ordinary interaction review in place. A fingerprint is
an identity for separately recorded tests, not evidence of a test or conformance.
Requests, model output and embedded PDF metadata cannot supply this field.

Preserved form structure and added native labels do not prove Acrobat's XFA
field announcements or checkbox behavior. Unsupported or unresolved speech
settings and specific unverified interaction requirements remain review items.
Do not repeat a repaired short-label or disabled-speech finding. Actual
validator failures and remaining interaction warnings cannot be dismissed by
the semantic auditor. Required flags stay unchanged: a clear source requirement
in the accessible label is distinct from adding validation. Missing signature,
date or cross-out widgets alone do not prove that no accessible viewer workflow
exists, and no model operation creates those controls.

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

`inventory.structureCandidates` lists bounded, source-derived proposals with
`candidateId`, `kind`, `tagId`, `pageNumber`, `text`, `preview`, and
`relatedTagIds`. The candidate identifier binds the exact prepared PDF and its
verified structure/painting boundaries. A planner may select
`{type:"repair_structure", tagId, expected, candidateId}`; only a
`split_heading` candidate also accepts `role:"H2"` through `"H6"`. A
`describe_chart` candidate requires `alt` (1–8000 characters) and forbids `role`.
Other candidate kinds are `convert_list`, `join_list_continuation`,
`mark_note_reference`, `rebuild_table`, `move_callout` and
`move_page_continuation`; these accept neither `role` nor `alt`. Up to 200
related tag IDs identify participants. Only `move_page_continuation` supplies
`readonlyTagIds`: exactly one related anchor, distinct from the primary tag,
that provides context and is not modified by that operation. This permits a
verified heading split on the anchor to compose with moving its continuation.
List candidates retain each original paragraph and its
visible label inside native list items. They do not invent labels or move
intervening content. The worker independently discovers the candidates again
and rejects forged, stale, overlapping or unsupported operations. It never
accepts replacement text or arbitrary content offsets. Candidate discovery is
optional: reaching its bounded work limit returns no candidates and a visible
`structure_candidates_limited` warning, while the ordinary checks and supported
metadata/role repairs continue. A selected structural repair still fails closed
if its proof cannot be completed.

`rebuild_table` uses verified aligned two-column geometry and existing text-show
boundaries to separate cells. It preserves exact encoded text and spacing,
creates Table/TR/TH/TD and explicit header IDs/associations, and keeps text
outside the table (including notes) outside its cells. `move_callout` requires
linked sidebar geometry beside an unfinished body sentence and its continuation;
it joins the original body owners under a paragraph and places the original
callout after it in tag reading order. `describe_chart` requires a caption,
verified native labels and simple vector plot scopes. It groups those graphics
and labels as a Figure with the proposed detailed description and the original
title as a Caption child. `move_page_continuation` moves an unchanged paragraph
past verified chart groups to follow its unfinished preceding-page paragraph.
The source-bound anchor must remain intact or match a prior private heading
split proof; arbitrary changes to that anchor are rejected. Authored
alternatives, identifiers and unsupported structures cannot be overwritten.
The private pipeline rederives selections from immutable source bytes, captures
original node maps before edits, rejects overlapping operations, and verifies
saved cell/header membership, graphic ownership and reading order after reopening.
The independent audit checks semantic accuracy against the original pages.

The table kernel may additionally wrap one source-proven constant pale axial
shading in `/Artifact` marking. It requires a self-contained rectangular clip
tightly surrounding the table, painting before its text, safe inherited graphics
state and no foreign text, images or forms in the region. Gradients, transparency,
authored marking and uncertain bounds are ineligible. The private saved proof
binds the original paint program, shading resource, transform and bounds; the
model cannot supply an artifact operation or select arbitrary graphics.

The final write may add a missing native `/Tabs /S` setting on pages containing
only uniquely tagged Link annotations, so keyboard link navigation follows
the repaired structure order. Original authored `/Tabs` settings must survive
preparation and final output. Forms, other annotation types and ambiguous
ownership are ineligible. Source eligibility and saved settings/owners are
independently verified; no model-supplied navigation setting is accepted.

Structure edits preserve original nodes and painting. A reference candidate may
partition a trailing `*` or `**` from a `Tj` string only with verified simple
Type1/TrueType, explicit WinAnsi encoding and no Unicode override. The adjacent
fragments must concatenate to the exact original bytes without any intervening
state change; the ordinary text/resource/pixel checks still apply. Unknown
graphics-state font overrides make the candidate ineligible. The model never
supplies the partition or replacement bytes. Added nodes may
change preorder IDs, so a repaired inventory supplies `sourceTagLineage`
(prepared ID to saved original-node ID) and each saved tag's `sourceTagId`.
New child tags can share a source ID. Audit comparison and retained findings
must use this lineage rather than assuming ordinal IDs are stable.

Preparation and the final write add missing Note identifiers and their IDTree
entries only when existing IDs and associations are valid. Reopening verifies
the exact additions and preserves existing identifiers. Ambiguous ID metadata
is left for review, and fonts are not changed by these repairs.

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
failure. The worker does not run generic OCR, font substitution or arbitrary
form editing. Hybrid-form preparation is restricted to the verified changes
described above.

Within one repair request, the baseline comparison, plan application and final
comparison may reuse a private structure inspection of identical saved bytes.
The evidence constructor parses those bytes itself; it accepts neither a
caller-provided inventory nor a mutable reader. Every consumer receives a deep
copy, and changed bytes require a fresh inspection. Source and repaired output
have separate evidence. Candidate discovery still derives its operations from
the current source, and each comparison still checks painting, resources,
behavior, descriptions and pixels. No evidence survives the request.

Failures return `{"error":{"code":"controlled_code"}}`, never native tool
stderr, source text or filesystem paths. HTTP 400 means unsupported input or
plan; 422 means unsafe preservation or incomplete evidence; 503 means capacity
or toolchain unavailable; 504 means the worker wall-clock or CPU limit expired.
The supervisor logs a bounded failure category, operation, elapsed time and
child exit code/signal. It never logs child output, document text, paths,
model plans or credentials. A CPU-limit signal is reported as a timeout and
remaining child processes are stopped before cleanup.

veraPDF checks the **actual delivered file**, without adding a PDF/UA claim to
satisfy the checker. Its failures remain visible independently of the model
audit. Machine and semantic findings never become a certificate.
