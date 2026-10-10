/**
 * Export digital + print PDFs via Storinkator (Playwright + system Chromium).
 *
 * Resolves Storinkator URL as:
 *   1. --url if given
 *   2. local http://127.0.0.1:<port> if reachable (default port 5173, override with --port)
 *   3. https://storinkator.vercel.app (production)
 *
 * Requires:
 *   - Brave / Chrome / Edge / Chromium installed
 *
 * Usage (from code/scripts):
 *   bun run generate-pdfs.ts
 *   bun run generate-pdfs.ts --book 1 --digital
 *   bun run generate-pdfs.ts --book 3 --variants bw --assets /path/to/private/assets
 *   bun run generate-pdfs.ts --port 5174
 *   bun run generate-pdfs.ts --url https://storinkator.vercel.app
 *   bun run generate-pdfs.ts --start   # auto-start local vite if missing
 *
 * Env:
 *   STORINKATOR_URL   force URL (skips auto-detect)
 *   STORINKATOR_DIR   path to storinkator repo (optional; with --start)
 *   CHROME_PATH       override browser executable
 */

import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, statSync, mkdirSync } from "node:fs";
import { mkdir, readdir, readFile } from "node:fs/promises";
import { dirname, join, relative, resolve, basename, extname } from "node:path";
import { fileURLToPath } from "node:url";
import type { Browser, Page } from "playwright-core";
import { discoverBooks, SERIES, type BookSpec } from "./books.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "../..");
let OUT_DIGITAL = join(REPO_ROOT, "assets/pdf/digital");
let OUT_PRINT_COLOR = join(REPO_ROOT, "assets/pdf/print-color");
let OUT_PRINT_BW = join(REPO_ROOT, "assets/pdf/print-bw");
const PROD_STORINKATOR_URL = "https://storinkator.vercel.app";
const DEFAULT_LOCAL_PORT = 5173;

type Variant = "digital" | "color" | "bw";

type CliOptions = {
  /** Explicit --url, or null to auto-detect local → prod */
  url: string | null;
  port: number;
  books: BookSpec[];
  variants: Variant[];
  /** Auto-start local vite only when explicitly requested */
  startStorinkator: boolean;
};

function log(msg: string) {
  const ts = new Date().toLocaleTimeString("uk-UA", { hour12: false });
  console.log(`[${ts}] ${msg}`);
}

function logStep(step: string, detail?: string) {
  log(detail ? `→ ${step}: ${detail}` : `→ ${step}`);
}

function logOk(msg: string) {
  log(`✓ ${msg}`);
}

function logWarn(msg: string) {
  log(`! ${msg}`);
}

function localUrl(port: number): string {
  return `http://127.0.0.1:${port}`;
}

function parseArgs(argv: string[]): CliOptions {
  const opts: CliOptions = {
    url: process.env.STORINKATOR_URL ?? null,
    port: DEFAULT_LOCAL_PORT,
    books: discoverBooks(),
    variants: ["digital", "color", "bw"],
    startStorinkator: false,
  };

  let variantsSet = false;

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--url") opts.url = argv[++i] ?? opts.url;
    else if (a === "--assets") {
      const dir = resolve(argv[++i] ?? "");
      OUT_DIGITAL = join(dir, "pdf/digital");
      OUT_PRINT_COLOR = join(dir, "pdf/print-color");
      OUT_PRINT_BW = join(dir, "pdf/print-bw");
    } else if (a === "--port") {
      const p = Number(argv[++i]);
      if (!Number.isInteger(p) || p < 1 || p > 65535) {
        throw new Error(`Invalid --port: ${p}`);
      }
      opts.port = p;
    } else if (a === "--book") {
      const id = argv[++i] ?? "";
      if (id === "all") opts.books = discoverBooks();
      else {
        const n = Number(id);
        const match = discoverBooks().find((b) => b.id === n);
        if (!match) throw new Error(`Unknown book id: ${id}`);
        opts.books = [match];
      }
    } else if (a === "--variants") {
      const list = (argv[++i] ?? "").split(",").map((s) => s.trim().toLowerCase());
      const mapped = list.map((v) => (v === "print" ? "color" : v));
      for (const v of mapped) {
        if (v !== "digital" && v !== "color" && v !== "bw") {
          throw new Error(`Unknown variant: ${v} (want digital,color,bw)`);
        }
      }
      opts.variants = mapped as Variant[];
      variantsSet = true;
    } else if (a === "--digital") {
      opts.variants = ["digital"];
      variantsSet = true;
    } else if (a === "--print" || a === "--color") {
      opts.variants = ["color"];
      variantsSet = true;
    } else if (a === "--bw") {
      opts.variants = ["bw"];
      variantsSet = true;
    } else if (a === "--no-digital") opts.variants = opts.variants.filter((v) => v !== "digital");
    else if (a === "--no-print" || a === "--no-color") opts.variants = opts.variants.filter((v) => v !== "color");
    else if (a === "--no-bw") opts.variants = opts.variants.filter((v) => v !== "bw");
    else if (a === "--start") opts.startStorinkator = true;
    else if (a === "--no-start") opts.startStorinkator = false;
    else if (a === "--help" || a === "-h") {
      console.log(`Usage: bun run generate-pdfs.ts [options]
  --book <1|2|3|all>   Which book(s) (default: all)
  --variants <list>     Comma list of digital,color,bw (default: all three;
                        \"print\" accepted as alias of color)
  --digital/--print/--color/--bw   Only that variant (legacy --print = color)
  --no-digital|--no-print|--no-bw
  --assets <dir>        Assets root holding pdf/digital + pdf/print-color + pdf/print-bw
                        (default: repo assets/; use for the private book)
  --port <n>            Local vite port to try first (default ${DEFAULT_LOCAL_PORT})
  --url <storinkator>   Force URL (skip local/prod auto-detect)
  --start               Auto-start local vite if not reachable
  (default)             Use local if up, else ${PROD_STORINKATOR_URL}`);
      process.exit(0);
    } else throw new Error(`Unknown arg: ${a}`);
  }

  if (!variantsSet) {
    // Back-compat placeholder: explicit --digital/--print handled above.
  }
  if (opts.variants.length === 0) throw new Error("No variants selected.");

  return opts;
}

function pdfBaseName(book: BookSpec): string {
  return `${SERIES}. ${book.title}`;
}

function digitalOutPath(book: BookSpec): string {
  return join(OUT_DIGITAL, `${pdfBaseName(book)}.pdf`);
}

function variantLabel(variant: Variant): string {
  return variant === "digital" ? "digital" : variant === "color" ? "Color" : "BW";
}

function printOutPath(book: BookSpec, variant: "color" | "bw"): string {
  const dir = variant === "color" ? OUT_PRINT_COLOR : OUT_PRINT_BW;
  return join(dir, `${pdfBaseName(book)} ${book.printFormat} ${variantLabel(variant)}.pdf`);
}

function bookAbsDir(book: BookSpec): string {
  return join(REPO_ROOT, book.dir);
}

function configFileFor(variant: Variant): string {
  if (variant === "digital") return "digital.storinkator.json";
  if (variant === "bw") return "print-bw.storinkator.json";
  return "print.storinkator.json";
}

function findBrowserExecutable(): string {
  if (process.env.CHROME_PATH && existsSync(process.env.CHROME_PATH)) {
    return process.env.CHROME_PATH;
  }
  const candidates = [
    "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
    "/Applications/Arc.app/Contents/MacOS/Arc",
    "/Applications/Vivaldi.app/Contents/MacOS/Vivaldi",
    `${process.env.HOME}/Applications/Brave Browser.app/Contents/MacOS/Brave Browser`,
    `${process.env.HOME}/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`,
    ...windowsBrowserCandidates(),
  ];
  for (const p of candidates) {
    if (p && existsSync(p)) return p;
  }
  throw new Error(
    "No Chromium browser found. Install Brave/Chrome/Edge or set CHROME_PATH.",
  );
}

/** Chromium locations on Windows (Program Files + per-user installs). */
function windowsBrowserCandidates(): string[] {
  if (process.platform !== "win32") return [];
  const progFiles = process.env.PROGRAMFILES ?? "C:\\Program Files";
  const localApp = process.env.LOCALAPPDATA ??
    (process.env.USERPROFILE ? join(process.env.USERPROFILE, "AppData", "Local") : "");
  const roots = [progFiles, localApp].filter((r) => r !== "");
  const rel = [
    "BraveSoftware/Brave-Browser/Application/brave.exe",
    "Google/Chrome/Application/chrome.exe",
    "Chromium/Application/chrome.exe",
    "Microsoft/Edge/Application/msedge.exe",
  ];
  return roots.flatMap((root) => rel.map((r) => join(root, r)));
}

function findStorinkatorDir(): string | null {
  if (process.env.STORINKATOR_DIR && existsSync(process.env.STORINKATOR_DIR)) {
    return process.env.STORINKATOR_DIR;
  }
  const sibling = resolve(REPO_ROOT, "../storinkator");
  if (existsSync(join(sibling, "package.json"))) return sibling;
  return null;
}

async function urlReachable(url: string): Promise<boolean> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(2000) });
    return res.ok || res.status === 404;
  } catch {
    return false;
  }
}

async function ensureStorinkator(
  opts: CliOptions,
): Promise<{ url: string; proc: ChildProcess | null }> {
  if (opts.url) {
    if (!(await urlReachable(opts.url))) {
      throw new Error(`Storinkator not reachable at ${opts.url}`);
    }
    logOk(`Using Storinkator at ${opts.url}`);
    return { url: opts.url, proc: null };
  }

  const local = localUrl(opts.port);
  if (await urlReachable(local)) {
    logOk(`Using local Storinkator at ${local}`);
    return { url: local, proc: null };
  }

  if (opts.startStorinkator) {
    const dir = findStorinkatorDir();
    if (!dir) {
      throw new Error(
        `Local Storinkator not reachable and STORINKATOR_DIR not found (looked for ../storinkator).`,
      );
    }
    logStep("Starting Storinkator", `${dir} :${opts.port}`);
    const child = spawn(
      "bun",
      ["run", "dev", "--", "--host", "127.0.0.1", "--port", String(opts.port)],
      {
        cwd: dir,
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env },
      },
    );
    const deadline = Date.now() + 60_000;
    await new Promise<void>((resolvePromise, reject) => {
      child.on("exit", (code) => {
        reject(new Error(`Storinkator exited early (code ${code})`));
      });
      const poll = async () => {
        while (Date.now() < deadline) {
          if (await urlReachable(local)) {
            resolvePromise();
            return;
          }
          await new Promise((r) => setTimeout(r, 500));
        }
        reject(new Error(`Storinkator did not become ready at ${local}`));
      };
      void poll();
    });
    logOk(`Storinkator ready at ${local}`);
    return { url: local, proc: child };
  }

  logWarn(`Local Storinkator not on ${local} — falling back to production`);
  if (!(await urlReachable(PROD_STORINKATOR_URL))) {
    throw new Error(
      `Neither local (${local}) nor production (${PROD_STORINKATOR_URL}) is reachable.`,
    );
  }
  logOk(`Using production Storinkator at ${PROD_STORINKATOR_URL}`);
  return { url: PROD_STORINKATOR_URL, proc: null };
}

type InjectFile = {
  /** webkitRelativePath, e.g. "1. Book/chapter/file.md" */
  relativePath: string;
  /** utf-8 text or base64 for binary */
  encoding: "utf8" | "base64";
  data: string;
};

async function collectBookFiles(book: BookSpec, variant: Variant): Promise<InjectFile[]> {
  const root = bookAbsDir(book);
  const bookFolderName = basename(root);
  const configName = configFileFor(variant);
  const configPath = join(root, configName);
  if (!existsSync(configPath)) {
    throw new Error(`Missing ${configName} in ${root}`);
  }

  const out: InjectFile[] = [];
  const skipNames = new Set([
    "digital.storinkator.json",
    "print.storinkator.json",
    "storinkator.json",
    "storinkator-online.json",
    "storinkator-print.json",
    ".DS_Store",
  ]);

  async function walk(dir: string) {
    for (const name of await readdir(dir)) {
      if (name === ".DS_Store") continue;
      const abs = join(dir, name);
      const st = statSync(abs);
      if (st.isDirectory()) {
        await walk(abs);
        continue;
      }
      if (skipNames.has(name)) continue;
      if (name.endsWith(".storinkator.json")) continue;

      const rel = `${bookFolderName}/${relative(root, abs).split("\\").join("/")}`;
      const ext = extname(name).toLowerCase();
      const isText =
        [".md", ".json", ".css", ".html", ".txt", ".svg"].includes(ext) ||
        name.endsWith(".storinkator.json");
      if (isText) {
        out.push({
          relativePath: rel,
          encoding: "utf8",
          data: await readFile(abs, "utf8"),
        });
      } else {
        out.push({
          relativePath: rel,
          encoding: "base64",
          data: (await readFile(abs)).toString("base64"),
        });
      }
    }
  }

  await walk(root);

  // Inject active config as storinkator.json so Storinkator auto-loads it.
  out.push({
    relativePath: `${bookFolderName}/storinkator.json`,
    encoding: "utf8",
    data: await readFile(configPath, "utf8"),
  });

  return out;
}

async function dismissOverlays(page: Page) {
  // Chromium hint
  const dismiss = page.getByRole("button", { name: /continue|dismiss|ok|got it/i });
  if (await dismiss.count()) {
    try {
      await dismiss.first().click({ timeout: 1000 });
    } catch {
      /* ignore */
    }
  }
  // Generic dismiss on error banner
  const errDismiss = page.locator(".error-banner button");
  if (await errDismiss.count()) {
    try {
      await errDismiss.first().click({ timeout: 500 });
    } catch {
      /* ignore */
    }
  }
}

async function loadBookIntoStorinkator(page: Page, files: InjectFile[], bookLabel: string) {
  logStep("Injecting book files", `${files.length} files → ${bookLabel}`);

  await page.evaluate(async (payload) => {
    const { files: filePayloads } = payload as { files: InjectFile[] };

    function toFile(entry: InjectFile): File {
      const name = entry.relativePath.split("/").pop() || "file";
      let blob: Blob;
      if (entry.encoding === "utf8") {
        blob = new Blob([entry.data], { type: "text/plain" });
      } else {
        const bin = atob(entry.data);
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        blob = new Blob([bytes]);
      }
      const file = new File([blob], name);
      Object.defineProperty(file, "webkitRelativePath", {
        configurable: true,
        enumerable: true,
        get: () => entry.relativePath,
      });
      return file;
    }

    const bridge = (
      window as unknown as {
        __STORINKATOR_AUTOMATION__?: { loadFolderFiles: (files: File[]) => Promise<void> };
      }
    ).__STORINKATOR_AUTOMATION__;
    if (!bridge?.loadFolderFiles) {
      throw new Error(
        "window.__STORINKATOR_AUTOMATION__ missing — deploy latest Storinkator (automation bridge) or use local vite.",
      );
    }
    await bridge.loadFolderFiles(filePayloads.map(toFile));
  }, { files });

  // Wait until loading overlay gone and book chrome present
  await page.waitForFunction(
    () => {
      const loading = document.querySelector(".loading-overlay");
      if (loading) return false;
      const paginate = Array.from(document.querySelectorAll("button")).some((b) =>
        /Paginate/i.test(b.textContent || ""),
      );
      return paginate;
    },
    { timeout: 180_000 },
  );
  logOk(`Book loaded: ${bookLabel}`);
}

async function paginate(page: Page) {
  logStep("Paginating (paged.js)");
  const btn = page.getByRole("button", { name: /Paginate all|Paginate selected/i });
  await btn.click();

  await page.waitForFunction(
    () => {
      const pages = document.querySelectorAll(".pagedjs_pages .pagedjs_page");
      const cancel = Array.from(document.querySelectorAll("button")).some((b) =>
        /Cancel pagination/i.test(b.textContent || ""),
      );
      return pages.length > 0 && cancel;
    },
    { timeout: 600_000 },
  );

  // Folio / TOC numbers settle after a short delay in Pageify
  await page.waitForTimeout(500);

  const pageCount = await page.locator(".pagedjs_pages .pagedjs_page").count();
  logOk(`Pagination done (${pageCount} pages)`);
  return pageCount;
}

function pageSizeForVariant(_variant: Variant, _book: BookSpec): { width: string; height: string } {
  // Match digital + print storinkator configs (145×205 mm)
  return { width: "145mm", height: "205mm" };
}

async function exportPdf(page: Page, outPath: string, variant: Variant, book: BookSpec) {
  await mkdir(dirname(outPath), { recursive: true });
  const size = pageSizeForVariant(variant, book);
  logStep("Printing PDF", `${size.width} × ${size.height} → ${basename(outPath)}`);

  await page.pdf({
    path: outPath,
    printBackground: true,
    preferCSSPageSize: true,
    width: size.width,
    height: size.height,
    margin: { top: "0", right: "0", bottom: "0", left: "0" },
  });

  const bytes = statSync(outPath).size;
  logOk(`Wrote ${relative(REPO_ROOT, outPath)} (${(bytes / 1024 / 1024).toFixed(2)} MB)`);
}

async function exportBookVariant(
  page: Page,
  book: BookSpec,
  variant: Variant,
  _opts: CliOptions,
  storinkatorUrl: string,
) {
  const label = `${book.title} [${variant}]`;
  console.log("");
  log(`════ ${label} ════`);
  const t0 = Date.now();

  const files = await collectBookFiles(book, variant);
  await page.goto(storinkatorUrl, { waitUntil: "networkidle", timeout: 60_000 });
  await dismissOverlays(page);
  await loadBookIntoStorinkator(page, files, label);
  await dismissOverlays(page);
  await paginate(page);

  const out =
    variant === "digital" ? digitalOutPath(book) : printOutPath(book, variant);
  await exportPdf(page, out, variant, book);

  logOk(`Finished ${label} in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  mkdirSync(OUT_DIGITAL, { recursive: true });
  mkdirSync(OUT_PRINT_COLOR, { recursive: true });
  mkdirSync(OUT_PRINT_BW, { recursive: true });

  console.log("");
  log("PDF export");
  log(`  books:    ${opts.books.map((b) => b.title).join(", ")}`);
  log(`  variants: ${opts.variants.join(" + ")}`);
  log(
    `  target:   ${opts.url ?? `local :${opts.port} → fallback ${PROD_STORINKATOR_URL}`}`,
  );

  const browserPath = findBrowserExecutable();
  logOk(`Browser: ${browserPath}`);

  let storinkatorProc: ChildProcess | null = null;
  try {
    const resolved = await ensureStorinkator(opts);
    storinkatorProc = resolved.proc;
    const storinkatorUrl = resolved.url;

    logStep("Launching Chromium");
    const { chromium } = await import("playwright-core");
    const browser: Browser = await chromium.launch({
      executablePath: browserPath,
      headless: true,
      args: ["--font-render-hinting=none", "--disable-lcd-text"],
    });

    try {
      const page = await browser.newPage();
      page.setDefaultTimeout(120_000);

      for (const book of opts.books) {
        for (const variant of opts.variants) {
          await exportBookVariant(page, book, variant, opts, storinkatorUrl);
        }
      }
    } finally {
      await browser.close();
    }

    console.log("");
    logOk("All exports complete");
    log(`  digital     → ${relative(REPO_ROOT, OUT_DIGITAL)}`);
    log(`  print-color → ${relative(REPO_ROOT, OUT_PRINT_COLOR)}`);
    log(`  print-bw    → ${relative(REPO_ROOT, OUT_PRINT_BW)}`);
  } finally {
    if (storinkatorProc) {
      logStep("Stopping Storinkator we started");
      storinkatorProc.kill("SIGTERM");
    }
  }
}

main().catch((err) => {
  console.error("");
  console.error(err instanceof Error ? err.stack || err.message : err);
  process.exit(1);
});
