// Run after a production build: node scripts/check-framework-runtime.mjs
// Local compatibility smoke only: no authenticated sessions or document processing.
// Sources: bundled Next.js guides/server-actions.md and functions/redirect.md;
// the action ID is resolved from this build, never copied from another deployment.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { readFile, stat } from "node:fs/promises";
import { createServer } from "node:net";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

const app = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const stop = new AbortController();
const deadline = setTimeout(() => stop.abort(), 60_000);
const onSignal = () => stop.abort();
process.once("SIGINT", onSignal);
process.once("SIGTERM", onSignal);
let child;
let exited;
let childStderr = Buffer.alloc(0);
let serviceTrap;
let serviceContacts = 0;
const checks = [];

async function listen(server) {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return server.address().port;
}

async function close(server) {
  if (server?.listening) await new Promise((done) => server.close(done));
}

async function request(base, path, options = {}) {
  const response = await fetch(`${base}${path}`, {
    ...options,
    redirect: "manual",
    credentials: "omit",
    signal: AbortSignal.any([stop.signal, AbortSignal.timeout(5_000)]),
  });
  const reader = response.body?.getReader();
  const chunks = [];
  let bytes = 0;
  try {
    while (reader) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.length;
      if (bytes > 2 * 1024 * 1024) {
        await reader.cancel();
        throw new Error("Smoke response exceeded its 2 MiB bound");
      }
      chunks.push(value);
    }
  } finally {
    reader?.releaseLock();
  }
  return { response, text: Buffer.concat(chunks, bytes).toString("utf8") };
}

try {
  // Next automatically loads these files. Refuse them rather than inheriting
  // real service credentials through a path outside our explicit child env.
  for (const name of [
    ".env",
    ".env.local",
    ".env.production",
    ".env.production.local",
  ]) {
    const exists = await stat(join(app, name)).then(
      () => true,
      (error) => {
        if (error.code === "ENOENT") return false;
        throw error;
      }
    );
    assert.equal(
      exists,
      false,
      `Run this smoke in a clean checkout without ${name}`
    );
  }
  assert.ok(
    (await readFile(join(app, ".next/BUILD_ID"), "utf8")).trim(),
    "Build the app before this smoke"
  );
  const { version } = JSON.parse(
    await readFile(join(app, "node_modules/next/package.json"), "utf8")
  );
  const manifest = JSON.parse(
    await readFile(
      join(app, ".next/server/server-reference-manifest.json"),
      "utf8"
    )
  );
  const actions = Object.entries(manifest.node).filter(
    ([, entry]) =>
      entry.filename === "lib/actions/sessions.ts" &&
      entry.exportedName === "listSessions" &&
      Object.hasOwn(entry.workers, "app/dashboard/page")
  );
  assert.equal(
    actions.length,
    1,
    "Expected the built, read-only listSessions action"
  );

  // The trap accepts no protocol and retains no data. Any service access fails
  // the smoke even if the application happens to return an expected response.
  serviceTrap = createServer((socket) => {
    serviceContacts++;
    socket.destroy();
  });
  const servicePort = await listen(serviceTrap);
  const reservation = createServer();
  const port = await listen(reservation);
  await close(reservation);
  const base = `http://127.0.0.1:${port}`;
  const serviceUrl = `http://127.0.0.1:${servicePort}`;
  const environment = {
    PATH: dirname(process.execPath),
    NODE_ENV: "production",
    NEXT_TELEMETRY_DISABLED: "1",
    DATABASE_URL: `postgresql://synthetic:synthetic@127.0.0.1:${servicePort}/synthetic?connect_timeout=1`,
    BETTER_AUTH_URL: base,
    BETTER_AUTH_SECRET:
      "synthetic-framework-smoke-secret-not-for-real-use-2026",
    SUPABASE_URL: serviceUrl,
    SUPABASE_SERVICE_ROLE_KEY: "synthetic-smoke-service-key",
    LITELLM_BASE_URL: serviceUrl,
    LITELLM_API_KEY: "synthetic-smoke-model-key",
    GOTENBERG_URL: serviceUrl,
    GOTENBERG_USERNAME: "synthetic",
    GOTENBERG_PASSWORD: "synthetic",
    NATIVE_PDF_URL: serviceUrl,
    NATIVE_PDF_API_KEY: "synthetic-smoke-native-pdf-key-not-for-real-use",
    EMAIL_PROVIDER: "console", // Production code rejects console OTP delivery.
  };
  for (const key of ["SystemRoot", "WINDIR", "TEMP", "TMP"])
    if (process.env[key]) environment[key] = process.env[key];
  child = spawn(
    process.execPath,
    [
      join(app, "node_modules/next/dist/bin/next"),
      "start",
      "--hostname",
      "127.0.0.1",
      "--port",
      String(port),
    ],
    {
      cwd: app,
      env: environment,
      windowsHide: true,
      stdio: ["ignore", "ignore", "pipe"],
    }
  );
  child.stderr.on("data", (chunk) => {
    childStderr = Buffer.concat([childStderr, chunk]).subarray(-8 * 1024);
  });
  exited = new Promise((done) => {
    child.once("exit", done);
    child.once("error", () => {
      stop.abort();
      done();
    });
  });

  const startupDeadline = Date.now() + 20_000;
  let login;
  while (!login) {
    stop.signal.throwIfAborted();
    assert.equal(
      child.exitCode,
      null,
      `Built Next process exited during startup\n${childStderr.toString("utf8")}`
    );
    try {
      login = await request(base, "/");
    } catch (error) {
      if (stop.signal.aborted || Date.now() >= startupDeadline) throw error;
      await delay(100, undefined, { signal: stop.signal });
    }
  }
  assert.equal(login.response.status, 200);
  assert.match(login.text, /Document Accessibility Workspace/);
  assert.match(login.text, /Log in to get started/);
  checks.push("login HTML: 200");

  for (const path of ["/dashboard", "/admin"]) {
    const { response } = await request(base, path);
    assert.equal(
      response.status,
      307,
      `${path} must redirect signed-out users`
    );
    assert.equal(
      new URL(response.headers.get("location"), base).href,
      `${base}/`
    );
    checks.push(`${path}: signed-out redirect`);
  }
  const session = await request(base, "/api/auth/get-session");
  assert.equal(session.response.status, 200);
  assert.equal(JSON.parse(session.text), null);
  checks.push("auth session: signed out");

  for (const path of [
    "/api/convert",
    "/api/document-upload",
    "/api/powerpoint-review",
    "/api/admin/model-info",
  ]) {
    const { response, text } = await request(base, path, {
      method: path === "/api/admin/model-info" ? "GET" : "POST",
      headers: { Origin: base, "Content-Type": "application/json" },
      ...(path === "/api/admin/model-info" ? {} : { body: "{}" }),
    });
    assert.equal(response.status, 401, `${path} must reject signed-out access`);
    assert.deepEqual(JSON.parse(text), { error: "Unauthorized" });
    checks.push(`${path}: 401`);
  }
  const action = await request(base, "/dashboard", {
    method: "POST",
    headers: {
      Origin: base,
      "Next-Action": actions[0][0],
      Accept: "text/x-component",
      "Content-Type": "text/plain;charset=UTF-8",
    },
    body: "[]",
  });
  assert.equal(
    action.response.status,
    200,
    "Fetch actions communicate redirects in a successful Flight response"
  );
  assert.equal(action.response.headers.get("x-action-redirect"), "/;push");
  assert.match(
    action.response.headers.get("content-type") ?? "",
    /^text\/x-component(?:;|$)/
  );
  checks.push("listSessions action: signed-out redirect");
  assert.equal(
    serviceContacts,
    0,
    "Signed-out smoke reached a configured service"
  );
  console.log(JSON.stringify({ next: version, checks, serviceContacts }));
} finally {
  stop.abort();
  clearTimeout(deadline);
  try {
    if (child && child.exitCode === null && child.signalCode === null) {
      child.kill("SIGTERM");
      const force = setTimeout(() => child.kill("SIGKILL"), 2_000);
      try {
        await Promise.race([
          exited,
          delay(5_000, undefined, { ref: false }).then(() => {
            throw new Error("Owned Next process did not stop");
          }),
        ]);
      } finally {
        clearTimeout(force);
      }
    }
  } finally {
    await close(serviceTrap);
    process.removeListener("SIGINT", onSignal);
    process.removeListener("SIGTERM", onSignal);
  }
}
