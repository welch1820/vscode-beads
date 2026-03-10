# Active Beads State

## bd-wisp-whj (in_progress) — Epics UX fixes
- Epic button wrapping fix: done (CSS `flex-wrap: nowrap` on `.filter-bar-epic-group`)\
- Epic drop target styling: done (blue outline + "blocks" label)\
- Drag line overlay: done (dashed line from source card to cursor)\
- **Fix applied this session**: SVG drag-line overlay was clipped by `overflow` on `.kanban-board` and `.kanban-column-body`. Moved to `createPortal(…, document.body)` to escape overflow clipping. Awaiting user verification.

## bd-wisp-00z (in_progress) — Drop onto Epic sets dependency
- `onAddDependency` prop added to KanbanBoard\
- Epic cards accept drops: `onDragOver`/`onDrop` handlers create "blocks" dependency\
- Transparent drag image when epic view enabled (card stays in place, line follows cursor)\
- Awaiting user verification of both drag line visibility and drop-onto-epic functionality

## Key files modified (uncommitted)
- `src/webview/views/KanbanBoard.tsx` — portal for drag overlay, epic drop handlers, transparent drag image\
- `src/webview/views/IssuesView.tsx` — passes `onAddDependency` to KanbanBoard\
- `src/webview/styles.css` — epic drop target styles, filter bar epic group layout, kanban-board `position: relative`
