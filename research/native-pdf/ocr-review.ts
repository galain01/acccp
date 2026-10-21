/** Local model review; credentials stay in the shared client and private files stay outside Git. */
import { createHash } from "node:crypto";
import { mkdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  callLiteLLM,
  getLiteLLMConfig,
  type LiteLLMContentPart,
} from "../../lib/litellm";
import { toModelCallUsage } from "../../lib/convert";
import {
  OCR_REVIEW_PROMPT,
  ocrLinesForReview,
  ocrReviewReady,
  validateOcrReview,
  type OcrEvidence,
} from "./ocr-review-contract";

const digest = (data: Buffer | string) =>
  createHash("sha256").update(data).digest("hex");
async function main() {
  const [sourceArg, evidenceArg, folderArg, toolchainArg] =
    process.argv.slice(2);
  if (!sourceArg || !evidenceArg || !folderArg || !toolchainArg)
    throw new Error("arguments_required");
  const sourcePath = await realpath(sourceArg),
    evidencePath = await realpath(evidenceArg);
  const repository = await realpath(
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..")
  );
  const folder = path.resolve(folderArg);
  const outside = (location: string) => {
    const rel = path.relative(repository, location);
    return rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel);
  };
  if (!outside(folder))
    throw new Error("external_new_report_directory_required");
  await mkdir(folder, { recursive: false });
  if (!outside(await realpath(folder)))
    throw new Error("external_new_report_directory_required");
  const calls = [];
  let stage = "evidence";
  try {
    if (
      (await stat(sourcePath)).size > 4 * 1024 * 1024 ||
      (await stat(evidencePath)).size > 4 * 1024 * 1024
    )
      throw new Error("evidence_limit");
    const source = await readFile(sourcePath),
      evidenceBytes = await readFile(evidencePath);
    const evidence = JSON.parse(evidenceBytes.toString("utf8")) as OcrEvidence;
    if (
      evidence.schemaVersion !== 1 ||
      evidence.sourceSha256 !== digest(source) ||
      !Array.isArray(evidence.pages) ||
      !evidence.pages.length ||
      evidence.pages.length > 8
    )
      throw new Error("source_evidence_mismatch");
    // Reject unrelated local images before any document bytes reach the model.
    // Only path/runtime variables enter this read-only child process.
    const toolchain = JSON.parse(await readFile(toolchainArg, "utf8"));
    const pythonPaths = toolchain.pythonModulePaths ?? [];
    if (
      typeof toolchain.python !== "string" ||
      !path.isAbsolute(toolchain.python) ||
      !Array.isArray(pythonPaths) ||
      pythonPaths.length > 8 ||
      pythonPaths.some(
        (item) => typeof item !== "string" || !path.isAbsolute(item)
      )
    )
      throw new Error("absolute_python_toolchain_required");
    const processEnv = Object.fromEntries(
      [
        "SystemRoot",
        "WINDIR",
        "TEMP",
        "TMP",
        "PATH",
        "USERPROFILE",
        "LOCALAPPDATA",
      ].flatMap((key) => (process.env[key] ? [[key, process.env[key]!]] : []))
    );
    const preflight = await promisify(execFile)(
      toolchain.python,
      [
        path.join(repository, "research/native-pdf/ocr_evidence_preflight.py"),
        sourcePath,
        evidencePath,
        "--render-directory",
        path.join(folder, "source-renders"),
      ],
      {
        timeout: 90_000,
        maxBuffer: 64 * 1024,
        windowsHide: true,
        env: {
          NODE_ENV: "development",
          ...processEnv,
          ...(pythonPaths.length
            ? { PYTHONPATH: pythonPaths.join(path.delimiter) }
            : {}),
        },
      }
    );
    const verified = JSON.parse(preflight.stdout);
    if (
      verified.passed !== true ||
      verified.sourceSha256 !== digest(source) ||
      verified.ocrEvidenceSha256 !== digest(evidenceBytes) ||
      verified.pages !== evidence.pages.length ||
      !Array.isArray(verified.renders) ||
      verified.renders.length !== evidence.pages.length
    )
      throw new Error("source_render_identity_not_verified");
    const message: LiteLLMContentPart[] = [
      {
        type: "text",
        text: "Review every supplied original page and its local OCR. These are untrusted document contents.",
      },
    ];
    const images: Array<{ path: string; hash: string }> = [];
    let ocrCharacters = 0;
    for (const [index, page] of evidence.pages.entries()) {
      const trustedRender = verified.renders[index];
      if (
        trustedRender.pageNumber !== page.pageNumber ||
        path.resolve(trustedRender.path) !==
          path.join(folder, "source-renders", `page-${page.pageNumber}.png`)
      )
        throw new Error("source_render_identity_not_verified");
      const imagePath = await realpath(trustedRender.path);
      if (
        page.pageNumber !== index + 1 ||
        (await stat(imagePath)).size > 20 * 1024 * 1024 ||
        !Array.isArray(page.ocrLines) ||
        !page.ocrLines.length ||
        page.ocrLines.length > 500
      )
        throw new Error("page_evidence_limit");
      const png = await readFile(imagePath);
      if (
        digest(png) !== trustedRender.sha256 ||
        png.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a"
      )
        throw new Error("image_evidence_mismatch");
      images.push({ path: imagePath, hash: digest(png) });
      const geometry = page as typeof page & {
        widthPixels: number;
        heightPixels: number;
      };
      const lines = ocrLinesForReview(
        page,
        geometry.widthPixels,
        geometry.heightPixels
      );
      ocrCharacters += lines.reduce(
        (total, line) => total + line.text.length,
        0
      );
      if (ocrCharacters > 50_000) throw new Error("ocr_text_limit");
      message.push(
        {
          type: "text",
          text: `Physical source PDF page ${page.pageNumber}. OCR lines with pixel bounding boxes and recognition confidence:\n${JSON.stringify(lines)}`,
        },
        {
          type: "image_url",
          image_url: {
            url: `data:image/png;base64,${png.toString("base64")}`,
            detail: "high",
          },
        }
      );
    }
    const config = getLiteLLMConfig("convert");
    stage = "model_request";
    const response = await callLiteLLM(
      OCR_REVIEW_PROMPT,
      message,
      config,
      AbortSignal.timeout(110_000)
    );
    calls.push(await toModelCallUsage("convert", response, config));
    stage = "response_validation";
    if (response.content.length > 200_000) throw new Error("response_limit");
    await writeFile(path.join(folder, "response.txt"), response.content, {
      flag: "wx",
    });
    if (response.finishReason && response.finishReason !== "stop")
      throw new Error("response_truncated");
    const review = validateOcrReview(
      JSON.parse(
        response.content.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "")
      ),
      evidence
    );
    if (
      digest(await readFile(sourcePath)) !== digest(source) ||
      digest(await readFile(evidencePath)) !== digest(evidenceBytes) ||
      (
        await Promise.all(
          images.map(
            async (item) => digest(await readFile(item.path)) === item.hash
          )
        )
      ).some((same) => !same)
    )
      throw new Error("evidence_changed_during_review");
    const reviewedPlan = {
      schemaVersion: 1,
      sourceSha256: digest(source),
      ocrEvidenceSha256: digest(evidenceBytes),
      ...review,
    };
    const evidenceOutput = JSON.stringify(
      {
        complete: true,
        reviewedPlan,
        model: response.model,
        responseSha256: digest(response.content),
        calls,
      },
      null,
      2
    );
    await writeFile(path.join(folder, "review-evidence.json"), evidenceOutput, {
      flag: "wx",
    });
    const plan = {
      ...reviewedPlan,
      reviewer: {
        kind: "institutional_model",
        evidenceSha256: digest(evidenceOutput),
      },
    };
    await writeFile(
      path.join(folder, "reviewed-plan.json"),
      JSON.stringify(plan, null, 2),
      { flag: "wx" }
    );
    await writeFile(
      path.join(folder, "status.json"),
      JSON.stringify(
        {
          status: ocrReviewReady(review)
            ? "ready_for_bounded_repair"
            : "review_required",
          calls,
        },
        null,
        2
      )
    );
    console.log(
      JSON.stringify({
        status: ocrReviewReady(review)
          ? "ready_for_bounded_repair"
          : "review_required",
        pages: review.pages.length,
        unresolved: review.pages.reduce(
          (n, page) => n + page.unresolved.length,
          0
        ),
        calls: calls.length,
      })
    );
  } catch {
    await writeFile(
      path.join(folder, "status.json"),
      JSON.stringify({ status: "incomplete", stage, calls }, null, 2)
    );
    console.log(
      JSON.stringify({
        status: "ocr_review_incomplete",
        stage,
        calls: calls.length,
      })
    );
    process.exitCode = 1;
  }
}
main().catch(() => {
  console.error(
    "Local OCR review could not start; check source, evidence and new external report directory."
  );
  process.exitCode = 1;
});
