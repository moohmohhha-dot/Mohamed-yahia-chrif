---
name: depth-ui-reel
description: Turn a landscape (16:9) or any video into a 1080x1920 vertical "depth UI" reel for Reels/Shorts/TikTok, with a blurred drifting parallax background, the sharp footage as a rounded glass card with shadow, a glass title pill, a caption, a handle and an accent progress bar. Arabic text is shaped correctly. Use when the user runs /depth-ui-reel, uploads a horizontal video and wants it as a reel/short, or asks for a vertical version with a layered/depth/glass look.
---

# Depth UI reel

Wraps any video in a layered vertical frame so landscape footage fills a 9:16 screen without
cropping the action:

1. **Back**: the same footage, blurred, darkened, vignetted, slowly drifting (the parallax that sells the depth).
2. **Mid**: soft drop shadow plus a thin translucent rim.
3. **Front**: the sharp footage as a rounded card (1000px wide, scaled down for tall sources).
4. **UI**: glass title pill above the card, accent caption below it, handle at the bottom, accent
   progress bar along the bottom edge. Text is rendered with libass, so Arabic joins and runs RTL.

Audio is kept and faded out with the picture.

## Steps

1. **Probe the input**: `ffprobe -v error -show_entries format=duration:stream=codec_type,width,height -of compact INPUT`.
2. **Look at it before writing text**: build a contact sheet and read it, so the title and caption
   match the content:
   `ffmpeg -v error -y -i INPUT -vf "fps=1/6,scale=480:-1,tile=4x4" -frames:v 1 SCRATCH/contact.png`
   (raise the `fps` divisor for long videos so the grid covers the whole runtime).
3. **Pick the text**. This repo's audience is Arabic-speaking (ARUMA MARK / MB Parfum), so default
   to Arabic title and caption unless the user says otherwise. Keep the title to 2-4 words
   (it sits in one pill) and the caption to one short line, ideally a hook question. Ask the user
   for the handle if it is not obvious; omit `--handle` rather than inventing one.
4. **Render an 8s preview first**, then check one frame:
   ```bash
   .claude/skills/depth-ui-reel/scripts/depth_reel.sh INPUT SCRATCH/preview.mp4 \
     --title "..." --caption "..." --handle "@..." --start 5 --duration 8
   ffmpeg -v error -y -ss 3 -i SCRATCH/preview.mp4 -frames:v 1 SCRATCH/frame.png
   ```
   Read `frame.png`. Check that the text doesn't overlap the card, that Arabic letters are joined,
   and that the card isn't clipped.
5. **Render the full reel** (drop `--start`/`--duration`). It runs at about 0.7x realtime on 4
   cores, so run long videos in the background.
6. **Deliver** the MP4 to the user (SendUserFile). Rendered videos are not committed: `videos/*/output/`
   is gitignored. If the reel belongs to a project under `videos/NN-name/`, write the output to that
   folder's `output/`.

## Options

| Flag | Default | Meaning |
|---|---|---|
| `--title T` | none | Text in the glass pill above the card |
| `--caption T` | none | Line under the card, in the accent colour |
| `--handle T` | none | Small text near the bottom |
| `--accent RRGGBB` | `FFE500` | Caption and progress-bar colour (same yellow as Short 01's subtitles) |
| `--start S` | `0` | Start offset in seconds |
| `--duration S` | to the end | Length to render |

To change the layout (card width, corner radius, text positions, drift speed), edit the variables
at the top of `scripts/depth_reel.sh` and the `crop` expression in the background chain. Requires
ffmpeg with libass and the DejaVu Sans font (both present in the cloud container).
