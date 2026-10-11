/**
 * Debug Ukrainian hyphenation (or any rendering diff) between a manually
 * opened Chrome and the Playwright-driven one used for PDF export.
 *
 * Uses the exact same browser resolution, executable, launch flags, viewport
 * and URL resolution as generate-pdfs.ts — only headless/headful differs.
 *
 * What it does:
 *   1. Opens a visible Chromium window and prints the full settings audit
 *      trail (so you can confirm it matches the generator).
 *   2. Renders a synthetic Ukrainian hyphenation fixture (lang="uk" +
 *      hyphens:auto vs manual/no-lang controls), measures line counts and
 *      overflow per block, and saves a screenshot for eyeballing.
 *   3. Optionally (--book) loads a real book into Storinkator first, with
 *      optional --paginate.
 *   4. Waits for Enter so you can compare side by side with
 *      your manual Chrome window.
 *
 * Usage (from code/scripts):
 *   bun run debug-window.ts
 *   bun run debug-window.ts --browser 2
 *   bun run debug-window.ts --locale uk-UA          # test a locale hypothesis
 *   bun run debug-window.ts --book 1                # also load book 1 (digital)
 *   bun run debug-window.ts --book 1 --variant print --paginate
 *   bun run debug-window.ts --url https://storinkator.vercel.app --out /tmp/shots
 *   bun run debug-window.ts --browser "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
 */

import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import type { Browser, Page } from "playwright-core";
import {
  CHROMIUM_LAUNCH_ARGS,
  DEFAULT_LOCAL_PORT,
  collectBookFiles,
  discoverBrowsers,
  dismissOverlays,
  ensureStorinkator,
  findBrowserExecutable,
  loadBookIntoStorinkator,
  paginate,
  selectBrowser,
  type CliOptions,
} from "./generate-pdfs.ts";
import { discoverBooks } from "./books.ts";

type Variant = "digital" | "color" | "bw";

const VIEWPORT = { width: 1280, height: 720 };

const WORDS =
  "відповідальність електроенцефалограма конституційність " +
  "самовдосконалення взаємовідносини переосмислення найхарактерніший " +
  "сільськогосподарський протистояння несправедливість";

const WORDS_EN =
  "responsibility incomprehensibility electroencephalography " +
  "constitutionalization characterization interdependence rethinking";

function shyify(text: string): string {
  return text
    .split(" ")
    .map((w) => w.replace(/(.{4})/g, "$1&shy;"))
    .join(" ");
}

function fixtureHtml(): string {
  const block = (id: string, attrs: string, text: string) =>
    `<h2>${id}</h2><p id="${id}" ${attrs}>${text}</p>`;
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    body { font-size: 18px; line-height: 1.5; margin: 24px; }
    .col { width: 200px; background: #f4f4f4; padding: 8px; }
    .auto { hyphens: auto; }
    .manual { hyphens: manual; }
  </style></head><body>
    ${block("auto-uk", 'lang="uk" class="col auto"', WORDS)}
    ${block("manual-uk", 'lang="uk" class="col manual"', WORDS)}
    ${block("auto-nolang", 'class="col auto"', WORDS)}
    ${block("locale-uk", `lang="uk" class="col auto" style="-webkit-locale: 'uk'"`, WORDS)}
    ${block("shy-uk", 'lang="uk" class="col manual"', shyify(WORDS))}
    ${block("auto-en", 'lang="en" class="col auto"', WORDS_EN)}
    ${block("manual-en", 'lang="en" class="col manual"', WORDS_EN)}
  </body></html>`;
}

type BlockMetrics = {
  lines: number;
  splitWords: number;
  lineHeight: number;
  overflow: boolean;
  scrollWidth: number;
  clientWidth: number;
  hyphens: string;
  lang: string;
  webkitLocale: string;
};

type FixtureReport = {
  blocks: Record<string, BlockMetrics>;
  cssSupportsHyphensAuto: boolean;
  webdriver: boolean;
  language: string;
  languages: string[];
  docLang: string;
  userAgent: string;
};

async function measureFixture(page: Page): Promise<FixtureReport> {
  await page.setContent(fixtureHtml(), { waitUntil: "load" });
  return page.evaluate((): FixtureReport => {
    const blocks: Record<string, BlockMetrics> = {};
    for (const id of ["auto-uk", "manual-uk", "auto-nolang", "shy-uk", "auto-en", "manual-en", "locale-uk"]) {
      const el = document.getElementById(id)!;
      const cs = getComputedStyle(el);
      const lh = parseFloat(cs.lineHeight);
      // A word whose rects span 2+ visual lines was split mid-word =
      // direct evidence of a hyphenation break (auto or soft hyphen).
      let splitWords = 0;
      try {
        const node = el.firstChild;
        if (node && node.nodeType === 3) {
          const text = node.textContent || "";
          const wordRe = /\S+/g;
          let m: RegExpExecArray | null;
          while ((m = wordRe.exec(text))) {
            const range = document.createRange();
            range.setStart(node, m.index);
            range.setEnd(node, m.index + m[0].length);
            const tops = new Set(
              Array.from(range.getClientRects()).map((r) => Math.round(r.top)),
            );
            if (tops.size > 1) splitWords++;
          }
        }
      } catch {
        splitWords = -1; // measurement failed; verdicts treat as unknown
      }
      blocks[id] = {
        lines: Math.round(el.scrollHeight / lh),
        splitWords,
        lineHeight: lh,
        overflow: el.scrollWidth > el.clientWidth + 1,
        scrollWidth: el.scrollWidth,
        clientWidth: el.clientWidth,
        hyphens: cs.getPropertyValue("hyphens"),
        lang: el.lang,
        webkitLocale: cs.getPropertyValue("-webkit-locale"),
      };
    }
    return {
      blocks,
      cssSupportsHyphensAuto: CSS.supports("hyphens", "auto"),
      webdriver: navigator.webdriver,
      language: navigator.language,
      languages: [...navigator.languages],
      docLang: document.documentElement.lang,
      userAgent: navigator.userAgent,
    };
  });
}

function verdict(r: FixtureReport): string {
  const auto = r.blocks["auto-uk"]!;
  if (auto.splitWords > 0) {
    return `hyphenation alive (${auto.splitWords} split words, ${auto.lines} lines)`;
  }
  return `HYPHENATION DEAD (0 split words, ${auto.lines} lines${auto.overflow ? ", OVERFLOW" : ""})`;
}

function extraVerdicts(r: FixtureReport): string[] {
  const out: string[] = [];
  const shy = r.blocks["shy-uk"]!;
  out.push(
    shy.splitWords > 0
      ? `soft hyphens work (${shy.splitWords} splits)`
      : `SOFT HYPHENS DEAD TOO — engine-level breakage, not dictionaries`,
  );
  const autoEn = r.blocks["auto-en"]!;
  out.push(
    autoEn.splitWords > 0
      ? `english dict present (${autoEn.splitWords} splits)`
      : `no english splits (dictionaries may still exist — check screenshot)`,
  );
  const localeUk = r.blocks["locale-uk"]!;
  out.push(
    localeUk.splitWords > 0
      ? `-webkit-locale WORKAROUND WORKS (${localeUk.splitWords} splits) — set it in CSS (see the-new-css-reset#36)`
      : `-webkit-locale does not help (0 splits)`,
  );
  return out;
}

function parseArgs(argv: string[]): {
  locale?: string;
  bookId?: number;
  variant: Variant;
  paginate: boolean;
  url: string | null;
  port: number;
  outDir: string;
  browser: string | null;
  userDataDir: string | null;
  ignoreArgs: string[];
} {
  const o = {
    locale: undefined as string | undefined,
    bookId: undefined as number | undefined,
    variant: "digital" as Variant,
    paginate: false,
    url: (process.env.STORINKATOR_URL ?? null) as string | null,
    port: DEFAULT_LOCAL_PORT,
    outDir: join(tmpdir(), "storinkator-debug"),
    browser: null as string | null,
    userDataDir: null as string | null,
    ignoreArgs: [] as string[],
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--locale") o.locale = argv[++i];
    else if (a === "--book") {
      const n = Number(argv[++i]);
      if (!discoverBooks().some((b) => b.id === n)) throw new Error(`Unknown book id: ${argv[i]}`);
      o.bookId = n;
    } else if (a === "--variant") {
      const v = argv[++i];
      if (v !== "digital" && v !== "color" && v !== "bw") {
        throw new Error(`Unknown --variant: ${v}`);
      }
      o.variant = v;
    } else if (a === "--paginate") o.paginate = true;
    else if (a === "--url") o.url = argv[++i] ?? o.url;
    else if (a === "--port") {
      const p = Number(argv[++i]);
      if (!Number.isInteger(p) || p < 1 || p > 65535) throw new Error(`Invalid --port: ${p}`);
      o.port = p;
    } else if (a === "--out") o.outDir = argv[++i] ?? o.outDir;
    else if (a === "--browser") {
      const sel = argv[++i];
      if (sel === undefined) throw new Error("Missing value for --browser");
      if (sel === "list") {
        const all = discoverBrowsers();
        console.log(
          all.length
            ? "Discovered browsers:\n" + all.map((p, i) => `  ${i + 1}. ${p}`).join("\n")
            : "No browsers discovered.",
        );
        process.exitCode = 0;
        throw new HelpDone();
      }
      o.browser = sel;
    } else if (a === "--user-data-dir") {
      const d = argv[++i];
      if (!d) throw new Error("Missing value for --user-data-dir");
      o.userDataDir = d;
    } else if (a === "--ignore-arg") {
      const f = argv[++i];
      if (!f) throw new Error("Missing value for --ignore-arg");
      o.ignoreArgs.push(f);
    }
    else if (a === "--help" || a === "-h") {
      console.log(`Usage: bun run debug-window.ts [options]
  --locale <locale>   Pass locale to newPage (default: none, like the generator)
  --book <id>         Also load a real book into Storinkator first
  --variant <v>       Book variant to load (default digital)
  --paginate          Paginate after loading the book (slow)
  --url <storinkator> Force URL (skip local/prod auto-detect)
  --browser <n|name|path> Pick a Chromium (default: auto-detect first found)
  --user-data-dir <dir> Use a REAL browser profile instead of a fresh one
                        (close that browser first — profile gets locked).
                        Decides profile-vs-flags: if hyphenation works here
                        but not in a fresh profile, the profile state matters.
  --ignore-arg <flag>   Drop a Playwright default launch flag, e.g.
                        --ignore-arg disable-component-update (repeatable).
                        Tests whether a default flag breaks hyphenation.
  --port <n>          Local vite port to try first (default ${DEFAULT_LOCAL_PORT})
  --out <dir>         Screenshot directory (default: tmpdir/storinkator-debug)
  --no-wait           Close the window and exit after the tasks (for scripting)`);
      process.exitCode = 0;
      throw new HelpDone();
    } else throw new Error(`Unknown arg: ${a}`);
  }
  return o;
}

class HelpDone extends Error {}

async function runFixture(
  page: Page,
  outDir: string,
  tag: string,
): Promise<FixtureReport> {
  const report = await measureFixture(page);
  mkdirSync(outDir, { recursive: true });
  const shot = join(outDir, `hyphenation-${tag}.png`);
  await page.screenshot({ path: shot, fullPage: true });
  console.log(`  screenshot → ${shot}`);
  await page.close();
  return report;
}

function printReport(tag: string, r: FixtureReport) {
  console.log(`--- fixture report [${tag}] ---`);
  console.log(`  verdict: ${verdict(r)}`);
  for (const v of extraVerdicts(r)) console.log(`  verdict: ${v}`);
  for (const [id, b] of Object.entries(r.blocks)) {
    console.log(
      `  ${id}: lines=${b.lines} splitWords=${b.splitWords} overflow=${b.overflow} ` +
        `scrollWidth=${b.scrollWidth} clientWidth=${b.clientWidth} hyphens=${b.hyphens} lang=${JSON.stringify(b.lang)} webkit-locale=${JSON.stringify(b.webkitLocale)}`,
    );
  }
  console.log(
    `  cssSupports(hyphens:auto)=${r.cssSupportsHyphensAuto} webdriver=${r.webdriver} ` +
      `language=${r.language} languages=[${r.languages.join(",")}] docLang=${JSON.stringify(r.docLang)}`,
  );
  console.log(`  ua: ${r.userAgent}`);
}

async function waitForEnter() {
  if (!process.stdin.isTTY) return;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  await new Promise<void>((resolve) => rl.question("Press Enter to close the window… ", () => resolve()));
  rl.close();
}

async function main() {
  let o;
  try {
    o = parseArgs(process.argv.slice(2));
  } catch (err) {
    if (err instanceof HelpDone) return;
    throw err;
  }

  try {
    await import("playwright-core");
  } catch {
    console.error("playwright-core is not installed. Run `npm install` inside code/scripts first.");
    process.exitCode = 1;
    return;
  }

  const browserPath = o.browser ? selectBrowser(o.browser) : findBrowserExecutable();
  const genOpts: CliOptions = {
    url: o.url,
    port: o.port,
    books: [],
    variants: [],
    browser: o.browser,
    startStorinkator: false,
  };
  const { url: storinkatorUrl } = await ensureStorinkator(genOpts);

  let browser: Browser | null = null;

  try {
    const { chromium } = await import("playwright-core");
    console.log("");
    console.log("  executable: " + browserPath + (o.browser ? ` (chosen via --browser "${o.browser}")` : " (auto-detected)"));
    for (const [i, p] of discoverBrowsers().entries()) {
      console.log(`  browser ${i + 1}: ${p}${p === browserPath ? "  ← using" : ""}`);
    }
    console.log(`  launch args: ${JSON.stringify(CHROMIUM_LAUNCH_ARGS)}`);
    console.log(`  ignoreDefaultArgs: ${o.ignoreArgs.length ? JSON.stringify(o.ignoreArgs) : "(none)"}`);
    console.log(`  viewport: ${VIEWPORT.width}x${VIEWPORT.height}`);
    console.log(`  locale: ${o.locale ?? "(none — like the generator)"}`);
    console.log(`  url: ${storinkatorUrl}`);

    browser = await chromium.launch({
      executablePath: browserPath,
      headless: false,
      args: CHROMIUM_LAUNCH_ARGS,
      // Playwright disables the component updater by default
      // (--disable-component-update), which is exactly how Chrome on
      // Windows/Linux downloads hyphen-data (microsoft/playwright#34375).
      // macOS is unaffected (system hyphen APIs). Accept both "flag" and
      // "--flag" spellings since matching is by string equality.
      ...(o.ignoreArgs.length
        ? {
            ignoreDefaultArgs: o.ignoreArgs.flatMap((f) =>
              f.startsWith("--") ? [f, f.slice(2)] : [f, `--${f}`],
            ),
          }
        : {}),
    });
    console.log(`  browser version: ${await browser.version()}`);
    const page = await browser.newPage({
      viewport: VIEWPORT,
      ...(o.locale ? { locale: o.locale } : {}),
    });
    const report = await runFixture(page, o.outDir, "window");
    printReport("window", report);

    if (o.bookId !== undefined) {
      if (!browser || !browser.isConnected()) throw new Error("browser went away before book load");
      const book = discoverBooks().find((b) => b.id === o.bookId)!;
      const label = `${book.title} [${o.variant}] (debug)`;
      const files = await collectBookFiles(book, o.variant);
      const page = await browser.newPage({ viewport: VIEWPORT });
      try {
        await page.goto(storinkatorUrl, { waitUntil: "networkidle", timeout: 60_000 });
        await dismissOverlays(page);
        await loadBookIntoStorinkator(page, files, label);
        await dismissOverlays(page);
        if (o.paginate) await paginate(page);
        else console.log("  (book loaded, pagination skipped — pass --paginate to run it)");
      } finally {
        await page.close();
      }
    }

    await waitForEnter();
  } finally {
    await browser?.close().catch(() => {});
  }
}

const invokedAsMain =
  process.argv[1] != null && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedAsMain) {
  main().catch((err) => {
    console.error("");
    console.error(err instanceof Error ? err.stack || err.message : err);
    process.exitCode = 1;
  });
}
