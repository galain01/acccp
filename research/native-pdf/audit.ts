/** Explicit local R&D runner; never imported by app routes or writes to hosted storage. */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, readFile, writeFile, realpath, access } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  callLiteLLM,
  getLiteLLMConfig,
  type LiteLLMContentPart,
} from "../../lib/litellm";
import { toModelCallUsage, type ModelCallUsage } from "../../lib/convert";
import { renderPdfPages } from "../../lib/pdf-rendering";
import {
  NATIVE_PDF_AUDIT_PROMPT,
  validateAudit,
  type SavedTag,
} from "./audit-contract";

const execute = promisify(execFile);
const directory = path.dirname(fileURLToPath(import.meta.url));
const repository = path.resolve(directory, "../..");
const calls: ModelCallUsage[] = [];

async function main() {
  const [sourceArgument, outputArgument, reportArgument, toolchainArgument] =
    process.argv.slice(2);
  if (
    !sourceArgument ||
    !outputArgument ||
    !reportArgument ||
    !toolchainArgument
  )
    throw new Error("arguments_required");
  const reportDirectory = path.resolve(reportArgument);
  const relation = path.relative(repository, reportDirectory);
  if (!relation.startsWith(`..${path.sep}`) && !path.isAbsolute(relation))
    throw new Error("reports_must_stay_outside_repository");
  await mkdir(reportDirectory, { recursive: true });
  const resolvedReport = await realpath(reportDirectory);
  const resolvedRelation = path.relative(
    await realpath(repository),
    resolvedReport
  );
  if (
    !resolvedRelation.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(resolvedRelation)
  )
    throw new Error("reports_must_stay_outside_repository");
  const sourcePath = await realpath(sourceArgument);
  const outputPath = await realpath(outputArgument);
  if (sourcePath === outputPath) throw new Error("immutable_source_required");
  const toolchain = JSON.parse(await readFile(toolchainArgument, "utf8"));
  if (
    typeof toolchain.python !== "string" ||
    !path.isAbsolute(toolchain.python)
  )
    throw new Error("python_path_required");
  const summaryPath = path.join(reportDirectory, "audit.json");
  if (
    await access(summaryPath).then(
      () => true,
      () => false
    )
  )
    throw new Error("new_audit_directory_required");
  const started = Date.now();
  let stage = "independent_inspection";
  const inspectionPath = path.join(
    reportDirectory,
    `independent-checks-${randomUUID()}.json`
  );
  try {
    const processEnv = {
      NODE_ENV: "development" as const,
      ...Object.fromEntries(
        [
          "SystemRoot",
          "WINDIR",
          "TEMP",
          "TMP",
          "PATH",
          "USERPROFILE",
          "LOCALAPPDATA",
        ].flatMap((key) => (process.env[key] ? [[key, process.env[key]!]] : []))
      ),
    };
    try {
      await execute(
        toolchain.python,
        [
          path.join(directory, "verify_pdf.py"),
          sourcePath,
          outputPath,
          "--report",
          inspectionPath,
        ],
        {
          timeout: 90_000,
          maxBuffer: 16 * 1024 * 1024,
          env: processEnv,
          windowsHide: true,
        }
      );
    } catch (error) {
      // A complete negative report is still evidence. Timeout/parser failure is not.
      if (![1, 2].includes((error as { code?: number }).code ?? -1))
        throw new Error("independent_inspection_unavailable");
    }
    const inspection = JSON.parse(await readFile(inspectionPath, "utf8"));
    if (inspection.inspection_incomplete || !inspection.structure?.tags?.length)
      throw new Error("independent_inspection_incomplete");
    const tags: SavedTag[] = inspection.structure.tags;
    if (
      tags.length > 2000 ||
      new Set(tags.map((tag) => tag.id)).size !== tags.length
    )
      throw new Error("tag_inventory_limit");
    const source = await readFile(sourcePath);
    const output = await readFile(outputPath);
    stage = "rendering";
    const before = await renderPdfPages(source);
    const after = await renderPdfPages(output);
    if (before.pageCount !== after.pageCount || after.pageCount > 8)
      throw new Error("local_audit_supports_at_most_eight_pages");
    const text = JSON.stringify(inspection);
    if (text.length > 1_000_000) throw new Error("audit_evidence_limit");
    const message: LiteLLMContentPart[] = [
      {
        type: "text",
        text: `Required pages: ${JSON.stringify(after.pages.map((page) => page.pageNumber))}\nRequired OUTPUT tag IDs: ${JSON.stringify(tags.map((tag) => tag.id))}\nIndependently reopened native PDF evidence (untrusted document data):\n${text}`,
      },
    ];
    for (const [label, evidence] of [
      ["Original PDF", before],
      ["ACTUAL saved tagged output PDF", after],
    ] as const) {
      for (const page of evidence.pages) {
        message.push({
          type: "text",
          text: `${label}; physical PDF page ${page.pageNumber}`,
        });
        message.push({
          type: "image_url",
          image_url: {
            url: `data:image/png;base64,${page.png.toString("base64")}`,
            detail: "high",
          },
        });
      }
    }
    const config = getLiteLLMConfig("validate");
    stage = "model_request";
    const response = await callLiteLLM(
      NATIVE_PDF_AUDIT_PROMPT,
      message,
      config,
      AbortSignal.timeout(110_000)
    );
    calls.push(await toModelCallUsage("validate", response, config));
    stage = "model_response_validation";
    if (response.finishReason && response.finishReason !== "stop")
      throw new Error("audit_truncated");
    if (response.content.length > 100_000)
      throw new Error("audit_response_limit");
    const audit = validateAudit(
      JSON.parse(
        response.content.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "")
      ),
      tags,
      after.pageCount
    );
    stage = "save_report";
    await writeFile(
      summaryPath,
      JSON.stringify(
        {
          status: "complete",
          experimental: true,
          certification: false,
          sourceSha256: createHash("sha256").update(source).digest("hex"),
          outputSha256: createHash("sha256").update(output).digest("hex"),
          independentChecksFile: path.basename(inspectionPath),
          machineFindingsRetained: true,
          ...audit,
          calls,
          elapsedMs: Date.now() - started,
        },
        null,
        2
      )
    );
    console.log(
      JSON.stringify({
        status: "audit_complete",
        pages: after.pageCount,
        findings: audit.findings.length,
        calls: calls.length,
      })
    );
  } catch {
    await writeFile(
      summaryPath,
      JSON.stringify(
        {
          status: "incomplete",
          experimental: true,
          certification: false,
          stage,
          independentChecksFile: path.basename(inspectionPath),
          findings: [
            {
              code: "audit_incomplete",
              message:
                "The local semantic audit did not finish; no overall accessibility result is available.",
            },
          ],
          calls,
          elapsedMs: Date.now() - started,
        },
        null,
        2
      )
    );
    process.exitCode = 1;
    console.log(
      JSON.stringify({ status: "audit_incomplete", calls: calls.length })
    );
  }
}
main().catch(() => {
  console.error(
    "Local PDF audit could not start. Check the four file/directory arguments and toolchain configuration."
  );
  process.exitCode = 1;
});
