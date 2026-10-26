# Native PDF corpus validation and generated structure IDs

**Follow-up:** [Sol6.1 local application validation](sol61-local-validation.md)
records the subsequent successful model access and seven complete browser
upload/repair/audit/download journeys. The earlier401 and zero-completion counts
below describe the previous configuration. The two navigation refusals, unsupported
W-4 and remaining accessibility findings persist. The hosted preview was skipped;
nothing has been merged or deployed.

This bounded follow-up starts at `d42b2f199e18d173866bd97b64ba4b2784c4bb78`
after the authentication correction in draft PR36. The three preceding draft
branches remain unchanged. The work preserves the existing native engine and
its source/content/pixel checks; it is not a format rewrite or accessibility
certification.

## Reproducible corpus and actual baseline

The local acceptance manifest contains exactly 10 whole PDFs / 68 pages: seven
public originals and three synthetic edge cases. Every file is within 4 MiB and
60 pages. Originals, SHA256s, source/rights provenance, pre-repair content oracles,
all-page renders, tool reports and per-stage execution evidence remain outside
Git. Public documents are not silently excerpted or redistributed as fixtures.
The original synthetic regression set remains separate and unchanged.

| ID | Whole source | Pages | Original veraPDF failed rules/checks | Native preparation before this fix |
| --- | --- | ---: | ---: | --- |
| 01 | [Eysenbach, Citation Advantage of Open Access Articles, PLOS Biology 2006](https://journals.plos.org/plosbiology/article?id=10.1371/journal.pbio.0040157) | 7 | 8 / 2594 | Preservation rejection at generated structure IDs |
| 02 | [Chemaya/Martin, Perceptions and detection of AI use in manuscript preparation, PLOS ONE 2024](https://journals.plos.org/plosone/article?id=10.1371/journal.pone.0304807) | 16 | 10 / 8899 | Preservation rejection at generated structure IDs |
| 03 | [Vaswani et al., Attention Is All You Need, NeurIPS 2017](https://proceedings.neurips.cc/paper_files/paper/2017/hash/3f5ee243547dee91fbd053c1c4a845aa-Abstract.html) | 11 | 11 / 3005 | Preservation rejection at generated structure IDs |
| 04 | [NIST Zero Trust Architecture 101 slides](https://csrc.nist.gov/presentations/2019/zero-trust-architecture-101) | 10 | 7 / 23 | Prepared; 6 / 22 remain |
| 05 | [NIST-hosted U.S. Government Transition to PQC slides](https://csrc.nist.gov/Presentations/2024/us-governments-transition-to-pqc) | 7 | 6 / 21 | Prepared; 6 / 19 remain |
| 06 | [Blank IRS W-9, March 2024 revision](https://www.irs.gov/forms-pubs/about-form-w-9) | 6 | 4 / 26 | Prepared; 3 / 3 remain |
| 07 | [Blank IRS W-4, 2026 edition](https://www.irs.gov/forms-pubs/about-form-w-4) | 5 | 5 / 54 | Unsupported static-XFA features |
| 08 | Synthetic image-only scan | 1 | 5 / 5 | Prepared; 3 / 3 remain; no OCR claim |
| 09 | Synthetic text plus scanned appendix | 2 | 6 / 25 | Prepared; 4 / 12 remain |
| 10 | Synthetic mixed orientation/crop boxes | 3 | 6 / 48 | Prepared; 3 / 19 remain |

All 10 original veraPDF audits completed normally using the PDF/UA-1 profile;
all 10 had machine findings. Baseline inspection is not a repaired-output audit.
Six original-candidate preparation pairs independently reopened in pypdf and
PDFium; all 29 pages retained geometry, extracted text, canonical field names/types/
values and exact pixels at 1.5 scale. These are intermediate native preparations,
not completed model-assisted repairs. Preserved pixels cannot establish semantic
reading order, accessible math, chart descriptions or usable form interaction.

## Confirmed common defect and bounded correction

OpenDataLoader 2.5.14 emits unique `/ID` byte strings on generated list tags but
omits the structure root's `/IDTree`. The three untagged research sources have
no authored structure IDs; their generated outputs contain 3, 8, 6 IDs respectively.
`verify_authored_ids` correctly rejects the invalid resulting index before the
general preservation comparison. Captured downstream comparisons independently
preserve the source content; the failure is not a reason to waive ID validation.

The correction belongs only at the trusted untagged-source/tagger-output boundary:
derive a missing index from bounded, unique existing generated IDs, keep their
exact target nodes and bytes, reopen the saved index and verify every association.
Never overwrite an authored or existing malformed index, remove IDs, invent
content associations or relax the existing preservation/inspection gates.
The [PDF Association structure reference](https://pdfa.org/download-area/cheat-sheets/LogicalStructureObjects.pdf)
describes the index mapping for identified structure elements. Regression fixtures
are synthetic and exercise the class of failure rather than a particular paper.

The existing production Docker build already executes the real native smoke as
its unprivileged user. A separate GitHub Actions job now builds that exact image
to exercise the installed Java tools on pull requests; it never pushes or deploys
an image and needs no app/model/storage credentials. Local Docker/WSL denial is
not retried or bypassed.

## Fix verification

The new worker integration regression failed before the correction at the same
`authored_id_preservation` boundary. The focused generated-ID, existing structure
and worker suites then passed 71 tests. The full native suite passed 341 tests on
Windows with one expected POSIX-only skip. Linux CI for the code candidate
`9bafa455505eba8053662bf14a2c48ba2ebd2805` passed all 341 without skipping.
Invalid/duplicate/oversized IDs, ambiguous parents/cycles, existing bad
indexes, binary ID ordering, changed cross-references/catalog metadata and the
separate Note-ID repair path have regression coverage.

An actual installed-tool rerun of public case01 now produces a prepared PDF:
three IDs are indexed and verified, content preservation and inspection complete,
and veraPDF completes with four failed rules / 1,270 failed checks still visible.
Its page6 retains `pixelsIdentical=false`: the existing bounded equivalence proof
records 25 differing pixels at the primary scale and exact pixels at both other
scales, with identical source painting/resources/text. This is not relabeled as
pixel identity, a semantic repair, or accessibility conformance.

A two-page synthetic continued list reliably reproduces the missing index in the
pinned real tagger. The smoke now requires that case to acquire a verified saved
index while preserving both pages and their content. Mocked executable tests and
this installed-tool test are recorded separately.

All ten sources were subsequently rerun through the actual loopback worker at
that code candidate: 01/04/05/06/08/09/10 prepared, 02/03 returned preservation
refusals, and 07 remained unsupported. No model call was made in this preparation
pass; every source hash remained unchanged. All seven intermediate outputs still
failed veraPDF conformance checks. Zero completed model repairs, semantic audits
or application downloads are established by this pass.

Independent reopening/rendering covers all 36 prepared pages. Geometry, pypdf
extraction and canonical field names/types/values match. PDFium extraction on
case01 page2 omits two generated spaces: `is that self-archiving` becomes
`isthatself-archiving`. All non-whitespace characters retain their order and the
page's pixels match, but word-boundary/speech equivalence remains unverified.
The separate page6 multiscale exception above remains explicit. All original,
prepared-file and comparison-image hashes were independently rechecked.

[CI run 40384947408](https://github.com/galain01/acccp/actions/runs/40384947408)
completed successfully for this head: 341 native tests without skips, 2,288 app
tests, 64 isolated PostgreSQL tests, typecheck/format, production build, a 21-page
traced-renderer smoke and 15 signed-out runtime checks with zero configured-service
contacts. The new native-tool job also passed the actual installed-tool smoke as
the unprivileged Linux worker. GitHub tested temporary merge `d1bcfa74505699b9adbb11c6b436dc02bf16e2fe`
with main `58adb76a30ffed4263b853eb438a95ba8cc4b7b8`; no PR was merged and no
image was published or deployed. This CI result does not establish the blocked
authenticated application or model-assisted acceptance journeys.

## Findings that remain unresolved

Source 02 has conflicting duplicate named destinations and missing referenced
destinations. Source 03 has 77 named local links with no destination dictionary/name
tree. These navigation defects exist in the originals. Index repair cannot infer
their intended targets; complete-inspection checks must continue to report/refuse
them honestly. Source 01 also has incorrect statistical-character mappings in both
extractors; parser agreement is insufficient proof of correct mathematical speech.

W-4 is refused at three independent XFA boundaries: an empty `xfdf` annotation
packet, repeated legacy checkbox handlers, and two embedded bitmap image elements.
The first rejection is not the only unsupported feature. Each class was reproduced
with a small synthetic input. Adding a packet name alone would not support the form.
Broader static-XFA handling needs bounded shape validation, independent preservation
and real Acrobat/assistive-technology interaction checks. No filled/private form is
used and no active document script was executed during inspection.

## Toolchain and service evidence

Approved task-local installation verified Temurin 17.0.20.1+1, the pinned
OpenDataLoader 2.5.14 archive/JAR and veraPDF 1.30.3. Existing Python 3.12.14 matched
the pinned PDF dependencies. No administrator/global configuration change, WSL,
new credential or paid infrastructure was used. The real native build smoke passed
tagging, native repair, hybrid forms, saved-file preservation and veraPDF on Windows.
Windows results alone do not establish Linux resource/process containment.

One actual full candidate CLI attempt on case 10 passed worker preparation and then
received **HTTP 401 from the existing OSU LiteLLM `POST /chat/completions` endpoint**
for the configured model. It recorded a safe `provider_auth` diagnostic and no
successful usage record. The runner stopped, durably recorded the denial and made
no further model request or alternative-key/profile attempt. The previously denied
metadata endpoint was not retried. Successful inference and its actual cost remain
unverified; no provider response body or credential was logged.

The immediate external prerequisite is legitimate restoration/confirmation of the
app's existing key/model authorization by the OSU gateway owner. The 401 alone does
not establish expiry, revocation, or the specific permission failure. Do not retry
until there is new relevant evidence and applicable authorization.

Full model repair/independent semantic audit, authenticated storage/publication/
download/retry/retention journeys, hosted preview configuration, dependency release
gates and manual Acrobat/Office/assistive-technology checks remain separate. The
automatic preview's missing build-time `DATABASE_URL` is not fixed by local Java
installation. See the [release checklist](release-validation-checklist.md). No
merge, production migration, credential change or deployment is justified by this
partial evaluation.
