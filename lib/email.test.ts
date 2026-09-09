import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ send: vi.fn() }));

vi.mock("resend", () => ({
  Resend: class {
    emails = { send: mocks.send };
  },
}));

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  vi.stubEnv("NODE_ENV", "production");
  vi.stubEnv("EMAIL_PROVIDER", "resend");
  vi.stubEnv("RESEND_API_KEY", "test-provider-key");
  vi.stubEnv("EMAIL_FROM", "noreply@example.test");
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  mocks.send.mockResolvedValue({ error: null });
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("OTP delivery privacy", () => {
  it.each([undefined, "console"])(
    "refuses production console delivery with provider %s without logging the code",
    async (provider) => {
      vi.stubEnv("EMAIL_PROVIDER", provider);
      const { sendOtpEmail } = await import("./email");

      await expect(sendOtpEmail("person@osu.edu", "123456")).rejects.toThrow(
        "Email delivery is not configured for production."
      );
      expect(mocks.send).not.toHaveBeenCalled();
      expect(console.log).not.toHaveBeenCalled();
      expect(console.error).not.toHaveBeenCalled();
    }
  );

  it("keeps explicit local console delivery working", async () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("EMAIL_PROVIDER", "console");
    const { sendOtpEmail } = await import("./email");

    await sendOtpEmail("person@osu.edu", "123456");

    expect(console.log).toHaveBeenCalledWith(
      "[email-otp] person@osu.edu: 123456 (expires in 5 minutes)"
    );
    expect(mocks.send).not.toHaveBeenCalled();
  });

  it("sends production codes only through the configured email provider", async () => {
    const { sendOtpEmail } = await import("./email");

    await sendOtpEmail("person@osu.edu", "123456");

    expect(mocks.send).toHaveBeenCalledWith({
      from: "noreply@example.test",
      to: "person@osu.edu",
      subject: "Your CarmenCanvas Accessibility Converter sign-in code",
      text: "Your sign-in code is 123456. It expires in 5 minutes.",
    });
    expect(console.log).not.toHaveBeenCalled();
  });

  it.each(["invalid-provider", ""])(
    "rejects unsupported provider %s without leaking configuration",
    async (provider) => {
      vi.stubEnv("EMAIL_PROVIDER", provider);
      const { sendOtpEmail } = await import("./email");

      await expect(sendOtpEmail("person@osu.edu", "123456")).rejects.toThrow(
        "Email delivery is not configured."
      );
      expect(mocks.send).not.toHaveBeenCalled();
      expect(console.log).not.toHaveBeenCalled();
    }
  );

  it.each(["RESEND_API_KEY", "EMAIL_FROM"])(
    "rejects missing %s before attempting delivery",
    async (name) => {
      vi.stubEnv(name, " ");
      const { sendOtpEmail } = await import("./email");

      await expect(sendOtpEmail("person@osu.edu", "123456")).rejects.toThrow(
        "Email delivery is not configured."
      );
      expect(mocks.send).not.toHaveBeenCalled();
    }
  );

  it.each(["returned", "thrown"])(
    "does not expose provider details from a %s delivery error",
    async (mode) => {
      const privateDetails =
        "person@osu.edu code=123456 Authorization: test-provider-key";
      if (mode === "returned") {
        mocks.send.mockResolvedValue({ error: { message: privateDetails } });
      } else {
        mocks.send.mockRejectedValue(new Error(privateDetails));
      }
      const { sendOtpEmail } = await import("./email");

      await expect(sendOtpEmail("person@osu.edu", "123456")).rejects.toThrow(
        /^Failed to send sign-in email\. Please try again\.$/
      );
      expect(console.log).not.toHaveBeenCalled();
      expect(console.error).not.toHaveBeenCalled();
    }
  );
});
