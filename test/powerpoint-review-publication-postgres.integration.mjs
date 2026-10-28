import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { resolve } from "node:path";

const fixture = vi.hoisted(() => ({
  db: null,
  onCommit: null,
  beforeCommit: null,
  beforeTransaction: null,
  upload: vi.fn(),
  download: vi.fn(),
  remove: vi.fn(),
  sign: vi.fn(),
  replay: vi.fn(),
  recheck: vi.fn(),
}));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/db", () => ({
  db: new Proxy(
    {},
    {
      get(_target, property) {
        if (!fixture.db)
          throw new Error("Isolated PostgreSQL is not initialized.");
        if (property === "transaction")
          return async (action, options) => {
            if (fixture.beforeTransaction) await fixture.beforeTransaction();
            const result = await fixture.db.transaction(async (tx) => {
              const value = await action(tx);
              if (fixture.beforeCommit) await fixture.beforeCommit(tx);
              return value;
            }, options);
            if (fixture.onCommit) await fixture.onCommit();
            return result;
          };
        const value = fixture.db[property];
        return typeof value === "function" ? value.bind(fixture.db) : value;
      },
    }
  ),
}));
vi.mock("@/lib/storage", () => ({
  uploadObject: fixture.upload,
  downloadObject: fixture.download,
  createSignedUrl: fixture.sign,
  removeObjects: fixture.remove,
  PPTX_MIME_TYPE:
    "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  sourceDocxKey: (s, d) => `${s}/${d}/source.docx`,
  sourcePdfKey: (s, d) => `${s}/${d}/source.pdf`,
  sourcePptxKey: (s, d) => `${s}/${d}/source.pptx`,
  htmlOutputKey: (s, d) => `${s}/${d}/output.html`,
  pptxOutputKey: (s, d, j) => `${s}/${d}/${j}/output.pptx`,
  docxOutputKey: (s, d, j) => `${s}/${d}/${j}/output.docx`,
  pdfOutputKey: (s, d, j) => `${s}/${d}/${j}/output.pdf`,
  outputReviewKey: (s, d, j) => `${s}/${d}/${j}/review.json`,
}));
vi.mock("@/lib/pptx-revisions", () => ({
  replayPptxRevisions: fixture.replay,
}));
vi.mock("@/lib/powerpoint-convert", () => ({
  recheckPowerPointRevision: fixture.recheck,
}));
vi.mock("@/lib/powerpoint-render-storage", () => ({
  createStoredPowerPointRenderer: () => vi.fn(),
}));

import { exportOwnedPowerPointReview } from "@/lib/powerpoint-review-storage";
import { purgeDocumentIfEligible } from "@/lib/document-retention";
import * as schema from "@/lib/db/schema";
import { eq } from "drizzle-orm";

let pg;
let context;
let input;
let oldIds;
let originalKey;
let oldReview;
let committedCandidates;
const blobs = new Map();
const selected = Buffer.from("Synthetic selected PPTX bytes");
const checksum = (body) => createHash("sha256").update(body).digest("hex");
const call = {
  stage: "validate",
  model: "synthetic",
  promptTokens: 7,
  completionTokens: 3,
  costUsd: 0.001,
  costSource: "gateway",
};

async function candidates() {
  return (
    await pg.query(
      "SELECT * FROM artifacts WHERE job_id=$1 AND storage_key LIKE '%/review-%' ORDER BY artifact_type",
      [context.jobId]
    )
  ).rows;
}
async function available() {
  return (
    await pg.query(
      "SELECT * FROM artifacts WHERE job_id=$1 AND artifact_status='available' ORDER BY artifact_type",
      [context.jobId]
    )
  ).rows;
}
async function findings() {
  return (
    await pg.query("SELECT message FROM validation_findings WHERE job_id=$1", [
      context.jobId,
    ])
  ).rows.map((row) => row.message);
}
async function assertOldResult() {
  expect((await available()).map((row) => row.id).sort()).toEqual(
    [...oldIds].sort()
  );
  expect(await findings()).toEqual(["Old review finding"]);
  expect(blobs.get(originalKey).toString()).toBe("Synthetic original source");
}
async function assertSingleUsage() {
  const rows = (
    await pg.query("SELECT * FROM model_calls WHERE job_id=$1", [context.jobId])
  ).rows;
  expect(rows).toHaveLength(1);
  expect(rows[0].prompt_tokens).toBe(7);
  expect(fixture.replay).toHaveBeenCalledOnce();
  expect(fixture.recheck).toHaveBeenCalledOnce();
}

beforeAll(async () => {
  const runtime = process.env.PGLITE_RUNTIME_DIR;
  if (!runtime)
    throw new Error(
      "Set PGLITE_RUNTIME_DIR to the isolated PostgreSQL/WASM runtime directory."
    );
  const runtimeRequire = createRequire(resolve(runtime, "package.json"));
  const { PGlite } = runtimeRequire("@electric-sql/pglite");
  const { drizzle } = runtimeRequire("drizzle-orm/pglite");
  pg = new PGlite("memory://");
  fixture.db = drizzle(pg, { schema });
  const require = createRequire(import.meta.url);
  const { generateDrizzleJson, generateMigration } = require("drizzle-kit/api");
  const snapshot = JSON.parse(
    await readFile(
      new URL("../drizzle/meta/0016_snapshot.json", import.meta.url),
      "utf8"
    )
  );
  snapshot.views = {};
  for (const table of Object.values(snapshot.tables)) table.indexes = {};
  for (const statement of await generateMigration(
    generateDrizzleJson({}),
    snapshot
  ))
    await pg.exec(statement);
  await pg.exec(
    "CREATE UNIQUE INDEX uq_available_artifact_per_job_type ON artifacts(job_id, artifact_type) WHERE artifact_status='available'"
  );
});
afterAll(async () => {
  if (pg) await pg.close();
});
beforeEach(async () => {
  await pg.exec(
    "TRUNCATE users, retained_job_metrics, retained_model_metrics, retained_job_stats, retained_job_duration_metrics, daily_failure_metrics CASCADE"
  );
  fixture.beforeCommit = null;
  fixture.beforeTransaction = null;
  fixture.onCommit = async () => {
    committedCandidates = await candidates();
  };
  committedCandidates = [];
  blobs.clear();
  context = {
    userId: randomUUID(),
    sessionId: randomUUID(),
    documentId: randomUUID(),
    jobId: randomUUID(),
  };
  originalKey = `${context.sessionId}/${context.documentId}/source.pptx`;
  oldReview = {
    outputTarget: "accessible_pptx",
    profileVersion: "powerpoint-v1",
    revisions: {
      version: 1,
      sourceHash: checksum("Synthetic original source"),
      plan: { slides: [] },
      changes: [{ id: "c1", editableDescription: true }],
    },
    changes: ["Old change"],
    findings: [],
  };
  input = {
    documentId: context.documentId,
    jobId: context.jobId,
    revisionToken: checksum(JSON.stringify(oldReview)),
    includedChangeIds: ["c1"],
    reviewedChangeIds: ["c1"],
    descriptionEdits: { c1: "Exact user description" },
  };
  fixture.upload.mockReset().mockImplementation(async (key, body) => {
    blobs.set(key, Buffer.from(body));
  });
  fixture.download.mockReset().mockImplementation(async (key) => {
    if (!blobs.has(key)) throw new Error("Missing synthetic blob");
    return blobs.get(key);
  });
  fixture.remove.mockReset().mockImplementation(async (keys) => {
    for (const key of keys) blobs.delete(key);
  });
  fixture.sign
    .mockReset()
    .mockImplementation(async (key) => `https://storage.example.test/${key}`);
  fixture.replay
    .mockReset()
    .mockResolvedValue({ buffer: selected, changes: [] });
  fixture.recheck.mockReset().mockResolvedValue({
    pptx: selected,
    errors: [
      {
        type: "other",
        severity: "warning",
        message: "New review finding",
        suggestion: "Review manually",
      },
    ],
    changes: ["Selected change"],
    calls: [call],
  });
  await pg.query(
    "INSERT INTO users(id,email,display_name) VALUES($1,'selected-export@example.test','Synthetic owner')",
    [context.userId]
  );
  await pg.query(
    "INSERT INTO sessions(id,owner_user_id,title) VALUES($1,$2,'Synthetic selection')",
    [context.sessionId, context.userId]
  );
  await pg.query(
    "INSERT INTO documents(id,session_id,uploaded_by_user_id,original_filename,mime_type,file_size_bytes,created_at) VALUES($1,$2,$3,'synthetic.pptx','application/octet-stream',100,clock_timestamp()-interval '1 hour')",
    [context.documentId, context.sessionId, context.userId]
  );
  await pg.query(
    "INSERT INTO conversion_jobs(id,document_id,requested_by_user_id,status,provider,output_target,profile_version,attempt_count,expires_at) VALUES($1,$2,$3,'completed','synthetic','accessible_pptx','powerpoint-v1',2,clock_timestamp()+interval '12 hours')",
    [context.jobId, context.documentId, context.userId]
  );
  blobs.set(originalKey, Buffer.from("Synthetic original source"));
  oldIds = [];
  for (const type of ["pptx_output", "review_metadata"]) {
    const id = randomUUID();
    const key = `${context.sessionId}/${context.documentId}/${context.jobId}/old-${type}`;
    oldIds.push(id);
    blobs.set(
      key,
      type === "pptx_output"
        ? Buffer.from("Old output")
        : Buffer.from(JSON.stringify(oldReview))
    );
    await pg.query(
      "INSERT INTO artifacts(id,job_id,artifact_type,filename,mime_type,storage_key) VALUES($1,$2,$3,$5,'application/octet-stream',$4)",
      [id, context.jobId, type, key, type]
    );
  }
  await pg.query(
    "INSERT INTO validation_findings(job_id,severity,rule_code,title,message) VALUES($1,'warning','synthetic','Synthetic finding','Old review finding')",
    [context.jobId]
  );
});

describe("selected PowerPoint publication against isolated PostgreSQL", () => {
  it("commits private settlement receipts before upload and returns the exact immutable selected pair", async () => {
    fixture.upload.mockImplementation(async (key, body, _mime, options) => {
      expect(committedCandidates).toHaveLength(2);
      expect(
        committedCandidates.every(
          (row) =>
            row.artifact_status === "expired" && !row.is_user_downloadable
        )
      ).toBe(true);
      expect(
        committedCandidates.find(
          (row) => row.artifact_type === "review_metadata"
        ).filename
      ).toBe("conversion-publication.json");
      expect(
        committedCandidates.find((row) => row.storage_key === key)
          .checksum_sha256
      ).toBe(checksum(body));
      expect(options.upsert).toBe(false);
      expect(options.signal).toBeInstanceOf(AbortSignal);
      blobs.set(key, Buffer.from(body));
    });
    const result = await exportOwnedPowerPointReview(context.userId, input);
    const pair = await available();
    const output = pair.find((row) => row.artifact_type === "pptx_output");
    const review = pair.find((row) => row.artifact_type === "review_metadata");
    expect(pair).toHaveLength(2);
    expect(result.savedOutputArtifactId).toBe(output.id);
    expect(result.url).toBe(
      `https://storage.example.test/${output.storage_key}`
    );
    expect(output.is_user_downloadable).toBe(true);
    expect(review.is_user_downloadable).toBe(false);
    expect(review.filename).toBe("review.json");
    const saved = JSON.parse(blobs.get(review.storage_key));
    expect(saved.selection).toEqual({
      includedChangeIds: input.includedChangeIds,
      reviewedChangeIds: input.reviewedChangeIds,
      descriptionEdits: input.descriptionEdits,
    });
    expect(saved.revisions).toEqual(oldReview.revisions);
    expect(result.revisionToken).toBe(checksum(blobs.get(review.storage_key)));
    expect(await findings()).toEqual(["New review finding"]);
    await assertSingleUsage();
  });

  it.each([1, 2])(
    "preserves the prior pair and committed receipts when upload %s fails",
    async (failAt) => {
      let count = 0;
      fixture.upload.mockImplementation(async (key, body) => {
        if (++count === failAt) throw new Error("Synthetic upload failure");
        blobs.set(key, Buffer.from(body));
      });
      await expect(
        exportOwnedPowerPointReview(context.userId, input)
      ).rejects.toThrow();
      await assertOldResult();
      expect(await candidates()).toHaveLength(2);
      expect(
        (await candidates()).every((row) => row.artifact_status === "expired")
      ).toBe(true);
      await assertSingleUsage();
    }
  );

  it("reconciles a lost publication commit acknowledgement without replaying or charging twice", async () => {
    let lost = false;
    fixture.onCommit = async () => {
      committedCandidates = await candidates();
      if (
        !lost &&
        committedCandidates.some((row) => row.artifact_status === "available")
      ) {
        lost = true;
        throw new Error("Synthetic lost commit acknowledgement");
      }
    };
    const result = await exportOwnedPowerPointReview(context.userId, input);
    expect(lost).toBe(true);
    expect(result.savedOutputArtifactId).toBe(
      (await available()).find((row) => row.artifact_type === "pptx_output").id
    );
    expect(await findings()).toEqual(["New review finding"]);
    expect(fixture.upload).toHaveBeenCalledTimes(2);
    await assertSingleUsage();
  });

  it("rolls back publication after both uploads while retaining discovery and the old review", async () => {
    fixture.beforeCommit = async (tx) => {
      const rows = await tx
        .select()
        .from(schema.artifacts)
        .where(eq(schema.artifacts.jobId, context.jobId));
      if (
        rows.some(
          (row) =>
            row.storageKey.includes("/review-") &&
            row.artifactStatus === "available"
        )
      )
        throw new Error("Synthetic metadata rollback");
    };
    await expect(
      exportOwnedPowerPointReview(context.userId, input)
    ).rejects.toThrow();
    await assertOldResult();
    expect(fixture.upload).toHaveBeenCalledTimes(2);
    expect(
      (await candidates()).every((row) => blobs.has(row.storage_key))
    ).toBe(true);
    await assertSingleUsage();
  });

  it("keeps a failed upload discoverable until the existing late-write settlement window passes", async () => {
    let lateWrite;
    fixture.upload.mockImplementationOnce(async (key, body) => {
      lateWrite = () => blobs.set(key, Buffer.from(body));
      throw new Error("Synthetic connection lost while upload may finish");
    });
    await expect(
      exportOwnedPowerPointReview(context.userId, input)
    ).rejects.toThrow();
    await pg.query(
      "UPDATE documents SET deleted_at=clock_timestamp() WHERE id=$1",
      [context.documentId]
    );
    expect(await purgeDocumentIfEligible(context.documentId)).toBe("retained");
    lateWrite();
    await pg.query(
      "UPDATE artifacts SET created_at=clock_timestamp()-interval '61 minutes' WHERE job_id=$1 AND artifact_status='expired'",
      [context.jobId]
    );
    expect(await purgeDocumentIfEligible(context.documentId)).toBe("purged");
    expect(blobs.size).toBe(0);
  });

  it("does not replace a newer conversion saved while the selected check runs", async () => {
    fixture.recheck.mockImplementationOnce(async () => {
      await pg.query("UPDATE conversion_jobs SET attempt_count=3 WHERE id=$1", [
        context.jobId,
      ]);
      return { pptx: selected, errors: [], changes: [], calls: [call] };
    });
    await expect(
      exportOwnedPowerPointReview(context.userId, input)
    ).rejects.toThrow("newer conversion");
    await assertOldResult();
    expect(fixture.upload).not.toHaveBeenCalled();
    await assertSingleUsage();
  });

  it("does not upload after an ambiguous checksum-receipt commit", async () => {
    let lost = false;
    fixture.onCommit = async () => {
      committedCandidates = await candidates();
      if (
        !lost &&
        committedCandidates.length === 2 &&
        committedCandidates.every((row) => row.checksum_sha256)
      ) {
        lost = true;
        throw new Error("Synthetic lost receipt acknowledgement");
      }
    };
    await expect(
      exportOwnedPowerPointReview(context.userId, input)
    ).rejects.toThrow("lost receipt acknowledgement");
    expect(lost).toBe(true);
    expect(fixture.upload).not.toHaveBeenCalled();
    await assertOldResult();
    expect(
      (await candidates()).every(
        (row) => row.artifact_status === "expired" && !row.is_user_downloadable
      )
    ).toBe(true);
    await assertSingleUsage();
  });

  it("does not sign a pair superseded between publication and acknowledgement recovery", async () => {
    let superseded = false;
    fixture.onCommit = async () => {
      committedCandidates = await candidates();
      if (
        !superseded &&
        committedCandidates.some((row) => row.artifact_status === "available")
      ) {
        superseded = true;
        await pg.query(
          "UPDATE conversion_jobs SET attempt_count=3 WHERE id=$1",
          [context.jobId]
        );
        throw new Error(
          "Synthetic publication acknowledgement lost before newer attempt"
        );
      }
    };
    await expect(
      exportOwnedPowerPointReview(context.userId, input)
    ).rejects.toThrow();
    expect(superseded).toBe(true);
    expect(fixture.sign).not.toHaveBeenCalled();
    expect(fixture.upload).toHaveBeenCalledTimes(2);
    await assertSingleUsage();
  });

  it("keeps a proven publication and reports download failure honestly when signing fails", async () => {
    fixture.sign.mockRejectedValue(new Error("Synthetic signing unavailable"));
    await expect(
      exportOwnedPowerPointReview(context.userId, input)
    ).rejects.toThrow("is saved, but its download could not be prepared");
    expect((await available()).every((row) => !oldIds.includes(row.id))).toBe(
      true
    );
    expect(await findings()).toEqual(["New review finding"]);
    const event = (
      await pg.query(
        "SELECT * FROM job_events WHERE job_id=$1 AND event_type='powerpoint_review_finished'",
        [context.jobId]
      )
    ).rows;
    expect(event).toHaveLength(1);
    expect(event[0].message).toBe(
      "Saved and checked the selected PowerPoint changes."
    );
    await assertSingleUsage();
  });

  it("leaves an unknown commit outcome intact when reconciliation is unavailable", async () => {
    let unknown = false;
    fixture.onCommit = async () => {
      committedCandidates = await candidates();
      if (
        !unknown &&
        committedCandidates.some((row) => row.artifact_status === "available")
      ) {
        unknown = true;
        fixture.beforeTransaction = async () => {
          throw new Error("Synthetic database unavailable");
        };
        throw new Error("Synthetic commit acknowledgement lost");
      }
    };
    await expect(
      exportOwnedPowerPointReview(context.userId, input)
    ).rejects.toThrow("saved status could not be confirmed");
    expect(fixture.sign).not.toHaveBeenCalled();
    expect((await available()).every((row) => !oldIds.includes(row.id))).toBe(
      true
    );
    const event = (
      await pg.query(
        "SELECT message FROM job_events WHERE job_id=$1 AND event_type='powerpoint_review_finished'",
        [context.jobId]
      )
    ).rows;
    expect(event[0].message).toBe(
      "Saved and checked the selected PowerPoint changes."
    );
    await assertSingleUsage();
  });

  it("serializes overlapping selections before a second audit can start", async () => {
    let start;
    const started = new Promise((resolve) => {
      start = resolve;
    });
    let release;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    fixture.recheck.mockImplementationOnce(async () => {
      start();
      await gate;
      return { pptx: selected, errors: [], changes: [], calls: [call] };
    });
    const first = exportOwnedPowerPointReview(context.userId, input);
    await started;
    try {
      await expect(
        exportOwnedPowerPointReview(context.userId, input)
      ).rejects.toThrow("already being checked");
      expect(fixture.recheck).toHaveBeenCalledOnce();
    } finally {
      release();
    }
    await expect(first).resolves.toMatchObject({
      savedOutputArtifactId: expect.any(String),
    });
    expect(await candidates()).toHaveLength(2);
    await assertSingleUsage();
  });
});
