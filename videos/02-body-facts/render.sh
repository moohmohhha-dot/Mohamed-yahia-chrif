#!/usr/bin/env bash
# Builds output/final.mp4 (1080x1920, 41s): records scene.html frame by frame, then adds
# a synthesized ambient pad with a whoosh on every scene change. If audio/voice.mp3 exists
# it is mixed on top and the music is ducked under it.
set -euo pipefail
cd "$(dirname "$0")"
mkdir -p output

node record.js
dur=41

# Scene starts (intro 4.5s, six 5.5s facts, outro 3.5s).
starts=(0 4.5 10 15.5 21 26.5 32 37.5)
whoosh=""
for s in "${starts[@]}"; do
  ms=$(awk -v s="$s" 'BEGIN{printf "%d", s*1000}')
  whoosh+="anoisesrc=d=0.5:c=pink:a=0.5,highpass=f=600,afade=t=in:d=0.15,afade=t=out:st=0.15:d=0.35,adelay=${ms}|${ms}[w$s];"
done
wmix=$(printf "[w%s]" "${starts[@]}")

# A minor pad (A2, E3, A3, C4) with slow tremolo, plus a soft 100 bpm kick.
pad="sine=f=110:d=$dur[p1];sine=f=164.81:d=$dur[p2];sine=f=220:d=$dur[p3];sine=f=261.63:d=$dur[p4];"
pad+="[p1][p2][p3][p4]amix=inputs=4,tremolo=f=0.25:d=0.5,lowpass=f=900,volume=0.9[pad];"
kick="aevalsrc='0.8*sin(2*PI*55*t)*exp(-18*mod(t\,0.6))':d=$dur:s=44100[kick];"

filter="${pad}${kick}${whoosh}${wmix}amix=inputs=${#starts[@]}:normalize=0,volume=0.35[wh];"
filter+="[pad][kick]amix=inputs=2:normalize=0,afade=t=in:d=1,afade=t=out:st=$((dur-2)):d=2,volume=0.5[music];"

if [[ -f audio/voice.mp3 ]]; then
  filter+="[1:a]volume=1.3,asplit[v1][v2];[music][v1]sidechaincompress=threshold=0.05:ratio=8[duck];"
  filter+="[duck][wh][v2]amix=inputs=3:normalize=0[a]"
  ffmpeg -v error -y -i output/frames.mp4 -i audio/voice.mp3 -filter_complex "$filter" \
    -map 0:v -map "[a]" -c:v copy -c:a aac -b:a 192k -t $dur output/final.mp4
else
  filter+="[music][wh]amix=inputs=2:normalize=0[a]"
  ffmpeg -v error -y -i output/frames.mp4 -filter_complex "$filter" \
    -map 0:v -map "[a]" -c:v copy -c:a aac -b:a 192k -t $dur output/final.mp4
fi
echo "Done: $(pwd)/output/final.mp4"
