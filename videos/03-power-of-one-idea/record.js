// Renders scene.html frame by frame into output/frames.mp4 (1080x1920, 30fps, 60s).
//   node record.js                -> full video
//   node record.js --stills 3,12  -> output/still_3.png, output/still_12.png for quick checks
const { chromium } = require("playwright");
const { spawn } = require("child_process");
const path = require("path");
const fs = require("fs");

const dir = __dirname;
const out = path.join(dir, "output");
fs.mkdirSync(out, { recursive: true });
const timeline = JSON.parse(fs.readFileSync(path.join(dir, "timeline.json"), "utf8"));
const lipsyncFile = path.join(out, "lipsync.json");
const lipsync = fs.existsSync(lipsyncFile) ? JSON.parse(fs.readFileSync(lipsyncFile, "utf8")) : null;

(async () => {
  const browser = await chromium.launch({ args: ["--allow-file-access-from-files"] });
  const page = await browser.newPage({ viewport: { width: 1080, height: 1920 } });
  await page.addInitScript(([tl, ls]) => { window.TIMELINE = tl; window.LIPSYNC = ls; }, [timeline, lipsync]);
  page.on("pageerror", e => { console.error("page error:", e.message); process.exitCode = 1; });
  await page.goto("file://" + path.join(dir, "scene.html"));
  await page.evaluate(() => window.ready);

  const stillsArg = process.argv.indexOf("--stills");
  if (stillsArg > 0) {
    for (const t of process.argv[stillsArg + 1].split(",").map(Number)) {
      await page.evaluate(t => window.render(t), t);
      await page.locator("canvas").screenshot({ path: path.join(out, `still_${t}.png`) });
    }
    await browser.close();
    return;
  }

  const frames = Math.round(timeline.duration * timeline.fps);
  const ff = spawn("ffmpeg", ["-v", "error", "-y", "-f", "image2pipe", "-framerate", String(timeline.fps), "-i", "-",
    "-c:v", "libx264", "-preset", "medium", "-crf", "17", "-pix_fmt", "yuv420p", path.join(out, "frames.mp4")],
    { stdio: ["pipe", "inherit", "inherit"] });
  for (let i = 0; i < frames; i++) {
    // toDataURL is much faster than a page screenshot for a single canvas.
    const b64 = await page.evaluate(t => { window.render(t); return document.getElementById("c").toDataURL("image/jpeg", .93).slice(23); }, i / timeline.fps);
    if (!ff.stdin.write(Buffer.from(b64, "base64"))) await new Promise(r => ff.stdin.once("drain", r));
    if (i % 300 === 0) console.log(`frame ${i}/${frames}`);
  }
  ff.stdin.end();
  await new Promise(r => ff.on("close", r));
  await browser.close();
  console.log(`Rendered ${frames} frames`);
})();
