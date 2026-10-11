/**
 * Chrome for Testing management (shared by generate-pdfs.ts and debug-window.ts).
 *
 * Playwright's default launch flags disable the component updater, which is
 * how stock Chrome on Windows/Linux downloads hyphen-data — so `hyphens: auto`
 * is dead there (microsoft/playwright#34375). Chrome for Testing bundles the
 * hyphen dictionaries, so it hyphenates everywhere with zero flags.
 *
 * Layout (gitignored, see .gitignore):
 *   code/.chrome-for-testing/PLATFORM/chrome-FOO/... (browser binary)
 *   code/.chrome-for-testing/PLATFORM/STAMP.json  { version, downloadedAt }
 *
 * Policy: reuse the downloaded copy while its stamp is under STALE_DAYS old,
 * otherwise fetch the current Stable build from
 * https://googlechromelabs.github.io/chrome-for-testing/last-known-good-versions.json
 * and re-download. A failed refresh falls back to the existing copy (if any).
 */

import { spawnSync } from "node:child_process";
import { createWriteStream, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { finished } from "node:stream/promises";
import { Readable } from "node:stream";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const CFT_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", ".chrome-for-testing");

/** Re-download when the local copy is older than this (days). */
export const CFT_STALE_DAYS = 30;

const LAST_KNOWN_GOOD_URL =
  "https://googlechromelabs.github.io/chrome-for-testing/last-known-good-versions.json";

export type ChromeForTesting = {
  executablePath: string;
  version: string;
  /** True when (re-)downloaded during this call. */
  downloaded: boolean;
};

/** Map node platform/arch onto a Chrome-for-Testing platform id. */
function cftPlatform(): string {
  if (process.platform === "win32") return "win64";
  if (process.platform === "darwin" && process.arch === "arm64") return "mac-arm64";
  if (process.platform === "darwin" && process.arch === "x64") return "mac-x64";
  if (process.platform === "linux" && process.arch === "x64") return "linux64";
  if (process.platform === "linux" && process.arch === "arm64") return "linux-arm64";
  throw new Error(
    `Chrome for Testing has no build for ${process.platform}/${process.arch} ` +
      `(see https://googlechromelabs.github.io/chrome-for-testing/).`,
  );
}

function resolveExe(dir: string): string {
  // Zips contain one top-level chrome-<platform>/ folder; locate it instead
  // of hardcoding the name so future renames don't break us.
  const inner = readdirSync(dir).find((e) => e.startsWith("chrome-"));
  const cands =
    process.platform === "win32"
      ? [join(dir, inner ?? "", "chrome.exe")]
      : process.platform === "darwin"
        ? [join(dir, inner ?? "", "Google Chrome for Testing.app", "Contents", "MacOS", "Google Chrome for Testing")]
        : [join(dir, inner ?? "", "chrome")];
  const hit = cands.find((p) => existsSync(p));
  if (!hit) throw new Error(`Browser binary not found under ${dir}`);
  return hit;
}

type Stamp = { version: string; downloadedAt: string };

function readStamp(dir: string): Stamp | null {
  try {
    return JSON.parse(readFileSync(join(dir, "STAMP.json"), "utf8")) as Stamp;
  } catch {
    return null;
  }
}

function stampAgeDays(stamp: Stamp | null): number {
  if (!stamp) return Infinity;
  const t = Date.parse(stamp.downloadedAt);
  if (Number.isNaN(t)) return Infinity;
  return (Date.now() - t) / 86_400_000;
}

function assertUnzipPresent(): void {
  const r = spawnSync("unzip", ["-v"], { stdio: "ignore" });
  if ((r as { error?: { code?: string } }).error?.code === "ENOENT") {
    throw new Error(
      "Need the `unzip` tool to unpack Chrome for Testing " +
        "(ships with macOS and Git Bash; on Debian/Ubuntu: apt install unzip).",
    );
  }
  if (r.status !== 0) throw new Error("`unzip -v` failed — is unzip installed?");
}

async function fetchStableChromeUrl(platform: string): Promise<{ version: string; url: string }> {
  const res = await fetch(LAST_KNOWN_GOOD_URL, { signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`CfT version feed HTTP ${res.status}: ${LAST_KNOWN_GOOD_URL}`);
  const data = (await res.json()) as {
    channels?: { Stable?: { version?: string } };
  };
  const version = data.channels?.Stable?.version;
  if (!version) throw new Error("CfT version feed has no Stable version.");
  // Documented CfT URL scheme (the feed no longer embeds download links):
  // https://googlechromelabs.github.io/chrome-for-testing/
  return {
    version,
    url: `https://storage.googleapis.com/chrome-for-testing-public/${version}/${platform}/chrome-${platform}.zip`,
  };
}

async function downloadFile(url: string, dest: string): Promise<void> {
  const res = await fetch(url);
  if (!res.ok || !res.body) throw new Error(`Download HTTP ${res.status}: ${url}`);
  mkdirSync(dirname(dest), { recursive: true });
  await finished(Readable.fromWeb(res.body as import("node:stream/web").ReadableStream).pipe(createWriteStream(dest)));
}

function unpackZip(zipPath: string, destDir: string): void {
  const r = spawnSync("unzip", ["-q", "-o", zipPath, "-d", destDir], { stdio: "inherit" });
  if (r.status !== 0) throw new Error(`unzip failed for ${zipPath}`);
}

/**
 * Return a ready Chrome-for-Testing binary, downloading Stable when the local
 * copy is missing or older than CFT_STALE_DAYS.
 */
export async function ensureChromeForTesting(
  log: (msg: string) => void = console.log,
): Promise<ChromeForTesting> {
  const platform = cftPlatform();
  const dir = join(CFT_ROOT, platform);

  const currentExe = existsSync(dir) ? (() => { try { return resolveExe(dir); } catch { return null; } })() : null;

  const reuse = (exePath: string, version: string, why: string): ChromeForTesting => {
    log(`Chrome for Testing ${version} (${why}): ${exePath}`);
    return { executablePath: exePath, version, downloaded: false };
  };

  const stamp = readStamp(dir);
  if (currentExe && stamp && stampAgeDays(stamp) <= CFT_STALE_DAYS) {
    return reuse(currentExe, stamp.version, "cached");
  }

  try {
    assertUnzipPresent();
    log(`Fetching current Stable Chrome for Testing (${platform})…`);
    const { version, url } = await fetchStableChromeUrl(platform);
    if (currentExe && stamp?.version === version) {
      // Same version, stale stamp: refresh in place so the next run is cheap.
      writeFileSync(join(dir, "STAMP.json"), JSON.stringify({ version, downloadedAt: new Date().toISOString() }));
      return reuse(currentExe, version, "stamp refreshed");
    }
    log(`Downloading Chrome for Testing ${version} (~150 MB)…`);
    const zipPath = join(tmpdir(), `chrome-for-testing-${platform}.zip`);
    await downloadFile(url, zipPath);
    try {
      rmSync(dir, { recursive: true, force: true });
      mkdirSync(dir, { recursive: true });
      unpackZip(zipPath, dir);
    } finally {
      rmSync(zipPath, { force: true });
    }
    const exe = resolveExe(dir);
    if (process.platform !== "win32") chmodSync(exe, 0o755);
    writeFileSync(join(dir, "STAMP.json"), JSON.stringify({ version, downloadedAt: new Date().toISOString() }));
    log(`Chrome for Testing ${version}: ${exe}`);
    return { executablePath: exe, version, downloaded: true };
  } catch (err) {
    if (currentExe) {
      log(`CfT refresh failed (${err instanceof Error ? err.message : err}) — reusing existing copy.`);
      return { executablePath: currentExe, version: stamp?.version ?? "unknown", downloaded: false };
    }
    throw err;
  }
}

const invokedAsMain =
  process.argv[1] != null && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedAsMain) {
  ensureChromeForTesting().catch((err) => {
    console.error(err instanceof Error ? err.stack || err.message : err);
    process.exitCode = 1;
  });
}
