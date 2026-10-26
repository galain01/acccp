import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => ({ handler: vi.fn() }));
vi.mock("@/lib/auth", () => ({ auth: { handler: fixture.handler } }));

import { GET, POST } from "@/app/api/auth/[...all]/route";

const limit = 32 * 1024;
const encoder = new TextEncoder();

function request(body: BodyInit | null, headers: HeadersInit = {}) {
  return new Request("https://acccp.example/api/auth/sign-in/email-otp", {
    method: "POST",
    headers,
    body,
    ...(body instanceof ReadableStream ? { duplex: "half" } : {}),
  });
}

beforeEach(() => {
  fixture.handler.mockReset().mockResolvedValue(new Response("accepted"));
});
afterEach(() => vi.useRealTimers());

describe("authentication request boundary", () => {
  it("rejects a posted body before the auth parser can allocate validation errors", async () => {
    const response = await POST(
      request(
        JSON.stringify({ provider: "google", scopes: Array(20_000).fill(0) })
      )
    );
    expect(response.status).toBe(413);
    expect(fixture.handler).not.toHaveBeenCalled();
  });

  it.each([undefined, "1", "0"])(
    "counts actual streamed bytes with Content-Length %s",
    async (length) => {
      const cancel = vi.fn();
      const body = new ReadableStream({
        start(controller) {
          controller.enqueue(new Uint8Array(limit));
          controller.enqueue(new Uint8Array(1));
        },
        cancel,
      });
      const response = await POST(
        request(body, length === undefined ? {} : { "Content-Length": length })
      );
      expect(response.status).toBe(413);
      expect(cancel).toHaveBeenCalledOnce();
      expect(fixture.handler).not.toHaveBeenCalled();
    }
  );

  it("rejects an oversized declared body without waiting for its first byte", async () => {
    const cancel = vi.fn();
    const response = await POST(
      request(new ReadableStream({ cancel }), {
        "Content-Length": String(limit + 1),
      })
    );
    expect(response.status).toBe(413);
    expect(cancel).toHaveBeenCalledOnce();
    expect(fixture.handler).not.toHaveBeenCalled();
  });

  it("preserves exact-limit bytes, request metadata and the response with cookies", async () => {
    const text = "é".repeat(limit / 2);
    const original = request(text, {
      "Content-Type": "application/json",
      Cookie: "session=synthetic",
      Origin: "https://acccp.example",
    });
    const expected = new Response("auth response", {
      status: 201,
      headers: [
        ["Set-Cookie", "first=1; HttpOnly; Secure"],
        ["Set-Cookie", "second=2; HttpOnly; Secure"],
      ],
    });
    fixture.handler.mockImplementation(async (forwarded: Request) => {
      expect(forwarded.url).toBe(original.url);
      expect(forwarded.method).toBe("POST");
      expect([...forwarded.headers]).toEqual([...original.headers]);
      expect(new Uint8Array(await forwarded.arrayBuffer())).toEqual(
        encoder.encode(text)
      );
      return expected;
    });
    expect(await POST(original)).toBe(expected);
    expect(fixture.handler).toHaveBeenCalledOnce();
  });

  it("leaves GET and bodyless POST semantics unchanged", async () => {
    const get = new Request("https://acccp.example/api/auth/get-session");
    await GET(get);
    expect(fixture.handler).toHaveBeenLastCalledWith(get);
    const post = request(null);
    await POST(post);
    expect(fixture.handler).toHaveBeenLastCalledWith(post);
  });

  it("times out a trickling body and cancels without awaiting a stuck cancellation", async () => {
    vi.useFakeTimers();
    const cancel = vi.fn(() => new Promise<void>(() => {}));
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode("{"));
      },
      cancel,
    });
    const pending = POST(request(body));
    await vi.advanceTimersByTimeAsync(10_000);
    const response = await pending;
    expect(response.status).toBe(408);
    expect(cancel).toHaveBeenCalledOnce();
    expect(fixture.handler).not.toHaveBeenCalled();
  });

  it("cancels an aborted request and returns no internal error text", async () => {
    const abort = new AbortController();
    const cancel = vi.fn();
    const body = new ReadableStream({ cancel });
    const original = new Request(request(body), { signal: abort.signal });
    const pending = POST(original);
    abort.abort(new Error("private internal detail"));
    const response = await pending;
    expect(response.status).toBe(400);
    expect(await response.text()).not.toContain("private internal detail");
    expect(cancel).toHaveBeenCalledOnce();
    expect(fixture.handler).not.toHaveBeenCalled();
  });

  it("handles a failed body stream without invoking authentication", async () => {
    const body = new ReadableStream({
      start(controller) {
        controller.error(new Error("private transport detail"));
      },
    });
    const response = await POST(request(body));
    expect(response.status).toBe(400);
    expect(await response.text()).not.toContain("private transport detail");
    expect(fixture.handler).not.toHaveBeenCalled();
  });
});
