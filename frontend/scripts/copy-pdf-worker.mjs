// Copies the pdf.js worker into /public so the viewer never fetches it from a
// CDN. Keeping it local is what makes the editor work fully offline.
import { copyFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
const publicDir = join(here, "..", "public");

mkdirSync(publicDir, { recursive: true });

const candidates = [
  "pdfjs-dist/build/pdf.worker.min.mjs",
  "pdfjs-dist/build/pdf.worker.mjs",
];

let copied = false;
for (const candidate of candidates) {
  try {
    const source = require.resolve(candidate);
    if (!existsSync(source)) continue;
    copyFileSync(source, join(publicDir, "pdf.worker.min.mjs"));
    console.log(`pdf.js worker copied from ${candidate}`);
    copied = true;
    break;
  } catch {
    /* try the next candidate */
  }
}

if (!copied) {
  console.error("Could not locate the pdf.js worker. Run `npm install` first.");
  process.exit(1);
}
