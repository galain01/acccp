"use client";

import { JSX, useState } from "react";
import { useRouter } from "next/navigation";
import { Loader2 } from "lucide-react";

import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import {
  InputOTP,
  InputOTPGroup,
  InputOTPSlot,
} from "@/components/ui/input-otp";
import { Button } from "@/components/ui/button";
import { authClient } from "@/lib/auth-client";

const RESEND_COOLDOWN_SECONDS = 30;

type Step = "email" | "otp";

export default function HomePage(): React.JSX.Element {
  const router = useRouter();
  const [step, setStep] = useState<Step>("email");
  const [email, setEmail] = useState("");
  const [otp, setOtp] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [cooldown, setCooldown] = useState(0);

  function startCooldown(): void {
    setCooldown(RESEND_COOLDOWN_SECONDS);
    const interval = setInterval(() => {
      setCooldown((prev) => {
        if (prev <= 1) {
          clearInterval(interval);
          return 0;
        }
        return prev - 1;
      });
    }, 1000);
  }

  async function sendCode(): Promise<void> {
    setError(null);
    setIsSubmitting(true);
    const { error: sendError } = await authClient.emailOtp.sendVerificationOtp({
      email,
      type: "sign-in",
    });
    setIsSubmitting(false);
    if (sendError) {
      setError(sendError.message ?? "Failed to send code. Please try again.");
      return;
    }
    setStep("otp");
    startCooldown();
  }

  async function handleEmailSubmit(event: React.SubmitEvent): Promise<void> {
    event.preventDefault();
    await sendCode();
  }

  async function verifyOtp(code: string): Promise<void> {
    if (isSubmitting) return;
    setError(null);
    setIsSubmitting(true);
    const { error: verifyError } = await authClient.signIn.emailOtp({
      email,
      otp: code,
      // Only used if this is the account's first sign-in; gives admins a
      // readable name to approve against instead of a blank display name.
      name: email.split("@")[0],
    });
    setIsSubmitting(false);
    if (verifyError) {
      setError(
        verifyError.message ?? "Invalid or expired code. Please try again."
      );
      return;
    }
    router.push("/dashboard");
    router.refresh();
  }

  async function handleOtpSubmit(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    await verifyOtp(otp);
  }

  function handleUseDifferentEmail(): void {
    setStep("email");
    setEmail("");
    setOtp("");
    setError(null);
    setCooldown(0);
  }

  return (
    <main className="flex min-h-svh flex-col items-center justify-center gap-8 px-4 py-12">
      <header className="flex w-full max-w-sm flex-col gap-1 text-center">
        <h1 className="text-2xl font-bold">
          Accessible Canvas Content Conversion Platform
        </h1>
        <p className="text-sm text-muted-foreground">
          Convert your PDF course content into accessible Canvas-ready HTML.
        </p>
      </header>
      {step === "email" ? (
        <Card className="w-full max-w-sm">
          <CardHeader className="text-center">
            <CardTitle>Log in to get started</CardTitle>
            <CardDescription>
              Enter your OSU email below. We&apos;ll send you a one-time code to
              verify it&apos;s you.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="grid gap-2">
              <form id="email-form" onSubmit={handleEmailSubmit}>
                <Label htmlFor="email">Email</Label>
                <Input
                  id="email"
                  type="email"
                  placeholder="name.#@osu.edu"
                  value={email}
                  onChange={(event) => setEmail(event.target.value)}
                  aria-invalid={error ? true : undefined}
                  autoFocus
                  required
                />
                {error && <p className="text-sm text-destructive">{error}</p>}
              </form>
            </div>
          </CardContent>
          <CardFooter>
            <Button
              type="submit"
              form="email-form"
              className="w-full"
              disabled={isSubmitting}
            >
              {isSubmitting && (
                <Loader2 className="animate-spin" aria-hidden="true" />
              )}
              {isSubmitting ? "Sending code…" : "Log in"}
            </Button>
          </CardFooter>
        </Card>
      ) : (
        <Card className="w-full max-w-sm">
          <CardHeader className="text-center">
            <CardTitle>Enter your code</CardTitle>
            <CardDescription>
              We sent a 6-digit code to <strong>{email}</strong>.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="flex flex-col items-center gap-2">
              <form id="otp-form" onSubmit={handleOtpSubmit}>
                <InputOTP
                  id="otp"
                  maxLength={6}
                  value={otp}
                  onChange={setOtp}
                  onComplete={verifyOtp}
                  autoComplete="one-time-code"
                  aria-invalid={error ? true : undefined}
                  disabled={isSubmitting}
                  containerClassName="justify-center"
                  autoFocus
                  required
                >
                  <InputOTPGroup>
                    <InputOTPSlot index={0} />
                    <InputOTPSlot index={1} />
                    <InputOTPSlot index={2} />
                    <InputOTPSlot index={3} />
                    <InputOTPSlot index={4} />
                    <InputOTPSlot index={5} />
                  </InputOTPGroup>
                </InputOTP>
                {error && <p className="text-sm text-destructive">{error}</p>}
              </form>
            </div>
          </CardContent>
          <CardFooter className="flex flex-col gap-2">
            <Button
              type="submit"
              form="otp-form"
              className="w-full"
              disabled={isSubmitting || otp.length !== 6}
            >
              {isSubmitting && (
                <Loader2 className="animate-spin" aria-hidden="true" />
              )}
              {isSubmitting ? "Verifying…" : "Verify and log in"}
            </Button>
            <div className="flex w-full items-center justify-between">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={handleUseDifferentEmail}
                disabled={isSubmitting}
              >
                Use a different email
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={sendCode}
                disabled={isSubmitting || cooldown > 0}
              >
                {cooldown > 0 ? `Resend in ${cooldown}s` : "Resend code"}
              </Button>
            </div>
          </CardFooter>
        </Card>
      )}
    </main>
  );
}
