import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const fixture = vi.hoisted(() => {
  process.env.BETTER_AUTH_URL = "https://acccp.example";
  process.env.BETTER_AUTH_SECRET =
    "synthetic-auth-integration-secret-not-for-real-use";
  process.env.BETTER_AUTH_TELEMETRY = "false";
  return {
    store: {
      users: [],
      authSessions: [],
      account: [],
      verification: [],
    } as Record<string, Record<string, unknown>[]>,
    send: vi.fn(),
  };
});

vi.mock("@/lib/db", () => ({ db: {} }));
vi.mock("@/lib/email", () => ({ sendOtpEmail: fixture.send }));
vi.mock("better-auth/adapters/drizzle", async () => {
  const { memoryAdapter } = await import("better-auth/adapters/memory");
  const { randomUUID } = await import("node:crypto");
  return {
    // Exercise the real application auth options and parsers. The synthetic
    // adapter generates the UUIDs PostgreSQL normally supplies; no DB/email call.
    drizzleAdapter:
      () => (options: Parameters<ReturnType<typeof memoryAdapter>>[0]) => ({
        ...memoryAdapter(fixture.store)({
          ...options,
          advanced: {
            ...options.advanced,
            database: {
              ...options.advanced?.database,
              generateId: () => randomUUID(),
            },
          },
        }),
        id: "synthetic-postgres",
      }),
  };
});

import { GET, POST } from "@/app/api/auth/[...all]/route";

function frameworkRequest(
  url: string,
  init?: ConstructorParameters<typeof NextRequest>[1]
): Request {
  // Match Next's app-route request proxy getter/method binding. Native Request
  // or NextRequest alone does not exercise the production proxy boundary.
  return new Proxy(new NextRequest(url, init), {
    get(target, property) {
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

function post(path: string, body: unknown) {
  return POST(
    frameworkRequest(`https://acccp.example/api/auth${path}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: "https://acccp.example",
      },
      body: JSON.stringify(body),
    })
  );
}

beforeEach(() => {
  for (const table of Object.keys(fixture.store)) fixture.store[table] = [];
  fixture.send.mockReset().mockResolvedValue(undefined);
  vi.stubGlobal(
    "fetch",
    vi.fn().mockRejectedValue(new Error("Unexpected network access"))
  );
});
afterEach(() => {
  expect(fetch).not.toHaveBeenCalled();
  vi.unstubAllGlobals();
});

describe("bounded real Better Auth parsing with framework-proxied requests", () => {
  it("preserves the ordinary OTP, session cookie, session lookup and sign-out flow", async () => {
    const email = "synthetic@osu.edu";
    const sent = await post("/email-otp/send-verification-otp", {
      email,
      type: "sign-in",
    });
    expect(sent.status).toBe(200);
    expect(fixture.send).toHaveBeenCalledOnce();
    const otp = fixture.send.mock.calls[0][1];
    const signedIn = await post("/sign-in/email-otp", { email, otp });
    expect(signedIn.status).toBe(200);
    const cookies = signedIn.headers.getSetCookie();
    expect(cookies.some((cookie) => cookie.includes("session_token="))).toBe(
      true
    );
    const cookie = cookies.map((value) => value.split(";")[0]).join("; ");
    const session = await GET(
      frameworkRequest("https://acccp.example/api/auth/get-session", {
        headers: { Cookie: cookie },
      })
    );
    expect(session.status).toBe(200);
    expect((await session.json()).user.email).toBe(email);
    const signedOut = await POST(
      frameworkRequest("https://acccp.example/api/auth/sign-out", {
        method: "POST",
        headers: {
          Cookie: cookie,
          Origin: "https://acccp.example",
          "Content-Type": "application/json",
        },
        body: "{}",
      })
    );
    expect(signedOut.status).toBe(200);
    expect(
      signedOut.headers
        .getSetCookie()
        .some((value) => value.includes("Max-Age=0"))
    ).toBe(true);
  });

  it("retains the application email-domain gate", async () => {
    const response = await post("/email-otp/send-verification-otp", {
      email: "synthetic@example.test",
      type: "sign-in",
    });
    expect(response.status).toBe(403);
    expect(fixture.send).not.toHaveBeenCalled();
    expect(fixture.store.verification).toEqual([]);
  });

  it("rejects a large social scopes array before the real parser, with no adapter or email activity", async () => {
    const response = await post("/sign-in/social", {
      provider: "google",
      scopes: Array(20_000).fill(false),
    });
    expect(response.status).toBe(413);
    expect(fixture.send).not.toHaveBeenCalled();
    expect(
      Object.values(fixture.store).every((rows) => rows.length === 0)
    ).toBe(true);
  });

  it("keeps invalid small JSON as the auth handler's normal client error", async () => {
    const response = await POST(
      frameworkRequest("https://acccp.example/api/auth/sign-in/email-otp", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{",
      })
    );
    expect(response.status).toBe(400);
    expect(fixture.send).not.toHaveBeenCalled();
  });
});
