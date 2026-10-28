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
import { eq, sql } from "drizzle-orm";

const fixture = vi.hoisted(() => ({
  db: null,
  onCommit: null,
  beforeTransaction: null,
  commits: 0,
  transactions: 0,
  upload: vi.fn(),
  remove: vi.fn(),
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
          return async (action) => {
            fixture.transactions += 1;
            if (fixture.beforeTransaction)
              await fixture.beforeTransaction(fixture.transactions);
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

import {
  publishConversionArtifacts,
  PublicationUncertainError,
} from "@/lib/conversion-publication";
import {
  DocumentUnavailableError,
  purgeDocumentIfEligible,
} from "@/lib/document-retention";
import * as schema from "@/lib/db/schema";

let pg;
let context;
let generated;
let oldArtifacts;
let usageId;
const blobs = new Map();

async function artifacts(status) {
  return (
    await pg.query(
      "SELECT * FROM artifacts WHERE job_id=$1 AND artifact_status=$2 ORDER BY artifact_type",
      [context.jobId, status]
    )
  ).rows;
}

async function candidates() {
  return (
    await pg.query(
      "SELECT * FROM artifacts WHERE job_id=$1 AND storage_key LIKE '%/publication-%' ORDER BY artifact_type",
      [context.jobId]
    )
  ).rows;
}

async function findingMessages() {
  return (
    await pg.query(
      "SELECT message FROM validation_findings WHERE job_id=$1 ORDER BY message",
      [context.jobId]
    )
  ).rows.map((row) => row.message);
}

async function usageReceipts() {
  return (
    await pg.query(
      "SELECT id,prompt_tokens,completion_tokens FROM model_calls WHERE job_id=$1",
      [context.jobId]
    )
  ).rows;
}

async function assertPreviousResult() {
  const available = await artifacts("available");
  const byType = (left, right) =>
    left.artifact_type.localeCompare(right.artifact_type);
  expect(
    available
      .map(({ artifact_type, storage_key }) => ({ artifact_type, storage_key }))
      .sort(byType)
  ).toEqual([...oldArtifacts].sort(byType));
  for (const row of oldArtifacts)
    expect(blobs.get(row.storage_key).toString()).toBe(
      `old ${row.artifact_type}`
    );
  expect(await findingMessages()).toEqual(["Old reviewed finding"]);
}

async function publish(afterPersist = async () => {}) {
  return publishConversionArtifacts(
    context,
    generated,
    async (tx) => {
      await tx
        .delete(schema.validationFindings)
        .where(eq(schema.validationFindings.jobId, context.jobId));
      await tx
        .insert(schema.validationFindings)
        .values({
          jobId: context.jobId,
          severity: "warning",
          ruleCode: "synthetic",
          title: "Synthetic finding",
          message: "New reviewed finding",
        });
      await tx
        .update(schema.conversionJobs)
        .set({ status: "completed" })
        .where(eq(schema.conversionJobs.id, context.jobId));
      await afterPersist(tx);
    },
    async (tx) => {
      await tx
        .insert(schema.modelCalls)
        .values({
          id: usageId,
          jobId: context.jobId,
          stage: "convert",
          model: "synthetic",
          promptTokens: 7,
          completionTokens: 3,
        })
        .onConflictDoNothing({ target: schema.modelCalls.id });
    }
  );
}

async function tombstone() {
  await pg.query(
    "UPDATE documents SET deleted_at=clock_timestamp() WHERE id=$1",
    [context.documentId]
  );
}

async function changeTarget(outputTarget, artifactType, extension, mimeType) {
  context.outputTarget = outputTarget;
  await pg.query("UPDATE conversion_jobs SET output_target=$1 WHERE id=$2", [
    outputTarget,
    context.jobId,
  ]);
  const oldOutput = oldArtifacts.find(
    (row) => row.artifact_type === "pdf_output"
  );
  blobs.delete(oldOutput.storage_key);
  oldOutput.artifact_type = artifactType;
  oldOutput.storage_key =
    extension === "html"
      ? `${context.sessionId}/${context.documentId}/output.html`
      : `${context.sessionId}/${context.documentId}/${context.jobId}/output.${extension}`;
  blobs.set(oldOutput.storage_key, Buffer.from(`old ${artifactType}`));
  await pg.query(
    "UPDATE artifacts SET artifact_type=$1,storage_key=$2 WHERE job_id=$3 AND artifact_type='pdf_output'",
    [artifactType, oldOutput.storage_key, context.jobId]
  );
  oldArtifacts.sort((left, right) =>
    left.artifact_type.localeCompare(right.artifact_type)
  );
  generated[0] = {
    artifactType,
    filename: `synthetic-repaired.${extension}`,
    mimeType,
    body: Buffer.from(`new ${artifactType}`),
  };
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
  // Keep real columns/checks/FKs/enums. Omit legacy introspected opclass errors
  // and recreate the publication-critical partial uniqueness exactly.
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
  fixture.onCommit = null;
  fixture.beforeTransaction = null;
  fixture.commits = 0;
  fixture.transactions = 0;
  blobs.clear();
  fixture.upload.mockReset().mockImplementation(async (key, body) => {
    blobs.set(key, Buffer.from(body));
  });
  fixture.remove.mockReset().mockImplementation(async (keys) => {
    for (const key of keys) blobs.delete(key);
  });
  context = {
    userId: randomUUID(),
    sessionId: randomUUID(),
    documentId: randomUUID(),
    jobId: randomUUID(),
    attemptNumber: 2,
    outputTarget: "accessible_pdf",
  };
  usageId = randomUUID();
  generated = [
    {
      artifactType: "pdf_output",
      filename: "synthetic-repaired.pdf",
      mimeType: "application/pdf",
      body: Buffer.from("new pdf_output"),
    },
    {
      artifactType: "review_metadata",
      filename: "review.json",
      mimeType: "application/json",
      body: '{"review":"new"}',
      isUserDownloadable: false,
    },
  ];
  await pg.query(
    "INSERT INTO users(id,email,display_name) VALUES($1,'publication@example.test','Synthetic owner')",
    [context.userId]
  );
  await pg.query(
    "INSERT INTO sessions(id,owner_user_id,title) VALUES($1,$2,'Synthetic publication')",
    [context.sessionId, context.userId]
  );
  await pg.query(
    "INSERT INTO documents(id,session_id,uploaded_by_user_id,original_filename,mime_type,file_size_bytes,created_at) VALUES($1,$2,$3,'synthetic.pdf','application/pdf',100,clock_timestamp()-interval '1 hour')",
    [context.documentId, context.sessionId, context.userId]
  );
  await pg.query(
    "INSERT INTO conversion_jobs(id,document_id,requested_by_user_id,status,provider,output_target,profile_version,attempt_count,expires_at) VALUES($1,$2,$3,'processing','synthetic','accessible_pdf','pdf-v1',2,clock_timestamp()+interval '12 hours')",
    [context.jobId, context.documentId, context.userId]
  );
  oldArtifacts = [
    {
      artifact_type: "pdf_output",
      storage_key: `${context.sessionId}/${context.documentId}/${context.jobId}/output.pdf`,
    },
    {
      artifact_type: "review_metadata",
      storage_key: `${context.sessionId}/${context.documentId}/${context.jobId}/review.json`,
    },
  ];
  for (const row of oldArtifacts) {
    blobs.set(row.storage_key, Buffer.from(`old ${row.artifact_type}`));
    await pg.query(
      "INSERT INTO artifacts(job_id,artifact_type,filename,mime_type,storage_key) VALUES($1,$2,$3,'application/octet-stream',$4)",
      [context.jobId, row.artifact_type, row.artifact_type, row.storage_key]
    );
  }
  await pg.query(
    "INSERT INTO validation_findings(job_id,severity,rule_code,title,message) VALUES($1,'warning','synthetic','Synthetic finding','Old reviewed finding')",
    [context.jobId]
  );
});

describe("immutable conversion publication against isolated PostgreSQL", () => {
  it("commits private cleanup receipts before any upload and atomically replaces the legacy pair", async () => {
    let committed;
    fixture.onCommit = async (count) => {
      if (count === 1) committed = await candidates();
    };
    fixture.upload.mockImplementation(async (key, body, _mime, options) => {
      expect(committed).toHaveLength(generated.length);
      expect(
        committed.every(
          (row) =>
            row.artifact_status === "expired" &&
            row.is_user_downloadable === false
        )
      ).toBe(true);
      expect(
        committed.some(
          (row) =>
            row.artifact_type === "review_metadata" &&
            row.filename === "conversion-publication.json"
        )
      ).toBe(true);
      expect(committed.map((row) => row.storage_key)).toContain(key);
      expect(options.upsert).toBe(false);
      expect(options.signal).toBeInstanceOf(AbortSignal);
      blobs.set(key, Buffer.from(body));
    });
    expect(await publish()).toBe(true);
    const available = await artifacts("available");
    expect(available).toHaveLength(2);
    for (const item of generated) {
      const row = available.find(
        (entry) => entry.artifact_type === item.artifactType
      );
      expect(row.storage_key).toContain(`/${context.jobId}/publication-`);
      expect(row.storage_key).not.toBe(
        oldArtifacts.find((entry) => entry.artifact_type === item.artifactType)
          .storage_key
      );
      expect(blobs.get(row.storage_key)).toEqual(Buffer.from(item.body));
      expect(row.checksum_sha256).toBe(
        createHash("sha256").update(item.body).digest("hex")
      );
      expect(row.file_size_bytes).toBe(Buffer.byteLength(item.body));
    }
    expect(
      available.find((row) => row.artifact_type === "review_metadata").filename
    ).toBe("review.json");
    expect(
      (await artifacts("expired")).map((row) => row.storage_key).sort()
    ).toEqual(oldArtifacts.map((row) => row.storage_key).sort());
    expect(await findingMessages()).toEqual(["New reviewed finding"]);
    for (const row of oldArtifacts)
      expect(blobs.get(row.storage_key).toString()).toBe(
        `old ${row.artifact_type}`
      );
    expect(await usageReceipts()).toEqual([
      { id: usageId, prompt_tokens: 7, completion_tokens: 3 },
    ]);
  });

  it("preserves previous bytes, findings and pointers when the second blob upload fails", async () => {
    fixture.upload.mockImplementationOnce(async (key, body) => {
      blobs.set(key, Buffer.from(body));
    });
    fixture.upload.mockRejectedValueOnce(
      new Error("synthetic second upload failure")
    );
    await expect(publish()).rejects.toThrow();
    await assertPreviousResult();
    expect(await candidates()).toHaveLength(2);
    expect(
      (await candidates()).every((row) => row.artifact_status === "expired")
    ).toBe(true);
    expect(fixture.remove).not.toHaveBeenCalled();
    expect(await usageReceipts()).toEqual([
      { id: usageId, prompt_tokens: 7, completion_tokens: 3 },
    ]);
  });

  it("rolls back promoted artifacts and replaced findings if the final metadata write fails", async () => {
    await expect(
      publish(async () => {
        throw new Error("synthetic final write failure");
      })
    ).rejects.toThrow();
    await assertPreviousResult();
    const pending = await candidates();
    expect(pending.every((row) => row.artifact_status === "expired")).toBe(
      true
    );
    for (const row of pending) expect(blobs.has(row.storage_key)).toBe(true);
  });

  it("recognizes a committed publication after its transaction response is lost", async () => {
    fixture.onCommit = async (count) => {
      if (count === 2) throw new Error("synthetic COMMIT acknowledgement lost");
    };
    expect(await publish()).toBe(true);
    expect(
      (await artifacts("available")).every((row) =>
        row.storage_key.includes("/publication-")
      )
    ).toBe(true);
    expect(await findingMessages()).toEqual(["New reviewed finding"]);
    expect(
      (
        await pg.query("SELECT status FROM conversion_jobs WHERE id=$1", [
          context.jobId,
        ])
      ).rows[0].status
    ).toBe("completed");
    expect(fixture.remove).not.toHaveBeenCalled();
    expect(await usageReceipts()).toEqual([
      { id: usageId, prompt_tokens: 7, completion_tokens: 3 },
    ]);
  });

  it("preserves a newer completed result when an older COMMIT acknowledgement is lost", async () => {
    const newer = generated.map((item) => ({
      artifact_type: item.artifactType,
      storage_key: `${context.sessionId}/${context.documentId}/${context.jobId}/newer-${item.artifactType}`,
    }));
    fixture.onCommit = async (count) => {
      if (count !== 2) return;
      await pg.query(
        "UPDATE conversion_jobs SET attempt_count=3,status='completed' WHERE id=$1",
        [context.jobId]
      );
      await pg.query(
        "UPDATE artifacts SET artifact_status='expired' WHERE job_id=$1",
        [context.jobId]
      );
      for (const row of newer) {
        blobs.set(row.storage_key, Buffer.from(`newer ${row.artifact_type}`));
        await pg.query(
          "INSERT INTO artifacts(job_id,artifact_type,filename,mime_type,storage_key) VALUES($1,$2,$3,'application/octet-stream',$4)",
          [context.jobId, row.artifact_type, row.artifact_type, row.storage_key]
        );
      }
      await pg.query(
        "UPDATE validation_findings SET message='Newer reviewed finding' WHERE job_id=$1",
        [context.jobId]
      );
      throw new Error("synthetic old COMMIT acknowledgement lost");
    };
    expect(await publish()).toBe(false);
    const available = await artifacts("available");
    expect(available.map((row) => row.storage_key).sort()).toEqual(
      newer.map((row) => row.storage_key).sort()
    );
    for (const row of newer)
      expect(blobs.get(row.storage_key).toString()).toBe(
        `newer ${row.artifact_type}`
      );
    expect(await findingMessages()).toEqual(["Newer reviewed finding"]);
    expect(
      (
        await pg.query(
          "SELECT status,attempt_count FROM conversion_jobs WHERE id=$1",
          [context.jobId]
        )
      ).rows
    ).toEqual([{ status: "completed", attempt_count: 3 }]);
    expect(await usageReceipts()).toEqual([
      { id: usageId, prompt_tokens: 7, completion_tokens: 3 },
    ]);
    expect(fixture.remove).not.toHaveBeenCalled();
  });

  it("does not upload after an ambiguous receipt reservation", async () => {
    fixture.onCommit = async (count) => {
      if (count === 1)
        throw new Error("synthetic receipt COMMIT acknowledgement lost");
    };
    await expect(publish()).rejects.toThrow();
    expect(fixture.upload).not.toHaveBeenCalled();
    expect(await candidates()).toHaveLength(2);
    await assertPreviousResult();
  });

  it("preserves committed blobs when reconciliation is unavailable after ambiguous COMMIT", async () => {
    fixture.onCommit = async (count) => {
      if (count === 2) throw new Error("synthetic COMMIT acknowledgement lost");
    };
    fixture.beforeTransaction = async (count) => {
      if (count >= 3) throw new Error("synthetic reconciliation unavailable");
    };
    await expect(publish()).rejects.toBeInstanceOf(PublicationUncertainError);
    const current = await artifacts("available");
    expect(current).toHaveLength(2);
    for (const row of current) expect(blobs.has(row.storage_key)).toBe(true);
    expect(await findingMessages()).toEqual(["New reviewed finding"]);
    expect(fixture.remove).not.toHaveBeenCalled();
  });

  it.each(["before reservation", "after reservation"])(
    "does not publish a superseded attempt %s",
    async (when) => {
      const supersede = () =>
        pg.query("UPDATE conversion_jobs SET attempt_count=3 WHERE id=$1", [
          context.jobId,
        ]);
      if (when === "before reservation") await supersede();
      else
        fixture.onCommit = async (count) => {
          if (count === 1) await supersede();
        };
      expect(await publish()).toBe(false);
      expect(fixture.upload).not.toHaveBeenCalled();
      await assertPreviousResult();
    }
  );

  it.each(["deleted", "expired"])(
    "rechecks a %s document after receipt reservation",
    async (kind) => {
      fixture.onCommit = async (count) => {
        if (count !== 1) return;
        if (kind === "deleted") await tombstone();
        else
          await pg.query(
            "UPDATE documents SET created_at=clock_timestamp()-interval '337 hours' WHERE id=$1",
            [context.documentId]
          );
      };
      await expect(publish()).rejects.toBeInstanceOf(DocumentUnavailableError);
      expect(fixture.upload).not.toHaveBeenCalled();
      expect(await candidates()).toHaveLength(2);
      await assertPreviousResult();
    }
  );

  it("rolls back publication if the document fails the final retention check", async () => {
    await expect(
      publish(async (tx) => {
        await tx.execute(
          sql`UPDATE documents SET created_at=clock_timestamp()-interval '337 hours' WHERE id=${context.documentId}`
        );
      })
    ).rejects.toBeInstanceOf(DocumentUnavailableError);
    await assertPreviousResult();
    expect(
      (await candidates()).every((row) => row.artifact_status === "expired")
    ).toBe(true);
  });

  it("keeps discovery for a late upload after rejection and immediate deletion", async () => {
    let lateKey;
    fixture.upload.mockImplementationOnce(async (key) => {
      lateKey = key;
      throw new Error("synthetic ambiguous upload response");
    });
    await expect(publish()).rejects.toThrow();
    await tombstone();
    expect(await purgeDocumentIfEligible(context.documentId)).toBe("retained");
    blobs.set(lateKey, Buffer.from("synthetic late bytes"));
    await pg.query(
      "UPDATE artifacts SET created_at=clock_timestamp()-interval '61 minutes' WHERE job_id=$1 AND filename='conversion-publication.json'",
      [context.jobId]
    );
    expect(await purgeDocumentIfEligible(context.documentId)).toBe("purged");
    expect(fixture.remove.mock.calls.at(-1)[0]).toContain(lateKey);
    expect(blobs.size).toBe(0);
    expect(await candidates()).toEqual([]);
  });

  it("does not delay ordinary purge after a fully published result", async () => {
    expect(await publish()).toBe(true);
    await tombstone();
    expect(await purgeDocumentIfEligible(context.documentId)).toBe("purged");
    expect(blobs.size).toBe(0);
  });

  it.each([
    [
      "accessible_docx",
      "docx_output",
      "docx",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ],
    [
      "accessible_pptx",
      "pptx_output",
      "pptx",
      "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    ],
    ["canvas_html", "html_output", "html", "text/html"],
  ])(
    "publishes %s with a matching review and immutable legacy replacement",
    async (target, type, extension, mime) => {
      await changeTarget(target, type, extension, mime);
      expect(await publish()).toBe(true);
      const available = await artifacts("available");
      expect(available.map((row) => row.artifact_type).sort()).toEqual(
        [type, "review_metadata"].sort()
      );
      for (const item of generated) {
        const row = available.find(
          (entry) => entry.artifact_type === item.artifactType
        );
        expect(blobs.get(row.storage_key)).toEqual(Buffer.from(item.body));
      }
      for (const row of oldArtifacts)
        expect(blobs.get(row.storage_key).toString()).toBe(
          `old ${row.artifact_type}`
        );
    }
  );

  it.each([false, true])(
    "keeps the Word-rendered PDF paired with Canvas HTML when persistence failure is %s",
    async (fail) => {
      await changeTarget("canvas_html", "html_output", "html", "text/html");
      const sourceKey = `${context.sessionId}/${context.documentId}/source.pdf`;
      const oldSource = { artifact_type: "source_pdf", storage_key: sourceKey };
      oldArtifacts.push(oldSource);
      oldArtifacts.sort((left, right) =>
        left.artifact_type.localeCompare(right.artifact_type)
      );
      blobs.set(sourceKey, Buffer.from("old source_pdf"));
      await pg.query(
        "INSERT INTO artifacts(job_id,artifact_type,filename,mime_type,storage_key) VALUES($1,'source_pdf','synthetic.pdf','application/pdf',$2)",
        [context.jobId, sourceKey]
      );
      generated.push({
        artifactType: "source_pdf",
        filename: "synthetic.pdf",
        mimeType: "application/pdf",
        body: Buffer.from("new rendered PDF"),
      });
      if (fail) {
        await expect(
          publish(async () => {
            throw new Error("synthetic metadata failure");
          })
        ).rejects.toThrow();
        await assertPreviousResult();
      } else {
        expect(await publish()).toBe(true);
        const available = await artifacts("available");
        expect(available).toHaveLength(3);
        const currentSource = available.find(
          (row) => row.artifact_type === "source_pdf"
        );
        expect(currentSource.storage_key).not.toBe(sourceKey);
        expect(blobs.get(currentSource.storage_key).toString()).toBe(
          "new rendered PDF"
        );
      }
      expect(blobs.get(sourceKey).toString()).toBe("old source_pdf");
    }
  );

  it.each(["owner", "requester", "target"])(
    "rejects an incorrect %s without uploading",
    async (kind) => {
      if (kind === "owner") context.userId = randomUUID();
      else if (kind === "requester") {
        const stranger = randomUUID();
        await pg.query(
          "INSERT INTO users(id,email,display_name) VALUES($1,'stranger@example.test','Synthetic stranger')",
          [stranger]
        );
        await pg.query(
          "UPDATE conversion_jobs SET requested_by_user_id=$1 WHERE id=$2",
          [stranger, context.jobId]
        );
      } else context.outputTarget = "accessible_docx";
      await expect(publish()).rejects.toThrow();
      expect(fixture.upload).not.toHaveBeenCalled();
      expect(await candidates()).toEqual([]);
      await assertPreviousResult();
    }
  );
});
