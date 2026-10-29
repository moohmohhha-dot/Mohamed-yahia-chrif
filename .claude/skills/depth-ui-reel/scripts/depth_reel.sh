#!/usr/bin/env bash
# Turns a landscape (or any) video into a 1080x1920 "depth UI" reel:
#   back  - the same footage, blurred, darkened and slowly drifting (parallax)
#   mid   - a soft drop shadow and a thin glass rim
#   front - the sharp footage as a rounded card
#   top   - glass title pill, caption, handle and an accent progress bar (ASS, so Arabic shapes correctly)
# Audio is kept as-is.
#
# Usage: depth_reel.sh INPUT OUTPUT [--title T] [--caption T] [--handle T]
#                      [--accent RRGGBB] [--start S] [--duration S]
set -euo pipefail

usage() { sed -n '2,11p' "$0" | sed 's/^# \{0,1\}//'; exit 1; }
[[ $# -ge 2 ]] || usage
in=$1 out=$2; shift 2
title="" caption="" handle="" accent="FFE500" start=0 dur=""
while [[ $# -gt 0 ]]; do
  case $1 in
    --title) title=$2 ;;
    --caption) caption=$2 ;;
    --handle) handle=$2 ;;
    --accent) accent=${2#\#} ;;
    --start) start=$2 ;;
    --duration) dur=$2 ;;
    *) usage ;;
  esac
  shift 2
done
[[ -f $in ]] || { echo "No such file: $in" >&2; exit 1; }

W=1080 H=1920
CW=1000          # card width
R=36             # card corner radius
src_w=$(ffprobe -v error -select_streams v:0 -show_entries stream=width -of csv=p=0 "$in")
src_h=$(ffprobe -v error -select_streams v:0 -show_entries stream=height -of csv=p=0 "$in")
CH=$(( (CW * src_h / src_w) / 2 * 2 ))
max_ch=1180      # keep tall sources from swallowing the title/caption space
if (( CH > max_ch )); then CH=$max_ch; CW=$(( (CH * src_w / src_h) / 2 * 2 )); fi
CX=$(( (W - CW) / 2 ))
CY=$(( (H - CH) / 2 - 40 ))

if [[ -z $dur ]]; then
  total=$(ffprobe -v error -show_entries format=duration -of csv=p=0 "$in")
  dur=$(awk -v t="$total" -v s="$start" 'BEGIN{printf "%.3f", t-s}')
fi

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

# Static layers, rendered once: rounded-rect alpha mask, glass rim and blurred shadow.
rr() { # rr WIDTH HEIGHT RADIUS -> geq expression, ~1px anti-aliased edge
  echo "clip(($3+0.5-hypot(max(max($3-X\,X-($1-1-$3))\,0)\,max(max($3-Y\,Y-($2-1-$3))\,0)))*255\,0\,255)"
}
ffmpeg -v error -y -f lavfi -i "color=black:s=${CW}x${CH}:d=1" -frames:v 1 \
  -vf "format=gray,geq=lum='$(rr $CW $CH $R)'" "$tmp/mask.png"
ffmpeg -v error -y -f lavfi -i "color=black:s=$((CW+6))x$((CH+6)):d=1" -frames:v 1 \
  -vf "format=rgba,geq=r=255:g=255:b=255:a='0.28*$(rr $((CW+6)) $((CH+6)) $((R+3)))'" "$tmp/rim.png"
pad=120
ffmpeg -v error -y -f lavfi -i "color=black:s=$((CW+2*pad))x$((CH+2*pad)):d=1" -frames:v 1 \
  -vf "format=rgba,geq=r=0:g=0:b=0:a='0.75*if(between(X\,$pad\,$((CW+pad-1)))*between(Y\,$pad\,$((CH+pad-1)))\,$(rr $CW $CH $R | sed "s/X/(X-$pad)/g; s/Y/(Y-$pad)/g")\,0)',gblur=sigma=34" \
  "$tmp/shadow.png"

# Text layer.
ass_time() { awk -v s="$1" 'BEGIN{h=int(s/3600); m=int((s%3600)/60); printf "%d:%02d:%05.2f", h, m, s-h*3600-m*60}'; }
bgr="${accent:4:2}${accent:2:2}${accent:0:2}"
end=$(ass_time "$dur")
{
  cat <<EOF
[Script Info]
ScriptType: v4.00+
PlayResX: $W
PlayResY: $H
WrapStyle: 0
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: PILL,DejaVu Sans,62,&H00FFFFFF,&H00FFFFFF,&H70FFFFFF,&H70FFFFFF,1,0,0,0,100,100,0,0,3,22,0,8,80,80,$(( CY - 190 )),1
Style: CAP,DejaVu Sans,54,&H00${bgr},&H00${bgr},&H00000000,&H90000000,1,0,0,0,100,100,0,0,1,4,3,8,80,80,$(( CY + CH + 70 )),1
Style: HANDLE,DejaVu Sans,40,&H40FFFFFF,&H40FFFFFF,&H00000000,&H00000000,1,0,0,0,100,100,0,0,1,0,2,2,80,80,120,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
EOF
  # Glass pill: translucent white box behind dark-shadowed white text.
  [[ -n $title ]] && echo "Dialogue: 0,0:00:00.00,$end,PILL,,0,0,0,,{\\fad(400,0)\\3a&HB8&\\4a&HB8&\\3c&HFFFFFF&}$title"
  [[ -n $caption ]] && echo "Dialogue: 0,0:00:00.30,$end,CAP,,0,0,0,,{\\fad(500,0)}$caption"
  [[ -n $handle ]] && echo "Dialogue: 0,0:00:00.00,$end,HANDLE,,0,0,0,,$handle"
} > "$tmp/ui.ass"

fade_out=$(awk -v d="$dur" 'BEGIN{printf "%.3f", (d>1.2)?d-0.6:0}')
filter="
[0:v]split=2[bgsrc][fgsrc];
[bgsrc]scale=360:640:force_original_aspect_ratio=increase,crop=360:640,gblur=sigma=10,
  scale=1300:2312,eq=brightness=-0.10:saturation=1.25,
  crop=$W:$H:x='(iw-ow)/2+sin(t/3.1)*90':y='(ih-oh)/2+cos(t/4.3)*160',vignette=PI/4,setsar=1[bg];
[fgsrc]scale=$CW:$CH:force_original_aspect_ratio=increase,crop=$CW:$CH,setsar=1,format=rgba[fgc];
[fgc][1:v]alphamerge[card];
[bg][3:v]overlay=$(( CX - pad )):$(( CY - pad + 34 ))[s1];
[s1][2:v]overlay=$(( CX - 3 )):$(( CY - 3 ))[s2];
[s2][card]overlay=$CX:$CY[s3];
[s3]ass='$tmp/ui.ass'[s4];
color=0x${accent}:s=${W}x10:r=30[bar];
[s4][bar]overlay=x='-w+w*t/$dur':y=$(( H - 10 )):shortest=1,
  fade=t=in:st=0:d=0.4,fade=t=out:st=$fade_out:d=0.6,fps=30,format=yuv420p[v]"

has_audio=$(ffprobe -v error -select_streams a -show_entries stream=index -of csv=p=0 "$in" | head -1)
amap=()
[[ -n $has_audio ]] && amap=(-map 0:a:0 -c:a aac -b:a 192k -af "afade=t=out:st=$fade_out:d=0.6")

mkdir -p "$(dirname "$out")"
ffmpeg -v error -stats -y -ss "$start" -t "$dur" -i "$in" \
  -i "$tmp/mask.png" -i "$tmp/rim.png" -i "$tmp/shadow.png" \
  -filter_complex "$filter" -map "[v]" "${amap[@]}" -t "$dur" \
  -c:v libx264 -preset medium -crf 20 -movflags +faststart "$out"
echo "Done: $out"
