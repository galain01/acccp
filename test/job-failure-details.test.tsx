import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import JobFailureDetails from "@/components/ui/job-failure-details";
import type { RecentJobFailure } from "@/lib/actions/admin-metrics";

beforeEach(() => vi.stubGlobal("React", React));
afterEach(() => vi.unstubAllGlobals());
const text = (markup: string) =>
  markup.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
const render = (failure: RecentJobFailure | null) =>
  renderToStaticMarkup(
    <JobFailureDetails failure={failure} filename="Synthetic course.pdf" />
  );

describe("admin failure disclosure", () => {
  it("renders a native keyboard-accessible disclosure with validated details and retry advice", () => {
    const markup = render({
      diagnostic: {
        version: 1,
        stage: "audit",
        code: "provider_rate_limit",
        model: "gpt-5.6-sol-2026-07-09",
        httpStatus: 429,
        pageNumber: 3,
        elapsedMs: 1200,
        attemptNumber: 2,
        retryAfterSeconds: 30,
        providerRequestId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
      },
      occurredAt: "2026-09-14T11:01:00Z",
    });
    expect(markup).toContain("<details");
    expect(markup).toContain("<summary");
    expect(markup).not.toContain(" open=");
    expect(text(markup)).toContain("Error details for Synthetic course.pdf");
    expect(text(markup)).toContain(
      "Accessibility check stopped on PDF page 3."
    );
    expect(text(markup)).toContain("Try again later.");
    expect(text(markup)).toContain("HTTP status 429");
    expect(text(markup)).toContain("Time in this step 1.2 s");
    expect(text(markup)).toContain("Attempt 2");
    expect(text(markup)).toContain("Provider wait hint 30 seconds");
    expect(text(markup)).toContain(
      "Provider request ID aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee"
    );
    expect(text(markup)).toContain("Failed (UTC) 2026-09-14 11:01:00");
  });

  it("uses a plain fixed message for older failures without inventing details", () => {
    const markup = render(null);
    expect(text(markup)).toContain(
      "Detailed reason was not recorded for this failure."
    );
    expect(markup).not.toContain("<dl");
    expect(text(markup)).not.toContain("HTTP status");
  });

  it("never renders malformed metadata, arbitrary legacy errors or unsafe diagnostic strings", () => {
    const markup = render({
      diagnostic: {
        version: 1,
        stage: "audit",
        code: "provider_auth",
        model: "<script>SYNTHETIC_PRIVATE</script>",
        providerRequestId: "SYNTHETIC_PRIVATE",
        rawError: "SYNTHETIC_PRIVATE",
      },
      occurredAt: "SYNTHETIC_PRIVATE",
      errorMessage: "SYNTHETIC_PRIVATE",
    } as unknown as RecentJobFailure);
    expect(text(markup)).toContain(
      "did not accept the app&#x27;s access credentials or permissions"
    );
    expect(markup).not.toContain("SYNTHETIC_PRIVATE");
    expect(markup).not.toContain("<script");
    expect(text(markup)).not.toContain("Provider request ID");
  });
});
