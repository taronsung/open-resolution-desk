// edit.mjs - turns a capture (raw.webm + timeline.json from capture.mjs) into the
// silent demo video: an address strip above the page, so viewers can see which
// site is on screen, and faster typing and model waits. Writes demo.mp4 and
// demo-timeline.json (every mark at its time in the edited video).
//
// Usage: node tools/video/edit.mjs <captureDir> [--out file.mp4] [--target seconds]
// Needs ffmpeg with libx264 and Playwright's Chromium (to draw the strips).
import { chromium } from "playwright";
import { execFileSync } from "node:child_process";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";

const args = process.argv.slice(2);
const dir = path.resolve(args.find((a) => !a.startsWith("--")) || "video-out");
const out = path.resolve(args.includes("--out") ? args[args.indexOf("--out") + 1] : path.join(dir, "demo.mp4"));
const timeline = JSON.parse(await readFile(path.join(dir, "timeline.json"), "utf8"));
// The capture is scaled by 1.5 (1280 x 680 to 1920 x 1020) under a 60-pixel strip: 1920 x 1080.
const SCALE = 1.5;
const FW = Math.round(timeline.frame.width * SCALE);
const FH = Math.round(timeline.frame.height * SCALE);
const BAR = 60;
const strips = path.join(dir, "strips");
await mkdir(strips, { recursive: true });

// ---------------------------------------------------------------- strips
function describe(url) {
  const u = new URL(url);
  let shown = `${u.host}${u.pathname}`;
  if (u.hash) {
    const [key, value = ""] = u.hash.slice(1).split("=");
    shown += `#${key}=${value.slice(0, 10)}…`;
  }
  let site = "";
  if (u.host === "taronsung.github.io") site = u.pathname.includes("/spec-checks/") ? "Open Resolution Desk: specification checks" : "Open Resolution Desk";
  else if (u.pathname.includes("backoffice")) site = "Brackenlight Home (fictional shop): case page";
  else if (u.pathname.startsWith("/brackenlight")) site = "Brackenlight Home (fictional shop)";
  else if (u.pathname.startsWith("/coppice")) site = "Coppice Cycles (fictional shop)";
  return { shown, site, secure: u.protocol === "https:" };
}
const segments = timeline.addresses
  .filter((a) => /^https?:/.test(a.url))
  .map((a, i, list) => ({ start: i === 0 ? 0 : a.t, end: list[i + 1]?.t ?? 1e6, ...describe(a.url) }));
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: FW, height: BAR } });
for (const [i, seg] of segments.entries()) {
  seg.png = path.join(strips, `strip-${i}.png`);
  await page.setContent(`<!doctype html><html><head><style>
    html,body{margin:0;width:${FW}px;height:${BAR}px;background:#E4E6EB;font-family:-apple-system,"Segoe UI",system-ui,sans-serif}
    .bar{display:flex;align-items:center;gap:18px;height:${BAR}px;padding:0 24px;box-sizing:border-box;border-bottom:1px solid #C9CDD5}
    .field{flex:1;display:flex;align-items:center;gap:12px;height:40px;padding:0 18px;border-radius:20px;background:#fff;color:#1C2230;font-size:22px;white-space:nowrap;overflow:hidden}
    .lock{width:14px;height:18px;flex:none}
    .site{flex:none;color:#3A4152;font-size:20px;font-weight:600}
  </style></head><body><div class="bar"><div class="field">${seg.secure ? '<svg class="lock" viewBox="0 0 14 18"><rect x="1" y="8" width="12" height="9" rx="2" fill="#5B6273"/><path d="M4 8V5.5a3 3 0 0 1 6 0V8" fill="none" stroke="#5B6273" stroke-width="2"/></svg>' : ""}<span>${seg.shown.replace(/&/g, "&amp;").replace(/</g, "&lt;")}</span></div><div class="site">${seg.site}</div></div></body></html>`);
  await page.screenshot({ path: seg.png });
}
await browser.close();

// ------------------------------------------------------------- speed plan
// Typing and model waits run faster; reading time, consent cards and dialogs run at 1x.
const mt = (label) => timeline.marks.find((m) => m.label === label)?.t;
const end = mt("end") + 0.6;
// The speed of the part that starts at a mark.
const rule = (label) => {
  if (/:type$/.test(label)) return 2.6; // typing
  if (/:sent$/.test(label)) return 1.8; // waiting for the model and the reply streaming in
  if (/:allowed$/.test(label)) return 1.6; // the peer network loads and runs
  if (/:confirmed$/.test(label) && !label.startsWith("office")) return 1.5;
  return 1;
};
// A slow model call should not stretch the video: waiting parts have a ceiling.
// The clause question gets a little longer, so the "Terms Analyst is working" line can be read.
const ceiling = (label) => (label === "desk0:sent" ? 3.4 : /:sent$/.test(label) ? 2.6 : /:allowed$/.test(label) ? 3.2 : /:confirmed$/.test(label) && !label.startsWith("office") ? 2 : Infinity);
const points = [{ t: 0.4, label: "start" }, ...timeline.marks.filter((m) => m.t > 0.4 && m.label !== "end")];
const parts = points.map((p, i) => {
  const a = p.t;
  const b = points[i + 1]?.t ?? end;
  return { a, b, speed: Math.max(rule(p.label), (b - a) / ceiling(p.label)), from: p.label };
}).filter((p) => p.b - p.a > 0.05);
// Fit the whole into the target length by running the 1x parts slightly faster (at most 1.2x).
const TARGET = Number(args.includes("--target") ? args[args.indexOf("--target") + 1] : 106);
const length = () => parts.reduce((sum, p) => sum + (p.b - p.a) / p.speed, 0);
const plain = parts.filter((p) => p.speed === 1);
const plainLength = plain.reduce((sum, p) => sum + (p.b - p.a), 0);
const excess = length() - TARGET;
if (excess > 0 && plainLength > excess) {
  const factor = Math.min(1.2, plainLength / (plainLength - excess));
  for (const p of plain) p.speed = Number(factor.toFixed(3));
}
const editedAt = (t) => parts.reduce((sum, p) => sum + Math.min(Math.max(t - p.a, 0), p.b - p.a) / p.speed, 0);

// ---------------------------------------------------------------- ffmpeg
const inputs = ["-i", timeline.video, ...segments.flatMap((s) => ["-i", s.png])];
let graph = `[0:v]scale=${FW}:${FH}:flags=lanczos,pad=${FW}:${FH + BAR}:0:${BAR}:color=0xE4E6EB[b0];`;
segments.forEach((s, i) => {
  graph += `[b${i}][${i + 1}:v]overlay=0:0:enable='between(t,${s.start.toFixed(2)},${Math.min(s.end, end).toFixed(2)})'[b${i + 1}];`;
});
graph += `[b${segments.length}]split=${parts.length}${parts.map((_, i) => `[p${i}]`).join("")};`;
parts.forEach((p, i) => {
  graph += `[p${i}]trim=start=${p.a.toFixed(3)}:end=${p.b.toFixed(3)},setpts=(PTS-STARTPTS)/${p.speed}[s${i}];`;
});
graph += `${parts.map((_, i) => `[s${i}]`).join("")}concat=n=${parts.length}:v=1:a=0,fps=30,format=yuv420p[v]`;
execFileSync("ffmpeg", ["-v", "error", "-y", ...inputs, "-filter_complex", graph, "-map", "[v]", "-c:v", "libx264", "-preset", "slow", "-crf", "18", "-movflags", "+faststart", out], { stdio: "inherit" });

const duration = Number(execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", out], { encoding: "utf8" }).trim());
const editedMarks = timeline.marks.map((m) => ({ t: Number(editedAt(m.t).toFixed(1)), raw: Number(m.t.toFixed(1)), label: m.label }));
const editedAddresses = segments.map((s) => ({ t: Number(editedAt(s.start).toFixed(1)), shown: s.shown, site: s.site }));
await writeFile(path.join(dir, "demo-timeline.json"), JSON.stringify({ video: out, duration, size: { width: FW, height: FH + BAR }, marks: editedMarks, addresses: editedAddresses, replies: timeline.replies, parts }, null, 2));
console.log(`${out}: ${duration.toFixed(1)} s`);
for (const m of editedMarks) console.log(`${m.t.toFixed(1).padStart(6)}  ${m.label}`);
