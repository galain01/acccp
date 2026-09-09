import { Resend } from "resend";

let resend: Resend | null = null;

function getResendClient(): Resend {
  if (!resend) {
    resend = new Resend(process.env.RESEND_API_KEY);
  }
  return resend;
}

// Console delivery is for local development only. A missing email provider in
// a production/preview deployment must never put sign-in codes in server logs.
const EMAIL_PROVIDER = process.env.EMAIL_PROVIDER ?? "console";

export async function sendOtpEmail(email: string, otp: string): Promise<void> {
  if (EMAIL_PROVIDER === "console") {
    if (process.env.NODE_ENV === "production") {
      throw new Error("Email delivery is not configured for production.");
    }
    console.log(`[email-otp] ${email}: ${otp} (expires in 5 minutes)`);
    return;
  }

  if (
    EMAIL_PROVIDER !== "resend" ||
    !process.env.RESEND_API_KEY?.trim() ||
    !process.env.EMAIL_FROM?.trim()
  ) {
    throw new Error("Email delivery is not configured.");
  }

  try {
    const { error } = await getResendClient().emails.send({
      from: process.env.EMAIL_FROM,
      to: email,
      subject: "Your CarmenCanvas Accessibility Converter sign-in code",
      text: `Your sign-in code is ${otp}. It expires in 5 minutes.`,
    });
    if (error) throw new Error("Email provider rejected delivery.");
  } catch {
    // Provider errors can include request details. Never expose them to the
    // auth response or logs, which could reveal the code, address, or API key.
    throw new Error("Failed to send sign-in email. Please try again.");
  }
}
