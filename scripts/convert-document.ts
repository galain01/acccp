import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { convertPdf } from "../lib/convert";
import { isDocxFilename, validateDocumentInput } from "../lib/document-input";
import { renderWordToPdf, WordToPdfError } from "../lib/word-to-pdf";
import {
  WORD_RENDERING_REVIEW_MESSAGE,
  withWordRenderingReview,
} from "../lib/word-rendering-review";

async function main() {
  const [input, outputDirectory, mode] = process.argv.slice(2);
  if (!input || !outputDirectory || (mode && mode !== "--render-only")) {
    console.error(
      "Usage: npm run convert:document -- <file.docx|file.pdf> <output-directory> [--render-only]"
    );
    process.exitCode = 1;
    return;
  }
  const source = await readFile(input);
  const filename = path.basename(input);
  const inputError = validateDocumentInput(source, filename);
  if (inputError) {
    console.error(inputError);
    process.exitCode = 1;
    return;
  }
  const output = path.resolve(outputDirectory);
  const startedAt = Date.now();
  const isWord = isDocxFilename(filename);
  const pdf = isWord ? await renderWordToPdf(source, filename) : source;
  const renderMs = Date.now() - startedAt;
  await mkdir(output, { recursive: true });
  await writeFile(path.join(output, "rendered.pdf"), pdf);
  if (mode === "--render-only") {
    console.log(
      JSON.stringify({
        status: "rendered",
        pdfBytes: pdf.length,
        renderMs,
        output,
        extractionWarnings: isWord ? [WORD_RENDERING_REVIEW_MESSAGE] : [],
      })
    );
    return;
  }
  let result = await convertPdf(pdf, "document.pdf");
  if ("error" in result) {
    console.error(
      JSON.stringify({ error: result.error, stage: "pdf-to-html" })
    );
    process.exitCode = 1;
    return;
  }
  if (isWord) result = withWordRenderingReview(result);
  await writeFile(path.join(output, "converted.html"), result.html);
  await writeFile(
    path.join(output, "result.json"),
    JSON.stringify(
      {
        model: result.model,
        tokensUsed: result.tokensUsed,
        calls: result.calls,
        findings: result.errors,
        extractionWarnings: result.extractionWarnings,
        sourceBytes: source.length,
        pdfBytes: pdf.length,
        renderMs,
        elapsedMs: Date.now() - startedAt,
      },
      null,
      2
    )
  );
  console.log(
    JSON.stringify({
      status: "converted",
      findings: result.errors.length,
      model: result.model,
      output,
    })
  );
}

main().catch((error: unknown) => {
  console.error(
    error instanceof WordToPdfError
      ? error.message
      : "Could not complete the local document conversion."
  );
  process.exitCode = 1;
});
