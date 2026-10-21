import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { repairNativePdf } from "../lib/native-pdf-convert";
import { pdfSha256 } from "../lib/native-pdf-worker";

async function main() {
  const [input, directory] = process.argv.slice(2);
  if (!input || !directory)
    throw new Error("input_and_new_output_directory_required");
  const output = path.resolve(directory);
  // Refuse to replace another run's evidence or an existing document directory.
  await mkdir(output, { recursive: false });
  const source = await readFile(input);
  const started = Date.now();
  const result = await repairNativePdf(source, path.basename(input));
  if ("error" in result) {
    await writeFile(
      path.join(output, "result.json"),
      JSON.stringify(result, null, 2),
      { flag: "wx" }
    );
    console.error(result.error);
    process.exitCode = 1;
    return;
  }
  const { pdf, ...report } = result;
  await writeFile(path.join(output, "repaired.pdf"), pdf, { flag: "wx" });
  await writeFile(
    path.join(output, "result.json"),
    JSON.stringify(
      {
        ...report,
        sourceSha256: pdfSha256(source),
        outputSha256: pdfSha256(pdf),
        elapsedMs: Date.now() - started,
      },
      null,
      2
    ),
    { flag: "wx" }
  );
  console.log(
    JSON.stringify({
      status: "repaired",
      pages: result.pageCount,
      changes: result.changes.length,
      findings: result.errors.length,
      auditComplete: result.nativePdfChecks.auditComplete,
      output,
    })
  );
}
main().catch(() => {
  console.error(
    "Local PDF repair could not finish. Check the input, a new output directory, and the private worker configuration."
  );
  process.exitCode = 1;
});
