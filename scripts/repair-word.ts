import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { repairWord } from "../lib/word-convert";

async function main() {
  const [input, directory] = process.argv.slice(2);
  if (!input || !directory)
    throw new Error(
      "Usage: node --conditions=react-server --env-file=.env.local --env-file=.env.word-to-pdf --import tsx scripts/repair-word.ts input.docx output-directory"
    );
  const output = path.resolve(directory);
  const started = Date.now();
  const result = await repairWord(await readFile(input), path.basename(input));
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
  const { docx, ...report } = result;
  await writeFile(path.join(output, "repaired.docx"), docx);
  await writeFile(
    path.join(output, "result.json"),
    JSON.stringify({ ...report, elapsedMs: Date.now() - started }, null, 2)
  );
  console.log(
    JSON.stringify({
      status: "repaired",
      pages: result.pageCount,
      changes: result.changes.length,
      findings: result.errors.length,
      output,
    })
  );
}
main().catch(() => {
  console.error(
    "The local Word repair could not finish. Check the input and output paths."
  );
  process.exitCode = 1;
});
