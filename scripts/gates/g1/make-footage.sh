#!/usr/bin/env bash
# Synthetic, legally unencumbered G1 footage: testsrc2 colour bars with a full-frame white flash
# on the first frame of every source second and a one-frame 1 kHz beep at the same instant.
set -eu
OUT=$1; cd $OUT
ff() { "${FFMPEG:-ffmpeg}" -hide_banner -loglevel error -y "$@"; }
mk() { # name hue codec-args...
  local name=$1 hue=$2; shift 2
  ff -f lavfi -i "testsrc2=s=1080x1920:r=30:d=22,hue=h=$hue" \
     -f lavfi -i "color=white:s=1080x1920:r=30:d=22" \
     -f lavfi -i "sine=f=1000:sample_rate=48000:d=22" \
     -filter_complex "[0:v][1:v]overlay=enable='lt(mod(n,30),1)',scale=out_color_matrix=bt709:out_range=tv,setparams=color_primaries=bt709:color_trc=bt709:colorspace=bt709:range=tv[v];[2:a]volume=enable='gte(mod(t,1),1/30)':volume=0[a]" \
     -map "[v]" -map "[a]" "$@" -colorspace bt709 -color_primaries bt709 -color_trc bt709 -color_range tv -c:a aac -b:a 192k -ar 48000 -ac 2 $name
}
mk clipA.mp4 0   -c:v libx264 -pix_fmt yuv420p -preset veryfast -crf 18 -r 30 -g 30
mk clipB.mov 120 -c:v hevc_videotoolbox -tag:v hvc1 -b:v 12M -pix_fmt yuv420p -r 30 -g 30
mk clipC.mp4 240 -c:v libx264 -pix_fmt yuv420p -preset veryfast -crf 18 -r 30 -g 30
# Music bed: a quiet two-tone chord, 62 s.
ff -f lavfi -i "sine=f=220:sample_rate=48000:d=62" -f lavfi -i "sine=f=330:sample_rate=48000:d=62" \
   -filter_complex "[0:a][1:a]amix=inputs=2,volume=0.3[a]" -map "[a]" -c:a aac -b:a 192k -ac 2 music.m4a
for f in clipA.mp4 clipB.mov clipC.mp4 music.m4a; do
  "${FFPROBE:-ffprobe}" -v error -show_entries stream=codec_name,width,height,r_frame_rate,duration -of csv=p=0 $f | tr '\n' ' '; echo " $f"
done
shasum -a 256 *.mp4 *.mov *.m4a
