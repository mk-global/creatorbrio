# G7 timeline spike

Gate harness for [G7 #103](https://github.com/mk-global/creatorbrio/issues/103), not product code.
Results are in [docs/roadmap/video-studio/gates/g7-timeline.md](../../../docs/roadmap/video-studio/gates/g7-timeline.md).

1. `npm install --no-save @xzdarcy/react-timeline-editor@1.0.0`.
2. Copy `timeline-spike.page.tsx.example` to `src/app/spike-g7/page.tsx` (never commit it).
3. `npx next dev -H 127.0.0.1 -p 3137`.
4. `node scripts/gates/g7/drive.mjs` for gestures, undo, accessibility and long tasks; `node scripts/gates/g7/drag-precision.mjs` for drag precision (`?snap` turns grid snapping on).
5. Remove `src/app/spike-g7/` and run `npm ci` to drop the unsaved package.

The committed page has snap lines off; the run that showed snapping to caption-word edges had them on.
