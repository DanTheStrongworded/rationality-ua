#!/usr/bin/env node
/**
 * Single source of truth about which books exist.
 * A book is any directory directly under books/ or books/private/
 * that contains a *.storinkator.json config. The leading number of the
 * folder name ("1. Мапа і Територія", "private/3. Машина у духові")
 * is the book id used by --book filters and prompts.
 *
 * Runs with node >= 22 or bun, no dependencies. Import it:
 *   import { discoverBooks, SERIES } from "./books.ts";
 * Or run it to list books as `id|dir|ordinal|format|title` lines:
 *   node books.ts
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

export const SERIES = "Раціональність від А до Я";

const ORDINALS_UK: Record<number, string> = {
  1: "Перша",
  2: "Друга",
  3: "Третя",
  4: "Четверта",
  5: "Пʼята",
  6: "Шоста",
  7: "Сьома",
  8: "Восьма",
  9: "Девʼята",
  10: "Десята",
  11: "Одинадцята",
  12: "Дванадцята",
};

export function ordinalUk(n: number): string {
  return ORDINALS_UK[n] ?? `${n}-та`;
}

export type BookSpec = {
  /** Leading number of the folder name, e.g. 1 or 3. */
  id: number;
  /** Repo-relative path with forward slashes, e.g. "books/1. ..." or "books/private/3. ...". */
  dir: string;
  ordinalUk: string;
  /** Display/PDF title, e.g. "Книга Перша". */
  title: string;
  /** Print format from the print config page size, e.g. "145x205mm". */
  printFormat: string;
};

function defaultRoot(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), "../..");
}

function readPrintFormat(absDir: string): string {
  try {
    const config = JSON.parse(readFileSync(join(absDir, "print.storinkator.json"), "utf8")) as {
      values?: { page_size?: { width?: unknown; height?: unknown; unit?: unknown } };
    };
    const ps = config?.values?.page_size;
    if (ps && Number.isFinite(ps.width) && Number.isFinite(ps.height)) {
      return `${ps.width}x${ps.height}${typeof ps.unit === "string" ? ps.unit : "mm"}`;
    }
  } catch {
    /* fall through to default */
  }
  return "145x205mm";
}

function scanBase(base: string, root: string, out: Map<string, BookSpec>): void {
  let entries: string[] = [];
  try {
    entries = readdirSync(base);
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.startsWith(".")) continue;
    const abs = join(base, entry);
    let st;
    try {
      st = statSync(abs);
    } catch {
      continue;
    }
    if (!st.isDirectory()) continue;
    let files: string[] = [];
    try {
      files = readdirSync(abs);
    } catch {
      continue;
    }
    if (!files.some((f) => f.endsWith(".storinkator.json"))) continue;
    const match = basename(abs).match(/^(\d+)\./);
    if (!match) continue;
    const id = Number(match[1]);
    const dir = abs.slice(root.length + 1).split(sep).join("/");
    if (out.has(dir)) continue;
    const ordinal = ordinalUk(id);
    out.set(dir, {
      id,
      dir,
      ordinalUk: ordinal,
      title: `Книга ${ordinal}`,
      printFormat: readPrintFormat(abs),
    });
  }
}

export function discoverBooks(root: string = defaultRoot()): BookSpec[] {
  const found = new Map<string, BookSpec>();
  scanBase(join(root, "books"), root, found);
  scanBase(join(root, "books", "private"), root, found);
  return [...found.values()].sort((a, b) => a.id - b.id || (a.dir < b.dir ? -1 : 1));
}

const invokedAsMain =
  process.argv[1] != null && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedAsMain) {
  for (const b of discoverBooks()) {
    console.log(`${b.id}|${b.dir}|${b.ordinalUk}|${b.printFormat}|${b.title}`);
  }
}
