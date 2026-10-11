/**
 * Debug Ukrainian hyphenation (or any rendering diff) between a manually
 * opened Chrome and the Playwright-driven one used for PDF export.
 *
 * Uses the exact same browser resolution, executable, launch flags, viewport
 * and URL resolution as generate-pdfs.ts — only headless/headful differs.
 *
 * What it does:
 *   1. Launches Chromium (visible window by default) with the generator's
 *      CHROMIUM_LAUNCH_ARGS and prints the full settings audit trail.
 *   2. Renders a synthetic Ukrainian hyphenation fixture (lang="uk" +
 *      hyphens:auto vs manual/no-lang controls), measures line counts and
 *      overflow per block, and saves a screenshot for eyeballing.
 *   3. Optionally (--book) loads a real book into Storinkator first, with
 *      optional --paginate.
 *   4. In headed mode waits for Enter so you can compare side by side with
 *      your manual Chrome window.
 *
 * Usage (from code/scripts):
 *   bun run debug-window.ts
 *   bun run debug-window.ts --mode compare          # headless metrics + headed window
 *   bun run debug-window.ts --mode headless         # no window, metrics only
 *   bun run debug-window.ts --locale uk-UA          # test a locale hypothesis
 *   bun run debug-window.ts --book 1                # also load book 1 (digital)
 *   bun run debug-window.ts --book 1 --variant print --paginate
 *   bun run debug-window.ts --url https://storinkator.vercel.app --out /tmp/shots
 *   bun run debug-window.ts --browser 2
 *   bun run debug-window.ts --browser "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
 */

import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
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

type Mode = "headed" | "headless" | "compare";
type Variant = "digital" | "color" | "bw";

const VIEWPORT = { width: 1280, height: 720 };

const WORDS =
  "відповідальність електроенцефалограма конституційність " +
  "самовдосконалення взаємовідносини переосмислення найхарактерніший " +
  "сільськогосподарський протистояння несправедливість";

function fixtureHtml(): string {
  const block = (id: string, attrs: string) =>
    `<h2>${id}</h2><p id="${id}" ${attrs}>${WORDS}</p>`;
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    body { font-size: 18px; line-height: 1.5; margin: 24px; }
    .col { width: 200px; background: #f4f4f4; padding: 8px; }
    .auto { hyphens: auto; }
    .manual { hyphens: manual; }
  </style></head><body>
    ${block("auto-uk", 'lang="uk" class="col auto"')}
    ${block("manual-uk", 'lang="uk" class="col manual"')}
    ${block("auto-nolang", 'class="col auto"')}
  </body></html>`;
}

type BlockMetrics = {
  lines: number;
  lineHeight: number;
  overflow: boolean;
  scrollWidth: number;
  clientWidth: number;
  hyphens: string;
  lang: string;
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
    for (const id of ["auto-uk", "manual-uk", "auto-nolang"]) {
      const el = document.getElementById(id)!;
      const cs = getComputedStyle(el);
      const lh = parseFloat(cs.lineHeight);
      blocks[id] = {
        lines: Math.round(el.scrollHeight / lh),
        lineHeight: lh,
        overflow: el.scrollWidth > el.clientWidth + 1,
        scrollWidth: el.scrollWidth,
        clientWidth: el.clientWidth,
        hyphens: cs.getPropertyValue("hyphens"),
        lang: el.lang,
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
  const manual = r.blocks["manual-uk"]!;
  // Working hyphenation packs words into FEWER lines than manual (which can
  // only break at spaces). Identical line counts = auto behaves like manual.
  if (!auto.overflow && auto.lines < manual.lines) {
    return `hyphenation alive (auto: ${auto.lines} lines vs manual: ${manual.lines} lines)`;
  }
  return `HYPHENATION DEAD (auto: ${auto.lines} lines${auto.overflow ? ", OVERFLOW" : ""} vs manual: ${manual.lines} lines)`;
}

function parseArgs(argv: string[]): {
  mode: Mode;
  locale?: string;
  bookId?: number;
  variant: Variant;
  paginate: boolean;
  url: string | null;
  port: number;
  outDir: string;
  browser: string | null;
} {
  const o = {
    mode: "headed" as Mode,
    locale: undefined as string | undefined,
    bookId: undefined as number | undefined,
    variant: "digital" as Variant,
    paginate: false,
    url: (process.env.STORINKATOR_URL ?? null) as string | null,
    port: DEFAULT_LOCAL_PORT,
    outDir: join(tmpdir(), "storinkator-debug"),
    browser: null as string | null,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--mode") {
      const m = argv[++i];
      if (m !== "headed" && m !== "headless" && m !== "compare") {
        throw new Error(`Unknown --mode: ${m} (want headed|headless|compare)`);
      }
      o.mode = m;
    } else if (a === "--locale") o.locale = argv[++i];
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
      o.browser = sel;
    }
    else if (a === "--help" || a === "-h") {
      console.log(`Usage: bun run debug-window.ts [options]
  --mode <headed|headless|compare>   headed opens a visible window (default),
                                     compare runs headless metrics first
  --locale <locale>   Pass locale to newPage (default: none, like the generator)
  --book <id>         Also load a real book into Storinkator first
  --variant <v>       Book variant to load (default digital)
  --paginate          Paginate after loading the book (slow)
  --url <storinkator> Force URL (skip local/prod auto-detect)
  --browser <n|name|path> Pick a Chromium (default: auto-detect first found)
  --port <n>          Local vite port to try first (default ${DEFAULT_LOCAL_PORT})
  --out <dir>         Screenshot directory (default: tmpdir/storinkator-debug)`);
      process.exitCode = 0;
      throw new HelpDone();
    } else throw new Error(`Unknown arg: ${a}`);
  }
  return o;
}

class HelpDone extends Error {}

async function runFixture(
  browser: Browser,
  opts: { headless: boolean; locale?: string; outDir: string; tag: string },
): Promise<FixtureReport> {
  const { chromium } = await import("playwright-core");
  void chromium;
  // NOTE: browser is already launched by the caller; this helper only opens
  // a page so headed/headless runs share one window in headed mode.
  const page = await browser.newPage({
    viewport: VIEWPORT,
    ...(opts.locale ? { locale: opts.locale } : {}),
  });
  const report = await measureFixture(page);
  mkdirSync(opts.outDir, { recursive: true });
  const shot = join(opts.outDir, `hyphenation-${opts.tag}.png`);
  await page.screenshot({ path: shot, fullPage: true });
  console.log(`  screenshot → ${shot}`);
  await page.close();
  return report;
}

function printReport(tag: string, r: FixtureReport) {
  console.log(`--- fixture report [${tag}] ---`);
  console.log(`  verdict: ${verdict(r)}`);
  for (const [id, b] of Object.entries(r.blocks)) {
    console.log(
      `  ${id}: lines=${b.lines} overflow=${b.overflow} ` +
        `scrollWidth=${b.scrollWidth} clientWidth=${b.clientWidth} hyphens=${b.hyphens} lang=${JSON.stringify(b.lang)}`,
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

  const modes = o.mode === "compare" ? (["headless", "headed"] as const) : ([o.mode] as const);
  const reports: Array<{ tag: string; report: FixtureReport }> = [];
  let browser: Browser | null = null;

  try {
    const { chromium } = await import("playwright-core");
    for (const m of modes) {
      const headless = m === "headless";
      console.log("");
      console.log(`═══ run [${m}] ═══`);
      console.log(`  executable: ${browserPath}${o.browser ? ` (chosen via --browser "${o.browser}")` : " (auto-detected)"}`);
      for (const [i, p] of discoverBrowsers().entries()) {
        console.log(`  browser ${i + 1}: ${p}${p === browserPath ? "  ← using" : ""}`);
      }
      console.log(`  headless: ${headless}`);
      console.log(`  launch args: ${JSON.stringify(CHROMIUM_LAUNCH_ARGS)}`);
      console.log(`  viewport: ${VIEWPORT.width}x${VIEWPORT.height}`);
      console.log(`  locale: ${o.locale ?? "(none — like the generator)"}`);
      console.log(`  url: ${storinkatorUrl}`);

      browser = await chromium.launch({
        executablePath: browserPath,
        headless,
        args: CHROMIUM_LAUNCH_ARGS,
      });
      console.log(`  browser version: ${await browser.version()}`);
      try {
        const report = await runFixture(browser, {
          headless,
          locale: o.locale,
          outDir: o.outDir,
          tag: m,
        });
        printReport(m, report);
        reports.push({ tag: m, report });
      } finally {
        // In compare mode the headless browser is disposable; the headed one
        // stays open below until Enter.
        if (m === "headless") await browser.close();
      }
    }

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

    if (o.mode !== "headless") await waitForEnter();
  } finally {
    await browser?.close().catch(() => {});
  }

  if (reports.length === 2) {
    console.log("");
    console.log("═══ compare ═══");
    for (const { tag, report } of reports) console.log(`  [${tag}] ${verdict(report)}`);
  }
}

main().catch((err) => {
  console.error("");
  console.error(err instanceof Error ? err.stack || err.message : err);
  process.exitCode = 1;
});
