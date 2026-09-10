import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PgDialect, getTableConfig } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";

const mocks = vi.hoisted(() => ({
  remove: vi.fn(),
  db: {
    transaction: vi.fn(),
    execute: vi.fn(),
    select: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
  },
  events: [] as string[],
}));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/db", () => ({ db: mocks.db }));
vi.mock("@/lib/storage", () => ({
  removeObjects: mocks.remove,
  sourceDocxKey: (session: string, id: string) =>
    `${session}/${id}/source.docx`,
  sourcePdfKey: (session: string, id: string) => `${session}/${id}/source.pdf`,
  htmlOutputKey: (session: string, id: string) =>
    `${session}/${id}/output.html`,
}));

import {
  deleteOwnedDocument,
  DocumentUnavailableError,
  purgeDocumentIfEligible,
  purgeExpiredDocuments,
  retainedDocumentCondition,
  withRetainedDocument,
} from "@/lib/document-retention";
import {
  artifacts,
  conversionJobs,
  documents,
  jobEvents,
  modelCalls,
  validationFindings,
} from "@/lib/db/schema";

function chain(value: unknown = []) {
  const result = {
    from: vi.fn(),
    where: vi.fn(),
    innerJoin: vi.fn(),
    orderBy: vi.fn(),
    limit: vi.fn(),
    for: vi.fn(),
    set: vi.fn(),
    then: Promise.resolve(value).then.bind(Promise.resolve(value)),
  };
  for (const key of [
    "from",
    "where",
    "innerJoin",
    "orderBy",
    "limit",
    "for",
    "set",
  ] as const) {
    result[key].mockReturnValue(result);
  }
  return result;
}

const document = {
  id: "00000000-0000-0000-0000-000000000001",
  sessionId: "00000000-0000-0000-0000-000000000002",
  originalFilename: "private-course.docx",
  createdAt: "2026-09-01T00:00:00Z",
  deletedAt: null,
};
const keys = ["source.docx", "source.pdf", "output.html"].map(
  (file) => `${document.sessionId}/${document.id}/${file}`
);
const queued = (...values: unknown[]) => {
  const builders = values.map(chain);
  for (const builder of builders) mocks.db.select.mockReturnValueOnce(builder);
  return builders;
};
const query = (value: SQL) => new PgDialect().sqlToQuery(value);
const archiveQueries = () =>
  mocks.db.execute.mock.calls
    .map(([statement]) => query(statement))
    .filter(({ sql }) => sql.includes('insert into "retained_'));

beforeEach(() => {
  vi.clearAllMocks();
  mocks.events.length = 0;
  mocks.db.select.mockReturnValue(chain());
  mocks.db.execute.mockResolvedValue([]);
  mocks.db.update.mockReturnValue(chain());
  mocks.db.delete.mockReturnValue(chain());
  mocks.db.transaction.mockImplementation(
    async (action: (tx: typeof mocks.db) => Promise<unknown>) => {
      mocks.events.push("begin");
      try {
        const result = await action(mocks.db);
        mocks.events.push("commit");
        return result;
      } catch (error) {
        mocks.events.push("rollback");
        throw error;
      }
    }
  );
  mocks.remove.mockImplementation(async () => {
    mocks.events.push("storage");
  });
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("retained document lock", () => {
  it("uses the DB clock and original creation time with a strict expiry boundary", () => {
    const compiled = query(retainedDocumentCondition()).sql;
    expect(compiled).toContain('"documents"."deleted_at" is null');
    expect(compiled).toContain('"documents"."created_at" > clock_timestamp()');
    expect(compiled).toContain("interval '336 hours'");
    expect(compiled).not.toContain("updated_at");
    expect(compiled).not.toContain("expires_at");
  });

  it("locks first, checks eligibility afterwards, then rechecks before commit", async () => {
    const [lock, before, after] = queued(
      [document],
      [{ id: document.id }],
      [{ id: document.id }]
    );
    const action = vi.fn().mockResolvedValue("saved");
    expect(await withRetainedDocument(document.id, action)).toBe("saved");
    expect(lock.for).toHaveBeenCalledWith("update");
    expect(lock.for.mock.invocationCallOrder[0]).toBeLessThan(
      before.where.mock.invocationCallOrder[0]
    );
    expect(before.where.mock.invocationCallOrder[0]).toBeLessThan(
      action.mock.invocationCallOrder[0]
    );
    expect(action.mock.invocationCallOrder[0]).toBeLessThan(
      after.where.mock.invocationCallOrder[0]
    );
    expect(action).toHaveBeenCalledWith(mocks.db, document);
    expect(mocks.events).toEqual(["begin", "commit"]);
  });

  it("rejects missing documents before invoking an action", async () => {
    queued([]);
    const action = vi.fn();
    await expect(
      withRetainedDocument(document.id, action)
    ).rejects.toBeInstanceOf(DocumentUnavailableError);
    expect(action).not.toHaveBeenCalled();
  });

  it("rejects expiry or deletion that occurred while waiting for the lock", async () => {
    queued([document], []);
    const action = vi.fn();
    await expect(
      withRetainedDocument(document.id, action)
    ).rejects.toBeInstanceOf(DocumentUnavailableError);
    expect(action).not.toHaveBeenCalled();
    expect(mocks.events).toContain("rollback");
  });

  it("rolls back and withholds the action result when expiry crosses during awaited work", async () => {
    queued([document], [{ id: document.id }], []);
    await expect(
      withRetainedDocument(document.id, async () => "private result")
    ).rejects.toBeInstanceOf(DocumentUnavailableError);
    expect(mocks.events).toEqual(["begin", "rollback"]);
  });
});

describe("document purge", () => {
  it("dry run only counts eligible documents, including soft-deleted and no-job documents", async () => {
    const [countQuery] = queued([{ total: 12 }]);
    const result = await purgeExpiredDocuments({ dryRun: true });
    expect(result).toMatchObject({
      dryRun: true,
      eligible: 12,
      examined: 0,
      purged: 0,
      failed: 0,
      hasMore: true,
    });
    expect(mocks.db.transaction).toHaveBeenCalledWith(expect.any(Function), {
      accessMode: "read only",
    });
    expect(countQuery.from).toHaveBeenCalledWith(documents);
    expect(countQuery.innerJoin).not.toHaveBeenCalled();
    expect(countQuery.for).not.toHaveBeenCalled();
    const predicate = query(countQuery.where.mock.calls[0][0]).sql;
    expect(predicate).toContain('"deleted_at" is not null');
    expect(predicate).toContain('"created_at" <= clock_timestamp()');
    expect(predicate).not.toContain("archived_at");
    expect(mocks.remove).not.toHaveBeenCalled();
    expect(mocks.db.update).not.toHaveBeenCalled();
    expect(mocks.db.delete).not.toHaveBeenCalled();
    expect(archiveQueries()).toEqual([]);
  });

  it("removes all canonical and legacy artifact keys before the document cascade", async () => {
    const [, , artifactQuery] = queued(
      [document],
      [{ id: document.id }],
      [
        { storageKey: keys[0] },
        { storageKey: "legacy/a.html" },
        { storageKey: "legacy/a.html" },
        { storageKey: "legacy/expired.txt" },
      ]
    );
    expect(await purgeDocumentIfEligible(document.id)).toBe("purged");
    expect(mocks.remove).toHaveBeenCalledWith(
      [...keys, "legacy/a.html", "legacy/expired.txt"],
      { signal: expect.any(AbortSignal) }
    );
    expect(artifactQuery.from).toHaveBeenCalledWith(artifacts);
    expect(query(artifactQuery.where.mock.calls[0][0]).sql).not.toContain(
      "artifact_status"
    );
    expect(mocks.remove.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.db.delete.mock.invocationCallOrder[0]
    );
    expect(mocks.db.delete).toHaveBeenCalledExactlyOnceWith(documents);
    const writes = mocks.db.execute.mock.calls
      .map(([statement], index) => ({
        sql: query(statement).sql,
        order: mocks.db.execute.mock.invocationCallOrder[index],
      }))
      .filter(({ sql }) => sql.includes('insert into "retained_'));
    expect(writes).toHaveLength(2);
    expect(mocks.remove.mock.invocationCallOrder[0]).toBeLessThan(
      writes[0].order
    );
    expect(writes[1].order).toBeLessThan(
      mocks.db.delete.mock.invocationCallOrder[0]
    );
  });

  it("still cleans orphaned sources when a document has no conversion job", async () => {
    queued([document], [{ id: document.id }], []);
    expect(await purgeDocumentIfEligible(document.id)).toBe("purged");
    expect(mocks.remove.mock.calls[0][0]).toEqual(keys);
    expect(mocks.db.delete).toHaveBeenCalledWith(documents);
  });

  it("retains the DB row on storage failure and allows a subsequent retry", async () => {
    queued([document], [{ id: document.id }], []);
    mocks.remove.mockRejectedValueOnce(
      new Error("private-provider-url-and-secret")
    );
    expect(await purgeDocumentIfEligible(document.id)).toBe("failed");
    expect(mocks.db.delete).not.toHaveBeenCalled();
    expect(archiveQueries()).toEqual([]);
    expect(mocks.events).toEqual(["begin", "rollback"]);
    expect(JSON.stringify(vi.mocked(console.error).mock.calls)).not.toContain(
      "private-provider"
    );
    queued([document], [{ id: document.id }], []);
    expect(await purgeDocumentIfEligible(document.id)).toBe("purged");
    expect(mocks.db.delete).toHaveBeenCalledExactlyOnceWith(documents);
    expect(archiveQueries()).toHaveLength(2);
  });

  it("retains source rows and rolls back if preserving metrics fails", async () => {
    queued([document], [{ id: document.id }], []);
    mocks.db.execute.mockImplementation(async (statement: SQL) => {
      if (
        query(statement).sql.includes('insert into "retained_model_metrics"')
      ) {
        throw new Error("private-database-details");
      }
      return [];
    });
    expect(await purgeDocumentIfEligible(document.id)).toBe("failed");
    expect(mocks.remove).toHaveBeenCalledTimes(1);
    expect(mocks.db.delete).not.toHaveBeenCalled();
    expect(mocks.events).toEqual(["begin", "storage", "rollback"]);
    expect(JSON.stringify(vi.mocked(console.error).mock.calls)).not.toContain(
      "private-database-details"
    );
  });

  it("rolls back aggregate writes if the final cascade fails", async () => {
    queued([document], [{ id: document.id }], []);
    mocks.db.delete.mockImplementationOnce(() => {
      throw new Error("private-delete-details");
    });
    expect(await purgeDocumentIfEligible(document.id)).toBe("failed");
    expect(archiveQueries()).toHaveLength(2);
    expect(mocks.events).toEqual(["begin", "storage", "rollback"]);
    expect(JSON.stringify(vi.mocked(console.error).mock.calls)).not.toContain(
      "private-delete-details"
    );
  });

  it("uses skipLocked so simultaneous cleanup cannot claim the same row", async () => {
    const [lockQuery] = queued([]);
    expect(await purgeDocumentIfEligible(document.id)).toBe("retained");
    expect(lockQuery.for).toHaveBeenCalledWith("update", { skipLocked: true });
    expect(query(lockQuery.where.mock.calls[0][0]).params).toContain(
      document.id
    );
    expect(mocks.remove).not.toHaveBeenCalled();
  });

  it("reports backlog if an eligible document was skipped because its row is locked", async () => {
    queued([{ total: 1 }], [], [{ id: document.id }]);
    expect(await purgeExpiredDocuments()).toMatchObject({
      eligible: 1,
      examined: 0,
      purged: 0,
      hasMore: true,
    });
    expect(mocks.remove).not.toHaveBeenCalled();
  });

  it("excludes a failed candidate for the rest of the run instead of retrying forever", async () => {
    const builders = queued(
      [{ total: 1 }],
      [document],
      [{ id: document.id }],
      [],
      [],
      [{ id: document.id }]
    );
    mocks.remove.mockRejectedValue(new Error("storage unavailable"));
    const result = await purgeExpiredDocuments();
    expect(result).toMatchObject({
      examined: 1,
      purged: 0,
      failed: 1,
      hasMore: true,
    });
    expect(query(builders[4].where.mock.calls[0][0]).sql).toContain("not in");
    expect(query(builders[4].where.mock.calls[0][0]).params).toContain(
      document.id
    );
    expect(mocks.remove).toHaveBeenCalledTimes(1);
  });

  it("returns complete when the eligible document was purged and no backlog remains", async () => {
    queued([{ total: 1 }], [document], [{ id: document.id }], [], [], []);
    expect(await purgeExpiredDocuments()).toMatchObject({
      eligible: 1,
      examined: 1,
      purged: 1,
      failed: 0,
      hasMore: false,
      timeLimitReached: false,
      limitReached: false,
    });
  });

  it("stops at the per-run count bound and conservatively reports more work", async () => {
    queued([{ total: 2 }], [document], [{ id: document.id }], []);
    expect(await purgeExpiredDocuments({ limit: 1 })).toMatchObject({
      examined: 1,
      purged: 1,
      limitReached: true,
      hasMore: true,
    });
    expect(mocks.db.select).toHaveBeenCalledTimes(4);
  });

  it("aborts a stalled storage request and never removes its retry metadata", async () => {
    vi.useFakeTimers();
    queued([document], [{ id: document.id }], []);
    mocks.remove.mockImplementation(() => new Promise(() => {}));
    const pending = purgeDocumentIfEligible(document.id);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(await pending).toBe("failed");
    expect(mocks.remove.mock.calls[0][1].signal.aborted).toBe(true);
    expect(mocks.db.delete).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("uses the remaining run budget when it is shorter than the storage timeout", async () => {
    vi.useFakeTimers();
    queued([{ total: 1 }], [document], [{ id: document.id }], []);
    mocks.remove.mockImplementation(() => new Promise(() => {}));
    const pending = purgeExpiredDocuments({ maxDurationMs: 20 });
    await vi.advanceTimersByTimeAsync(20);
    expect(await pending).toMatchObject({
      failed: 1,
      timeLimitReached: true,
      hasMore: true,
    });
    expect(mocks.remove.mock.calls[0][1].signal.aborted).toBe(true);
    expect(mocks.db.delete).not.toHaveBeenCalled();
  });

  it("does not start another query or storage operation after row acquisition exhausts the budget", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    queued([{ total: 1 }]);
    mocks.db.select.mockImplementationOnce(() => {
      vi.setSystemTime(25);
      return chain([document]);
    });
    expect(await purgeExpiredDocuments({ maxDurationMs: 20 })).toMatchObject({
      examined: 1,
      failed: 1,
      timeLimitReached: true,
      hasMore: true,
    });
    expect(mocks.db.select).toHaveBeenCalledTimes(2);
    expect(mocks.remove).not.toHaveBeenCalled();
    expect(mocks.db.delete).not.toHaveBeenCalled();
  });

  it("bounds large legacy-key sets into storage batches without losing a key", async () => {
    const legacy = Array.from({ length: 205 }, (_, index) => ({
      storageKey: `legacy/${index}`,
    }));
    queued([document], [{ id: document.id }], legacy);
    expect(await purgeDocumentIfEligible(document.id)).toBe("purged");
    expect(mocks.remove.mock.calls.map(([batch]) => batch.length)).toEqual([
      100, 100, 8,
    ]);
    expect(mocks.remove.mock.calls.flatMap(([batch]) => batch)).toEqual([
      ...keys,
      ...legacy.map((a) => a.storageKey),
    ]);
  });

  it("rejects invalid operator bounds before querying", async () => {
    await expect(purgeExpiredDocuments({ limit: 0 })).rejects.toThrow(
      RangeError
    );
    await expect(purgeExpiredDocuments({ maxDurationMs: NaN })).rejects.toThrow(
      RangeError
    );
    expect(mocks.db.transaction).not.toHaveBeenCalled();
  });
});

describe("owner-requested deletion", () => {
  it("refuses another owner's document without touching storage", async () => {
    const [ownerQuery] = queued([]);
    await deleteOwnedDocument(document.id, "other-user");
    const predicate = query(ownerQuery.where.mock.calls[0][0]);
    expect(predicate.sql).toContain('"sessions"."owner_user_id"');
    expect(predicate.params).toEqual([document.id, "other-user"]);
    expect(ownerQuery.for).toHaveBeenCalledWith("update", { of: documents });
    expect(mocks.db.update).not.toHaveBeenCalled();
    expect(mocks.remove).not.toHaveBeenCalled();
    expect(console.error).not.toHaveBeenCalled();
  });

  it("commits a tombstone before storage cleanup, retaining it if cleanup fails", async () => {
    queued([{ id: document.id }], [document], [{ id: document.id }], []);
    mocks.remove.mockImplementation(async () => {
      expect(mocks.events).toEqual(["begin", "commit", "begin"]);
      throw new Error("private-storage-details");
    });
    await expect(
      deleteOwnedDocument(document.id, "owner")
    ).resolves.toBeUndefined();
    expect(mocks.db.update).toHaveBeenCalledWith(documents);
    const update = mocks.db.update.mock.results[0].value;
    expect(query(update.set.mock.calls[0][0].deletedAt).sql).toBe(
      "clock_timestamp()"
    );
    expect(mocks.db.delete).not.toHaveBeenCalled();
    expect(mocks.events).toEqual(["begin", "commit", "begin", "rollback"]);
  });
});

describe("existing retention cascade contract", () => {
  it.each([
    [conversionJobs, documents],
    [artifacts, conversionJobs],
    [validationFindings, conversionJobs],
    [jobEvents, conversionJobs],
    [modelCalls, conversionJobs],
  ])(
    "cascades every dependent table when the document is hard-deleted",
    (child, parent) => {
      const foreignKey = getTableConfig(child).foreignKeys.find(
        (key) => key.reference().foreignTable === parent
      );
      expect(foreignKey?.onDelete).toBe("cascade");
    }
  );
});
