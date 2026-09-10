import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ createClient: vi.fn(), remove: vi.fn() }));
vi.mock("@supabase/supabase-js", () => ({ createClient: mocks.createClient }));

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.resetModules();
  vi.clearAllMocks();
});

describe("storage deletion cancellation", () => {
  it("passes the caller's AbortSignal to the actual SDK transport", async () => {
    vi.stubEnv("SUPABASE_URL", "https://storage.example.test");
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "synthetic-test-key");
    const response = new Response("[]", { status: 200 });
    const fetch = vi.fn().mockResolvedValue(response);
    vi.stubGlobal("fetch", fetch);
    mocks.remove.mockResolvedValue({ error: null });
    mocks.createClient.mockReturnValue({
      storage: { from: () => ({ remove: mocks.remove }) },
    });
    const { removeObjects } = await import("@/lib/storage");
    const controller = new AbortController();
    await removeObjects(["known/key"], { signal: controller.signal });
    expect(mocks.createClient).toHaveBeenCalledTimes(2);
    const scopedFetch = mocks.createClient.mock.calls[1][2].global.fetch;
    await scopedFetch(
      "https://storage.example.test/storage/v1/object/documents",
      { method: "DELETE" }
    );
    expect(fetch).toHaveBeenCalledWith(expect.any(String), {
      method: "DELETE",
      signal: controller.signal,
    });
    expect(mocks.remove).toHaveBeenCalledWith(["known/key"]);
  });
});
