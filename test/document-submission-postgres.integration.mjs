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

const fixture = vi.hoisted(() => {
  const originalSecret = process.env.BETTER_AUTH_SECRET;
  process.env.BETTER_AUTH_SECRET =
    "synthetic-submission-secret-32-characters-only";
  return {
    db: null,
    onCommit: null,
    commits: 0,
    upload: vi.fn(),
    download: vi.fn(),
    remove: vi.fn(),
    originalSecret,
  };
});
vi.mock("server-only", () => ({}));
vi.mock("@/lib/db", () => ({
  db: new Proxy(
    {},
    {
      get(_target, property) {
        if (!fixture.db)
          throw new Error("Isolated PostgreSQL is not initialized.");
        if (property === "transaction")
          return async (action) => {
            const result = await fixture.db.transaction(action);
            fixture.commits += 1;
            if (fixture.onCommit) await fixture.onCommit(fixture.commits);
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
  downloadObjectBounded: fixture.download,
  removeObjects: fixture.remove,
  sourceDocxKey: (s, d) => `${s}/${d}/source.docx`,
  sourcePdfKey: (s, d) => `${s}/${d}/source.pdf`,
  sourcePptxKey: (s, d) => `${s}/${d}/source.pptx`,
  htmlOutputKey: (s, d) => `${s}/${d}/output.html`,
  pptxOutputKey: (s, d, j) => `${s}/${d}/${j}/output.pptx`,
  docxOutputKey: (s, d, j) => `${s}/${d}/${j}/output.docx`,
  pdfOutputKey: (s, d, j) => `${s}/${d}/${j}/output.pdf`,
  outputReviewKey: (s, d, j) => `${s}/${d}/${j}/review.json`,
  StorageObjectSizeError: class extends Error {},
}));

import {
  prepareDocumentSubmission,
  reserveDocumentSubmission,
  persistSubmissionSource,
  cancelDocumentSubmission,
  assertSubmissionCanStart,
} from "@/lib/document-submission";
import {
  purgeDocumentIfEligible,
  withRetainedDocument,
} from "@/lib/document-retention";
import { eq } from "drizzle-orm";
import * as schema from "@/lib/db/schema";

let pg;
let userId;
let sessionId;
const blobs = new Map();
const PDF = Buffer.from("%PDF-1.7\nsynthetic source fixture\n%%EOF");
const DOCX = Buffer.from("PK\x03\x04synthetic Word source fixture");
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");

function input(overrides = {}) {
  return {
    sessionId,
    filename: "synthetic.pdf",
    fileSizeBytes: PDF.length,
    checksumSha256: hash(PDF),
    outputTarget: "accessible_pdf",
    ...overrides,
  };
}
async function prepare(overrides = {}) {
  return prepareDocumentSubmission(userId, input(overrides));
}
async function documentRows() {
  return (await pg.query("SELECT * FROM documents ORDER BY id")).rows;
}
async function jobRows() {
  return (await pg.query("SELECT * FROM conversion_jobs ORDER BY id")).rows;
}
async function expectOneReservation(ticket) {
  const docs = await documentRows();
  const jobs = await jobRows();
  expect(docs).toHaveLength(1);
  expect(jobs).toHaveLength(1);
  expect(docs[0]).toMatchObject({
    id: ticket.documentId,
    session_id: sessionId,
    uploaded_by_user_id: userId,
    checksum_sha256: hash(PDF),
    file_size_bytes: PDF.length,
  });
  expect(jobs[0]).toMatchObject({
    document_id: ticket.documentId,
    requested_by_user_id: userId,
    status: "queued",
    attempt_count: 0,
    output_target: "accessible_pdf",
  });
  expect(
    new Date(jobs[0].expires_at).getTime() -
      new Date(docs[0].created_at).getTime()
  ).toBe(14 * 24 * 60 * 60 * 1000);
  return docs[0];
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
  // Keep actual schema columns, checks, FKs and unique constraints. Legacy
  // introspected opclasses are omitted; the artifact partial index is restored.
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
  if (fixture.originalSecret === undefined)
    delete process.env.BETTER_AUTH_SECRET;
  else process.env.BETTER_AUTH_SECRET = fixture.originalSecret;
  vi.useRealTimers();
});

beforeEach(async () => {
  vi.useRealTimers();
  await pg.exec(
    "TRUNCATE users, retained_job_metrics, retained_model_metrics, retained_job_stats, retained_job_duration_metrics, daily_failure_metrics CASCADE"
  );
  fixture.commits = 0;
  fixture.onCommit = null;
  blobs.clear();
  fixture.upload
    .mockReset()
    .mockImplementation(async (key, body, _type, options) => {
      expect(options).toMatchObject({ upsert: false });
      if (blobs.has(key)) throw new Error("Synthetic object already exists");
      blobs.set(key, Buffer.from(body));
    });
  fixture.download.mockReset().mockImplementation(async (key, maximum) => {
    const bytes = blobs.get(key);
    if (!bytes) throw new Error("Synthetic object missing");
    expect(bytes.length).toBeLessThanOrEqual(maximum);
    return Buffer.from(bytes);
  });
  fixture.remove.mockReset().mockImplementation(async (keys) => {
    for (const key of keys) blobs.delete(key);
  });
  userId = randomUUID();
  sessionId = randomUUID();
  await pg.query(
    "INSERT INTO users(id,email,display_name) VALUES($1,'submission@example.test','Synthetic owner')",
    [userId]
  );
  await pg.query(
    "INSERT INTO sessions(id,owner_user_id,title) VALUES($1,$2,'Synthetic submissions')",
    [sessionId, userId]
  );
});

describe("initial document submission against isolated PostgreSQL", () => {
  it("issues a bounded server identity without persisting content or reservation state", async () => {
    const before = Date.now();
    const ticket = await prepare();
    expect(ticket.documentId).toMatch(/^[a-f0-9-]{36}$/);
    expect(ticket.submissionToken).toEqual(expect.any(String));
    expect(Date.parse(ticket.expiresAt)).toBeGreaterThan(before);
    expect(Date.parse(ticket.expiresAt)).toBeLessThanOrEqual(
      Date.now() + 10 * 60 * 1000
    );
    expect(await documentRows()).toEqual([]);
    expect(await jobRows()).toEqual([]);
    expect(fixture.upload).not.toHaveBeenCalled();
  });

  it("reuses the signed identity and original expiry for duplicate reservations", async () => {
    const ticket = await prepare();
    const claims = await reserveDocumentSubmission(
      userId,
      ticket.submissionToken
    );
    expect(claims).toMatchObject({
      documentId: ticket.documentId,
      userId,
      ...input(),
    });
    const first = await expectOneReservation(ticket);
    expect(first.upload_completed_at).toBeNull();
    await Promise.all([
      reserveDocumentSubmission(userId, ticket.submissionToken),
      reserveDocumentSubmission(userId, ticket.submissionToken),
    ]);
    const second = await expectOneReservation(ticket);
    expect(second.created_at).toEqual(first.created_at);
    expect(second.upload_expires_at).toEqual(first.upload_expires_at);
    expect(fixture.upload).not.toHaveBeenCalled();
  });

  it("recovers the same reservation after its commit response is lost", async () => {
    const ticket = await prepare();
    fixture.onCommit = async () => {
      throw new Error("Synthetic lost reservation response");
    };
    await reserveDocumentSubmission(userId, ticket.submissionToken).catch(
      () => undefined
    );
    await expectOneReservation(ticket);
    fixture.onCommit = null;
    await reserveDocumentSubmission(userId, ticket.submissionToken);
    await expectOneReservation(ticket);
    expect(fixture.upload).not.toHaveBeenCalled();
  });

  it("rolls back the document if the queued job cannot be inserted", async () => {
    const ticket = await prepare();
    await pg.exec(
      "ALTER TABLE conversion_jobs ADD CONSTRAINT synthetic_reject_job CHECK (false)"
    );
    try {
      await expect(
        reserveDocumentSubmission(userId, ticket.submissionToken)
      ).rejects.toThrow();
      expect(await documentRows()).toEqual([]);
      expect(await jobRows()).toEqual([]);
    } finally {
      await pg.exec(
        "ALTER TABLE conversion_jobs DROP CONSTRAINT synthetic_reject_job"
      );
    }
  });

  it.each([
    { filename: "../private.pdf" },
    { filename: "synthetic.pptx", outputTarget: "accessible_pdf" },
    { fileSizeBytes: 0 },
    { fileSizeBytes: 4 * 1024 * 1024 + 1 },
    { checksumSha256: "invalid" },
    { outputTarget: "unsupported" },
  ])(
    "rejects malformed preflight metadata before persistence: %j",
    async (bad) => {
      await expect(prepare(bad)).rejects.toThrow();
      expect(await documentRows()).toEqual([]);
      expect(await jobRows()).toEqual([]);
    }
  );

  it("rejects another owner and a changed signed capability", async () => {
    const ticket = await prepare();
    const otherUser = randomUUID();
    await pg.query(
      "INSERT INTO users(id,email,display_name) VALUES($1,'other@example.test','Other owner')",
      [otherUser]
    );
    await expect(
      reserveDocumentSubmission(otherUser, ticket.submissionToken)
    ).rejects.toMatchObject({ status: 403 });
    const token = ticket.submissionToken;
    const tampered = `${token.slice(0, -2)}${token.at(-2) === "a" ? "b" : "a"}${token.at(-1)}`;
    await expect(reserveDocumentSubmission(userId, tampered)).rejects.toThrow();
    expect(await documentRows()).toEqual([]);
    expect(fixture.upload).not.toHaveBeenCalled();
  });

  it("rechecks session ownership and archive status at reservation", async () => {
    const ticket = await prepare();
    await pg.query(
      "UPDATE sessions SET archived_at=clock_timestamp() WHERE id=$1",
      [sessionId]
    );
    await expect(
      reserveDocumentSubmission(userId, ticket.submissionToken)
    ).rejects.toThrow();
    expect(await documentRows()).toEqual([]);
  });

  it("persists the exact original once and marks source readiness without starting model work", async () => {
    const ticket = await prepare();
    await persistSubmissionSource(userId, ticket.submissionToken, PDF);
    const saved = await expectOneReservation(ticket);
    expect(saved.upload_completed_at).not.toBeNull();
    expect(blobs.get(`${sessionId}/${ticket.documentId}/source.pdf`)).toEqual(
      PDF
    );
    await persistSubmissionSource(userId, ticket.submissionToken, PDF);
    const replay = await expectOneReservation(ticket);
    expect(replay.created_at).toEqual(saved.created_at);
    expect(replay.upload_completed_at).toEqual(saved.upload_completed_at);
    expect(blobs.size).toBe(1);
    expect((await pg.query("SELECT * FROM model_calls")).rows).toEqual([]);
  });

  it("preserves a DOCX original as DOCX for Canvas without storing a derived PDF", async () => {
    const ticket = await prepare({
      filename: "synthetic.docx",
      fileSizeBytes: DOCX.length,
      checksumSha256: hash(DOCX),
      outputTarget: "canvas_html",
    });
    await persistSubmissionSource(userId, ticket.submissionToken, DOCX);
    expect([...blobs.keys()]).toEqual([
      `${sessionId}/${ticket.documentId}/source.docx`,
    ]);
    expect([...blobs.values()]).toEqual([DOCX]);
    expect((await jobRows())[0]).toMatchObject({
      status: "queued",
      attempt_count: 0,
      output_target: "canvas_html",
    });
  });

  it("rejects altered bytes before creating or uploading the original", async () => {
    const ticket = await prepare();
    const changed = Buffer.from(PDF);
    changed[changed.length - 1] ^= 1;
    await expect(
      persistSubmissionSource(userId, ticket.submissionToken, changed)
    ).rejects.toThrow();
    expect(fixture.upload).not.toHaveBeenCalled();
    expect(blobs.size).toBe(0);
    expect(
      (await documentRows()).every((row) => row.upload_completed_at === null)
    ).toBe(true);
  });

  it("rejects bytes with a correct claimed hash but a mismatched file envelope", async () => {
    const bytes = Buffer.from(
      "not a PDF file with sufficient synthetic length"
    );
    const ticket = await prepare({
      fileSizeBytes: bytes.length,
      checksumSha256: hash(bytes),
    });
    await expect(
      persistSubmissionSource(userId, ticket.submissionToken, bytes)
    ).rejects.toThrow();
    expect(fixture.upload).not.toHaveBeenCalled();
  });

  it("accepts a confirmed identical object after an uncertain upload response", async () => {
    const ticket = await prepare();
    fixture.upload.mockImplementationOnce(
      async (key, bytes, _type, options) => {
        expect(options).toMatchObject({ upsert: false });
        blobs.set(key, Buffer.from(bytes));
        throw new Error("Synthetic lost upload response");
      }
    );
    await persistSubmissionSource(userId, ticket.submissionToken, PDF);
    expect(
      (await expectOneReservation(ticket)).upload_completed_at
    ).not.toBeNull();
    expect(fixture.download).toHaveBeenCalled();
    expect([...blobs.values()]).toEqual([PDF]);
  });

  it("does not mark a source ready when the existing object has different bytes", async () => {
    const ticket = await prepare();
    await reserveDocumentSubmission(userId, ticket.submissionToken);
    const key = `${sessionId}/${ticket.documentId}/source.pdf`;
    const conflicting = Buffer.from(PDF);
    conflicting[conflicting.length - 1] ^= 1;
    blobs.set(key, conflicting);
    await expect(
      persistSubmissionSource(userId, ticket.submissionToken, PDF)
    ).rejects.toMatchObject({ status: 409 });
    expect((await expectOneReservation(ticket)).upload_completed_at).toBeNull();
    expect(blobs.get(key)).toEqual(conflicting);
    expect(fixture.remove).not.toHaveBeenCalled();
  });

  it("keeps an incomplete reservation discoverable when upload and reconciliation both fail", async () => {
    const ticket = await prepare();
    fixture.upload.mockRejectedValueOnce(
      new Error("Synthetic unavailable upload")
    );
    await expect(
      persistSubmissionSource(userId, ticket.submissionToken, PDF)
    ).rejects.toThrow();
    expect((await expectOneReservation(ticket)).upload_completed_at).toBeNull();
    expect(fixture.remove).not.toHaveBeenCalled();
    await persistSubmissionSource(userId, ticket.submissionToken, PDF);
    expect(
      (await expectOneReservation(ticket)).upload_completed_at
    ).not.toBeNull();
  });

  it("retains ready source data when the source-readiness commit response is lost", async () => {
    const ticket = await prepare();
    fixture.onCommit = async () => {
      if ((await documentRows())[0]?.upload_completed_at)
        throw new Error("Synthetic lost ready response");
    };
    await persistSubmissionSource(userId, ticket.submissionToken, PDF).catch(
      () => undefined
    );
    const saved = await expectOneReservation(ticket);
    expect(saved.upload_completed_at).not.toBeNull();
    fixture.onCommit = null;
    await persistSubmissionSource(userId, ticket.submissionToken, PDF);
    expect((await expectOneReservation(ticket)).upload_completed_at).toEqual(
      saved.upload_completed_at
    );
    expect([...blobs.values()]).toEqual([PDF]);
  });

  it("cancels before reservation using a retained tombstone that prevents resurrection", async () => {
    const ticket = await prepare();
    await cancelDocumentSubmission(userId, ticket.submissionToken);
    const docs = await documentRows();
    expect(docs).toHaveLength(1);
    expect(docs[0]).toMatchObject({
      id: ticket.documentId,
      uploaded_by_user_id: userId,
      session_id: sessionId,
    });
    expect(docs[0].deleted_at).not.toBeNull();
    expect(
      new Date(docs[0].upload_expires_at).getTime()
    ).toBeGreaterThanOrEqual(Date.parse(ticket.expiresAt));
    expect(await purgeDocumentIfEligible(ticket.documentId)).toBe("retained");
    await expect(
      reserveDocumentSubmission(userId, ticket.submissionToken)
    ).rejects.toMatchObject({ status: 410 });
    await expect(
      persistSubmissionSource(userId, ticket.submissionToken, PDF)
    ).rejects.toMatchObject({ status: 410 });
    expect(fixture.upload).not.toHaveBeenCalled();
    expect((await documentRows())[0].deleted_at).toEqual(docs[0].deleted_at);
  });

  it.each(["reserve-first", "cancel-first"])(
    "serializes duplicate reserve/cancel requests without resurrection (%s)",
    async (order) => {
      const ticket = await prepare();
      const reserve = () =>
        reserveDocumentSubmission(userId, ticket.submissionToken);
      const cancel = () =>
        cancelDocumentSubmission(userId, ticket.submissionToken);
      await Promise.allSettled(
        order === "reserve-first"
          ? [reserve(), cancel()]
          : [cancel(), reserve()]
      );
      const docs = await documentRows();
      expect(docs).toHaveLength(1);
      expect(docs[0].id).toBe(ticket.documentId);
      expect(docs[0].deleted_at).not.toBeNull();
      await expect(reserve()).rejects.toMatchObject({ status: 410 });
      expect(fixture.upload).not.toHaveBeenCalled();
    }
  );

  it("serializes cancellation with an in-flight original upload and prevents later replay", async () => {
    const ticket = await prepare();
    let enterUpload;
    let finishUpload;
    const entered = new Promise((resolve) => {
      enterUpload = resolve;
    });
    const gate = new Promise((resolve) => {
      finishUpload = resolve;
    });
    fixture.upload.mockImplementationOnce(async (key, bytes) => {
      enterUpload();
      await gate;
      blobs.set(key, Buffer.from(bytes));
    });
    const uploading = persistSubmissionSource(
      userId,
      ticket.submissionToken,
      PDF
    );
    await entered;
    let cancelled = false;
    const cancellation = cancelDocumentSubmission(
      userId,
      ticket.submissionToken
    ).then(() => {
      cancelled = true;
    });
    await Promise.resolve();
    expect(cancelled).toBe(false);
    finishUpload();
    await Promise.all([uploading, cancellation]);
    const docs = await documentRows();
    expect(docs).toHaveLength(1);
    expect(docs[0].deleted_at).not.toBeNull();
    expect(docs[0].upload_completed_at).not.toBeNull();
    expect(blobs.get(`${sessionId}/${ticket.documentId}/source.pdf`)).toEqual(
      PDF
    );
    await expect(
      persistSubmissionSource(userId, ticket.submissionToken, PDF)
    ).rejects.toMatchObject({ status: 410 });
    expect(fixture.upload).toHaveBeenCalledTimes(1);
  });

  it("keeps discovery when an uncertain original write finishes after cancellation", async () => {
    const ticket = await prepare();
    let finishLateWrite;
    fixture.upload.mockImplementationOnce(async (key, bytes) => {
      finishLateWrite = () => blobs.set(key, Buffer.from(bytes));
      throw new Error("Synthetic lost upload connection");
    });
    await expect(
      persistSubmissionSource(userId, ticket.submissionToken, PDF)
    ).rejects.toMatchObject({ status: 503 });
    await cancelDocumentSubmission(userId, ticket.submissionToken);
    expect(await purgeDocumentIfEligible(ticket.documentId)).toBe("retained");
    finishLateWrite();
    expect(await purgeDocumentIfEligible(ticket.documentId)).toBe("retained");
    expect((await documentRows())[0]).toMatchObject({
      id: ticket.documentId,
      session_id: sessionId,
    });
    expect((await documentRows())[0].deleted_at).not.toBeNull();
    expect([...blobs.keys()]).toEqual([
      `${sessionId}/${ticket.documentId}/source.pdf`,
    ]);
    expect(fixture.remove).not.toHaveBeenCalled();
  });

  it("does not count cancellation before reservation against the live pending-upload cap", async () => {
    for (let count = 0; count < 3; count++) {
      const ticket = await prepare();
      await cancelDocumentSubmission(userId, ticket.submissionToken);
    }
    const fresh = await prepare();
    await reserveDocumentSubmission(userId, fresh.submissionToken);
    const docs = await documentRows();
    expect(docs).toHaveLength(4);
    expect(docs.filter((row) => row.deleted_at !== null)).toHaveLength(3);
    expect(
      docs.find((row) => row.id === fresh.documentId).deleted_at
    ).toBeNull();
    expect(await jobRows()).toHaveLength(1);
  });

  it("keeps cancelled existing reservations in the pending cap while uploads can still arrive", async () => {
    for (let count = 0; count < 3; count++) {
      const ticket = await prepare({
        filename: "synthetic.pptx",
        fileSizeBytes: DOCX.length,
        checksumSha256: hash(DOCX),
        outputTarget: "accessible_pptx",
      });
      await reserveDocumentSubmission(userId, ticket.submissionToken);
      await cancelDocumentSubmission(userId, ticket.submissionToken);
    }
    const fresh = await prepare();
    await expect(
      reserveDocumentSubmission(userId, fresh.submissionToken)
    ).rejects.toMatchObject({ status: 429 });
    const docs = await documentRows();
    expect(docs).toHaveLength(3);
    expect(
      docs.every(
        (row) => row.deleted_at !== null && row.upload_completed_at === null
      )
    ).toBe(true);
    expect(await jobRows()).toHaveLength(3);
    expect(fixture.upload).not.toHaveBeenCalled();
  });

  it("allows the queued initial attempt once and rejects all billable replays", async () => {
    const ticket = await prepare();
    const claims = await persistSubmissionSource(
      userId,
      ticket.submissionToken,
      PDF
    );
    let starts = 0;
    const start = () =>
      withRetainedDocument(ticket.documentId, async (tx) => {
        await assertSubmissionCanStart(tx, claims);
        starts++;
        await tx
          .update(schema.conversionJobs)
          .set({ status: "processing", attemptCount: 1 })
          .where(eq(schema.conversionJobs.documentId, ticket.documentId));
      });
    await start();
    for (const status of ["processing", "completed", "failed"]) {
      await pg.query(
        "UPDATE conversion_jobs SET status=$1 WHERE document_id=$2",
        [status, ticket.documentId]
      );
      await expect(start()).rejects.toMatchObject({ status: 409 });
    }
    expect(starts).toBe(1);
    expect((await pg.query("SELECT * FROM model_calls")).rows).toEqual([]);
    expect((await jobRows())[0]).toMatchObject({
      attempt_count: 1,
      status: "failed",
    });
  });

  it("rejects expired capabilities and never creates a missing tombstone for one", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() - 11 * 60 * 1000);
    const ticket = await prepare();
    vi.useRealTimers();
    await expect(
      reserveDocumentSubmission(userId, ticket.submissionToken)
    ).rejects.toMatchObject({ status: 410 });
    await cancelDocumentSubmission(userId, ticket.submissionToken);
    expect(await documentRows()).toEqual([]);
    expect(await jobRows()).toEqual([]);
  });

  it("allows an expired signed capability to cancel its existing reservation", async () => {
    const ticket = await prepare();
    await reserveDocumentSubmission(userId, ticket.submissionToken);
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.parse(ticket.expiresAt) + 1);
    await cancelDocumentSubmission(userId, ticket.submissionToken);
    vi.useRealTimers();
    expect((await documentRows())[0].deleted_at).not.toBeNull();
  });
});
