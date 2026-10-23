#!/usr/bin/env bash
# Builds output/final.mp4 (1080x1920) from clips/01.mp4..10.mp4, audio/voice.mp3,
# optional audio/music.mp3, and burns in the EN + AR subtitles.
# Missing clips are replaced with dark placeholder cards so the cut can be previewed early.
set -euo pipefail
cd "$(dirname "$0")"
mkdir -p output/tmp

durations=(4 4 4 4 4 4 5 5 5 4)
: > output/tmp/list.txt
for i in $(seq 1 10); do
  n=$(printf "%02d" "$i")
  d=${durations[$((i-1))]}
  out="output/tmp/$n.mp4"
  if [[ -f "clips/$n.mp4" ]]; then
    ffmpeg -v error -y -i "clips/$n.mp4" -t "$d" \
      -vf "scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,fps=30,setsar=1" \
      -an -c:v libx264 -pix_fmt yuv420p "$out"
  else
    ffmpeg -v error -y -f lavfi -i "color=c=0x1c2430:s=1080x1920:r=30:d=$d" \
      -vf "drawtext=fontfile=/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf:text='SCENE $n':fontsize=80:fontcolor=white@0.35:x=(w-tw)/2:y=500" \
      -c:v libx264 -pix_fmt yuv420p "$out"
  fi
  echo "file '$n.mp4'" >> output/tmp/list.txt
done
ffmpeg -v error -y -f concat -safe 0 -i output/tmp/list.txt -c copy output/tmp/video.mp4

audio_in=()
filter="[0:v]ass=subtitles.ass[v]"
map_audio=()
if [[ -f audio/voice.mp3 && -f audio/music.mp3 ]]; then
  audio_in=(-i audio/voice.mp3 -i audio/music.mp3)
  filter+=";[2:a]volume=0.18[m];[1:a][m]amix=inputs=2:duration=first[a]"
  map_audio=(-map "[a]")
elif [[ -f audio/voice.mp3 ]]; then
  audio_in=(-i audio/voice.mp3)
  map_audio=(-map 1:a)
fi

ffmpeg -v error -y -i output/tmp/video.mp4 "${audio_in[@]}" \
  -filter_complex "$filter" -map "[v]" "${map_audio[@]}" \
  -c:v libx264 -crf 20 -pix_fmt yuv420p -c:a aac -shortest output/final.mp4
echo "Done: $(pwd)/output/final.mp4"
