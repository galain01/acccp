import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

const shell =
  process.platform === "win32"
    ? [
        join(process.env.LOCALAPPDATA ?? "", "Programs/Git/bin/bash.exe"),
        join(process.env.ProgramFiles ?? "", "Git/bin/bash.exe"),
      ].find(existsSync)
    : "/bin/sh";
const source = readFileSync("services/renderer/start-renderer.sh", "utf8")
  .replaceAll("\r\n", "\n")
  // Capture the worker's exact environment without starting the native worker.
  .replace("exec /usr/bin/env -i \\\n", "printf '%s\\n' \\\n");

function startup(supabaseUrl: string) {
  const result = spawnSync(shell!, ["-s"], {
    input: source,
    encoding: "utf8",
    env: {
      ...process.env,
      GOTENBERG_USERNAME: "test-user",
      GOTENBERG_PASSWORD: "test-password",
      PORT: "3000",
      SUPABASE_URL: supabaseUrl,
      API_DOWNLOAD_FROM_ALLOW_LIST: ".*",
      API_DOWNLOAD_FROM_DENY_PRIVATE_IPS: "false",
      HTTPS_PROXY: "http://private-proxy.invalid",
    },
  });
  expect(result.error).toBeUndefined();
  expect(result.status, result.stderr).toBe(0);
  return Object.fromEntries(
    result.stdout
      .trim()
      .split("\n")
      .filter((line) => line.includes("="))
      .map((line) => {
        const separator = line.indexOf("=");
        return [line.slice(0, separator), line.slice(separator + 1)];
      })
  );
}

describe.skipIf(!shell)("renderer startup download restrictions", () => {
  it("permits only configured signed PPTX downloads without bypassing private IP checks", () => {
    const environment = startup("https://project.supabase.co/");
    expect(environment.API_DISABLE_DOWNLOAD_FROM).toBe("false");
    expect(environment.API_DOWNLOAD_FROM_ALLOW_LIST).toBeUndefined();
    expect(environment.API_DOWNLOAD_FROM_DENY_PRIVATE_IPS).toBe("true");
    expect(environment.API_DOWNLOAD_FROM_ENABLE_ENVIRONMENT_PROXY).toBe(
      "false"
    );
    expect(environment.HTTPS_PROXY).toBeUndefined();
    expect(environment.API_DOWNLOAD_FROM_MAX_RETRY).toBe("0");
    expect(environment.API_BODY_LIMIT).toBe("32MB");
    expect(environment.API_TIMEOUT).toBe("60s");
    expect(environment.LIBREOFFICE_DENY_LIST).toBe(".*");
    expect(environment.WEBHOOK_DISABLE).toBe("true");
    const deny = new RegExp(environment.API_DOWNLOAD_FROM_DENY_LIST);
    const signed =
      "https://project.supabase.co/storage/v1/object/sign/documents/session/document/job/render-id.pptx?token=header.payload.signature&download=source.pptx";
    expect(deny.test(signed)).toBe(false);
    for (const url of [
      signed.replace("https:", "http:"),
      signed.replace("project.supabase.co", "other.supabase.co"),
      signed.replace("project.supabase.co", "project.supabase.co.evil.test"),
      signed.replace("project.supabase.co", "project.supabase.co@127.0.0.1"),
      signed.replace("project.supabase.co", "user@project.supabase.co"),
      signed.replace("/sign/documents/", "/public/documents/"),
      signed.replace("render-id.pptx", "render-id.pdf"),
      signed.replace("/job/", "/job/../"),
      signed.replace("/job/", "/job%2F"),
      signed.replace("download=source.pptx", "download=secret.pptx"),
      `${signed}&redirect=https://evil.test`,
      "http://169.254.169.254/",
    ])
      expect(deny.test(url), url).toBe(true);
  });

  it.each([
    "",
    "http://127.0.0.1:54321",
    "https://project.supabase.co.evil.test",
    "https://project.supabase.co@127.0.0.1",
    "https://project.supabase.co/subpath",
    "https://project.supabase.co?token=secret",
    "https://project.supabase.co:443",
    "https://custom-supabase.example.test",
    "https://-project.supabase.co",
  ])("leaves downloads disabled for unsupported storage origin %s", (url) => {
    const environment = startup(url);
    expect(environment.API_DISABLE_DOWNLOAD_FROM).toBe("true");
    expect(environment.API_DOWNLOAD_FROM_DENY_LIST).toBe(".*");
  });
});
