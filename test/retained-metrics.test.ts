import { describe, expect, it, vi } from "vitest";
import { getTableConfig, PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";

vi.mock("server-only", () => ({}));

import { archiveDocumentMetrics } from "@/lib/retained-metrics";
import type { DocumentTransaction } from "@/lib/document-retention";
import { retainedJobMetrics, retainedModelMetrics } from "@/lib/db/schema";

describe("retained metric privacy contract", () => {
  it.each([
    [retainedJobMetrics, ["day", "status", "job_count"]],
    [
      retainedModelMetrics,
      [
        "day",
        "model",
        "stage",
        "call_count",
        "prompt_tokens",
        "completion_tokens",
        "cost_usd",
      ],
    ],
  ] as const)(
    "stores only approved aggregate dimensions and measures",
    (table, columns) => {
      const config = getTableConfig(table);
      expect(config.columns.map((column) => column.name)).toEqual(columns);
      expect(
        config.columns.find((column) => column.name === "day")?.getSQLType()
      ).toBe("date");
      expect(config.foreignKeys).toEqual([]);
      expect(config.enableRLS).toBe(true);
      expect(config.primaryKeys).toHaveLength(1);
    }
  );

  it("scopes aggregate reads to the locked document and uses explicit UTC days", async () => {
    const statements: { sql: string; params: unknown[] }[] = [];
    const execute = vi.fn(async (statement: SQL) => {
      statements.push(new PgDialect().sqlToQuery(statement));
    });
    await archiveDocumentMetrics(
      { execute } as unknown as DocumentTransaction,
      "private-document-id"
    );
    expect(statements).toHaveLength(2);
    for (const statement of statements) {
      expect(statement.params).toEqual(["private-document-id"]);
      expect(statement.sql).toContain(
        'where "conversion_jobs"."document_id" = $1'
      );
      expect(statement.sql).toContain("at time zone 'UTC')::date");
      expect(statement.sql).not.toContain("private-document-id");
      expect(statement.sql).not.toMatch(
        /original_filename|requested_by_user_id|error_message|preview_snippet|storage_key|email|session_id/
      );
    }
  });

  it("refreshes the time budget before each write and stops before an exhausted second write", async () => {
    const execute = vi.fn(async () => {});
    const beforeQuery = vi
      .fn()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("Budget exhausted"));
    await expect(
      archiveDocumentMetrics(
        { execute } as unknown as DocumentTransaction,
        "document-id",
        beforeQuery
      )
    ).rejects.toThrow("Budget exhausted");
    expect(beforeQuery).toHaveBeenCalledTimes(2);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(beforeQuery.mock.invocationCallOrder[0]).toBeLessThan(
      execute.mock.invocationCallOrder[0]
    );
    expect(execute.mock.invocationCallOrder[0]).toBeLessThan(
      beforeQuery.mock.invocationCallOrder[1]
    );
  });
});
