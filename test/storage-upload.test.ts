import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  createClient: vi.fn(),
  signUpload: vi.fn(),
  signDownload: vi.fn(),
  fetch: vi.fn(),
}));
vi.mock("@supabase/supabase-js", () => ({ createClient: mocks.createClient }));
beforeEach(() => {
  vi.stubEnv("SUPABASE_URL", "https://storage.test");
  vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "synthetic-key");
  mocks.createClient.mockReturnValue({
    storage: {
      from: () => ({
        createSignedUploadUrl: mocks.signUpload,
        createSignedUrl: mocks.signDownload,
      }),
    },
  });
  mocks.signDownload.mockResolvedValue({
    data: { signedUrl: "https://storage.test/signed" },
    error: null,
  });
  vi.stubGlobal("fetch", mocks.fetch);
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.resetModules();
  vi.clearAllMocks();
});
describe("direct upload storage transport", () => {
  it("cancels signed read URL creation with the caller's signal", async () => {
    const controller = new AbortController();
    mocks.fetch.mockImplementation(
      (_input, options) =>
        new Promise((_resolve, reject) => {
          options.signal.addEventListener(
            "abort",
            () => reject(new Error("cancelled")),
            { once: true }
          );
        })
    );
    mocks.signDownload.mockImplementationOnce(async () => {
      const options = mocks.createClient.mock.calls.at(-1)![2];
      await options.global.fetch("https://storage.test/sign", {
        method: "POST",
      });
    });
    const { createSignedUrl } = await import("@/lib/storage");
    const pending = createSignedUrl("owned/render.pptx", 60, "source.pptx", {
      signal: controller.signal,
    });
    controller.abort();
    await expect(pending).rejects.toThrow("cancelled");
    expect(mocks.fetch).toHaveBeenCalledWith(
      "https://storage.test/sign",
      expect.objectContaining({ signal: controller.signal })
    );
  });

  it("creates a non-overwriting capability and extracts its actual deadline", async () => {
    const exp = Math.floor(Date.now() / 1000) + 7200;
    const token = `header.${Buffer.from(JSON.stringify({ exp })).toString("base64url")}.signature`;
    mocks.signUpload.mockResolvedValue({
      data: { signedUrl: `https://storage.test/upload?token=${token}`, token },
      error: null,
    });
    const { createSignedUploadUrl } = await import("@/lib/storage");
    expect(await createSignedUploadUrl("owned/source.pptx")).toMatchObject({
      expiresAt: new Date(exp * 1000).toISOString(),
    });
    expect(mocks.signUpload).toHaveBeenCalledWith("owned/source.pptx", {
      upsert: false,
    });
  });
  it.each([
    "bad",
    `header.${Buffer.from(JSON.stringify({ exp: 1 })).toString("base64url")}.signature`,
  ])("rejects a missing or expired token deadline", async (token) => {
    mocks.signUpload.mockResolvedValue({
      data: { signedUrl: "https://storage.test/upload", token },
      error: null,
    });
    const { createSignedUploadUrl } = await import("@/lib/storage");
    await expect(createSignedUploadUrl("owned/source.pptx")).rejects.toThrow(
      "Could not prepare"
    );
  });
  it("rejects header-declared oversize content before buffering", async () => {
    mocks.fetch.mockResolvedValue(
      new Response("large", { headers: { "content-length": "11" } })
    );
    const { downloadObjectBounded, StorageObjectSizeError } =
      await import("@/lib/storage");
    await expect(
      downloadObjectBounded("owned/source.pptx", 10)
    ).rejects.toBeInstanceOf(StorageObjectSizeError);
  });
  it("bounds actual streamed bytes when the header is absent or false", async () => {
    mocks.fetch.mockResolvedValue(
      new Response("123456", { headers: { "content-length": "1" } })
    );
    const { downloadObjectBounded, StorageObjectSizeError } =
      await import("@/lib/storage");
    await expect(
      downloadObjectBounded("owned/source.pptx", 5)
    ).rejects.toBeInstanceOf(StorageObjectSizeError);
  });
  it("accepts exactly the allowed bytes and does not forward credentials or follow redirects", async () => {
    mocks.fetch.mockResolvedValue(new Response("12345"));
    const { downloadObjectBounded } = await import("@/lib/storage");
    expect(await downloadObjectBounded("owned/source.pptx", 5)).toEqual(
      Buffer.from("12345")
    );
    expect(mocks.fetch).toHaveBeenCalledWith(
      "https://storage.test/signed",
      expect.objectContaining({
        credentials: "omit",
        redirect: "error",
        signal: expect.any(AbortSignal),
      })
    );
    const readSignal = mocks.fetch.mock.calls[0][1].signal;
    const signingClient = mocks.createClient.mock.calls.at(-1)![2];
    await signingClient.global.fetch("https://storage.test/sign");
    expect(mocks.fetch.mock.calls.at(-1)![1].signal).toBe(readSignal);
  });
});
