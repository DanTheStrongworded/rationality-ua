import { readdir } from "node:fs/promises";
import { join } from "node:path";

const BOOKS_DIR = join(import.meta.dir, "../../books");
const TIMEOUT_MS = 15_000;
const CONCURRENCY = 8;
const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36";

type LinkHit = {
  url: string;
  files: string[];
};

type Probe = {
  status: number | null;
  finalUrl: string | null;
  redirected: boolean;
  error: string | null;
};

function cleanUrl(raw: string): string {
  return raw
    .replace(/\\_/g, "_")
    .replace(/[.,;:!?]+$/, "")
    .replace(/\/+$/, (match, offset, str) =>
      str.includes("?") ? match : match,
    );
}

function extractHttpUrls(text: string): string[] {
  const urls = new Set<string>();

  for (const match of text.matchAll(/\]\(\s*<?(https?:\/\/[^)\s>]+)>?/g)) {
    const url = cleanUrl(match[1]);
    if (url.startsWith("http://")) urls.add(url);
  }

  for (const match of text.matchAll(/href=["'](https?:\/\/[^"']+)["']/gi)) {
    const url = cleanUrl(match[1]);
    if (url.startsWith("http://")) urls.add(url);
  }

  for (const match of text.matchAll(/(?<![=/])http:\/\/[^\s)\]>"'<>]+/g)) {
    urls.add(cleanUrl(match[0]));
  }

  return [...urls];
}

async function walkMarkdown(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await walkMarkdown(path)));
    } else if (entry.name.endsWith(".md")) {
      files.push(path);
    }
  }
  return files;
}

async function collectLinks(): Promise<LinkHit[]> {
  const files = await walkMarkdown(BOOKS_DIR);
  const byUrl = new Map<string, Set<string>>();

  for (const file of files) {
    const text = await Bun.file(file).text();
    const rel = file.slice(BOOKS_DIR.length + 1);
    for (const url of extractHttpUrls(text)) {
      const set = byUrl.get(url) ?? new Set<string>();
      set.add(rel);
      byUrl.set(url, set);
    }
  }

  return [...byUrl.entries()]
    .map(([url, files]) => ({ url, files: [...files].sort() }))
    .sort((a, b) => a.url.localeCompare(b.url));
}

function toHttps(url: string): string {
  return url.replace(/^http:\/\//i, "https://");
}

async function probe(url: string): Promise<Probe> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      method: "GET",
      redirect: "follow",
      signal: controller.signal,
      headers: {
        "user-agent": USER_AGENT,
        accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      },
    });
    return {
      status: response.status,
      finalUrl: response.url,
      redirected: response.redirected || response.url !== url,
      error: null,
    };
  } catch (error) {
    const message =
      error instanceof Error ? error.message.replace(/\s+/g, " ") : String(error);
    return { status: null, finalUrl: null, redirected: false, error: message };
  } finally {
    clearTimeout(timer);
  }
}

async function mapPool<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;

  async function worker() {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index], index);
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, () => worker()),
  );
  return results;
}

function formatStatus(probe: Probe): string {
  if (probe.error) return `ERR (${probe.error.slice(0, 80)})`;
  const extra = probe.redirected && probe.finalUrl ? ` → ${probe.finalUrl}` : "";
  return `${probe.status}${extra}`;
}

function verdict(http: Probe, https: Probe): string {
  const httpsOk = https.status !== null && https.status < 400;
  const httpOk = http.status !== null && http.status < 400;
  if (httpsOk) return "OK to https";
  if (httpOk) return "HTTPS broken, HTTP works";
  return "Both fail";
}

const links = await collectLinks();
console.log(`Found ${links.length} unique http:// links\n`);

const results = await mapPool(links, CONCURRENCY, async (link, index) => {
  const httpsUrl = toHttps(link.url);
  process.stderr.write(`[${index + 1}/${links.length}] ${link.url}\n`);
  const [http, https] = await Promise.all([
    probe(link.url),
    probe(httpsUrl),
  ]);
  return { link, http, https, httpsUrl };
});

const groups = {
  "OK to https": [] as typeof results,
  "HTTPS broken, HTTP works": [] as typeof results,
  "Both fail": [] as typeof results,
};

for (const result of results) {
  groups[verdict(result.http, result.https)].push(result);
}

for (const [name, items] of Object.entries(groups)) {
  console.log(`\n=== ${name} (${items.length}) ===`);
  for (const item of items) {
    console.log(item.link.url);
    console.log(`  HTTP : ${formatStatus(item.http)}`);
    console.log(`  HTTPS: ${formatStatus(item.https)}`);
    console.log(`  files: ${item.link.files.join(" | ")}`);
  }
}

console.log("\n=== Summary ===");
console.log(`Total unique http:// links: ${links.length}`);
console.log(`OK to https: ${groups["OK to https"].length}`);
console.log(`HTTPS broken, HTTP works: ${groups["HTTPS broken, HTTP works"].length}`);
console.log(`Both fail: ${groups["Both fail"].length}`);
