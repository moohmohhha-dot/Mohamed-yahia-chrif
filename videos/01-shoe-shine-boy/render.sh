#!/usr/bin/env bash
# Builds output/final.mp4 (1080x1920) from clips/01.mp4..06.mp4, the voice lines in
# audio/ placed at fixed offsets, optional audio/music.mp3, and burns in the Arabic subtitles.
# Missing clips are replaced with dark placeholder cards so the cut can be previewed early.
set -euo pipefail
cd "$(dirname "$0")"
mkdir -p output/tmp

# Scene lengths in seconds (scene 1 is the 4s Seedance clip, scene 5 is a 10s Kling clip).
durations=(4.04 5 5 5 10 5)
# Voice line file and its start time on the timeline.
voices=(
  "l01_grant.mp3 0.2"
  "l03_narrator.mp3 4.4"
  "l05_narrator.mp3 9.3"
  "l06_assistant.mp3 14.3"
  "l07_grant.mp3 19.1"
  "l08_sam.mp3 20.9"
  "l09_sam.mp3 24.4"
  "l10_narrator.mp3 30.0"
)

: > output/tmp/list.txt
for i in "${!durations[@]}"; do
  n=$(printf "%02d" "$((i+1))")
  d=${durations[$i]}
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

inputs=(-i output/tmp/video.mp4)
filter="[0:v]ass=subtitles.ass[v]"
mix=""
idx=1
for entry in "${voices[@]}"; do
  read -r file start <<< "$entry"
  [[ -f "audio/$file" ]] || continue
  inputs+=(-i "audio/$file")
  ms=$(awk -v s="$start" 'BEGIN{printf "%d", s*1000}')
  filter+=";[$idx:a]adelay=${ms}|${ms},volume=1.4[a$idx]"
  mix+="[a$idx]"
  idx=$((idx+1))
done
if [[ -f audio/music.mp3 ]]; then
  inputs+=(-i audio/music.mp3)
  filter+=";[$idx:a]volume=0.22,afade=t=out:st=32:d=2[a$idx]"
  mix+="[a$idx]"
  idx=$((idx+1))
fi

map_audio=()
if [[ -n "$mix" ]]; then
  n_audio=$(( $(grep -o '\[a' <<< "$mix" | wc -l) ))
  filter+=";${mix}amix=inputs=${n_audio}:normalize=0:duration=longest[a]"
  map_audio=(-map "[a]")
fi

ffmpeg -v error -y "${inputs[@]}" -filter_complex "$filter" -map "[v]" "${map_audio[@]}" \
  -c:v libx264 -crf 20 -pix_fmt yuv420p -c:a aac -b:a 192k -t 34.04 output/final.mp4
echo "Done: $(pwd)/output/final.mp4"
