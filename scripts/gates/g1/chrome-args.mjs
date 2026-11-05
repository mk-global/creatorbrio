// Pinned Chromium flags for overlay frames. With GPU rasterization, 2 of 7 full-length runs differed
// from the rest in 1-3 frames; with these flags 14 of 14 runs at 1, 4 and 8 workers were identical.
export const CHROME_ARGS = [
  "--disable-gpu", "--disable-gpu-rasterization", "--disable-gpu-compositing", "--force-color-profile=srgb",
  "--disable-lcd-text", "--font-render-hinting=none", "--disable-partial-raster",
];
