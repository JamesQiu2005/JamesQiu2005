#!/usr/bin/env node
// Redraws assets/release-downloads-{light,dark}.svg: downloads of each SpektraLab
// release, from the GitHub API, drawn with chart.xkcd so it matches the
// star-history chart beside it in the README. GitHub keeps only each release's
// running count, not a history, so the chart is a snapshot dated in its title.
//
//     node tools/release-downloads.mjs
//
// Needs Node 22+, network access to api.github.com and cdn.jsdelivr.net, and a
// Chromium binary (set CHROME if the default below is missing). GITHUB_TOKEN is
// optional and only raises the API rate limit.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = "JamesQiu2005/SpektraLab";
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CHROME =
  process.env.CHROME ||
  join(homedir(), "Library/Caches/ms-playwright/chromium_headless_shell-1223/chrome-headless-shell-mac-arm64/chrome-headless-shell");
// Fetched here and inlined into the page (headless Chrome may not reach the CDN itself),
// and refused unless it is byte-for-byte the release this script was written against.
const LIB = "https://cdn.jsdelivr.net/npm/chart.xkcd@2.0.12/dist/chart.xkcd.min.js";
const LIB_SHA384 = "VCpo58LOJanLwWG+GO/+FtIEB8N6Wh9+FjGxpbnPmzZcrJuS3pbgzcBnlVNOBO1P";
// The colours star-history.com uses for its light and dark charts; the grey is the reference series.
const THEMES = {
  light: { backgroundColor: "#fff", strokeColor: "#000", dataColors: ["#dd4528", "#949494"] },
  dark: { backgroundColor: "#0d1117", strokeColor: "#fff", dataColors: ["#ff6b6b", "#8b949e"] },
};

const headers = { accept: "application/vnd.github+json" };
if (process.env.GITHUB_TOKEN) headers.authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
const res = await fetch(`https://api.github.com/repos/${REPO}/releases?per_page=100`, { headers });
if (!res.ok) throw new Error(`GitHub API answered ${res.status}`);
const releases = (await res.json())
  .filter((r) => !r.draft)
  .sort((a, b) => a.published_at.localeCompare(b.published_at))
  .map((r) => ({ version: r.tag_name.replace(/^spektralab-v/, ""), downloads: r.assets.reduce((n, a) => n + a.download_count, 0) }));
let total = 0;
const running = releases.map((r) => (total += r.downloads));
const date = new Date().toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "Asia/Shanghai" });

const lib = await (await fetch(LIB)).text();
if (createHash("sha384").update(lib).digest("base64") !== LIB_SHA384) throw new Error(`${LIB} does not match the pinned hash`);

const dir = mkdtempSync(join(tmpdir(), "release-downloads-"));
try {
  for (const [name, theme] of Object.entries(THEMES)) {
    const config = {
      title: `Release Downloads (${date})`,
      xLabel: "Version",
      yLabel: "Downloads",
      data: {
        labels: releases.map((r) => r.version),
        datasets: [
          { label: "running total", data: running },
          { label: "per release", data: releases.map((r) => r.downloads) },
        ],
      },
      options: { yTickCount: 4, ...theme },
    };
    const page = join(dir, `${name}.html`);
    writeFileSync(
      page,
      `<!doctype html><meta charset="utf-8"><body style="margin:0"><div style="width:800px"><svg id="chart"></svg></div>
<script>${lib.replaceAll("</script", "<\\/script")}</script>
<script>
  const config = ${JSON.stringify(config)};
  config.options.legendPosition = chartXkcd.config.positionType.upLeft;
  new chartXkcd.Line(document.getElementById("chart"), config);
</script>`,
    );
    const dom = execFileSync(
      CHROME,
      ["--headless", "--disable-gpu", "--dump-dom", "--virtual-time-budget=10000", `--user-data-dir=${join(dir, "profile")}`, `file://${page}`],
      { encoding: "utf8", maxBuffer: 64 << 20, stdio: ["ignore", "pipe", "ignore"] },
    );
    const svg = dom.match(/<svg id="chart"[\s\S]*<\/svg>/)?.[0];
    const [w, h] = ["width", "height"].map((a) => svg?.match(new RegExp(`^<svg[^>]* ${a}="([\\d.]+)"`))?.[1]);
    if (!w || !h) throw new Error(`chart.xkcd drew nothing for the ${name} chart`);
    // A viewBox so the chart scales with the README column instead of keeping its pixel size.
    const out = svg.replace('<svg id="chart"', `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}"`);
    writeFileSync(join(ROOT, "assets", `release-downloads-${name}.svg`), out + "\n");
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}
console.log(`${releases.length} releases, ${total} downloads, ${date}`);
