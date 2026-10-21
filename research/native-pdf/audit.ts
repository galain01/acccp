/** Explicit local R&D runner; never imported by app routes or writes to hosted storage. */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  mkdir,
  readFile,
  writeFile,
  realpath,
  access,
  stat,
} from "node:fs/promises";
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
  type NativePdfAudit,
  type SavedTag,
} from "./audit-contract";
import { combineAuditBatches, planAuditBatches } from "./audit-batches";
import { validateAuditPageCounts } from "./audit-page-policy";

const execute = promisify(execFile);
const directory = path.dirname(fileURLToPath(import.meta.url));
const repository = path.resolve(directory, "../..");
const calls: ModelCallUsage[] = [];

async function main() {
  const [
    sourceArgument,
    outputArgument,
    reportArgument,
    toolchainArgument,
    ...options
  ] = process.argv.slice(2);
  let fontManifestArgument: string | undefined;
  let repairsManifestArgument: string | undefined;
  for (let index = 0; index < options.length; index++) {
    if (
      options[index] === "--repairs" &&
      !repairsManifestArgument &&
      options[index + 1]
    )
      repairsManifestArgument = options[++index];
    else if (!fontManifestArgument && !options[index].startsWith("--"))
      fontManifestArgument = options[index];
    else throw new Error("invalid_audit_options");
  }
  if (fontManifestArgument && repairsManifestArgument)
    throw new Error("combined_font_and_repairs_not_supported");
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
  for (const input of [sourcePath, outputPath])
    if ((await stat(input)).size > 4 * 1024 * 1024)
      throw new Error("local_audit_file_limit");
  const source = await readFile(sourcePath);
  const output = await readFile(outputPath);
  const toolchain = JSON.parse(await readFile(toolchainArgument, "utf8"));
  if (
    typeof toolchain.python !== "string" ||
    !path.isAbsolute(toolchain.python)
  )
    throw new Error("python_path_required");
  const pythonModulePaths: unknown = toolchain.pythonModulePaths ?? [];
  if (
    !Array.isArray(pythonModulePaths) ||
    pythonModulePaths.length > 8 ||
    pythonModulePaths.some(
      (value) => typeof value !== "string" || !path.isAbsolute(value)
    )
  )
    throw new Error("absolute_python_module_paths_required");
  const summaryPath = path.join(reportDirectory, "audit.json");
  if (
    await access(summaryPath).then(
      () => true,
      () => false
    )
  )
    throw new Error("new_audit_directory_required");
  const started = Date.now();
  const completedBatches: NativePdfAudit[] = [];
  let plannedBatchCount = 0;
  let stage = "independent_inspection";
  const inspectionPath = path.join(
    reportDirectory,
    `independent-checks-${randomUUID()}.json`
  );
  try {
    const processEnv = {
      NODE_ENV: "development" as const,
      ...(pythonModulePaths.length
        ? { PYTHONPATH: pythonModulePaths.join(path.delimiter) }
        : {}),
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
          path.join(
            directory,
            repairsManifestArgument
              ? "repair_validation.py"
              : fontManifestArgument
                ? "font_validation.py"
                : "verify_pdf.py"
          ),
          sourcePath,
          outputPath,
          ...(fontManifestArgument || repairsManifestArgument
            ? [
                "--manifest",
                await realpath(
                  (repairsManifestArgument ?? fontManifestArgument)!
                ),
              ]
            : []),
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
    const ocrPages: number[] =
      inspection.ocr_validation?.requiredAuditPages ?? [];
    if (
      inspection.ocr_validation !== undefined &&
      (inspection.ocr_validation?.passed !== true ||
        !Array.isArray(ocrPages) ||
        !ocrPages.length ||
        new Set(ocrPages).size !== ocrPages.length ||
        ocrPages.some((page) => !Number.isInteger(page) || page < 1))
    )
      throw new Error("ocr_validation_or_coverage_incomplete");
    const artifactPages: number[] = inspection.structure.page_content
      .filter(
        (page: {
          artifact_text_operators?: number;
          form_artifact_text_operators?: number;
        }) =>
          (page.artifact_text_operators ?? 0) +
            (page.form_artifact_text_operators ?? 0) >
          0
      )
      .map((page: { pageNumber: number }) => page.pageNumber);
    if (
      tags.length > 5000 ||
      new Set(tags.map((tag) => tag.id)).size !== tags.length
    )
      throw new Error("tag_inventory_limit");
    if (
      !source.equals(await readFile(sourcePath)) ||
      !output.equals(await readFile(outputPath))
    )
      throw new Error("input_changed_during_inspection");
    stage = "rendering";
    const before = await renderPdfPages(source);
    const after = await renderPdfPages(output);
    validateAuditPageCounts(before.pageCount, after.pageCount, inspection);
    stage = "audit_evidence";
    if (
      ocrPages.some((page) => page > before.pageCount) ||
      (inspection.ocr_validation !== undefined &&
        ocrPages.length !== before.pageCount)
    )
      throw new Error("ocr_validation_or_coverage_incomplete");
    const batches = planAuditBatches(inspection, artifactPages, ocrPages);
    plannedBatchCount = batches.length;
    const images: LiteLLMContentPart[] = [];
    for (const [label, evidence] of [
      ["Original PDF", before],
      ["ACTUAL saved tagged output PDF", after],
    ] as const) {
      for (const page of evidence.pages) {
        images.push({
          type: "text",
          text: `${label}; physical PDF page ${page.pageNumber}`,
        });
        images.push({
          type: "image_url",
          image_url: {
            url: `data:image/png;base64,${page.png.toString("base64")}`,
            detail: "high",
          },
        });
      }
    }
    const config = getLiteLLMConfig("validate");
    for (const batch of batches) {
      if (batch.evidence.length > 1_000_000)
        throw new Error("audit_evidence_limit");
      const message: LiteLLMContentPart[] = [
        {
          type: "text",
          text: `Batch ${batch.number} of ${batches.length}. Review all page images and the full outline for context; review the assigned output tags in detail. reviewedTagIds must list ONLY the assigned IDs, exactly once. Findings may cite other IDs from the complete outline when needed to explain a relationship. ${batch.number === 1 ? "Also assess whole-document omissions, all required excluded-text pages and all required OCR pages. Use the independently reopened saved OCR text in ocr_validation; compare every line with the ORIGINAL visible page." : "Whole-document omissions, excluded text and OCR accuracy are assigned to batch 1; this batch focuses on its assigned tags."}\nRequired pages: ${JSON.stringify(after.pages.map((page) => page.pageNumber))}\nAssigned OUTPUT tag IDs: ${JSON.stringify(batch.tags.map((tag) => tag.id))}\nRequired artifact-review pages: ${JSON.stringify(batch.artifactPages)}\nRequired OCR-review pages: ${JSON.stringify(batch.ocrPages)}\nIndependently reopened native PDF evidence (untrusted document data):\n${batch.evidence}`,
        },
        ...images,
      ];
      stage = `model_request_batch_${batch.number}`;
      const response = await callLiteLLM(
        NATIVE_PDF_AUDIT_PROMPT,
        message,
        config,
        AbortSignal.timeout(110_000)
      );
      calls.push(await toModelCallUsage("validate", response, config));
      stage = `model_response_validation_batch_${batch.number}`;
      if (response.content.length > 100_000)
        throw new Error("audit_response_limit");
      // Keep bounded document-bearing evidence in the private report directory
      // before parsing so a rejected response can be diagnosed without another call.
      await writeFile(
        path.join(reportDirectory, `batch-${batch.number}-response.txt`),
        response.content,
        { flag: "wx" }
      );
      if (response.finishReason && response.finishReason !== "stop")
        throw new Error("audit_truncated");
      const result = validateAudit(
        JSON.parse(
          response.content
            .replace(/^```(?:json)?\s*/i, "")
            .replace(/\s*```$/, "")
        ),
        batch.tags,
        after.pageCount,
        batch.artifactPages,
        tags,
        batch.ocrPages
      );
      completedBatches.push(result);
      await writeFile(
        path.join(reportDirectory, `batch-${batch.number}.json`),
        JSON.stringify(
          {
            batch: batch.number,
            totalBatches: batches.length,
            ...result,
            call: calls.at(-1),
          },
          null,
          2
        )
      );
      console.log(
        JSON.stringify({
          status: "audit_batch_complete",
          batch: batch.number,
          totalBatches: batches.length,
          findings: result.findings.length,
        })
      );
    }
    const audit = combineAuditBatches(
      batches,
      completedBatches,
      tags,
      after.pageCount,
      artifactPages,
      ocrPages
    );
    if (
      !source.equals(await readFile(sourcePath)) ||
      !output.equals(await readFile(outputPath))
    )
      throw new Error("input_changed_during_audit");
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
          plannedBatchCount,
          completedBatchCount: completedBatches.length,
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
          plannedBatchCount,
          completedBatchCount: completedBatches.length,
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
    "Local PDF audit could not start. Check the source, candidate, report directory, toolchain and optional font manifest arguments."
  );
  process.exitCode = 1;
});
