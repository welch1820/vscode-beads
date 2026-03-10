# Active Beads State

## bd-wisp-3dk (in_progress) — Plain drag onto epic without Shift
- **Goal**: Plain drag onto epic assigns child; Shift+drag draws arrow for dependency\
- **Design intent**: plain drag = lane move, shift+drag = arrow/dependency mode (future: blocker/blocked in non-epic lanes too)\
- **Latest fix (2026-03-10)**: Replaced unreliable keyboard-only shift tracking with multi-event document-level tracker\
  - Listens to `keydown`, `keyup`, `pointerdown`, `pointermove`, `dragover` on `document` (capture phase)\
  - `pointermove` fires constantly as mouse moves — shift state always current before click\
  - `dragover` fires during drag — detects shift pressed mid-drag\
  - Removed redundant per-card `onMouseDown` shift handlers\
  - All existing drag logic unchanged: `handleDragStart` checks `e.shiftKey || shiftKeyDownRef.current`\
  - `updateDragMousePos` detects shift mid-drag as fallback\
- **Build status**: compiled, dist/webview/main.js is current\
- Pending: user reload + verify shift+drag shows arrow, plain drag moves between lanes

## bd-wisp-whj (in_progress) — Epics UX fixes
- Epic button wrapping fix: done\
- Epic drop target styling: done\
- Drag line overlay: done (portal to document.body)\
- Awaiting user verification

## bd-wisp-00z (in_progress) — Drop onto Epic sets dependency
- `onAddDependency` prop wired through IssuesView → KanbanBoard\
- Epic cards accept drops\
- Awaiting user verification

## Key files modified (uncommitted)
- `src/webview/views/KanbanBoard.tsx` — shift key tracking, epic drop handlers, drag overlay portal, transparent drag image\
- `src/webview/views/IssuesView.tsx` — passes `onAddDependency` to KanbanBoard\
- `src/webview/styles.css` — epic drop target styles, filter bar epic group layout
