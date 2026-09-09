import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { convertPdf } from "@/lib/convert";
import { clearModelPricingCache } from "@/lib/litellm";

const PDF_BYTES = Buffer.from("%PDF-1.7\nmock pdf bytes\n%%EOF");

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    headers: { "Content-Type": "application/json" },
  });
}

describe("conversion model configuration", () => {
  beforeEach(() => {
    clearModelPricingCache();
    vi.stubEnv("LITELLM_BASE_URL", "https://litellm.test");
    vi.stubEnv("LITELLM_API_KEY", "updated-test-key");
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
        .mockResolvedValueOnce(completion("[]"));
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
      expect(conversionRequest.messages).toEqual([
        { role: "system", content: expect.any(String) },
        {
          role: "user",
          content: [
            { type: "text", text: expect.any(String) },
            {
              type: "file",
              file: {
                filename: "course.pdf",
                file_data: `data:application/pdf;base64,${PDF_BYTES.toString("base64")}`,
              },
            },
          ],
        },
      ]);
      const auditRequest = JSON.parse(requests[2][1]?.body as string);
      expect(auditRequest.messages).toEqual([
        { role: "system", content: expect.any(String) },
        { role: "user", content: expect.stringContaining(result.html) },
      ]);
      expect(requests[1][0]).toBe("https://litellm.test/model/info");
      for (const [, options] of requests) {
        expect(options?.headers).toMatchObject({
          Authorization: "Bearer updated-test-key",
        });
      }
      expect(result.model).toBe(model);
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
