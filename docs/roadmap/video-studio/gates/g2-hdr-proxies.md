# G2: HDR ingest and SDR proxies on the target Mac

**Gate:** [#98](https://github.com/mk-global/creatorbrio/issues/98).
**Campaign:** [#135](https://github.com/mk-global/creatorbrio/issues/135).
**Measured:** 2026-11-06 on the founder's MacBook Pro (M5 Max), macOS 27.2, FFmpeg 9.0.2.

## Result

**CONDITIONAL.**
The conversion path works on this Mac with synthetic HDR signals.
Tone-mapping quality, Dolby Vision metadata and variable frame rate need real iPhone footage, which was not available.

## What was measured

- This FFmpeg build has neither `zscale` (zimg) nor `libplacebo`, so the usual software tone-mapping chain is unavailable.
- It does have VideoToolbox decode and the `scale_vt` filter, which converts colour primaries, transfer and matrix in hardware.
- A 10-bit HEVC Main 10 clip tagged BT.2020 with HLG (`arib-std-b67`), and one with PQ (`smpte2084`), were each converted to an H.264 proxy with `scale_vt` and `h264_videotoolbox`.
- Both proxies came out as `yuv420p` tagged `tv,bt709,bt709,bt709`, with decode, conversion and encode all on VideoToolbox.
- The pixels changed in the direction a transfer conversion predicts (HLG yellows warm, PQ colours expand), so the conversion is real, not a relabel.

## What this does not establish

- Whether the tone mapping looks right on real HDR footage: the synthetic signals were not graded as HDR.
- Handling of iPhone Dolby Vision profile 8.4 (an HLG base layer with RPU metadata).
- Variable frame rate iPhone clips, rotation metadata and spatial audio.
- Creator acceptance of colour.

## Consequences for the slice

These are requirements on work not yet built:

- Media import (WS2 [#79](https://github.com/mk-global/creatorbrio/issues/79)) is to probe transfer and primaries, and make SDR BT.709 proxies of HLG and PQ sources through `scale_vt`, of everything else through the software scaler.
- The final render (WS4 [#81](https://github.com/mk-global/creatorbrio/issues/81)) is to convert HDR originals the same way before compositing, so preview and export agree.
- An HDR clip is to be marked as converted in its media record, so the Studio can say so until G2 passes on real footage.

## Reproduce

`scripts/gates/g2/hdr-proxy.sh <outDir>` writes both synthetic sources and proxies and prints their colour tags.
