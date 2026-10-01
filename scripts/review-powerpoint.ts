import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { replayPptxRevisions } from "../lib/pptx-revisions";
import { recheckPowerPointRevision } from "../lib/powerpoint-convert";
import type { PptxRevisionBundle } from "../lib/pptx-types";

/** Local equivalent of restoring revisions and exporting the selected version. */
async function main() {
  const [input, reportPath, directory, ...options] = process.argv.slice(2);
  if (!input || !reportPath || !directory)
    throw new Error(
      "Usage: scripts/review-powerpoint.ts source.pptx conversion-result.json output-directory [--exclude change-id ...]"
    );
  const restoredIds: string[] = [];
  for (let index = 0; index < options.length; index += 2) {
    if (options[index] !== "--exclude" || !options[index + 1])
      throw new Error("Use --exclude followed by a revision ID.");
    restoredIds.push(options[index + 1]);
  }
  const report = JSON.parse(await readFile(reportPath, "utf8"));
  const revisions = report.revisions as PptxRevisionBundle;
  if (
    !revisions ||
    revisions.version !== 1 ||
    !Array.isArray(revisions.changes)
  )
    throw new Error("The conversion report has no supported revision bundle.");
  if (
    restoredIds.some(
      (id) => !revisions.changes.some((change) => change.id === id)
    )
  )
    throw new Error("An unknown revision ID was requested.");
  const selectedIds = revisions.changes
    .filter((change) => !restoredIds.includes(change.id))
    .map((change) => change.id);
  const original = await readFile(input);
  const replayed = await replayPptxRevisions(original, revisions, selectedIds);
  const result = await recheckPowerPointRevision(
    original,
    replayed.buffer,
    replayed.changes
  );
  const output = path.resolve(directory);
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
  const { pptx, ...checked } = result;
  await writeFile(path.join(output, "selected.pptx"), pptx);
  await writeFile(
    path.join(output, "result.json"),
    JSON.stringify({ ...checked, revisions, selectedIds, restoredIds }, null, 2)
  );
  console.log(
    JSON.stringify({
      status: "checked-selected-version",
      included: selectedIds.length,
      restored: restoredIds.length,
      findings: result.errors.length,
      output,
    })
  );
}

main().catch(() => {
  console.error(
    "The selected PowerPoint could not be exported. Check the original file, report path and revision IDs."
  );
  process.exitCode = 1;
});
