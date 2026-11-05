# G7: reusable timeline UI

**Gate:** [#103](https://github.com/mk-global/creatorbrio/issues/103).
**Campaign:** [#135](https://github.com/mk-global/creatorbrio/issues/135).
**Measured:** 2026-11-06 on the founder's MacBook Pro (M5 Max), macOS 27.2, Next.js 16.2.3, React 19.2.4, headless Chrome 146.

## Result

**CONDITIONAL PASS** for `@xzdarcy/react-timeline-editor` 1.0.0 as the interaction layer only.
CreatorBrio keeps the timeline semantics: every gesture becomes one change set through the Production API, and the widget never owns state.
The fallback is an owned component; the widget is about 3,200 lines of MIT code if a fork is needed.
`elah` was not evaluated in this run.

## Licence and dependencies

- `@xzdarcy/react-timeline-editor` 1.0.0: MIT; `@xzdarcy/timeline-engine` 1.0.0: ISC; last published 2026-01-25.
- Runtime dependencies: `interactjs` and `react-virtualized` 9.22.6.
- `react-virtualized` uses `findDOMNode` (removed in React 19) only in its own test files, not in the code the widget imports.

## What was measured

The spike page (`scripts/gates/g7/timeline-spike.page.tsx.example`) renders six lanes (two video, graphics, captions with 150 word items, a dialogue lane with a 600-bar waveform, music) over 60 s, controlled through an application-level undo history.

- It ran under Next.js 16 and React 19 with no console errors or warnings; 158 timeline items were rendered.
- A drag produced one `onActionMoveEnd` and a trim one `onActionResizeEnd` at the end of the gesture, each committed as one history entry; undo and redo restored and re-applied them.
- With snap lines off, a 60 px drag at 20 px per second moved the clip by exactly +3.000 s for 1, 5, 20 and 60 pointer steps, with and without grid snapping.
- With snap lines on, the clip snapped to the nearest edge of any item on any lane (a caption word), moving 7.2 s for a 5 s drag.
- In the development build, each committed edit produced a long task of about 90 ms (10 long tasks for 32 gestures).

## What CreatorBrio must supply

- Keyboard access: no timeline item could receive focus; the only roles came from the virtualized grid. Each item needs a focusable control and keyboard commands for select, move and trim.
- Frame snapping: the widget works in seconds; positions are rounded to whole frames before a change set is sent.
- Overlap prevention: the widget let a clip be dropped over another on the same lane; the drag must be constrained, and the server's rejection shown.
- Scoped snap lines: snapping only to the same lane's clip edges and the playhead.

## Not measured

- Ripple and keyframe editing: these are CreatorBrio operations, not widget features, and are tested with the change engine.
- A production build's per-edit cost.
- Screen-reader behaviour of the focusable controls, which do not exist yet.

## Reproduce

See `scripts/gates/g7/README.md`.
