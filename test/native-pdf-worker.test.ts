import {
  afterEach,
  beforeEach,
  describe,
  expect,
  expectTypeOf,
  it,
  vi,
} from "vitest";
vi.mock("server-only", () => ({}));
import {
  nativePdfRequest,
  parseNativePdfState,
  pdfSha256,
  type NativePdfTransport,
} from "@/lib/native-pdf-worker";

const source = Buffer.from("%PDF-1.7\nfixture source\n%%EOF");
const candidate = Buffer.from("%PDF-1.7\nfixture candidate\n%%EOF");
function response() {
  return {
    schemaVersion: 1,
    sourceSha256: pdfSha256(source),
    candidateSha256: pdfSha256(candidate),
    pdfBase64: candidate.toString("base64"),
    pageCount: 1,
    inventory: {
      title: "Test",
      language: "en",
      page_content: [
        {
          pageNumber: 1,
          mcids: [0],
          text_show_operators: 1,
          untagged_text_operators: 0,
          artifact_text_operators: 0,
          artifactText: "",
          artifactTextComplete: true,
        },
      ],
      form_content: [] as Record<string, unknown>[],
      forms: {},
      tags: [
        {
          id: "tag-1",
          parentId: null,
          children: [],
          role: "P",
          pageNumber: 1,
          text: "Test",
          content: [{ pageNumber: 1 }],
          editable: { role: true, alt: false, tableHeader: false },
          snapshot: {
            role: "P",
            pageNumber: 1,
            text: "Test",
            mcids: [0],
            alt: null,
          },
        },
      ],
    },
    findings: [],
    changes: [],
    machineChecks: {
      preservationPassed: true,
      pixelsIdentical: true,
      inspectionComplete: true,
      structurePassed: true,
      targetStandard: "PDF/UA-1 (ISO 14289-1:2014)",
      veraPdf: {
        completed: true,
        compliant: false,
        failedRules: 1,
        failedChecks: 1,
      },
      conformanceClaim: false,
    },
  };
}
function renderingEquivalence() {
  return {
    method: "identical-paint-multiscale-v1",
    pages: [
      {
        pageNumber: 1,
        changedPixels: 8,
        totalPixels: 1_000_000,
        verificationScales: [1, 2],
      },
    ],
  };
}
describe("native PDF service client", () => {
  it("accepts only the versioned worker fingerprint shape", () => {
    const raw = response();
    raw.inventory.forms = {
      interactionFingerprint: { schemaVersion: 1, sha256: "a".repeat(64) },
    };
    expect(parseNativePdfState(raw, source).inventory.forms).toEqual(
      raw.inventory.forms
    );
    for (const bad of [
      null,
      { schemaVersion: 2, sha256: "a".repeat(64) },
      { schemaVersion: 1, sha256: "claimed-passed" },
      { schemaVersion: 1, sha256: "a".repeat(64), passed: true },
    ]) {
      raw.inventory.forms = { interactionFingerprint: bad };
      expect(() => parseNativePdfState(raw, source)).toThrow();
    }
  });
  beforeEach(() => {
    vi.stubEnv("NATIVE_PDF_URL", "https://private-worker.example");
    vi.stubEnv("NATIVE_PDF_API_KEY", "s".repeat(40));
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response(JSON.stringify(response())))
    );
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });
  it("binds candidate and source bytes and retained findings to the actual output", async () => {
    const result = await nativePdfRequest("prepare", source, 90_000);
    expect(result.pdf).toEqual(candidate);
    expect(result.sourceSha256).toBe(pdfSha256(source));
    expect(fetch).toHaveBeenCalledWith(
      new URL("https://private-worker.example/prepare"),
      expect.objectContaining({
        redirect: "manual",
        cache: "no-store",
        body: new Uint8Array(source),
        headers: {
          Authorization: `Bearer ${"s".repeat(40)}`,
          "Content-Type": "application/pdf",
        },
      })
    );
  });
  it.each(["sourceSha256", "candidateSha256"])(
    "rejects mismatched %s",
    (key) => {
      const raw = { ...response(), [key]: "0".repeat(64) };
      expect(() => parseNativePdfState(raw, source)).toThrow(
        "pdf_protocol_error"
      );
    }
  );
  it("rejects incomplete inspections and altered page pixels", () => {
    for (const key of [
      "preservationPassed",
      "inspectionComplete",
      "pixelsIdentical",
    ] as const) {
      const raw = response();
      raw.machineChecks[key] = false;
      expect(() => parseNativePdfState(raw, source)).toThrow(
        "pdf_protocol_error"
      );
    }
  });
  it("keeps nonidentical pixels honest when the worker supplies bounded rendering equivalence", () => {
    const evidence = renderingEquivalence();
    const raw = {
      ...response(),
      machineChecks: {
        ...response().machineChecks,
        pixelsIdentical: false,
        renderingEquivalence: evidence,
      },
    };
    const state = parseNativePdfState(raw, source);
    expect(state.machineChecks.pixelsIdentical).toBe(false);
    expect(state.machineChecks.renderingEquivalence).toEqual(evidence);
    expectTypeOf(state.machineChecks.pixelsIdentical).toEqualTypeOf<boolean>();
    expectTypeOf(
      state.machineChecks.renderingEquivalence?.pages[0].verificationScales
    ).toEqualTypeOf<[1, 2] | undefined>();
  });
  it("accepts the bounded difference threshold without rounding it upward", () => {
    const raw = response();
    const evidence = renderingEquivalence();
    const checks = raw.machineChecks as Record<string, unknown>;
    checks.pixelsIdentical = false;
    checks.renderingEquivalence = evidence;
    evidence.pages[0].changedPixels = 1;
    evidence.pages[0].totalPixels = 10_000;
    expect(parseNativePdfState(raw, source).machineChecks.pixelsIdentical).toBe(
      false
    );
    evidence.pages[0].totalPixels = 9_999;
    expect(() => parseNativePdfState(raw, source)).toThrow(
      "pdf_protocol_error"
    );
    evidence.pages[0].totalPixels = 4_000_000;
    evidence.pages[0].changedPixels = 128;
    expect(parseNativePdfState(raw, source).machineChecks.pixelsIdentical).toBe(
      false
    );
  });
  it("rejects missing, unknown, conflicting or malformed rendering equivalence", () => {
    const valid = renderingEquivalence();
    const page = valid.pages[0];
    const invalidPages = [
      null,
      { ...page, pageNumber: 0 },
      { ...page, pageNumber: 2 },
      { ...page, pageNumber: "1" },
      { ...page, changedPixels: 0 },
      { ...page, changedPixels: -1 },
      { ...page, changedPixels: 1.5 },
      { ...page, changedPixels: 129 },
      { ...page, changedPixels: "8" },
      { ...page, changedPixels: Infinity },
      { ...page, totalPixels: 0 },
      { ...page, totalPixels: -1 },
      { ...page, totalPixels: 100.5 },
      { ...page, totalPixels: 4_000_001 },
      { ...page, totalPixels: "1000000" },
      { ...page, totalPixels: 70_000 },
      { ...page, verificationScales: undefined },
      { ...page, verificationScales: [1] },
      { ...page, verificationScales: [2, 1] },
      { ...page, verificationScales: [1, 2, 3] },
      { ...page, verificationScales: [1, "2"] },
      { ...page, verificationScales: [1, 1.5] },
      { ...page, modelApproved: true },
    ];
    const invalidEvidence = [
      undefined,
      null,
      {},
      { ...valid, method: "model-approved" },
      { ...valid, pages: [] },
      { ...valid, pages: [page, page] },
      { ...valid, pages: "passed" },
      { ...valid, modelApproved: true },
      ...invalidPages.map((value) => ({ ...valid, pages: [value] })),
    ];
    for (const evidence of invalidEvidence) {
      const raw = response();
      const checks = raw.machineChecks as Record<string, unknown>;
      checks.pixelsIdentical = false;
      checks.renderingEquivalence = evidence;
      expect(() => parseNativePdfState(raw, source)).toThrow(
        "pdf_protocol_error"
      );
    }
    for (const evidence of [undefined, null, valid, { ...valid, pages: [] }]) {
      const raw = response();
      (raw.machineChecks as Record<string, unknown>).renderingEquivalence =
        evidence;
      expect(() => parseNativePdfState(raw, source)).toThrow(
        "pdf_protocol_error"
      );
    }
  });
  it("limits rendering evidence to eight distinct physical pages", () => {
    const raw = response();
    raw.pageCount = 9;
    raw.inventory.page_content = Array.from({ length: 9 }, (_, index) => ({
      ...raw.inventory.page_content[0],
      pageNumber: index + 1,
    }));
    const evidence = renderingEquivalence();
    evidence.pages = Array.from({ length: 8 }, (_, index) => ({
      ...evidence.pages[0],
      pageNumber: index + 1,
    }));
    Object.assign(raw.machineChecks, {
      pixelsIdentical: false,
      renderingEquivalence: evidence,
    });
    expect(
      parseNativePdfState(raw, source).machineChecks.renderingEquivalence?.pages
    ).toHaveLength(8);
    evidence.pages.push({ ...evidence.pages[0], pageNumber: 9 });
    expect(() => parseNativePdfState(raw, source)).toThrow(
      "pdf_protocol_error"
    );
  });
  it("never uses rendering equivalence to waive preservation or inspection failures", () => {
    for (const key of ["preservationPassed", "inspectionComplete"] as const) {
      const raw = response();
      raw.machineChecks[key] = false;
      Object.assign(raw.machineChecks, {
        pixelsIdentical: false,
        renderingEquivalence: renderingEquivalence(),
      });
      expect(() => parseNativePdfState(raw, source)).toThrow(
        "pdf_protocol_error"
      );
    }
    for (const pixelsIdentical of [undefined, null, 1, "true", "false"]) {
      const raw = response();
      Object.assign(raw.machineChecks, {
        pixelsIdentical,
        renderingEquivalence: renderingEquivalence(),
      });
      expect(() => parseNativePdfState(raw, source)).toThrow(
        "pdf_protocol_error"
      );
    }
  });
  it("accepts bounded source-derived structure candidates and non-bijective source lineage", () => {
    const raw = response();
    const inventory = raw.inventory as unknown as Record<string, unknown>;
    inventory.tags = [
      { ...raw.inventory.tags[0], sourceTagId: "tag-1" },
      { ...raw.inventory.tags[0], id: "tag-2", sourceTagId: "tag-1" },
      { ...raw.inventory.tags[0], id: "tag-3", sourceTagId: null },
    ];
    inventory.structureCandidates = [
      {
        candidateId: "a".repeat(64),
        kind: "mark_note_reference",
        tagId: "tag-1",
        pageNumber: 1,
        text: "Original marker",
        preview: "Matching original note",
        relatedTagIds: ["tag-2"],
      },
    ];
    inventory.sourceTagLineage = { "tag-1": "tag-2" };
    const parsed = parseNativePdfState(raw, source);
    expect(parsed.inventory.tags.map((tag) => tag.sourceTagId)).toEqual([
      "tag-1",
      "tag-1",
      null,
    ]);
    expect(parsed.inventory.sourceTagLineage).toEqual({ "tag-1": "tag-2" });
    expect(parsed.inventory.structureCandidates).toHaveLength(1);
    inventory.structureCandidates = [
      {
        candidateId: "b".repeat(64),
        kind: "convert_list",
        tagId: "tag-1",
        pageNumber: 1,
        text: "A—First existing item",
        preview: "A—First existing item\nB—Second existing item",
        relatedTagIds: ["tag-2"],
      },
    ];
    expect(
      parseNativePdfState(raw, source).inventory.structureCandidates?.[0].kind
    ).toBe("convert_list");
  });
  it.each(["rebuild_table", "move_callout", "describe_chart"])(
    "accepts %s with all bounded participant IDs",
    (kind) => {
      const raw = response();
      const inventory = raw.inventory as unknown as Record<string, unknown>;
      inventory.tags = Array.from({ length: 42 }, (_, index) => ({
        ...raw.inventory.tags[0],
        id: `tag-${index + 1}`,
      }));
      const relatedTagIds = Array.from(
        { length: 41 },
        (_, index) => `tag-${index + 2}`
      );
      inventory.structureCandidates = [
        {
          candidateId: "b".repeat(64),
          kind,
          tagId: "tag-1",
          pageNumber: 1,
          text: "Source",
          preview: "Verified structural relationship",
          relatedTagIds,
        },
      ];
      expect(
        parseNativePdfState(raw, source).inventory.structureCandidates?.[0]
      ).toMatchObject({ kind, relatedTagIds });
    }
  );
  it("rejects malformed structure candidates and lineage before supplying them to the model", () => {
    const candidate = {
      candidateId: "a".repeat(64),
      kind: "split_heading",
      tagId: "tag-1",
      pageNumber: 1,
      text: "Source",
      preview: "Heading and body",
      relatedTagIds: [],
    };
    for (const changed of [
      { candidateId: "invented" },
      { tagId: "tag-99" },
      { pageNumber: 2 },
      { kind: "replace_text" },
      { text: "x".repeat(20_001) },
      { relatedTagIds: ["tag-99"] },
      { relatedTagIds: ["tag-1", "tag-1"] },
    ]) {
      const raw = response();
      (
        raw.inventory as unknown as Record<string, unknown>
      ).structureCandidates = [{ ...candidate, ...changed }];
      expect(() => parseNativePdfState(raw, source)).toThrow(
        "pdf_protocol_error"
      );
    }
    for (const lineage of [
      { "tag-1": "tag-99" },
      { invalid: "tag-1" },
      { "tag-1": null },
    ]) {
      const raw = response();
      (raw.inventory as unknown as Record<string, unknown>).sourceTagLineage =
        lineage;
      expect(() => parseNativePdfState(raw, source)).toThrow(
        "pdf_protocol_error"
      );
    }
  });

  it("limits read-only structure context to the supplied cross-page anchor", () => {
    const raw = response();
    const inventory = raw.inventory as unknown as Record<string, unknown>;
    inventory.tags = [
      raw.inventory.tags[0],
      { ...raw.inventory.tags[0], id: "tag-2" },
    ];
    const candidate = {
      candidateId: "e".repeat(64),
      kind: "move_page_continuation",
      tagId: "tag-2",
      pageNumber: 1,
      text: "Continuation",
      preview: "After the preceding paragraph",
      relatedTagIds: ["tag-1"],
      readonlyTagIds: ["tag-1"],
    };
    inventory.structureCandidates = [candidate];
    expect(
      parseNativePdfState(raw, source).inventory.structureCandidates?.[0]
        .readonlyTagIds
    ).toEqual(["tag-1"]);
    for (const changed of [
      { readonlyTagIds: undefined },
      { readonlyTagIds: [] },
      { readonlyTagIds: ["tag-2"] },
      { readonlyTagIds: ["tag-3"] },
      { readonlyTagIds: ["tag-1", "tag-2"] },
      { kind: "move_callout" },
    ]) {
      inventory.structureCandidates = [{ ...candidate, ...changed }];
      expect(() => parseNativePdfState(raw, source)).toThrow(
        "pdf_protocol_error"
      );
    }
  });
  it("rejects missing pages, duplicate tags, stale snapshots and parent cycles", () => {
    const missing = response();
    missing.inventory.page_content = [];
    const duplicate = response();
    duplicate.inventory.tags.push(duplicate.inventory.tags[0]);
    const stale = response();
    stale.inventory.tags[0].snapshot.text = "Different";
    const cyclic = response() as unknown as Record<string, unknown>;
    const ci = cyclic.inventory as { tags: { parentId: unknown }[] };
    ci.tags[0].parentId = "tag-1";
    for (const raw of [missing, duplicate, stale, cyclic])
      expect(() => parseNativePdfState(raw, source)).toThrow(
        "pdf_protocol_error"
      );
  });
  it("requires page evidence in exact physical order with bounded complete excluded text", () => {
    const page = response().inventory.page_content[0];
    for (const changed of [
      { pageNumber: 2 },
      { pageNumber: "1" },
      { artifactText: "x".repeat(16_001) },
      { artifactText: undefined },
      { artifactTextComplete: false },
      { mcids: [0, 0] },
      { mcids: [2, 1] },
      { mcids: [-1] },
      { text_show_operators: 200_001 },
      { untagged_text_operators: -1 },
      { artifact_text_operators: undefined },
      { form_artifact_text_operators: "1" },
    ]) {
      const raw = response();
      const inventory = raw.inventory as unknown as Record<string, unknown>;
      inventory.page_content = [{ ...page, ...changed }];
      expect(() => parseNativePdfState(raw, source)).toThrow(
        "pdf_protocol_error"
      );
    }
    for (const pageNumbers of [
      [1, 1],
      [2, 1],
      [1, 3],
    ]) {
      const raw = response();
      raw.pageCount = 2;
      raw.inventory.page_content = pageNumbers.map((pageNumber) => ({
        ...page,
        pageNumber,
      }));
      expect(() => parseNativePdfState(raw, source)).toThrow(
        "pdf_protocol_error"
      );
    }
  });
  it("requires complete uniquely identified nested-form scopes on known pages", () => {
    const form = {
      streamId: "form-1",
      pageNumber: 1,
      mcids: [0],
      checksComplete: true,
      gaps: [],
    };
    const good = response();
    good.inventory.form_content = [form];
    expect(parseNativePdfState(good, source).inventory.form_content).toEqual([
      form,
    ]);
    for (const changed of [
      { pageNumber: 2 },
      { checksComplete: false },
      { gaps: ["unresolved"] },
      { streamId: "" },
      { mcids: [0, 0] },
    ]) {
      const raw = response();
      raw.inventory.form_content = [{ ...form, ...changed }];
      expect(() => parseNativePdfState(raw, source)).toThrow(
        "pdf_protocol_error"
      );
    }
    const duplicated = response();
    duplicated.inventory.form_content = [form, form];
    expect(() => parseNativePdfState(duplicated, source)).toThrow(
      "pdf_protocol_error"
    );
    const absent = response();
    delete (absent.inventory as Partial<typeof absent.inventory>).form_content;
    expect(() => parseNativePdfState(absent, source)).toThrow(
      "pdf_protocol_error"
    );
  });
  it("requires both directions of every parent/child relationship", () => {
    const raw = response();
    const parent = {
      ...raw.inventory.tags[0],
      role: "Document",
      children: ["tag-2"],
    };
    parent.snapshot = { ...parent.snapshot, role: "Document" };
    const child = { ...raw.inventory.tags[0], id: "tag-2", parentId: "tag-1" };
    const inventory = raw.inventory as unknown as Record<string, unknown>;
    inventory.tags = [parent, child];
    expect(parseNativePdfState(raw, source).inventory.tags).toHaveLength(2);
    parent.children = [];
    expect(() => parseNativePdfState(raw, source)).toThrow(
      "pdf_protocol_error"
    );
    parent.children = ["tag-2"];
    inventory.tags = [parent, { ...child, parentId: null }];
    expect(() => parseNativePdfState(raw, source)).toThrow(
      "pdf_protocol_error"
    );
    inventory.tags = [parent, { ...child, parentId: "" }];
    expect(() => parseNativePdfState(raw, source)).toThrow(
      "pdf_protocol_error"
    );
  });
  it("refuses redirects before credentials can go to another host", async () => {
    vi.mocked(fetch).mockResolvedValue(
      new Response(null, {
        status: 302,
        headers: { Location: "https://other.example" },
      })
    );
    await expect(nativePdfRequest("prepare", source, 1000)).rejects.toThrow(
      "native_pdf_configuration"
    );
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it.each([
    "http://remote.example",
    "https://user:secret@private-worker.example",
    "https://private-worker.example?token=x",
  ])("rejects unsafe endpoint %s", async (url) => {
    vi.stubEnv("NATIVE_PDF_URL", url);
    await expect(nativePdfRequest("prepare", source, 1000)).rejects.toThrow(
      "native_pdf_configuration"
    );
    expect(fetch).not.toHaveBeenCalled();
  });
  it("requires a service key even on local development", async () => {
    vi.stubEnv("NATIVE_PDF_API_KEY", "");
    await expect(nativePdfRequest("prepare", source, 1000)).rejects.toThrow(
      "native_pdf_configuration"
    );
  });
  it("preserves a controlled busy error without leaking server error text", async () => {
    vi.mocked(fetch).mockResolvedValue(
      new Response(
        JSON.stringify({
          error: { code: "native_pdf_busy", message: "private data" },
        }),
        { status: 503 }
      )
    );
    await expect(nativePdfRequest("prepare", source, 1000)).rejects.toThrow(
      /^native_pdf_busy$/
    );
  });
  it("replaces arbitrary upstream messages and codes", async () => {
    vi.mocked(fetch).mockResolvedValue(
      new Response(
        JSON.stringify({
          error: { code: "secret source contents", message: "private key" },
        }),
        { status: 500 }
      )
    );
    await expect(nativePdfRequest("prepare", source, 1000)).rejects.toThrow(
      /^native_pdf_worker_failed$/
    );
  });
  it("bounds a streamed response even without Content-Length", async () => {
    vi.mocked(fetch).mockResolvedValue(
      new Response(new Uint8Array(16 * 1024 * 1024 + 1))
    );
    await expect(nativePdfRequest("prepare", source, 1000)).rejects.toThrow(
      "pdf_protocol_error"
    );
  });
  it("checks candidate identity again before a repair request", async () => {
    const state = parseNativePdfState(response(), source);
    state.pdf = Buffer.from("%PDF-mutated");
    await expect(
      nativePdfRequest("repair", source, 1000, state, {
        schemaVersion: 1,
        candidateSha256: state.candidateSha256,
        operations: [],
      })
    ).rejects.toThrow("pdf_protocol_error");
    expect(fetch).not.toHaveBeenCalled();
  });
  it.each([413, 500, 503])(
    "retains HTTP %s for a plain-text platform failure",
    async (status) => {
      vi.mocked(fetch).mockResolvedValue(
        new Response("private platform details", { status })
      );
      await expect(
        nativePdfRequest("prepare", source, 1000)
      ).rejects.toMatchObject({
        diagnostic: {
          httpStatus: status,
          code:
            status === 413
              ? "pdf_complexity_limit"
              : status === 503
                ? "native_pdf_busy"
                : "native_pdf_worker_failed",
        },
      });
    }
  );
  it("transfers a near-limit PDF pair by an exact short-lived object reference", async () => {
    const large = Buffer.alloc(4 * 1024 * 1024 - 1024, 32);
    source.copy(large);
    const raw = {
      ...response(),
      sourceSha256: pdfSha256(large),
      candidateSha256: pdfSha256(large),
      pdfBase64: large.toString("base64"),
    };
    const state = parseNativePdfState(raw, large);
    vi.mocked(fetch).mockResolvedValue(new Response(JSON.stringify(raw)));
    let payloadBytes = 0;
    let cleaned = false;
    const transport: NativePdfTransport = async (payload, signal, action) => {
      payloadBytes = payload.length;
      expect(signal.aborted).toBe(false);
      const decoded = JSON.parse(payload.toString());
      expect(Buffer.from(decoded.sourcePdfBase64, "base64").equals(large)).toBe(
        true
      );
      expect(
        Buffer.from(decoded.candidatePdfBase64, "base64").equals(large)
      ).toBe(true);
      try {
        return await action({
          requestUrl: "https://project.supabase.co/synthetic-signed-object",
          requestSha256: pdfSha256(payload),
          requestBytes: payload.length,
        });
      } finally {
        cleaned = true;
      }
    };
    const result = await nativePdfRequest(
      "repair",
      large,
      90_000,
      state,
      {
        schemaVersion: 1,
        candidateSha256: state.candidateSha256,
        operations: [],
      },
      transport
    );
    expect(result.pdf.equals(large)).toBe(true);
    expect(payloadBytes).toBeGreaterThan(10 * 1024 * 1024);
    expect(cleaned).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = vi.mocked(fetch).mock.calls[0];
    expect(String(url)).toBe("https://private-worker.example/repair-stored");
    expect(Buffer.byteLength(init!.body as string)).toBeLessThan(1024);
    expect(init!.body).not.toContain(large.toString("base64"));
  });
  it("keeps small local repair calls inline without reserving storage", async () => {
    const state = parseNativePdfState(response(), source);
    const reserved = vi.fn();
    const transport: NativePdfTransport = async () => {
      reserved();
      throw new Error("Unexpected storage transfer");
    };
    await nativePdfRequest(
      "repair",
      source,
      1000,
      state,
      {
        schemaVersion: 1,
        candidateSha256: state.candidateSha256,
        operations: [],
      },
      transport
    );
    expect(reserved).not.toHaveBeenCalled();
    expect(String(vi.mocked(fetch).mock.calls[0][0])).toBe(
      "https://private-worker.example/repair"
    );
  });
});
