import { createHash } from "node:crypto";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  retained: vi.fn(),
  upload: vi.fn(),
  sign: vi.fn(),
  remove: vi.fn(),
  insert: vi.fn(),
  select: vi.fn(),
  delete: vi.fn(),
  execute: vi.fn(),
  transaction: vi.fn(),
  action: vi.fn(),
  events: [] as string[],
  predicates: [] as unknown[],
  deletes: [] as unknown[],
  lockDepth: 0,
}));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/document-retention", () => ({
  withRetainedDocument: mocks.retained,
}));
vi.mock("@/lib/db", () => ({
  db: { transaction: mocks.transaction },
}));
vi.mock("@/lib/storage", () => ({
  uploadObject: mocks.upload,
  createSignedUrl: mocks.sign,
  removeObjects: mocks.remove,
}));
import { createNativePdfTransport } from "@/lib/native-pdf-transport-storage";
import { retentionExpiresAt } from "@/lib/retention";

const context = {
  sessionId: "11111111-1111-4111-8111-111111111111",
  documentId: "22222222-2222-4222-8222-222222222222",
  jobId: "33333333-3333-4333-8333-333333333333",
  userId: "44444444-4444-4444-8444-444444444444",
  attemptNumber: 2,
};
const body = Buffer.from('{"synthetic":"request"}');
const result = { repaired: true };
const signal = () => new AbortController().signal;
const query = (where: unknown) => new PgDialect().sqlToQuery(where as SQL);
let document: { sessionId: string; createdAt: string };
let jobExpiresAt: string;
let selectRows: { expiresAt: string }[] | undefined;

beforeEach(() => {
  vi.clearAllMocks();
  mocks.events.length = 0;
  mocks.predicates.length = 0;
  mocks.deletes.length = 0;
  mocks.lockDepth = 0;
  document = {
    sessionId: context.sessionId,
    createdAt: new Date().toISOString(),
  };
  jobExpiresAt = retentionExpiresAt(document.createdAt);
  selectRows = undefined;
  mocks.select.mockImplementation(() => ({
    from: () => ({
      innerJoin: () => ({
        where: (where: unknown) => {
          mocks.predicates.push(where);
          return {
            for: async () => selectRows ?? [{ expiresAt: jobExpiresAt }],
          };
        },
      }),
    }),
  }));
  mocks.insert.mockReturnValue({
    values: async () => {
      mocks.events.push("receipt");
    },
  });
  mocks.retained.mockImplementation(async (_id, action) => {
    mocks.events.push("lock");
    mocks.lockDepth++;
    try {
      const value = await action(
        { select: mocks.select, insert: mocks.insert },
        document
      );
      mocks.events.push("commit");
      return value;
    } finally {
      mocks.lockDepth--;
    }
  });
  mocks.upload.mockImplementation(async () => {
    expect(mocks.lockDepth).toBe(1);
    mocks.events.push("upload");
  });
  mocks.sign.mockImplementation(async () => {
    expect(mocks.lockDepth).toBe(1);
    mocks.events.push("sign");
    return "https://storage.example/opaque-signed-request";
  });
  mocks.remove.mockImplementation(async () => {
    expect(mocks.lockDepth).toBe(0);
    mocks.events.push("remove");
  });
  mocks.delete.mockReturnValue({
    where: async (where: unknown) => {
      mocks.events.push("delete-receipt");
      mocks.deletes.push(where);
    },
  });
  mocks.transaction.mockImplementation(async (action) =>
    action({ execute: mocks.execute, delete: mocks.delete })
  );
  mocks.action.mockImplementation(async () => {
    expect(mocks.lockDepth).toBe(0);
    mocks.events.push("action");
    return result;
  });
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("native PDF temporary request storage", () => {
  it("commits the receipt before upload, signs inside the second lock and calls the worker outside it", async () => {
    const requestSignal = signal();
    await expect(
      createNativePdfTransport(context)(body, requestSignal, mocks.action)
    ).resolves.toBe(result);
    expect(mocks.events).toEqual([
      "lock",
      "receipt",
      "commit",
      "lock",
      "upload",
      "sign",
      "commit",
      "action",
      "remove",
      "delete-receipt",
    ]);
    const key = mocks.upload.mock.calls[0][0];
    expect(key).toMatch(
      new RegExp(
        `^${context.sessionId}/${context.documentId}/${context.jobId}/native-pdf-request-[0-9a-f-]+\\.json$`
      )
    );
    const values = mocks.insert.mock.results[0].value.values;
    expect(values).toBeTypeOf("function");
    expect(mocks.upload).toHaveBeenCalledWith(key, body, "application/json", {
      signal: requestSignal,
    });
    expect(mocks.sign).toHaveBeenCalledWith(key, 60, undefined, {
      signal: requestSignal,
    });
    expect(mocks.action).toHaveBeenCalledWith({
      requestUrl: "https://storage.example/opaque-signed-request",
      requestSha256: createHash("sha256").update(body).digest("hex"),
      requestBytes: body.length,
    });
    expect(mocks.remove.mock.calls[0][0]).toEqual([key]);
    expect(mocks.remove.mock.calls[0][1].signal).not.toBe(requestSignal);
    const deletion = query(mocks.deletes[0]);
    expect(deletion.params).toEqual(
      expect.arrayContaining([
        context.jobId,
        key,
        "review_metadata",
        "expired",
        false,
      ])
    );
    expect(deletion.sql).toContain('"artifacts"."id"');
  });

  it("pins an expired, non-downloadable receipt to original retention and payload checksum", async () => {
    const values = vi.fn(async () => {});
    mocks.insert.mockReturnValue({ values });
    await createNativePdfTransport(context)(body, signal(), mocks.action);
    expect(values).toHaveBeenCalledWith(
      expect.objectContaining({
        jobId: context.jobId,
        artifactType: "review_metadata",
        artifactStatus: "expired",
        filename: "native-pdf-request.json",
        mimeType: "application/json",
        fileSizeBytes: body.length,
        checksumSha256: createHash("sha256").update(body).digest("hex"),
        isUserDownloadable: false,
        expiresAt: retentionExpiresAt(document.createdAt),
      })
    );
  });

  it("authorizes the owner, requested user, native target, processing state and exact attempt twice", async () => {
    await createNativePdfTransport(context)(body, signal(), mocks.action);
    expect(mocks.predicates).toHaveLength(2);
    for (const predicate of mocks.predicates) {
      const checked = query(predicate);
      expect(checked.params).toEqual([
        context.jobId,
        context.documentId,
        context.userId,
        "accessible_pdf",
        "pdf-v1",
        "processing",
        context.attemptNumber,
        context.userId,
      ]);
      expect(checked.sql).toContain('"sessions"."owner_user_id"');
      expect(checked.sql).toContain('"conversion_jobs"."requested_by_user_id"');
      expect(checked.sql).toContain(
        '"conversion_jobs"."expires_at" > clock_timestamp()'
      );
    }
  });

  it("does not store bytes or call the service for a missing or unauthorized attempt", async () => {
    selectRows = [];
    await expect(
      createNativePdfTransport(context)(body, signal(), mocks.action)
    ).rejects.toThrow("Could not prepare");
    expect(mocks.insert).not.toHaveBeenCalled();
    expect(mocks.upload).not.toHaveBeenCalled();
    expect(mocks.action).not.toHaveBeenCalled();
    expect(mocks.remove).not.toHaveBeenCalled();
  });

  it("rechecks the attempt after committing its receipt, before uploading", async () => {
    const retained = mocks.retained.getMockImplementation()!;
    let calls = 0;
    mocks.retained.mockImplementation(async (...args) => {
      if (++calls === 2) selectRows = [];
      return retained(...args);
    });
    await expect(
      createNativePdfTransport(context)(body, signal(), mocks.action)
    ).rejects.toThrow();
    expect(mocks.insert).toHaveBeenCalledOnce();
    expect(mocks.upload).not.toHaveBeenCalled();
    expect(mocks.action).not.toHaveBeenCalled();
    expect(mocks.remove).toHaveBeenCalledOnce();
  });

  it("stops before upload if retention expires between the receipt and upload transactions", async () => {
    const retained = mocks.retained.getMockImplementation()!;
    let calls = 0;
    mocks.retained.mockImplementation(async (...args) => {
      if (++calls === 2) throw new Error("Document expired");
      return retained(...args);
    });
    await expect(
      createNativePdfTransport(context)(body, signal(), mocks.action)
    ).rejects.toThrow("Could not prepare");
    expect(mocks.insert).toHaveBeenCalledOnce();
    expect(mocks.upload).not.toHaveBeenCalled();
    expect(mocks.action).not.toHaveBeenCalled();
  });

  it("rejects a document from another session before reserving a receipt", async () => {
    document.sessionId = "55555555-5555-4555-8555-555555555555";
    await expect(
      createNativePdfTransport(context)(body, signal(), mocks.action)
    ).rejects.toThrow();
    expect(mocks.insert).not.toHaveBeenCalled();
    expect(mocks.upload).not.toHaveBeenCalled();
  });

  it("withholds the descriptor if retention expires after the upload transaction's action", async () => {
    const retained = mocks.retained.getMockImplementation()!;
    let calls = 0;
    mocks.retained.mockImplementation(async (...args) => {
      const value = await retained(...args);
      if (++calls === 2) throw new Error("Expired after upload");
      return value;
    });
    await expect(
      createNativePdfTransport(context)(body, signal(), mocks.action)
    ).rejects.toThrow();
    expect(mocks.upload).toHaveBeenCalledOnce();
    expect(mocks.action).not.toHaveBeenCalled();
    expect(mocks.remove).toHaveBeenCalledOnce();
  });

  it("preserves the original action error while cleaning the confirmed upload", async () => {
    const error = new Error("worker action failure");
    mocks.action.mockRejectedValueOnce(error);
    await expect(
      createNativePdfTransport(context)(body, signal(), mocks.action)
    ).rejects.toBe(error);
    expect(mocks.remove).toHaveBeenCalledOnce();
    expect(mocks.delete).toHaveBeenCalledOnce();
  });

  it("keeps a partial upload's receipt after immediate deletion succeeds", async () => {
    mocks.upload.mockRejectedValueOnce(new Error("secret provider details"));
    await expect(
      createNativePdfTransport(context)(body, signal(), mocks.action)
    ).rejects.toThrow("Could not prepare the private PDF repair request.");
    expect(mocks.sign).not.toHaveBeenCalled();
    expect(mocks.action).not.toHaveBeenCalled();
    expect(mocks.remove).toHaveBeenCalledOnce();
    expect(mocks.delete).not.toHaveBeenCalled();
  });

  it("cleans a confirmed upload if signing fails without leaking the storage error", async () => {
    mocks.sign.mockRejectedValueOnce(new Error("private signed URL token"));
    await expect(
      createNativePdfTransport(context)(body, signal(), mocks.action)
    ).rejects.toThrow("Could not prepare the private PDF repair request.");
    expect(mocks.action).not.toHaveBeenCalled();
    expect(mocks.remove).toHaveBeenCalledOnce();
    expect(mocks.delete).toHaveBeenCalledOnce();
  });

  it("leaves the receipt and preserves success when object cleanup fails", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    mocks.remove.mockRejectedValueOnce(new Error("private storage error"));
    await expect(
      createNativePdfTransport(context)(body, signal(), mocks.action)
    ).resolves.toBe(result);
    expect(mocks.delete).not.toHaveBeenCalled();
    expect(console.error).toHaveBeenCalledWith(
      "[native-pdf] temporary repair request awaits document cleanup"
    );
  });

  it("bounds a hung delete at ten seconds without later removing the receipt", async () => {
    vi.useFakeTimers();
    vi.spyOn(console, "error").mockImplementation(() => {});
    let finish!: () => void;
    mocks.remove.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        })
    );
    const running = createNativePdfTransport(context)(
      body,
      signal(),
      mocks.action
    );
    await vi.advanceTimersByTimeAsync(10001);
    await expect(running).resolves.toBe(result);
    expect(mocks.remove.mock.calls[0][1].signal.aborted).toBe(true);
    expect(mocks.delete).not.toHaveBeenCalled();
    finish();
    await Promise.resolve();
    expect(mocks.delete).not.toHaveBeenCalled();
  });

  it("keeps successful results if deleting the receipt fails", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    mocks.transaction.mockRejectedValueOnce(
      new Error("private database error")
    );
    await expect(
      createNativePdfTransport(context)(body, signal(), mocks.action)
    ).resolves.toBe(result);
    expect(mocks.remove).toHaveBeenCalledOnce();
  });

  it("uses a fresh cleanup signal after an action cancels the request", async () => {
    const controller = new AbortController();
    mocks.action.mockImplementationOnce(async () => {
      controller.abort();
      throw new Error("request cancelled");
    });
    await expect(
      createNativePdfTransport(context)(body, controller.signal, mocks.action)
    ).rejects.toThrow("request cancelled");
    expect(mocks.remove.mock.calls[0][1].signal.aborted).toBe(false);
    expect(mocks.delete).toHaveBeenCalledOnce();
  });

  it("withholds a signed URL when signing latency would extend past original expiry", async () => {
    const now = Date.now();
    let elapsed = 0;
    vi.spyOn(Date, "now").mockImplementation(() => now + elapsed);
    document.createdAt = new Date(now - 14 * 86400000 + 62000).toISOString();
    jobExpiresAt = retentionExpiresAt(document.createdAt);
    mocks.sign.mockImplementationOnce(async () => {
      elapsed = 3000;
      return "https://storage.example/late";
    });
    await expect(
      createNativePdfTransport(context)(body, signal(), mocks.action)
    ).rejects.toThrow();
    expect(mocks.sign.mock.calls[0][1]).toBe(60);
    expect(mocks.action).not.toHaveBeenCalled();
  });

  it("bounds its payload and validates path identifiers before touching storage", async () => {
    expect(() =>
      createNativePdfTransport({ ...context, documentId: "../other" })
    ).toThrow();
    expect(() =>
      createNativePdfTransport({ ...context, attemptNumber: 0 })
    ).toThrow();
    const transport = createNativePdfTransport(context);
    await expect(
      transport(Buffer.alloc(0), signal(), mocks.action)
    ).rejects.toThrow();
    await expect(
      transport(Buffer.alloc(12 * 1024 * 1024 + 1), signal(), mocks.action)
    ).rejects.toThrow();
    const controller = new AbortController();
    controller.abort();
    await expect(
      transport(body, controller.signal, mocks.action)
    ).rejects.toThrow();
    expect(mocks.retained).not.toHaveBeenCalled();
    expect(mocks.upload).not.toHaveBeenCalled();
  });

  it("holds an immutable payload snapshot across the committed receipt and upload", async () => {
    const mutable = Buffer.from(body);
    mocks.insert.mockReturnValue({
      values: async () => {
        mutable.fill(0);
      },
    });
    await createNativePdfTransport(context)(mutable, signal(), mocks.action);
    expect(mocks.upload.mock.calls[0][1]).toEqual(body);
    expect(mocks.action.mock.calls[0][0].requestSha256).toBe(
      createHash("sha256").update(body).digest("hex")
    );
  });
});
