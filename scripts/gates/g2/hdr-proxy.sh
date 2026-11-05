#!/usr/bin/env bash
# G2 (partial): synthetic 10-bit HLG and PQ HEVC clips, converted to tagged BT.709 SDR H.264 proxies on
# VideoToolbox (scale_vt), the only HDR conversion path in an FFmpeg build without zscale or libplacebo.
# Synthetic signals prove the pipeline, not tone-mapping quality: real iPhone footage is still required.
# usage: scripts/gates/g2/hdr-proxy.sh <outDir>
set -eu
OUT=$1; mkdir -p "$OUT"; cd "$OUT"
FF="${FFMPEG:-ffmpeg}"; FP="${FFPROBE:-ffprobe}"
for trc in arib-std-b67 smpte2084; do
  "$FF" -hide_banner -loglevel error -y -f lavfi -i "testsrc2=s=1080x1920:r=30:d=5" -f lavfi -i "sine=f=1000:d=5:sample_rate=48000" \
    -vf "format=p010le,setparams=color_primaries=bt2020:color_trc=${trc}:colorspace=bt2020nc:range=tv" \
    -c:v hevc_videotoolbox -profile:v main10 -tag:v hvc1 -b:v 20M -c:a aac "hdr-${trc}.mov"
  "$FF" -hide_banner -loglevel error -y -hwaccel videotoolbox -hwaccel_output_format videotoolbox_vld -i "hdr-${trc}.mov" \
    -vf "scale_vt=w=540:h=960:color_matrix=bt709:color_primaries=bt709:color_transfer=bt709" \
    -c:v h264_videotoolbox -b:v 4M -c:a aac "proxy-${trc}.mp4"
  echo "${trc} source: $("$FP" -v error -select_streams v:0 -show_entries stream=profile,pix_fmt,color_range,color_space,color_transfer,color_primaries -of csv=p=0 "hdr-${trc}.mov")"
  echo "${trc} proxy:  $("$FP" -v error -select_streams v:0 -show_entries stream=codec_name,width,height,pix_fmt,color_range,color_space,color_transfer,color_primaries -of csv=p=0 "proxy-${trc}.mp4")"
done
