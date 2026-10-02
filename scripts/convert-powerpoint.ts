import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { convertPowerPoint } from "../lib/powerpoint-convert";

async function main() {
  const [input, directory] = process.argv.slice(2);
  if (!input || !directory)
    throw new Error(
      "Usage: node --conditions=react-server --env-file=.env.local --env-file=.env.word-to-pdf --import tsx scripts/convert-powerpoint.ts input.pptx output-directory"
    );
  const output = path.resolve(directory);
  const started = Date.now();
  const result = await convertPowerPoint(
    await readFile(input),
    path.basename(input)
  );
  await mkdir(output, { recursive: true });
  if ("error" in result) {
    await writeFile(
      path.join(output, "result.json"),
      JSON.stringify(result, null, 2)
    );
    console.error(result.error);
    process.exitCode = 1;
    return;
  }
  const { pptx, ...report } = result;
  await writeFile(path.join(output, "repaired.pptx"), pptx);
  await writeFile(
    path.join(output, "result.json"),
    JSON.stringify({ ...report, elapsedMs: Date.now() - started }, null, 2)
  );
  console.log(
    JSON.stringify({
      status: "repaired",
      slides: result.pageCount,
      changes: result.changes.length,
      findings: result.errors.length,
      output,
    })
  );
}
main().catch(() => {
  console.error(
    "The local PowerPoint conversion could not finish. Check the input and output paths."
  );
  process.exitCode = 1;
});
