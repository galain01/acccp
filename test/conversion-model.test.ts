import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { convertPdf } from "@/lib/convert";
import { clearModelPricingCache } from "@/lib/litellm";
import type { LiteLLMContentPart } from "@/lib/litellm";
import type { RenderedPdf } from "@/lib/pdf-rendering";

const { renderPdfPagesMock } = vi.hoisted(() => ({
  renderPdfPagesMock: vi.fn(),
}));
vi.mock("@/lib/pdf-rendering", async () => ({
  ...(await vi.importActual<typeof import("@/lib/pdf-rendering")>(
    "@/lib/pdf-rendering"
  )),
  renderPdfPages: renderPdfPagesMock,
}));

const PDF_BYTES = Buffer.from("%PDF-1.7\nmock pdf bytes\n%%EOF");
const RENDERED: RenderedPdf = {
  pageCount: 3,
  pages: Array.from({ length: 3 }, (_, index) => ({
    pageNumber: index + 1,
    width: 1,
    height: 1,
    png: Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aP1sAAAAASUVORK5CYII=",
      "base64"
    ),
    text: null,
    imageAlternatives: { status: "complete", figures: [] },
  })),
};
const COMPLETED_AUDIT = JSON.stringify({
  headingReview: {
    pagesReviewed: [1, 2, 3],
    sourceHeadings: [
      {
        id: "s1",
        page: 1,
        text: "Course overview",
        parentId: null,
        rank: 1,
        certainty: "supported",
        evidence: "Document title above the course introduction.",
        htmlHeadingIds: ["h1"],
      },
    ],
    unmatchedHtmlHeadingIds: [],
  },
  findings: [],
});

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    headers: { "Content-Type": "application/json" },
  });
}

describe("conversion model configuration", () => {
  beforeEach(() => {
    clearModelPricingCache();
    renderPdfPagesMock.mockReset().mockResolvedValue(RENDERED);
    vi.stubEnv("LITELLM_BASE_URL", "https://litellm.test");
    vi.stubEnv("LITELLM_API_KEY", "updated-test-key");
    vi.stubEnv("LITELLM_CONVERSION_MODEL", undefined);
    vi.stubEnv("LITELLM_AUDIT_MODEL", undefined);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it.each([
    ["the Sol default when unset", undefined, "gpt-5.6-sol-2026-07-09"],
    ["an explicit model override", "custom-proxy-model", "custom-proxy-model"],
  ])(
    "uses %s for both stages and pricing",
    async (_, configuredModel, model) => {
      vi.stubEnv("LITELLM_MODEL", configuredModel);
      const completion = (content: string) =>
        jsonResponse({
          model,
          choices: [{ message: { content } }],
          usage: { prompt_tokens: 12, completion_tokens: 3 },
        });
      const fetchMock = vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(completion("<h2>Course overview</h2>"))
        .mockResolvedValueOnce(
          jsonResponse({
            data: [
              {
                model_name: "unrelated-model",
                model_info: {
                  input_cost_per_token: 1,
                  output_cost_per_token: 1,
                },
              },
              {
                model_name: model,
                model_info: {
                  input_cost_per_token: 0.000002,
                  output_cost_per_token: 0.000004,
                },
              },
            ],
          })
        )
        .mockResolvedValueOnce(completion(COMPLETED_AUDIT));
      vi.stubGlobal("fetch", fetchMock);

      const result = await convertPdf(PDF_BYTES, "course.pdf");

      if ("error" in result) throw new Error(result.detail ?? result.error);

      const requests = fetchMock.mock.calls;
      expect(requests).toHaveLength(3);
      for (const index of [0, 2]) {
        const [url, options] = requests[index];
        expect(url).toBe("https://litellm.test/chat/completions");
        expect(options?.method).toBe("POST");
        expect(JSON.parse(options?.body as string).model).toBe(model);
      }
      const conversionRequest = JSON.parse(requests[0][1]?.body as string);
      const conversionParts = conversionRequest.messages[1]
        .content as LiteLLMContentPart[];
      expect(conversionParts.filter((part) => part.type === "file")).toEqual([
        {
          type: "file",
          file: {
            filename: "course.pdf",
            file_data: `data:application/pdf;base64,${PDF_BYTES.toString("base64")}`,
          },
        },
      ]);
      expect(
        conversionParts.filter((part) => part.type === "image_url")
      ).toEqual(
        RENDERED.pages.map((page) => ({
          type: "image_url",
          image_url: {
            url: `data:image/png;base64,${page.png.toString("base64")}`,
            detail: "high",
          },
        }))
      );
      const auditRequest = JSON.parse(requests[2][1]?.body as string);
      expect(auditRequest.messages[1].content.slice(1)).toEqual(
        conversionParts.slice(1)
      );
      expect(auditRequest.messages[1].content[0].text).toContain(
        'data-audit-heading-id="h1"'
      );
      expect(auditRequest.messages[1].content[0].text).not.toContain("<h2>");
      expect(auditRequest.messages[1].content[0].text).toContain(
        "page count: 3"
      );
      expect(requests[1][0]).toBe("https://litellm.test/model/info");
      for (const [, options] of requests) {
        expect(options?.headers).toMatchObject({
          Authorization: "Bearer updated-test-key",
        });
      }
      expect(result.model).toBe(model);
      expect(result.pageCount).toBe(3);
      expect(renderPdfPagesMock).toHaveBeenCalledExactlyOnceWith(PDF_BYTES);
      expect(result.errors).toEqual([]);
      expect(result.calls.map((call) => call.stage)).toEqual([
        "convert",
        "validate",
      ]);
      for (const call of result.calls) {
        expect(call).toMatchObject({
          model,
          promptTokens: 12,
          completionTokens: 3,
        });
        expect(call.costUsd).toBeCloseTo(0.000036, 10);
      }
      expect(result.tokensUsed).toBe(30);
    }
  );
});
