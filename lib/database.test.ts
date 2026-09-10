/**
 * Database Testing
 *
 * Matches test suite slide categories:
 *   1. Connection handling  — DB errors are identified and handled correctly
 *   2. Schema integrity     — all tables, enums, views, and constraints are
 *                             present in the schema definition
 *
 * These tests run without a live database. They verify the application's
 * database layer — error handling logic and schema definitions — in isolation.
 * Live connection tests (requiring DATABASE_URL) belong in integration tests.
 */

import { describe, expect, it } from "vitest";

import { isUniqueViolation } from "@/lib/db/errors";
import {
  // Enums
  artifactStatus,
  artifactType,
  findingSeverity,
  jobStatus,
  modelCallStage,
  reviewStatus,
  userRole,
  // Tables
  accounts,
  artifacts,
  authSessions,
  conversionJobs,
  documents,
  jobEvents,
  modelCalls,
  sessions,
  users,
  validationFindings,
  verifications,
  // Views
  adminDailyJobSummary,
  adminFindingSummary,
  adminJobStatusSummary,
  adminRetentionSummary,
  userSessionFileOverview,
} from "@/lib/db/schema";

// ── 1. Connection handling ────────────────────────────────────────────────────
// isUniqueViolation() is the application's primary connection-error classifier.
// It walks the error cause chain so Drizzle's wrapping doesn't hide the Postgres
// error code.

describe("Connection handling — isUniqueViolation", () => {
  it("returns true when the error itself carries code 23505", () => {
    const err = Object.assign(new Error("unique"), { code: "23505" });
    expect(isUniqueViolation(err)).toBe(true);
  });

  it("returns true when the Postgres code is on cause (Drizzle wraps driver errors)", () => {
    const cause = Object.assign(new Error("unique_violation"), {
      code: "23505",
    });
    const wrapped = Object.assign(new Error("DrizzleQueryError"), { cause });
    expect(isUniqueViolation(wrapped)).toBe(true);
  });

  it("returns true when the code is nested two levels deep", () => {
    const root = Object.assign(new Error("pg"), { code: "23505" });
    const mid = Object.assign(new Error("driver"), { cause: root });
    const outer = Object.assign(new Error("drizzle"), { cause: mid });
    expect(isUniqueViolation(outer)).toBe(true);
  });

  it("returns false for a generic error with no code", () => {
    expect(isUniqueViolation(new Error("connection refused"))).toBe(false);
  });

  it("returns false for a different Postgres error code", () => {
    const err = Object.assign(new Error("not null violation"), {
      code: "23502",
    });
    expect(isUniqueViolation(err)).toBe(false);
  });

  it("returns false for null and undefined without throwing", () => {
    expect(isUniqueViolation(null)).toBe(false);
    expect(isUniqueViolation(undefined)).toBe(false);
  });

  it("returns false for a plain string error", () => {
    expect(isUniqueViolation("23505")).toBe(false);
  });
});

// ── 2. Schema integrity ───────────────────────────────────────────────────────
// Verifies that all tables, enums, and views declared in lib/db/schema.ts are
// present and hold the values the application depends on. These tests catch
// accidental schema regressions without requiring a live database.

describe("Schema integrity — enums", () => {
  it("userRole defines pending, instructor, and admin", () => {
    expect(userRole.enumValues).toEqual(["pending", "instructor", "admin"]);
  });

  it("jobStatus defines all pipeline states", () => {
    expect(jobStatus.enumValues).toEqual(
      expect.arrayContaining([
        "queued",
        "processing",
        "needs_review",
        "completed",
        "failed",
        "expired",
        "cancelled",
      ])
    );
  });

  it("reviewStatus defines not_required, pending, and reviewed", () => {
    expect(reviewStatus.enumValues).toEqual([
      "not_required",
      "pending",
      "reviewed",
    ]);
  });

  it("artifactType defines all supported output file types", () => {
    expect(artifactType.enumValues).toEqual(
      expect.arrayContaining([
        "source_docx",
        "source_pdf",
        "extracted_text",
        "html_output",
        "validation_report",
        "review_metadata",
      ])
    );
  });

  it("artifactStatus defines available, expired, and deleted", () => {
    expect(artifactStatus.enumValues).toEqual([
      "available",
      "expired",
      "deleted",
    ]);
  });

  it("findingSeverity defines info, warning, and error", () => {
    expect(findingSeverity.enumValues).toEqual(["info", "warning", "error"]);
  });

  it("modelCallStage defines convert and validate", () => {
    expect(modelCallStage.enumValues).toEqual(["convert", "validate"]);
  });
});

describe("Schema integrity — tables", () => {
  it("exports all expected table objects", () => {
    expect(users).toBeDefined();
    expect(authSessions).toBeDefined();
    expect(accounts).toBeDefined();
    expect(verifications).toBeDefined();
    expect(sessions).toBeDefined();
    expect(documents).toBeDefined();
    expect(conversionJobs).toBeDefined();
    expect(artifacts).toBeDefined();
    expect(validationFindings).toBeDefined();
    expect(jobEvents).toBeDefined();
    expect(modelCalls).toBeDefined();
  });

  it("users table has id, email, displayName, role, and timestamp columns", () => {
    const cols = Object.keys(users);
    expect(cols).toEqual(
      expect.arrayContaining([
        "id",
        "email",
        "displayName",
        "role",
        "createdAt",
        "updatedAt",
      ])
    );
  });

  it("sessions table has ownerUserId and title columns", () => {
    const cols = Object.keys(sessions);
    expect(cols).toEqual(
      expect.arrayContaining([
        "id",
        "ownerUserId",
        "title",
        "createdAt",
        "updatedAt",
      ])
    );
  });

  it("documents table has sessionId, uploadedByUserId, and fileSizeBytes columns", () => {
    const cols = Object.keys(documents);
    expect(cols).toEqual(
      expect.arrayContaining([
        "id",
        "sessionId",
        "uploadedByUserId",
        "originalFilename",
        "fileSizeBytes",
        "deletedAt",
      ])
    );
  });

  it("conversionJobs table has status, reviewStatus, and expiry columns", () => {
    const cols = Object.keys(conversionJobs);
    expect(cols).toEqual(
      expect.arrayContaining([
        "id",
        "documentId",
        "requestedByUserId",
        "status",
        "reviewStatus",
        "expiresAt",
        "attemptCount",
      ])
    );
  });

  it("artifacts table has storageKey and artifactType columns", () => {
    const cols = Object.keys(artifacts);
    expect(cols).toEqual(
      expect.arrayContaining([
        "id",
        "jobId",
        "artifactType",
        "artifactStatus",
        "storageKey",
        "fileSizeBytes",
        "expiresAt",
      ])
    );
  });

  it("validationFindings table has severity, ruleCode, and wcag columns", () => {
    const cols = Object.keys(validationFindings);
    expect(cols).toEqual(
      expect.arrayContaining([
        "id",
        "jobId",
        "severity",
        "ruleCode",
        "title",
        "message",
        "suggestion",
        "wcag",
      ])
    );
  });

  it("modelCalls table has stage, model, and cost columns", () => {
    const cols = Object.keys(modelCalls);
    expect(cols).toEqual(
      expect.arrayContaining([
        "id",
        "jobId",
        "stage",
        "model",
        "promptTokens",
        "completionTokens",
        "costUsd",
      ])
    );
  });
});

describe("Schema integrity — views", () => {
  it("exports all expected database views", () => {
    expect(adminJobStatusSummary).toBeDefined();
    expect(adminDailyJobSummary).toBeDefined();
    expect(adminFindingSummary).toBeDefined();
    expect(adminRetentionSummary).toBeDefined();
    expect(userSessionFileOverview).toBeDefined();
  });

  it("adminJobStatusSummary view exposes status and count column references", () => {
    // Drizzle views are SelectionProxy objects — columns are accessible via direct
    // property access, not as enumerable own keys.
    expect(adminJobStatusSummary.status).toBeDefined();
    expect(adminJobStatusSummary.jobCount).toBeDefined();
    expect(adminJobStatusSummary.jobsCreatedLast24H).toBeDefined();
  });

  it("userSessionFileOverview view exposes document and job summary column references", () => {
    expect(userSessionFileOverview.sessionId).toBeDefined();
    expect(userSessionFileOverview.documentId).toBeDefined();
    expect(userSessionFileOverview.status).toBeDefined();
    expect(userSessionFileOverview.visibleFindingCount).toBeDefined();
    expect(userSessionFileOverview.htmlArtifactId).toBeDefined();
  });
});
