import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { resolve } from "node:path";

const fixture = vi.hoisted(() => ({
  db: null,
  onCommit: null,
  commits: 0,
  upload: vi.fn(),
  sign: vi.fn(),
  remove: vi.fn(),
}));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/db", () => ({
  db: new Proxy({}, {
    get(_target, property) {
      if (!fixture.db) throw new Error("Isolated PostgreSQL is not initialized.");
      if (property === "transaction") return async (action) => {
        const result = await fixture.db.transaction(action);
        fixture.commits += 1;
        if (fixture.onCommit) await fixture.onCommit(fixture.commits);
        return result;
      };
      const value = fixture.db[property];
      return typeof value === "function" ? value.bind(fixture.db) : value;
    },
  }),
}));
vi.mock("@/lib/storage", () => ({
  uploadObject: fixture.upload,
  createSignedUrl: fixture.sign,
  removeObjects: fixture.remove,
  sourceDocxKey: (s, d) => `${s}/${d}/source.docx`,
  sourcePdfKey: (s, d) => `${s}/${d}/source.pdf`,
  sourcePptxKey: (s, d) => `${s}/${d}/source.pptx`,
  htmlOutputKey: (s, d) => `${s}/${d}/output.html`,
  pptxOutputKey: (s, d, j) => `${s}/${d}/${j}/output.pptx`,
  docxOutputKey: (s, d, j) => `${s}/${d}/${j}/output.docx`,
  pdfOutputKey: (s, d, j) => `${s}/${d}/${j}/output.pdf`,
  outputReviewKey: (s, d, j) => `${s}/${d}/${j}/review.json`,
}));

import { createNativePdfTransport } from "@/lib/native-pdf-transport-storage";
import { DocumentUnavailableError, purgeDocumentIfEligible, withRetainedDocument } from "@/lib/document-retention";
import * as schema from "@/lib/db/schema";

let pg;
let context;
const blobs = new Map();
const payload = Buffer.from('{"synthetic":"private PDF transport request"}');
const checksum = createHash("sha256").update(payload).digest("hex");

async function receipts() {
  return (await pg.query("SELECT * FROM artifacts WHERE filename='native-pdf-request.json' ORDER BY created_at")).rows;
}

async function expireReceipt() {
  await pg.exec("UPDATE artifacts SET created_at=clock_timestamp()-interval '61 minutes' WHERE filename='native-pdf-request.json'");
}

async function tombstone() {
  await pg.query("UPDATE documents SET deleted_at=clock_timestamp() WHERE id=$1", [context.documentId]);
}

async function invoke(action = async () => "repaired") {
  return createNativePdfTransport(context)(payload, new AbortController().signal, action);
}

beforeAll(async () => {
  const runtime = process.env.PGLITE_RUNTIME_DIR;
  if (!runtime) throw new Error("Set PGLITE_RUNTIME_DIR to the isolated PostgreSQL/WASM runtime directory.");
  const runtimeRequire = createRequire(resolve(runtime, "package.json"));
  const { PGlite } = runtimeRequire("@electric-sql/pglite");
  const { drizzle } = runtimeRequire("drizzle-orm/pglite");
  pg = new PGlite("memory://");
  fixture.db = drizzle(pg, { schema });
  const require = createRequire(import.meta.url);
  const { generateDrizzleJson, generateMigration } = require("drizzle-kit/api");
  const snapshot = JSON.parse(await readFile(new URL("../drizzle/meta/0016_snapshot.json", import.meta.url), "utf8"));
  snapshot.views = {};
  // Retain actual columns/checks/FKs/enums while omitting legacy introspected
  // index opclass mistakes. Recreate the relevant partial uniqueness exactly.
  for (const table of Object.values(snapshot.tables)) table.indexes = {};
  for (const statement of await generateMigration(generateDrizzleJson({}), snapshot)) await pg.exec(statement);
  await pg.exec("CREATE UNIQUE INDEX uq_available_artifact_per_job_type ON artifacts(job_id, artifact_type) WHERE artifact_status='available'");
});

afterAll(async () => { if (pg) await pg.close(); });

beforeEach(async () => {
  await pg.exec("TRUNCATE users, retained_job_metrics, retained_model_metrics, retained_job_stats, retained_job_duration_metrics, daily_failure_metrics CASCADE");
  fixture.onCommit = null;
  fixture.commits = 0;
  blobs.clear();
  fixture.upload.mockReset().mockImplementation(async (key, bytes) => { blobs.set(key, Buffer.from(bytes)); });
  fixture.sign.mockReset().mockImplementation(async (key) => `https://synthetic.supabase.co/storage/v1/object/sign/documents/${key}?token=test.test.test`);
  fixture.remove.mockReset().mockImplementation(async (keys) => { for (const key of keys) blobs.delete(key); });
  const userId = randomUUID(), sessionId = randomUUID(), documentId = randomUUID(), jobId = randomUUID();
  context = { userId, sessionId, documentId, jobId, attemptNumber: 1 };
  await pg.query("INSERT INTO users(id,email,display_name) VALUES($1,'transport@example.test','Synthetic owner')", [userId]);
  await pg.query("INSERT INTO sessions(id,owner_user_id,title) VALUES($1,$2,'Synthetic transport')", [sessionId,userId]);
  await pg.query(`INSERT INTO documents(id,session_id,uploaded_by_user_id,original_filename,mime_type,file_size_bytes,created_at)
    VALUES($1,$2,$3,'synthetic.pdf','application/pdf',100,clock_timestamp()-interval '1 hour')`, [documentId,sessionId,userId]);
  await pg.query(`INSERT INTO conversion_jobs(id,document_id,requested_by_user_id,status,provider,output_target,profile_version,attempt_count,expires_at)
    VALUES($1,$2,$3,'processing','synthetic','accessible_pdf','pdf-v1',1,clock_timestamp()+interval '12 hours')`, [jobId,documentId,userId]);
});

describe("native PDF transport against isolated PostgreSQL", () => {
  it("commits a non-downloadable receipt before upload and preserves the available review artifact", async () => {
    const reviewKey = `${context.sessionId}/${context.documentId}/${context.jobId}/review.json`;
    await pg.query(`INSERT INTO artifacts(job_id,artifact_type,filename,mime_type,storage_key)
      VALUES($1,'review_metadata','review.json','application/json',$2)`, [context.jobId,reviewKey]);
    let committed;
    fixture.onCommit = async (count) => { if (count === 1) committed = await receipts(); };
    fixture.upload.mockImplementation(async (key, bytes) => {
      expect(committed).toHaveLength(1);
      expect(committed[0]).toMatchObject({ artifact_status: "expired", artifact_type: "review_metadata", is_user_downloadable: false,
        storage_key: key, checksum_sha256: checksum, file_size_bytes: payload.length });
      blobs.set(key, Buffer.from(bytes));
    });
    const result = await invoke(async (descriptor) => {
      // This read would be stuck behind PGlite's active transaction if the
      // worker action were accidentally called while retaining the DB lock.
      expect(await receipts()).toHaveLength(1);
      expect(descriptor).toMatchObject({ requestSha256: checksum, requestBytes: payload.length });
      return "actual action result";
    });
    expect(result).toBe("actual action result");
    expect(fixture.sign.mock.calls[0][1]).toBeLessThanOrEqual(60);
    expect(await receipts()).toEqual([]);
    expect(blobs.size).toBe(0);
    const available = await pg.query("SELECT storage_key FROM artifacts WHERE artifact_status='available'");
    expect(available.rows).toEqual([{ storage_key: reviewKey }]);
  });

  it("cleans confirmed upload after a failed worker action without replacing its error", async () => {
    const expected = new Error("synthetic worker failure");
    await expect(invoke(async () => { throw expected; })).rejects.toBe(expected);
    expect(await receipts()).toEqual([]);
    expect(blobs.size).toBe(0);
  });

  it("retains failed-delete discovery and lets ordinary purge remove the exact random key after settlement", async () => {
    fixture.remove.mockRejectedValueOnce(new Error("synthetic remove failure"));
    expect(await invoke()).toBe("repaired");
    const [receipt] = await receipts();
    expect(blobs.has(receipt.storage_key)).toBe(true);
    await tombstone();
    expect(await purgeDocumentIfEligible(context.documentId)).toBe("retained");
    await expireReceipt();
    expect(await purgeDocumentIfEligible(context.documentId)).toBe("purged");
    expect(fixture.remove.mock.calls.at(-1)[0]).toContain(receipt.storage_key);
    expect(await receipts()).toEqual([]);
    expect(blobs.size).toBe(0);
  });

  it("keeps discovery through a late upload after abort and immediate document deletion", async () => {
    let key;
    fixture.upload.mockImplementation(async (path) => { key = path; throw new Error("ambiguous upload response"); });
    await expect(invoke()).rejects.toThrow("Could not prepare the private PDF repair request.");
    expect(await receipts()).toHaveLength(1);
    expect(blobs.size).toBe(0); // Immediate cleanup already returned successfully.
    await tombstone();
    expect(await purgeDocumentIfEligible(context.documentId)).toBe("retained");
    blobs.set(key, Buffer.from(payload)); // Storage finishes the earlier request late.
    expect(await receipts()).toHaveLength(1);
    await expireReceipt();
    expect(await purgeDocumentIfEligible(context.documentId)).toBe("purged");
    expect(blobs.has(key)).toBe(false);
    expect(await receipts()).toEqual([]);
  });

  it("blocks retrieval at 14 days while preserving an unsettled receipt for physical cleanup", async () => {
    fixture.upload.mockRejectedValueOnce(new Error("ambiguous upload"));
    await expect(invoke()).rejects.toThrow();
    await pg.query("UPDATE documents SET created_at=clock_timestamp()-interval '337 hours' WHERE id=$1", [context.documentId]);
    await expect(withRetainedDocument(context.documentId, async () => "private")).rejects.toBeInstanceOf(DocumentUnavailableError);
    expect(await purgeDocumentIfEligible(context.documentId)).toBe("retained");
    await expireReceipt();
    expect(await purgeDocumentIfEligible(context.documentId)).toBe("purged");
  });

  it.each(["expired", "superseded", "deleted"])("reauthorizes %s state between receipt commit and upload", async (change) => {
    fixture.onCommit = async (count) => {
      if (count !== 1) return;
      expect(await receipts()).toHaveLength(1);
      if (change === "expired") await pg.query("UPDATE documents SET created_at=clock_timestamp()-interval '337 hours' WHERE id=$1", [context.documentId]);
      else if (change === "superseded") await pg.query("UPDATE conversion_jobs SET attempt_count=2 WHERE id=$1", [context.jobId]);
      else await tombstone();
    };
    await expect(invoke()).rejects.toThrow();
    expect(fixture.upload).not.toHaveBeenCalled();
    expect(fixture.sign).not.toHaveBeenCalled();
    expect(await receipts()).toEqual([]); // No upload began, so cleanup is settled.
  });

  it.each(["owner", "requester", "target", "profile", "status", "attempt", "job expiry"])("rejects incorrect %s before committing a receipt", async (kind) => {
    if (kind === "owner") {
      const stranger = randomUUID();
      await pg.query("INSERT INTO users(id,email,display_name) VALUES($1,'stranger@example.test','Synthetic stranger')", [stranger]);
      await pg.query("UPDATE sessions SET owner_user_id=$1 WHERE id=$2", [stranger,context.sessionId]);
    } else if (kind === "requester") context.userId = randomUUID();
    else if (kind === "target") await pg.query("UPDATE conversion_jobs SET output_target='canvas_html' WHERE id=$1", [context.jobId]);
    else if (kind === "profile") await pg.query("UPDATE conversion_jobs SET profile_version='other' WHERE id=$1", [context.jobId]);
    else if (kind === "status") await pg.query("UPDATE conversion_jobs SET status='failed' WHERE id=$1", [context.jobId]);
    else if (kind === "attempt") context.attemptNumber = 2;
    else await pg.query("UPDATE conversion_jobs SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1", [context.jobId]);
    await expect(invoke()).rejects.toThrow();
    expect(await receipts()).toEqual([]);
    expect(fixture.upload).not.toHaveBeenCalled();
  });

  it("does not delay purge for an unrelated expired review artifact", async () => {
    await pg.query(`INSERT INTO artifacts(job_id,artifact_type,artifact_status,filename,mime_type,storage_key,is_user_downloadable)
      VALUES($1,'review_metadata','expired','review.json','application/json','synthetic-old-review',false)`, [context.jobId]);
    await tombstone();
    expect(await purgeDocumentIfEligible(context.documentId)).toBe("purged");
  });
});
