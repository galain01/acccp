// Local-only recognition. PDF writing and text approval happen separately.
const fs = require('node:fs');
const path = require('node:path');

async function main() {
  const [moduleRoot, input, output] = process.argv.slice(2);
  if (![moduleRoot, input, output].every(x => x && path.isAbsolute(x)) || fs.existsSync(output)) throw Error('paths');
  const { createWorker } = require(path.join(moduleRoot, 'tesseract.js'));
  const worker = await createWorker('eng', 1, {
    workerPath: path.join(moduleRoot, 'tesseract.js/src/worker-script/node/index.js'),
    corePath: path.join(moduleRoot, 'tesseract.js-core'),
    langPath: path.join(moduleRoot, '@tesseract.js-data/eng/4.0.0_best_int'),
    cacheMethod: 'none', gzip: true, logger: () => {},
  });
  try {
    await worker.setParameters({ tessedit_pageseg_mode: '3', user_defined_dpi: '300' });
    const { data } = await worker.recognize(input, {}, { text: true, blocks: true });
    const lines = [];
    for (const block of data.blocks || []) for (const para of block.paragraphs || []) for (const line of para.lines || []) {
      if (line.text.trim()) lines.push({ text: line.text.trim(), confidence: line.confidence,
        bbox: [line.bbox.x0, line.bbox.y0, line.bbox.x1, line.bbox.y1] });
    }
    if (!lines.length || lines.length > 500) throw Error('line_limit');
    fs.writeFileSync(output, JSON.stringify({ lines, confidence: data.confidence }), { flag: 'wx' });
  } finally { await worker.terminate(); }
}
main().catch(() => { process.stderr.write('Local OCR could not complete.\n'); process.exitCode = 1; });
