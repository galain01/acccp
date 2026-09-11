import { beforeEach, describe, expect, it, vi } from "vitest";

const { authorize, config, pricing } = vi.hoisted(() => ({
  authorize: vi.fn(),
  config: vi.fn(),
  pricing: vi.fn(),
}));
vi.mock("@/lib/auth", () => ({ verifyRoleOrUnauthorized: authorize }));
vi.mock("@/lib/litellm", () => ({
  getLiteLLMConfig: config,
  fetchModelPricing: pricing,
}));

import { GET } from "@/app/api/admin/model-info/route";

const connection = {
  baseUrl: "https://gateway.example.test",
  apiKey: "synthetic-key-not-for-responses",
};
const rates = {
  source: "gateway",
  inputCostPerToken: 0.000001,
  outputCostPerToken: 0.000002,
};

function request(query = "") {
  return new Request(`https://example.test/api/admin/model-info${query}`);
}

describe("admin model pricing by stage", () => {
  beforeEach(() => {
    authorize.mockReset().mockResolvedValue({ user: { role: "admin" } });
    config.mockReset().mockImplementation((stage?: "convert" | "validate") => ({
      ...connection,
      model: stage ? `${stage}-model` : "shared-model",
    }));
    pricing.mockReset().mockResolvedValue(rates);
  });

  it("keeps the shared model and response shape when no stage is supplied", async () => {
    const response = await GET(request());

    expect(response.status).toBe(200);
    expect(authorize).toHaveBeenCalledWith(["admin"]);
    expect(config).toHaveBeenCalledWith();
    expect(pricing).toHaveBeenCalledWith("shared-model", {
      ...connection,
      model: "shared-model",
    });
    expect(await response.json()).toEqual({ model: "shared-model", ...rates });
  });

  it.each(["convert", "validate"] as const)(
    "prices the %s stage and identifies the selected stage",
    async (stage) => {
      const response = await GET(request(`?stage=${stage}`));

      expect(response.status).toBe(200);
      expect(config).toHaveBeenCalledWith(stage);
      expect(pricing).toHaveBeenCalledWith(`${stage}-model`, {
        ...connection,
        model: `${stage}-model`,
      });
      expect(await response.json()).toEqual({
        model: `${stage}-model`,
        stage,
        ...rates,
      });
    }
  );

  it.each([
    "?stage=",
    "?stage=audit",
    "?stage=Convert",
    "?stage=%20convert%20",
    "?stage=convert&stage=validate",
    "?stage=convert&stage=convert",
  ])(
    "rejects invalid or ambiguous stages before reading settings: %s",
    async (query) => {
      const response = await GET(request(query));

      expect(response.status).toBe(400);
      expect(config).not.toHaveBeenCalled();
      expect(pricing).not.toHaveBeenCalled();
    }
  );

  it.each([401, 403])(
    "returns authorization failure %s before reading query, settings, or pricing",
    async (status) => {
      const denied = Response.json({ error: "Unauthorized" }, { status });
      authorize.mockResolvedValue({ response: denied });
      const input = request("?stage=invalid");
      const url = vi.spyOn(input, "url", "get");

      expect(await GET(input)).toBe(denied);
      expect(url).not.toHaveBeenCalled();
      expect(config).not.toHaveBeenCalled();
      expect(pricing).not.toHaveBeenCalled();
      url.mockRestore();
    }
  );

  it("returns 404 when the selected model has no usable pricing", async () => {
    pricing.mockResolvedValue(null);
    const response = await GET(request("?stage=validate"));

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({
      error: 'No pricing available for model "validate-model".',
    });
  });

  it("does not expose configuration exception details or credentials", async () => {
    config.mockImplementation(() => {
      throw new Error(`${connection.apiKey}: unexpected configuration details`);
    });
    const response = await GET(request("?stage=convert"));

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({
      error: "Model provider configuration is unavailable.",
    });
    expect(pricing).not.toHaveBeenCalled();
  });

  it("does not expose unexpected pricing-provider failures", async () => {
    pricing.mockRejectedValue(new Error(`${connection.apiKey}: provider body`));
    const response = await GET(request("?stage=validate"));

    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({
      error: "Model pricing is temporarily unavailable.",
    });
  });
});
