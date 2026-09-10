import postgres from "postgres";
import { describe, expect, it } from "vitest";

import { databaseConnectionOptions } from "@/lib/db/connection-options";

const url = "postgres://localhost:5432/test";
const publicCertificate =
  "-----BEGIN CERTIFICATE-----\nTEST\n-----END CERTIFICATE-----";

describe("database TLS configuration", () => {
  it.each(["disable", "require", "verify-full"])(
    "a configured CA overrides URL sslmode=%s and requires certificate verification",
    async (mode) => {
      // Inspect the actual driver's resolved options without opening a socket.
      const client = postgres(
        `${url}?sslmode=${mode}`,
        databaseConnectionOptions(publicCertificate)
      );
      try {
        expect(client.options.ssl).toEqual({
          ca: publicCertificate,
          rejectUnauthorized: true,
        });
        expect(client.options.prepare).toBe(false);
      } finally {
        await client.end();
      }
    }
  );

  it("preserves the URL's TLS mode when no CA is configured", async () => {
    const client = postgres(
      `${url}?sslmode=verify-full`,
      databaseConnectionOptions("")
    );
    try {
      expect(client.options.ssl).toBe("verify-full");
    } finally {
      await client.end();
    }
  });

  it("accepts escaped PEM newlines used in deployment environment variables", () => {
    expect(
      databaseConnectionOptions(publicCertificate.replace(/\n/g, "\\n")).ssl
    ).toEqual({
      ca: publicCertificate,
      rejectUnauthorized: true,
    });
  });
});
