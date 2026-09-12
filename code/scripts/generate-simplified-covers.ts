/**
 * Generate simplified print covers (black Geologica ExtraBold title on transparent).
 *
 * Design frame (1×): 1027 × 1452
 * Output: 2× (2054 × 2904)
 *
 * Typography: Geologica ExtraBold 72, line-height 100%
 * Horizontal: centered, min 100px inset from left/right
 * Vertical: single-line block sits 625 from top / 755 from bottom;
 *   multi-line blocks keep the same vertical center.
 *
 * Usage: bun run generate-simplified-covers.ts
 */

import { createCanvas, GlobalFonts } from "@napi-rs/canvas";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, "../..");

/** Design units (1×). Output is SCALE times larger. */
const DESIGN = {
  width: 1027,
  height: 1452,
  fontSize: 72,
  lineHeight: 1, // 100%
  minEdgeInset: 100,
  textTop: 625,
  textBottom: 755,
} as const;

const SCALE = 2;

const FONT_PATH = join(repoRoot, "code/fonts/Geologica-ExtraBold.ttf");
const FONT_FAMILY = "Geologica ExtraBold";

type BookCover = {
  title: string;
  /** Relative to repo root */
  outPath: string;
};

const BOOKS: BookCover[] = [
  {
    title: "Мапа і Територія",
    outPath: "books/1. Мапа і Територія/cover-print.png",
  },
  {
    title: "Як по-справжньому змінювати думку",
    outPath: "books/2. Як по-справжньому змінювати думку/cover-print.png",
  },
  {
    title: "Машина у духові",
    outPath: "books/private/3. Машина у духові/cover-print.png",
  },
];

/** Vertical center of the single-line title slot. */
const TEXT_CENTER_Y =
  DESIGN.textTop + (DESIGN.height - DESIGN.textTop - DESIGN.textBottom) / 2;

function wrapLines(
  measure: (text: string) => number,
  title: string,
  maxWidth: number,
): string[] {
  const words = title.split(/\s+/).filter(Boolean);
  if (words.length === 0) return [];

  const lines: string[] = [];
  let current = words[0]!;

  for (let i = 1; i < words.length; i++) {
    const word = words[i]!;
    const candidate = `${current} ${word}`;
    if (measure(candidate) <= maxWidth) {
      current = candidate;
    } else {
      lines.push(current);
      current = word;
    }
  }
  lines.push(current);
  return lines;
}

function renderCover(title: string): Buffer {
  const w = DESIGN.width * SCALE;
  const h = DESIGN.height * SCALE;
  const canvas = createCanvas(w, h);
  const ctx = canvas.getContext("2d");

  // Transparent background (print cover plate); black title.
  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = "#000000";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.font = `${DESIGN.fontSize * SCALE}px "${FONT_FAMILY}"`;

  const maxWidth = (DESIGN.width - DESIGN.minEdgeInset * 2) * SCALE;
  const measure = (text: string) => ctx.measureText(text).width;
  const lines = wrapLines(measure, title, maxWidth);

  const lineBox = DESIGN.fontSize * DESIGN.lineHeight * SCALE;
  const blockHeight = lines.length * lineBox;
  const blockCenterY = TEXT_CENTER_Y * SCALE;
  const firstLineCenterY = blockCenterY - blockHeight / 2 + lineBox / 2;
  const centerX = w / 2;

  for (let i = 0; i < lines.length; i++) {
    const y = firstLineCenterY + i * lineBox;
    ctx.fillText(lines[i]!, centerX, y, maxWidth);
  }

  return canvas.toBuffer("image/png");
}

async function main() {
  if (!GlobalFonts.has(FONT_FAMILY)) {
    const ok = GlobalFonts.registerFromPath(FONT_PATH, FONT_FAMILY);
    if (!ok) {
      throw new Error(`Failed to register font at ${FONT_PATH}`);
    }
  }

  console.log(
    `Design ${DESIGN.width}×${DESIGN.height} → output ${DESIGN.width * SCALE}×${DESIGN.height * SCALE}`,
  );
  console.log(
    `Text center Y (1×): ${TEXT_CENTER_Y} (top ${DESIGN.textTop}, bottom gap ${DESIGN.textBottom})`,
  );

  for (const book of BOOKS) {
    const abs = join(repoRoot, book.outPath);
    await mkdir(dirname(abs), { recursive: true });
    const png = renderCover(book.title);
    await writeFile(abs, png);
    console.log(`Wrote ${book.outPath} — “${book.title}”`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
