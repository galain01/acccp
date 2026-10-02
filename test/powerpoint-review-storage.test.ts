import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";

const mock = vi.hoisted(() => ({
  retained: vi.fn(),
  download: vi.fn(),
  upload: vi.fn(),
  sign: vi.fn(),
  replay: vi.fn(),
  recheck: vi.fn(),
  recordCalls: vi.fn(),
  tx: { select: vi.fn(), insert: vi.fn(), update: vi.fn(), delete: vi.fn() },
  locked: false,
  events: [] as string[],
}));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/document-retention", async () => {
  const { sql } = await import("drizzle-orm");
  return {
    withRetainedDocument: mock.retained,
    retainedDocumentCondition: () => sql`retained_document`,
    DocumentUnavailableError: class extends Error {},
  };
});
vi.mock("@/lib/storage", () => ({
  downloadObject: mock.download,
  uploadObject: mock.upload,
  createSignedUrl: mock.sign,
  sourcePptxKey: (s: string, d: string) => `${s}/${d}/source.pptx`,
  PPTX_MIME_TYPE: "application/pptx",
}));
vi.mock("@/lib/pptx-revisions", () => ({ replayPptxRevisions: mock.replay }));
vi.mock("@/lib/powerpoint-convert", () => ({
  recheckPowerPointRevision: mock.recheck,
}));
vi.mock("@/lib/powerpoint-review-costs", () => ({
  recordPowerPointReviewCalls: mock.recordCalls,
}));
import {
  exportOwnedPowerPointReview,
  readOwnedPowerPointReview,
  readOwnedPowerPointPreview,
} from "@/lib/powerpoint-review-storage";
import { artifacts, modelCalls, jobEvents } from "@/lib/db/schema";

const documentId = "00000000-0000-0000-0000-000000000001",
  jobId = "00000000-0000-0000-0000-000000000002";
const change = {
  id: "c1",
  type: "description",
  slideNumber: 1,
  objectId: "2",
  label: "Image description",
  before: "",
  after: "A river",
  reason: "Describe the teaching image.",
  operationIds: ["op1"],
  editableDescription: true,
};
const record = {
  outputTarget: "accessible_pptx",
  profileVersion: "powerpoint-v1",
  revisions: {
    version: 1,
    sourceHash: "a".repeat(64),
    plan: { slides: [] },
    changes: [change],
  },
  changes: ["Image described"],
  findings: [],
};
const body = Buffer.from(JSON.stringify(record));
const revisionToken = createHash("sha256").update(body).digest("hex");
const request = () => ({
  documentId,
  jobId,
  revisionToken,
  includedChangeIds: ["c1"],
  reviewedChangeIds: [],
  descriptionEdits: {},
});
const owned = {
  sessionId: "session-1",
  filename: "Teaching.pptx",
  attemptNumber: 1,
  status: "completed",
};
const call = {
  stage: "validate",
  model: "test-model",
  promptTokens: 50,
  completionTokens: 20,
  costUsd: 0.002,
  costSource: "gateway",
};
let selections: unknown[][];
let inserts: { table: unknown; values: unknown }[];
let createdAt: string;
function chain(rows: unknown[] = []) {
  const value = {
    from: vi.fn(),
    innerJoin: vi.fn(),
    where: vi.fn(),
    orderBy: vi.fn(),
    limit: vi.fn(),
    set: vi.fn(),
    values: vi.fn(),
    then: Promise.resolve(rows).then.bind(Promise.resolve(rows)),
  };
  for (const method of [
    value.from,
    value.innerJoin,
    value.where,
    value.orderBy,
    value.limit,
    value.set,
    value.values,
  ])
    method.mockReturnValue(value);
  return value;
}
beforeEach(() => {
  vi.clearAllMocks();
  selections = [];
  inserts = [];
  mock.events = [];
  mock.locked = false;
  createdAt = new Date().toISOString();
  mock.retained.mockImplementation(async (_id, action) => {
    mock.locked = true;
    try {
      return await action(mock.tx, { createdAt });
    } finally {
      mock.locked = false;
    }
  });
  mock.tx.select.mockImplementation(() => chain(selections.shift() ?? []));
  mock.tx.insert.mockImplementation((table) => {
    const result = chain();
    result.values.mockImplementation((values) => {
      inserts.push({ table, values });
      mock.events.push(table === artifacts ? "reserve-artifacts" : "insert");
      return result;
    });
    return result;
  });
  mock.tx.update.mockImplementation(() => chain());
  mock.tx.delete.mockImplementation(() => chain());
  mock.download.mockImplementation(async (key: string) => {
    expect(mock.locked).toBe(true);
    return key.endsWith("source.pptx") ? Buffer.from("original") : body;
  });
  mock.upload.mockImplementation(async () => {
    expect(mock.locked).toBe(true);
    mock.events.push("upload");
  });
  mock.sign.mockResolvedValue("https://storage.test/selected");
  mock.recordCalls.mockImplementation(async ({ calls }) => {
    if (calls.length) inserts.push({ table: modelCalls, values: calls });
  });
  mock.replay.mockImplementation(async () => {
    expect(mock.locked).toBe(false);
    mock.events.push("replay");
    return { buffer: Buffer.from("selected"), changes: [] };
  });
  mock.recheck.mockImplementation(async () => {
    expect(mock.locked).toBe(false);
    mock.events.push("audit");
    return {
      pptx: Buffer.from("selected"),
      errors: [],
      changes: ["Chosen description"],
      calls: [call],
    };
  });
});

describe("PowerPoint review ownership and retained storage", () => {
  it("loads an added description slide without inventing an original image", async () => {
    const preview = { slideNumber: 2, after: "data:image/jpeg;base64,Yg==" };
    const saved = Buffer.from(
      JSON.stringify({
        ...record,
        revisions: {
          ...record.revisions,
          plan: { slides: [{ slideNumber: 1 }] },
          changes: [
            { ...change, type: "long-description", generatedSlideNumbers: [2] },
          ],
        },
        reviewPreviews: [preview],
      })
    );
    mock.download.mockResolvedValue(saved);
    selections = [[owned], [{ storageKey: "saved.json" }]];
    expect(
      await readOwnedPowerPointPreview(
        "owner",
        documentId,
        jobId,
        createHash("sha256").update(saved).digest("hex"),
        2
      )
    ).toEqual(preview);
  });

  it.each([
    { slideNumber: 2, after: "data:image/jpeg;base64,Yg==" },
    {
      slideNumber: 1,
      before: "https://unrelated.example/image.jpg",
      after: "data:image/jpeg;base64,Yg==",
    },
  ])(
    "rejects unverified added-slide previews and remote images: %j",
    async (preview) => {
      mock.download.mockResolvedValue(
        Buffer.from(JSON.stringify({ ...record, reviewPreviews: [preview] }))
      );
      selections = [[owned], [{ storageKey: "saved.json" }]];
      await expect(
        readOwnedPowerPointReview("owner", documentId, jobId)
      ).rejects.toThrow("saved slide preview could not be read");
    }
  );

  it("loads slide image pairs individually instead of returning an oversized review response", async () => {
    const preview = {
      slideNumber: 1,
      before: "data:image/jpeg;base64,YQ==",
      after: "data:image/jpeg;base64,Yg==",
    };
    const saved = Buffer.from(
      JSON.stringify({ ...record, reviewPreviews: [preview] })
    );
    const savedToken = createHash("sha256").update(saved).digest("hex");
    mock.download.mockResolvedValue(saved);
    selections = [
      [owned],
      [{ storageKey: "saved.json" }],
      [owned],
      [{ storageKey: "saved.json" }],
    ];
    const review = await readOwnedPowerPointReview("owner", documentId, jobId);
    expect(review?.previews).toBeUndefined();
    expect(review?.previewSlideNumbers).toEqual([1]);
    expect(
      await readOwnedPowerPointPreview(
        "owner",
        documentId,
        jobId,
        savedToken,
        1
      )
    ).toEqual(preview);
  });
  it("rejects stale or unowned slide preview requests", async () => {
    selections = [[owned], [{ storageKey: "saved.json" }]];
    expect(
      await readOwnedPowerPointPreview(
        "owner",
        documentId,
        jobId,
        "c".repeat(64),
        1
      )
    ).toBeNull();
    await expect(
      readOwnedPowerPointPreview(
        "other-owner",
        documentId,
        jobId,
        revisionToken,
        1
      )
    ).rejects.toThrow();
    expect(
      await readOwnedPowerPointPreview(
        "owner",
        documentId,
        jobId,
        revisionToken,
        61
      )
    ).toBeNull();
  });
  it("does not retry an unknown billing commit or expose an unchecked output", async () => {
    selections = [[owned], [{ storageKey: "saved.json" }], []];
    mock.recordCalls.mockRejectedValueOnce(new Error("Unknown commit outcome"));
    await expect(
      exportOwnedPowerPointReview("owner", request())
    ).rejects.toThrow("Unknown commit outcome");
    expect(mock.recordCalls).toHaveBeenCalledTimes(1);
    expect(mock.upload).not.toHaveBeenCalled();
    expect(mock.sign).not.toHaveBeenCalled();
  });
  it("constrains the job query by caller, document, job and target before storage", async () => {
    const builder = chain([owned]);
    mock.tx.select
      .mockReturnValueOnce(builder)
      .mockReturnValueOnce(chain([{ storageKey: "saved-review.json" }]));
    const result = await readOwnedPowerPointReview("owner", documentId, jobId);
    const query = new PgDialect().sqlToQuery(
      builder.where.mock.calls[0][0] as SQL
    );
    expect(query.params).toEqual(
      expect.arrayContaining(["owner", documentId, jobId, "accessible_pptx"])
    );
    expect(query.sql).toContain("retained_document");
    expect(result?.changes).toEqual([change]);
    expect(result?.includedChangeIds).toEqual(["c1"]);
    expect(result).not.toHaveProperty("plan");
    expect(result?.revisionToken).toBe(revisionToken);
  });
  it("never reads source data for an unowned job", async () => {
    await expect(
      readOwnedPowerPointReview("wrong-owner", documentId, jobId)
    ).rejects.toThrow();
    expect(mock.download).not.toHaveBeenCalled();
  });
  it("returns no revision UI for a legacy output", async () => {
    selections = [[owned], [{ storageKey: "legacy.json" }]];
    mock.download.mockResolvedValue(
      Buffer.from('{"outputTarget":"accessible_pptx","changes":[]}')
    );
    expect(
      await readOwnedPowerPointReview("owner", documentId, jobId)
    ).toBeNull();
  });
  it.each(["unknown-id", "__proto__"])(
    "rejects unknown selection %s before billable work",
    async (id) => {
      selections = [[owned], [{ storageKey: "saved.json" }]];
      await expect(
        exportOwnedPowerPointReview("owner", {
          ...request(),
          includedChangeIds: [id],
        })
      ).rejects.toThrow("selected changes");
      expect(mock.recheck).not.toHaveBeenCalled();
      expect(mock.upload).not.toHaveBeenCalled();
    }
  );
  it("rejects stale review state before rendering", async () => {
    selections = [[owned], [{ storageKey: "saved.json" }]];
    await expect(
      exportOwnedPowerPointReview("owner", {
        ...request(),
        revisionToken: "b".repeat(64),
      })
    ).rejects.toThrow("has changed");
    expect(mock.replay).not.toHaveBeenCalled();
  });
  it("does not start work near the original expiry", async () => {
    createdAt = new Date(Date.now() - 14 * 86400000 + 120000).toISOString();
    selections = [[owned]];
    await expect(
      exportOwnedPowerPointReview("owner", request())
    ).rejects.toThrow("expires shortly");
    expect(mock.download).not.toHaveBeenCalled();
  });
  it("serializes duplicate export requests with a persisted lease", async () => {
    selections = [
      [owned],
      [{ storageKey: "saved.json" }],
      [
        {
          eventType: "powerpoint_review_started",
          createdAt: new Date().toISOString(),
        },
      ],
    ];
    await expect(
      exportOwnedPowerPointReview("owner", request())
    ).rejects.toThrow("already being checked");
    expect(mock.recheck).not.toHaveBeenCalled();
  });
  it("reserves purge discovery before work and saves every failed-audit call", async () => {
    selections = [[owned], [{ storageKey: "saved.json" }], []];
    mock.recheck.mockResolvedValue({ error: "audit failed", calls: [call] });
    await expect(
      exportOwnedPowerPointReview("owner", request())
    ).rejects.toThrow("could not be checked");
    const reserved = inserts.find((item) => item.table === artifacts)
      ?.values as { artifactStatus: string; storageKey: string }[];
    expect(reserved).toHaveLength(2);
    expect(reserved.every((row) => row.artifactStatus === "expired")).toBe(
      true
    );
    expect(mock.events.indexOf("reserve-artifacts")).toBeLessThan(
      mock.events.indexOf("replay")
    );
    expect(inserts.filter((item) => item.table === modelCalls)).toHaveLength(1);
    expect(mock.upload).not.toHaveBeenCalled();
  });
  it("does not overwrite a newer conversion and still records its audit cost", async () => {
    selections = [
      [owned],
      [{ storageKey: "saved.json" }],
      [],
      [{ ...owned, attemptNumber: 2 }],
      [{ storageKey: "saved.json" }],
    ];
    await expect(
      exportOwnedPowerPointReview("owner", request())
    ).rejects.toThrow("newer conversion");
    expect(inserts.filter((item) => item.table === modelCalls)).toHaveLength(1);
    expect(mock.upload).not.toHaveBeenCalled();
  });
  it("passes selected ids and edited descriptions to replay without altering the original", async () => {
    selections = [[owned], [{ storageKey: "saved.json" }], []];
    mock.recheck.mockResolvedValue({ error: "check failed", calls: [] });
    await expect(
      exportOwnedPowerPointReview("owner", {
        ...request(),
        descriptionEdits: { c1: "Blue river beside a forest." },
      })
    ).rejects.toThrow();
    expect(mock.replay).toHaveBeenCalledWith(
      Buffer.from("original"),
      record.revisions,
      ["c1"],
      { c1: "Blue river beside a forest." }
    );
    expect(
      mock.upload.mock.calls.some(([key]) =>
        String(key).endsWith("source.pptx")
      )
    ).toBe(false);
  });
  it("rejects an older writer after a newer export finishes without changing the revision token", async () => {
    selections = [
      [owned],
      [{ storageKey: "saved.json" }],
      [],
      [owned],
      [{ storageKey: "saved.json" }],
    ];
    let finalQuery: ReturnType<PgDialect["sqlToQuery"]> | undefined;
    mock.tx.select.mockImplementation(() => {
      if (selections.length) return chain(selections.shift());
      const originalEvent = inserts.find((item) => item.table === jobEvents)
        ?.values as { id: string };
      const query = chain();
      query.where.mockImplementation((condition: SQL) => {
        finalQuery = new PgDialect().sqlToQuery(condition);
        // A finished newer event must remain visible to the final lease check.
        // The old started-only query incorrectly rediscovers this older writer.
        return chain(
          finalQuery.params.includes("powerpoint_review_finished")
            ? [{ id: "newer-export", eventType: "powerpoint_review_finished" }]
            : [{ id: originalEvent.id, eventType: "powerpoint_review_started" }]
        );
      });
      return query;
    });
    await expect(
      exportOwnedPowerPointReview("owner", request())
    ).rejects.toThrow("no longer current");
    expect(finalQuery?.params).toEqual(
      expect.arrayContaining([
        jobId,
        "powerpoint_review_started",
        "powerpoint_review_finished",
      ])
    );
    expect(mock.recordCalls).toHaveBeenCalledOnce();
    expect(mock.upload).not.toHaveBeenCalled();
    expect(mock.sign).not.toHaveBeenCalled();
  });
  it("saves the checked selection with private reserved paths and signs only that output", async () => {
    selections = [
      [owned],
      [{ storageKey: "saved.json" }],
      [],
      [owned],
      [{ storageKey: "saved.json" }],
    ];
    mock.tx.select.mockImplementation(() => {
      if (selections.length) return chain(selections.shift());
      const event = inserts.find((item) => item.table === jobEvents)
        ?.values as { id: string };
      return chain([{ id: event.id, eventType: "powerpoint_review_started" }]);
    });
    const result = await exportOwnedPowerPointReview("owner", request());
    expect(result).toEqual({
      url: "https://storage.test/selected",
      filename: "Teaching-accessible.pptx",
      findings: [],
      changes: ["Chosen description"],
      revisionToken: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(mock.upload).toHaveBeenCalledTimes(2);
    const [key, pptx] = mock.upload.mock.calls[0];
    expect(key).toMatch(
      new RegExp(`^session-1/${documentId}/${jobId}/review-[a-f0-9-]+\\.pptx$`)
    );
    expect(pptx).toEqual(Buffer.from("selected"));
    const saved = JSON.parse(mock.upload.mock.calls[1][1]);
    expect(saved.revisions).toEqual(record.revisions);
    expect(saved.selection.includedChangeIds).toEqual(["c1"]);
    expect(mock.sign).toHaveBeenCalledWith(key, 60, "Teaching-accessible.pptx");
    expect(inserts.filter((item) => item.table === modelCalls)).toHaveLength(1);
  });
  it("keeps the old artifact pointers if upload fails, with purge discovery already committed", async () => {
    selections = [
      [owned],
      [{ storageKey: "saved.json" }],
      [],
      [owned],
      [{ storageKey: "saved.json" }],
    ];
    mock.tx.select.mockImplementation(() => {
      if (selections.length) return chain(selections.shift());
      const event = inserts.find((item) => item.table === jobEvents)
        ?.values as { id: string };
      return chain([{ id: event.id, eventType: "powerpoint_review_started" }]);
    });
    mock.upload.mockRejectedValueOnce(new Error("Storage unavailable"));
    await expect(
      exportOwnedPowerPointReview("owner", request())
    ).rejects.toThrow("Storage unavailable");
    expect(
      mock.tx.update.mock.calls.some(([table]) => table === artifacts)
    ).toBe(false);
    expect(inserts.filter((item) => item.table === artifacts)).toHaveLength(1);
    expect(inserts.filter((item) => item.table === modelCalls)).toHaveLength(1);
    expect(mock.sign).not.toHaveBeenCalled();
  });
});
