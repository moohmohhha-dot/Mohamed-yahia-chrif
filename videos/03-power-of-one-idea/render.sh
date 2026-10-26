#!/usr/bin/env bash
# Builds output/final.mp4 (1080x1920, 30fps, 60s) for "The Power of One Small Idea".
#   1. cutout.py  - cuts the four characters out of refs/*.jpg into assets/*.png (skipped if present)
#   2. audio.py   - music, sound effects and any dialogue in audio/lines/ -> output/mix.wav,
#                   mouth envelopes -> output/lipsync.json, captions -> output/captions.srt
#   3. record.js  - renders scene.html frame by frame -> output/frames.mp4
#   4. ffmpeg     - muxes picture and sound
set -euo pipefail
cd "$(dirname "$0")"
mkdir -p output

for c in boy young_man delivery elder; do
  [[ -f "assets/$c.png" ]] || { python3 cutout.py boy young_man delivery elder; break; }
done
python3 audio.py
node record.js
ffmpeg -v error -y -i output/frames.mp4 -i output/mix.wav -map 0:v -map 1:a \
  -c:v copy -c:a aac -b:a 192k -movflags +faststart -shortest output/final.mp4
echo "Done: $(pwd)/output/final.mp4"
