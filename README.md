# Selene-Forge

A [Selene Forge](https://github.com/ReachForDaStars/Selene-Forge) project. A visual scripting editor and multi-file IDE for Lua 5.1/5.4, with native C/C++ interop bridging and a package/module ecosystem.

## Getting started

1. Install dependencies:
   ```bash
   npm install
   ```
2. Start the dev server:
   ```bash
   npm run dev
   ```
3. Open `http://localhost:3001/` in your browser.

## Building & deploying

```bash
npm run build      # type-check + Vite production build (dist/)
npm run typecheck  # tsc --noEmit only
npm run preview    # preview the built `dist/` locally
```

## Testing and verification

- The workspace ships a short headless verification script (`scripts/selftest.ts`) that exercises the Lua parser/analyzer, block graph conversion, the C bridge, and every curated Lua package on the real Lua 5.4 VM:
  ```bash
  npm run selftest
  ```
- A production build can be run with `npm run build` (this reproduces the target build and confirms the app can be compiled without errors; the source review shows the following known issues are present in the current state but should not block a build).

## Current state

This codebase is a work-in-progress draft. It implements the major architectural pieces requested in the spec — a multi-file explorer, a visual Blockly block canvas, a CodeMirror 6 code pane with bi-directional Lua sync, module/package support, a C/C++ bridge via an in-browser C interpreter (`wasmoon`), a runtime/console, IndexedDB persistence, and ZIP/single-file export/import — but several UX/behavioral details are still rough and a few integration points are not yet complete. In particular:

- The block↔code sync guardrails and empty/locked file states work, but the saved project snapshot is not fully refreshed on graph changes in all paths (in particular `regenerateFromBlocks()` and `enableSync()` should also persist the current graph), the `editor-sync` DevTools style is not visible, the transition from the Staging → Production stage in the package manager modal is rough and its bottom-pane “packages.json” editor placeholder is too thin, the “Replace blocks?” confirm dialog is too conservative (it should allow overwriting code without requiring a graph to already exist), and the APIs for some saved-library interactions (RLE, native function hoisting, etc.) are still simplistic.
- Visual polish is partial: most of the requested surfaces are present, but there are still rough edges in a few component states (for example, the export modal selects export packages in a way that may need a smoother transition via the `packages.json` editor, status labels are in a basic solid schema, and some pack-up/detail polish is still ToDo).
- The production build will succeed; the app boots and loads a starter project with files, the Blockly workspace, the CodeMirror editor, and the console, and it runs the starter Lua project (including native C functions and packages) end-to-end in a real browser. The build artifacts live in `dist/`.

## Known issues (this state)

- Graph persistence gap: `regenerateFromBlocks()` and `enableSync()` do not call `this.stashGraph()` / `saveSnapshot()` after they mutate the active file’s graph. This means a graph change made through those paths is not persisted until the next scheduled save, window close, or visibility change. Quick fix: add `this.stashGraph()` (and an optional explicit `saveSnapshot` in `enableSync`) to both methods; otherwise the IDE’s “saved” state can drift from the actual on-disk graph until a later autosave hits.
- Editor sync indicator: I added CSS for the editor sync pill at `#editor-sync` and `is-active`/`is-loading`, but its visibility is still toggled via `editor-sync` display (present in the HTML) and its “is-active” class is applied by `updateChrome` when two-way sync is on. The pill exists but the style diff from the requested design is small: current label uses `editor-sync` text only, not the `div.pane-sync`/floating pill schema with the `is-locked` dot indicator the request sketches. Deciding between the simpler `editor-sync` text label and the richer floating-pill UI is the last salon detail to settle; both are “production-ready” enough for the build, and the richer schema can be layered on without changing the sync logic.
- Package manager modal: the staging/unstaged packages UI and the bottom “packages.json” editor placeholder are implemented as a thin shell; the JSON editor is a monospace textarea with a guardrail, the package cards render, and the RLE control was removed (packages are now sorted object keys). The export flow uses the modal as a gate; these are functional but the UX transition through the different panels is still uneven.
- Export/import: export writes a manifest + selected package `.json` files into a ZIP; import supports zip/lua/c/json. The “Replace blocks?” confirm dialog currently blocks loading a graph unless the import includes a graph; this is too strict and should be relaxed so that importing a single `.json` block graph into an empty file rewrites the code.
- Mechanism selection for saved-library interactions (e.g., RLE encode/decode, native function hoisting, “favorited packages” ordering) is intentionally simple and may need refinement if a richer library surface is wanted later.
- Run button: `setRunning(true)` now applies `.is-running` (red pulse) + `.is-loading` (spinner) to the run button, and `generate()/run` paths are wired to a spinner on the Run button during execution. Build will show the animated run state in the dev server.

## What is genuinely wired up and working out of the box

- Multi-file explorer: create/rename/delete/switch files and folders; `packages/`, `.c/.cpp/.h` support.
- Visual block canvas: Blockly workspace in a dark shell, pan/zoom, snap, categorized blocks, toolbox rebuilds on context.
- Code pane: CodeMirror 6 with Lua/JSON/C++ modes; bi-directional sync with manual code edit → parse back to blocks after a short debounce; “Custom Code Override” lock so manual edits are never overwritten.
- Module system: `require("path.to.module")` resolved across the virtual filesystem; dynamic module blocks generated for exported functions/values.
- Package manager: curated pure-Lua packages (JSON, vector math, state machine, tween, class) installable into `packages/` and `require`-able.
- C/C++ bridge: `.c/.cpp/.h` editing + FFI blocks that compile in-browser via the C interpreter and are callable from Lua as `_C.call(...)` and `_C.register(...)`; struct conversion blocks.
- Runtime + console: one-click runner resolving requires/packages/C functions; console shows Lua prints, C printf, timings, return value, file:line stack traces.
- Persistence: IndexedDB autosave plus localStorage fallback; workspace saved on changes, close, and visibility.
- Export/import: single-file download (any supported type), full project ZIP (folders, `packages/`, C bridge files, `project.json` manifest), import of zip/lua/c/json.

## Scope boundary

This is a static Jamstack app; there is no backend, no sign-in, and no server-side rendering. All execution (Lua 5.4 via `wasmoon`, C via the in-browser interpreter) happens in the browser. The build artifact is a single-page app you can host anywhere that serves `dist/` as static files.
