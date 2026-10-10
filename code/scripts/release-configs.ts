#!/usr/bin/env node
/**
 * Prepare the three Storinkator configs of one book for release.
 * Runs with node >= 22 or bun, no dependencies.
 *
 * Each book ships three configs side by side:
 *   digital.storinkator.json    digital PDF
 *   print.storinkator.json      color print PDF (145x205mm Color)
 *   print-bw.storinkator.json   black-and-white print PDF (145x205mm BW)
 *
 * What `prepare` does:
 *   1. Creates print-bw.storinkator.json when missing — from a --bw-base file
 *      (a `git show origin/print-bw:...` blob) or derived from the color
 *      print config with --derive-bw (h1 colors off, black accents).
 *   2. Forward-ports keys the BW config is missing (e.g. text_tables and
 *      anything added to Storinkator later) from the current color print
 *      config. Existing BW values are never overwritten.
 *   3. Sets TRANSLATION_VERSION / TRANSLATION_DATE in all three configs.
 *   4. Optionally sets page_margin_gutter (spine/inner) / page_margin_outer
 *      when --gutter/--outer are given. A release never touches margins
 *      on its own.
 *
 * Usage:
 *   node release-configs.ts show --book-dir <dir>
 *   node release-configs.ts prepare --book-dir <dir> --version X.X \
 *     --date "..." [--gutter 20 --outer 18.5] [--bw-base <file> | --derive-bw]
 *   node release-configs.ts links --repo-root <root> --book <id>
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { discoverBooks, SERIES } from "./books.ts";

const DIGITAL = "digital.storinkator.json";
const PRINT = "print.storinkator.json";
const PRINT_BW = "print-bw.storinkator.json";

// Generic B&W derivation when no print-bw branch blob exists.
const BW_DERIVE_OVERRIDES: Record<string, unknown> = {
  h1_page_colors: false,
  accent_color: "hsl(0deg 0% 0%)",
};

const BW_TOP_LEVEL_KEYS = ["storinkatorPageCss", "schemaVersion", "exportedAt", "bookScopeHint"];

type JsonObj = Record<string, unknown>;

function loadConfig(path: string): JsonObj {
  return JSON.parse(readFileSync(path, "utf8")) as JsonObj;
}

function saveConfig(path: string, config: JsonObj): void {
  writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`, "utf8");
}

function isObj(v: unknown): v is JsonObj {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Copy keys missing in target from source, recursively. Returns added paths. */
function deepMergeMissing(target: JsonObj, source: JsonObj, prefix = ""): string[] {
  const added: string[] = [];
  for (const [key, value] of Object.entries(source)) {
    const where = prefix ? `${prefix}.${key}` : key;
    if (!(key in target)) {
      target[key] = JSON.parse(JSON.stringify(value)) as unknown;
      added.push(where);
    } else if (isObj(target[key]) && isObj(value)) {
      added.push(...deepMergeMissing(target[key], value, where));
    }
  }
  return added;
}

function show(bookDir: string): number {
  console.log(`book: ${bookDir}`);
  for (const name of [DIGITAL, PRINT, PRINT_BW]) {
    const path = join(bookDir, name);
    if (!existsSync(path)) {
      console.log(`  ${name}: MISSING`);
      continue;
    }
    const values = (loadConfig(path).values ?? {}) as JsonObj;
    const cv = (values.content_variables ?? {}) as JsonObj;
    console.log(
      `  ${name}: version=${String(cv.TRANSLATION_VERSION)} ` +
        `date=${String(cv.TRANSLATION_DATE)} ` +
        `gutter=${String(values.page_margin_gutter)} outer=${String(values.page_margin_outer)}`,
    );
  }
  return 0;
}

type PrepareOptions = {
  bookDir: string;
  version: string;
  date: string;
  gutter: number | null;
  outer: number | null;
  bwBase: string | null;
  deriveBw: boolean;
};

function prepare(o: PrepareOptions): number {
  const digitalPath = join(o.bookDir, DIGITAL);
  const printPath = join(o.bookDir, PRINT);
  const bwPath = join(o.bookDir, PRINT_BW);

  for (const p of [digitalPath, printPath]) {
    if (!existsSync(p)) {
      console.error(`ERROR: required config missing: ${p}`);
      return 1;
    }
  }

  const digital = loadConfig(digitalPath);
  const color = loadConfig(printPath);
  let bw: JsonObj;
  let created = false;

  if (existsSync(bwPath)) {
    bw = loadConfig(bwPath);
  } else if (o.bwBase) {
    bw = loadConfig(o.bwBase);
    created = true;
  } else if (o.deriveBw) {
    bw = JSON.parse(JSON.stringify(color)) as JsonObj;
    Object.assign((bw.values ??= {}) as JsonObj, JSON.parse(JSON.stringify(BW_DERIVE_OVERRIDES)));
    created = true;
  } else {
    console.error(`ERROR: ${bwPath} missing and no --bw-base/--derive-bw given.`);
    return 1;
  }

  // Forward-port anything Storinkator learned since the BW config was made.
  const bwValues = ((bw.values ??= {}) as JsonObj);
  const colorValues = ((color.values ?? {}) as JsonObj);
  const added = deepMergeMissing(bwValues, colorValues);
  const addedTop: string[] = [];
  for (const key of BW_TOP_LEVEL_KEYS) {
    if (key in color && !(key in bw)) {
      bw[key] = JSON.parse(JSON.stringify(color[key])) as unknown;
      addedTop.push(key);
    }
  }

  for (const cfg of [digital, color, bw]) {
    const values = ((cfg.values ??= {}) as JsonObj);
    const cv = ((values.content_variables ??= {}) as JsonObj);
    cv.TRANSLATION_VERSION = o.version;
    cv.TRANSLATION_DATE = o.date;
    if (o.gutter !== null) values.page_margin_gutter = o.gutter;
    if (o.outer !== null) values.page_margin_outer = o.outer;
  }

  saveConfig(digitalPath, digital);
  saveConfig(printPath, color);
  saveConfig(bwPath, bw);

  console.log(`version/date written to all 3 configs: v${o.version}, ${o.date}`);
  if (o.gutter !== null || o.outer !== null) {
    console.log(`margins written: gutter(inner)=${o.gutter} outer=${o.outer}`);
  }
  if (created) {
    const src = o.bwBase ?? "derived from print config (h1 colors off, black accent)";
    console.log(`created ${PRINT_BW} from ${src}`);
  }
  if (added.length > 0) console.log(`forward-ported into BW config (${added.length}): ${added.join(", ")}`);
  if (addedTop.length > 0) console.log(`forward-ported top-level keys: ${addedTop.join(", ")}`);
  if (!created && added.length === 0 && addedTop.length === 0) {
    console.log(`${PRINT_BW} already up to date with print config`);
  }
  return 0;
}

function usage(): void {
  console.log(`Usage:
  node release-configs.ts show --book-dir <dir>
  node release-configs.ts prepare --book-dir <dir> --version X.X --date "..." \\
    [--gutter 20 --outer 18.5] [--bw-base <file> | --derive-bw]
  node release-configs.ts links --repo-root <root> --book <id>`);
}

function takeValue(args: string[], flag: string): string | null {
  const i = args.indexOf(flag);
  if (i < 0 || i + 1 >= args.length) return null;
  return args[i + 1]!;
}

const LINKS_BASE =
  "https://github.com/DanTheStrongworded/rationality-ua/raw/refs/heads/main/assets/pdf";

/**
 * Point the SELFPUBLISHING.md block-download cells of one book at the freshly
 * generated Color/BW print PDFs (stable names on main). The book's column is
 * found by matching the table header cell against the book folder name, so
 * future books work as soon as the table gains a column for them. Only
 * touches cells whose file exists on disk; prints what changed.
 */
export function updateLinks(repoRoot: string, bookId: string): number {
  const id = Number(bookId);
  const spec = discoverBooks(repoRoot).find((b) => b.id === id);
  if (!spec) {
    console.error(`ERROR: unknown book id: ${bookId}`);
    return 1;
  }
  const folderName = spec.dir.split("/").pop()!;
  const mdPath = join(repoRoot, "SELFPUBLISHING.md");
  if (!existsSync(mdPath)) {
    console.error(`ERROR: not found: ${mdPath}`);
    return 1;
  }
  const lines = readFileSync(mdPath, "utf8").split("\n");
  const header = lines.find((l) => l.startsWith("|") && l.includes("| Файл |"));
  if (!header) {
    console.error("ERROR: downloads table not found in SELFPUBLISHING.md");
    return 1;
  }
  const col = header.split("|").findIndex((c) => c.includes(folderName));
  if (col < 0) {
    console.log(`SELFPUBLISHING.md has no column for "${folderName}" — skipping`);
    return 0;
  }
  const targets: Array<{ match: string; folder: string; file: string }> = [
    {
      match: "Сторінки в ч/б",
      folder: "print-bw",
      file: `${SERIES}. ${spec.title} ${spec.printFormat} BW.pdf`,
    },
    {
      match: "Сторінки в кольорі",
      folder: "print-color",
      file: `${SERIES}. ${spec.title} ${spec.printFormat} Color.pdf`,
    },
  ];
  let changed = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const target = targets.find((t) => line.includes(`| ${t.match} |`));
    if (!target) continue;
    if (!existsSync(join(repoRoot, "assets/pdf", target.folder, target.file))) {
      console.log(`skip "${target.match}": ${target.folder}/${target.file} not found`);
      continue;
    }
    const cells = line.split("|");
    if (col >= cells.length) continue;
    const url = `${LINKS_BASE}/${target.folder}/${encodeURIComponent(target.file)}`;
    const next = ` [Завантажити](${url}) `;
    if (cells[col] !== next) {
      cells[col] = next;
      lines[i] = cells.join("|");
      changed++;
      console.log(`link: ${target.match} (книга ${bookId}) -> ${target.file}`);
    }
  }
  if (changed > 0) writeFileSync(mdPath, lines.join("\n"), "utf8");
  else console.log("SELFPUBLISHING.md: nothing to update");
  return 0;
}

export function run(argv: string[]): number {
  const [cmd, ...rest] = argv;
  if (cmd === "links") {
    const repoRoot = takeValue(rest, "--repo-root");
    const book = takeValue(rest, "--book");
    if (!repoRoot || !book) {
      usage();
      return 1;
    }
    return updateLinks(repoRoot, book);
  }
  if (cmd === "show") {
    const bookDir = takeValue(rest, "--book-dir");
    if (!bookDir) {
      usage();
      return 1;
    }
    return show(bookDir);
  }
  if (cmd === "prepare") {
    const bookDir = takeValue(rest, "--book-dir");
    const version = takeValue(rest, "--version");
    const date = takeValue(rest, "--date");
    const gutter = takeValue(rest, "--gutter");
    const outer = takeValue(rest, "--outer");
    if (!bookDir || !version || !date) {
      usage();
      return 1;
    }
    if (!/^\d+\.\d+$/.test(version.trim())) {
      console.error(`ERROR: version must be X.X, got '${version}'`);
      return 1;
    }
    let gutterNum: number | null = null;
    let outerNum: number | null = null;
    if (gutter !== null || outer !== null) {
      if (gutter === null || outer === null) {
        console.error("ERROR: --gutter and --outer must be given together");
        return 1;
      }
      gutterNum = Number(gutter);
      outerNum = Number(outer);
      if (!Number.isFinite(gutterNum) || !Number.isFinite(outerNum)) {
        console.error(`ERROR: gutter/outer must be numbers, got '${gutter}'/'${outer}'`);
        return 1;
      }
    }
    return prepare({
      bookDir,
      version: version.trim(),
      date,
      gutter: gutterNum,
      outer: outerNum,
      bwBase: takeValue(rest, "--bw-base"),
      deriveBw: rest.includes("--derive-bw"),
    });
  }
  usage();
  return 1;
}

const invokedAsMain =
  process.argv[1] != null && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedAsMain) {
  process.exit(run(process.argv.slice(2)));
}
