import { BlockEngine } from './blocks/engine';
import { blocksFromLua } from './blocks/fromAst';
import { buildCBridge, type CBridgeBuild } from './cbridge/bridge';
import { collectNativeSources } from './cbridge/nativeSources';
import { debounce } from './core/emitter';
import { Project } from './core/project';
import { loadSnapshot, saveSnapshot } from './core/storage';
import type { FileKind, ProjectFile } from './core/types';
import {
  downloadFile,
  downloadGraph,
  exportProjectZip,
  parseJsonImport,
  readArchive,
} from './export/project';
import { analyzeProject, type ProjectAnalysis } from './lua/analyze';
import { executeProject, warmupLua } from './runtime/lua';
import { createDefaultSnapshot } from './samples/defaultProject';
import { ConsoleView } from './ui/console';
import { confirmDialog, openModal, promptDialog } from './ui/dialogs';
import { CodeEditor } from './ui/editor';
import { Explorer } from './ui/explorer';
import { newCFunctionDialog, newCStructDialog, openNativeBridge } from './ui/ffi';
import { isMenuOpen, closeMenu } from './ui/menus';
import { openPackageManager } from './ui/packages';
import { TabBar } from './ui/tabs';
import { escapeHtml, toast } from './ui/toast';

function el<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`Missing element #${id}`);
  return node as T;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function normalizeLua(value: string): string {
  return value
    .replace(/\r\n/g, '\n')
    .replace(/[ \t]+$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

const KIND_LABEL: Record<FileKind, string> = {
  lua: 'lua',
  c: 'c',
  cpp: 'c++',
  h: 'header',
  json: 'json',
};

const NEW_FILE_TEMPLATES: Array<{ id: string; label: string; path: string; content: string }> = [
  { id: 'lua', label: 'Lua script (blocks)', path: 'main.lua', content: '' },
  {
    id: 'module',
    label: 'Lua module (return table)',
    path: 'lib/module.lua',
    content: 'local module = {}\n\nfunction module.hello(name)\n  return "hello, " .. name\nend\n\nreturn module\n',
  },
  {
    id: 'c',
    label: 'C source (native bridge)',
    path: 'native/helper.c',
    content: 'int helper_add(int a, int b) {\n  return a + b;\n}\n',
  },
  {
    id: 'cpp',
    label: 'C++ source (native bridge)',
    path: 'native/helper.cpp',
    content: 'extern "C" int helper_mul(int a, int b) {\n  return a * b;\n}\n',
  },
  {
    id: 'h',
    label: 'C header',
    path: 'native/helper.h',
    content: '#ifndef HELPER_H\n#define HELPER_H\n\nint helper_add(int a, int b);\n\n#endif\n',
  },
  { id: 'json', label: 'JSON data file', path: 'data/values.json', content: '{\n  "name": "selene",\n  "version": 1\n}\n' },
];

class App {
  private project!: Project;
  private engine!: BlockEngine;
  private editor!: CodeEditor;
  private console!: ConsoleView;
  private explorer!: Explorer;
  private tabs!: TabBar;

  private loadedPath = '';
  private loadedKind: FileKind | null = null;
  private lastGenerated = '';
  private diverged = false;
  private running = false;
  private analysis: ProjectAnalysis = analyzeProject([]);
  private bridge!: CBridgeBuild;
  private contextSignature = '';
  private notice!: HTMLElement;
  private noticeText!: HTMLElement;
  private noticeError = '';
  private saveTimer: ReturnType<typeof setTimeout> | null = null;

  private refreshSoon = debounce(() => this.refreshContext(), 420);
  private syncSoon = debounce(() => this.syncCodeToBlocks(), 700);

  async boot(): Promise<void> {
    const saved = await loadSnapshot();
    this.project = Project.fromSnapshot(saved ?? createDefaultSnapshot());
    if (!saved) this.prepareStarterGraphs();

    this.engine = new BlockEngine(el('blockly-host'), {
      onGraphChange: () => this.onGraphChanged(),
      onCreateNativeFunction: () => void this.createNativeItem('function'),
      onCreateNativeStruct: () => void this.createNativeItem('struct'),
    });

    this.editor = new CodeEditor(el('editor-host'), {
      onChange: (value) => this.onEditorChanged(value),
      onCursor: (line, column) => {
        el('status-cursor').textContent = `Ln ${line}, Col ${column}`;
      },
    });

    this.console = new ConsoleView(el('console'), el('console-summary'), el('run-dot'));

    this.explorer = new Explorer(el('tree'), el('tree-empty'), this.project, {
      onOpen: (path) => this.project.open(path),
      onNewFile: (folder) => void this.newFile(folder),
      onNewFolder: (folder) => void this.newFolder(folder),
      onRename: (path) => void this.renamePath(path),
      onDelete: (path) => void this.deletePath(path),
      onDownload: (path) => {
        const file = this.project.get(path);
        if (file) downloadFile(file);
      },
      onCopyPath: (path) => void this.copyText(path, 'Path copied.'),
    });

    this.tabs = new TabBar(el('tabs'), this.project, {
      onActivate: (path) => this.project.open(path),
      onClose: (path) => this.project.closeTab(path),
      onCloseOthers: (path) => {
        for (const tab of [...this.project.openTabs]) {
          if (tab !== path) this.project.closeTab(tab);
        }
        this.project.setActive(path);
      },
      onDownload: (path) => {
        const file = this.project.get(path);
        if (file) downloadFile(file);
      },
    });

    this.buildNotice();
    this.bindProjectEvents();
    this.bindToolbar();
    this.bindSplitters();
    this.bindKeyboard();
    this.bindOverlay();

    this.console.add('sys', 'Selene Forge ready — Lua 5.4 (wasm) with the in-browser C bridge.');
    this.console.setStatus('idle');

    this.refreshContext();
    this.explorer.render();
    this.tabs.render();
    this.onActiveChanged();
    this.updatePackageCount();

    void warmupLua();

    window.addEventListener('beforeunload', () => {
      this.stashGraph();
      void saveSnapshot(this.project.toSnapshot());
    });
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') {
        this.stashGraph();
        this.persistNow();
      }
    });
  }

  /* ── starter project ──────────────────────────────────────────────────── */

  private prepareStarterGraphs(): void {
    for (const file of this.project.luaFiles()) {
      if (file.path.startsWith('packages/')) continue;
      if (!file.content.trim() || file.graph) continue;
      try {
        file.graph = blocksFromLua(file.content).graph;
      } catch {
        file.locked = true;
      }
    }
  }

  /* ── persistence ──────────────────────────────────────────────────────── */

  private scheduleSave(): void {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      this.persistNow();
    }, 550);
  }

  private async persistNow(): Promise<void> {
    const status = el('status-save');
    status.textContent = 'saving…';
    status.className = 'status-item is-saving';
    const ok = await saveSnapshot(this.project.toSnapshot());
    status.textContent = ok ? 'saved' : 'save failed';
    status.className = `status-item ${ok ? 'is-saved' : ''}`;
  }

  /* ── project events ───────────────────────────────────────────────────── */

  private bindProjectEvents(): void {
    this.project.on('files', () => {
      this.explorer.render();
      this.tabs.render();
      this.refreshSoon();
      this.scheduleSave();
    });
    this.project.on('tabs', () => {
      this.tabs.render();
      this.scheduleSave();
    });
    this.project.on('active', () => {
      this.tabs.render();
      this.explorer.render();
      this.onActiveChanged();
      this.scheduleSave();
    });
    this.project.on('content', () => {
      this.refreshSoon();
      this.scheduleSave();
    });
    this.project.on('packages', () => {
      this.updatePackageCount();
      this.refreshSoon();
      this.scheduleSave();
    });
  }

  /* ── active file ──────────────────────────────────────────────────────── */

  private stashGraph(): void {
    if (!this.loadedPath || this.loadedKind !== 'lua') return;
    const previous = this.project.get(this.loadedPath);
    if (previous && previous.kind === 'lua') {
      previous.graph = this.engine.saveGraph();
    }
  }

  private onActiveChanged(): void {
    this.stashGraph();
    const file = this.project.activeFile;
    this.loadedPath = file?.path ?? '';
    this.loadedKind = file?.kind ?? null;
    this.diverged = false;
    this.noticeError = '';
    this.hideNotice();

    if (!file) {
      this.editor.setValue('', { silent: true });
      this.showOverlay('empty');
      this.updateChrome();
      return;
    }

    if (file.kind !== 'lua') {
      this.engine.loadGraph(null);
      this.editor.setLanguage(file.kind);
      this.editor.setValue(file.content, { silent: true });
      this.showOverlay('native');
      this.updateChrome();
      this.engine.resize();
      return;
    }

    if (!file.graph && file.content.trim() && !file.locked) {
      this.project.setLocked(file.path, true);
    }
    this.engine.loadFile(file);
    this.editor.setLanguage('lua');
    this.editor.setValue(file.content, { silent: true });
    this.lastGenerated = this.engine.generate();
    this.showOverlay(file.locked ? 'locked' : 'none');
    this.updateChrome();
    this.engine.resize();
  }

  /* ── block ↔ code sync ────────────────────────────────────────────────── */

  private onGraphChanged(): void {
    const file = this.project.activeFile;
    if (!file || file.kind !== 'lua' || file.locked) return;
    if (this.diverged) {
      this.showNotice('Blocks changed, but the editor code does not map back to blocks. Choose an action to resolve it.');
      return;
    }
    const code = this.engine.generate();
    file.graph = this.engine.saveGraph();
    this.lastGenerated = code;
    this.project.write(file.path, code);
    this.editor.setValue(code, { silent: true });
    this.updateChrome();
  }

  private onEditorChanged(value: string): void {
    const file = this.project.activeFile;
    if (!file) return;
    this.project.write(file.path, value);
    if (file.kind !== 'lua' || file.locked) return;
    this.syncSoon();
  }

  private syncCodeToBlocks(): void {
    const file = this.project.activeFile;
    if (!file || file.kind !== 'lua' || file.locked) return;
    const code = this.editor.getValue();
    if (normalizeLua(code) === normalizeLua(this.lastGenerated)) {
      this.diverged = false;
      this.hideNotice();
      this.updateChrome();
      return;
    }
    const result = this.engine.loadCode(code);
    if (!result.ok) {
      this.diverged = true;
      this.noticeError = result.error ?? 'Unable to parse Lua';
      this.showNotice();
      this.updateChrome();
      return;
    }
    file.graph = this.engine.saveGraph();
    this.diverged = false;
    this.noticeError = '';
    this.hideNotice();
    this.lastGenerated = this.engine.generate();
    this.updateChrome();
    this.refreshSoon();
  }

  private regenerateFromBlocks(): void {
    const file = this.project.activeFile;
    if (!file || file.kind !== 'lua') return;
    if (file.locked) {
      toast('This file is in Custom Code Override mode — unlock sync first.', 'error');
      return;
    }
    const code = this.engine.generate();
    file.graph = this.engine.saveGraph();
    this.lastGenerated = code;
    this.diverged = false;
    this.noticeError = '';
    this.hideNotice();
    this.project.write(file.path, code);
    this.editor.setValue(code, { silent: true });
    this.updateChrome();
    toast('Regenerated Lua from the block graph.', 'ok');
    this.stashGraph();
  }

  private toggleSync(): void {
    const file = this.project.activeFile;
    if (!file || file.kind !== 'lua') {
      toast('Only Lua files participate in block ↔ code sync.', 'error');
      return;
    }
    if (file.locked) this.enableSync();
    else this.disableSync();
  }

  private disableSync(): void {
    const file = this.project.activeFile;
    if (!file) return;
    this.project.setLocked(file.path, true);
    this.showOverlay('locked');
    this.updateChrome();
    toast('Custom Code Override enabled — blocks are frozen, your Lua is authoritative.', 'ok');
  }

  private enableSync(): void {
    const file = this.project.activeFile;
    if (!file || file.kind !== 'lua') return;
    const code = this.editor.getValue();
    const result = this.engine.loadCode(code);
    if (!result.ok) {
      toast(`Cannot map this file back to blocks yet: ${result.error}`, 'error');
      return;
    }
    this.project.setLocked(file.path, false);
    file.graph = this.engine.saveGraph();
    this.lastGenerated = this.engine.generate();
    this.diverged = false;
    this.noticeError = '';
    this.hideNotice();
    this.showOverlay('none');
    this.updateChrome();
    toast('Two-way sync enabled — manual edits now map back into blocks.', 'ok');
    this.stashGraph();
  }

  /* ── code notice ──────────────────────────────────────────────────────── */

  private buildNotice(): void {
    const notice = document.createElement('div');
    notice.className = 'code-notice';
    notice.hidden = true;
    const text = document.createElement('span');
    text.className = 'code-notice-text';
    const lock = document.createElement('button');
    lock.className = 'btn btn-ghost btn-sm';
    lock.textContent = 'Keep as custom code';
    lock.addEventListener('click', () => {
      this.disableSync();
      this.hideNotice();
    });
    const regen = document.createElement('button');
    regen.className = 'btn btn-ghost btn-sm';
    regen.textContent = 'Regenerate from blocks';
    regen.addEventListener('click', () => this.regenerateFromBlocks());
    notice.append(text, lock, regen);
    el('pane-code').insertBefore(notice, el('editor-host'));
    this.notice = notice;
    this.noticeText = text;
  }

  private showNotice(message?: string): void {
    const file = this.project.activeFile;
    if (!file) return;
    this.noticeText.textContent =
      message ??
      `Manual edits in ${file.path} don't map to blocks${this.noticeError ? `: ${this.noticeError}` : '.'} Your code is preserved.`;
    this.notice.hidden = false;
  }

  private hideNotice(): void {
    if (this.notice) this.notice.hidden = true;
  }

  /* ── overlays & chrome ────────────────────────────────────────────────── */

  private showOverlay(kind: 'none' | 'locked' | 'native' | 'empty'): void {
    const overlay = el('blocks-overlay');
    const title = el('overlay-title');
    const text = el('overlay-text');
    const actions = overlay.querySelector('.overlay-actions') as HTMLElement | null;
    if (kind === 'none') {
      overlay.hidden = true;
      return;
    }
    overlay.hidden = false;
    if (actions) actions.style.display = kind === 'locked' ? 'flex' : 'none';
    if (kind === 'locked') {
      title.textContent = 'Custom Code Override';
      text.innerHTML =
        'This file is locked to handwritten Lua. Blocks are frozen so your edits are never overwritten. Turn sync back on to map the code into blocks.';
    } else if (kind === 'native') {
      const file = this.project.activeFile;
      title.textContent = `Native source · ${file?.path ?? ''}`;
      text.innerHTML =
        'C, C++ and header files are edited in the code pane and compiled by the in-browser bridge when you run. Call them from Lua with <code>_C.call("name", …)</code> or a <code>lua_register</code> block.';
    } else {
      title.textContent = 'No file open';
      text.innerHTML = 'Create a Lua file to start a block graph, or pick a file from the explorer.';
    }
  }

  private updateChrome(): void {
    const file = this.project.activeFile;
    el('file-path').textContent = file?.path ?? '—';
    el('file-kind').textContent = file ? KIND_LABEL[file.kind] : '—';
    const mode = el('file-mode');
    const sync = el('btn-sync');
    const editorSync = el('editor-sync');
    const regenerate = el('btn-regenerate') as HTMLButtonElement;

    if (!file) {
      mode.textContent = 'no file';
      mode.dataset.mode = 'code';
      sync.setAttribute('aria-pressed', 'false');
      editorSync.textContent = 'no file';
      regenerate.disabled = true;
      el('status-file').textContent = '—';
      el('status-sync').textContent = 'no file';
      return;
    }

    el('status-file').textContent = file.path;
    if (file.kind !== 'lua') {
      mode.textContent = 'native source';
      mode.dataset.mode = 'code';
      sync.setAttribute('aria-pressed', 'false');
      editorSync.textContent = 'read-write · compiled on run';
      editorSync.classList.remove('is-locked');
      regenerate.disabled = true;
      el('status-sync').textContent = 'native';
      return;
    }

    if (file.locked) {
      mode.textContent = 'custom code';
      mode.dataset.mode = 'locked';
      sync.setAttribute('aria-pressed', 'false');
      editorSync.textContent = 'authoritative · blocks frozen';
      editorSync.classList.add('is-locked');
      regenerate.disabled = true;
      el('status-sync').textContent = 'override';
    } else if (this.diverged) {
      mode.textContent = 'unmapped edits';
      mode.dataset.mode = 'code';
      sync.setAttribute('aria-pressed', 'true');
      editorSync.textContent = 'code has unmapped changes';
      editorSync.classList.add('is-locked');
      regenerate.disabled = false;
      el('status-sync').textContent = 'needs mapping';
    } else {
      mode.textContent = 'two-way sync';
      mode.dataset.mode = 'sync';
      sync.setAttribute('aria-pressed', 'true');
      editorSync.classList.remove('is-sync');
      editorSync.classList.add('is-active');
      editorSync.textContent = 'live · blocks ↔ code';
      editorSync.classList.remove('is-locked');
      regenerate.disabled = false;
      el('status-sync').textContent = 'sync on';
    }
  }

  /* ── analysis, modules, native context ────────────────────────────────── */

  private refreshContext(): void {
    const files = this.project.list();
    this.analysis = analyzeProject(files);
    this.bridge = buildCBridge(collectNativeSources(files), () => {});
    const signature = JSON.stringify({
      modules: this.analysis.modules.map((module) => [
        module.moduleName,
        module.exports.map((entry) => `${entry.name}(${entry.params.join(',')})`),
      ]),
      functions: this.bridge.info.functions.map((fn) => `${fn.name}/${fn.params.length}`),
      structs: this.bridge.info.structs.map((entry) => entry.name),
      errors: this.bridge.info.errors,
      installed: this.project.installed,
    });
    if (signature !== this.contextSignature) {
      this.contextSignature = signature;
      this.engine.setProjectContext(this.analysis, this.bridge.info);
      this.renderModules();
    }
    this.updateStatus();
  }

  private renderModules(): void {
    const root = el('modules');
    root.innerHTML = '';
    const modules = this.analysis.modules.filter((module) => !module.isPackage);
    if (modules.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'module-empty';
      empty.textContent = 'No Lua modules yet.';
      root.appendChild(empty);
      return;
    }
    for (const module of modules) {
      const row = document.createElement('button');
      row.className = 'module-row';
      row.title = `${module.moduleName} · ${module.exports.length} exports — click to open`;
      const name = document.createElement('b');
      name.textContent = module.moduleName;
      const count = document.createElement('span');
      count.textContent = module.error ? 'parse error' : `${module.exports.length} exports`;
      row.append(name, count);
      row.addEventListener('click', () => this.project.open(module.path));
      root.appendChild(row);
    }
  }

  private updateStatus(): void {
    const modules = this.analysis.modules.filter((module) => !module.isPackage);
    el('status-modules').textContent = `${modules.length} modules`;
    const bridgeStatus = el('status-cbridge');
    if (this.bridge.info.errors.length > 0) {
      bridgeStatus.textContent = `${this.bridge.info.errors.length} native errors`;
      bridgeStatus.style.color = 'var(--danger)';
    } else {
      bridgeStatus.textContent = `${this.bridge.info.functions.length} native fns`;
      bridgeStatus.style.color = '';
    }
  }

  private updatePackageCount(): void {
    el('pkg-count').textContent = String(this.project.installed.length);
  }

  /* ── file operations ──────────────────────────────────────────────────── */

  private async newFile(folder: string): Promise<void> {
    const selected = await this.chooseTemplate();
    if (!selected) return;
    const suggested = folder ? `${folder}/${selected.path.split('/').pop()}` : selected.path;
    const path = await promptDialog({
      title: 'New file',
      subtitle: 'Creates a file in the virtual project. Paths may contain folders.',
      label: 'Path',
      value: suggested,
      confirmLabel: 'Create file',
      hint: 'Extension decides the editor mode: <code>.lua</code>, <code>.c</code>, <code>.cpp</code>, <code>.h</code>, <code>.json</code>.',
      validate: (value) => (value.trim() ? null : 'A path is required.'),
    });
    if (!path) return;
    try {
      const content = path === suggested ? selected.content : selected.content;
      const file = this.project.createFile(path, content, { activate: true });
      if (file.kind === 'lua' && content.trim()) {
        try {
          file.graph = blocksFromLua(content).graph;
        } catch {
          file.locked = true;
        }
      }
      toast(`Created ${file.path}`, 'ok');
    } catch (error) {
      toast(error instanceof Error ? error.message : String(error), 'error');
    }
  }

  private chooseTemplate(): Promise<(typeof NEW_FILE_TEMPLATES)[number] | null> {
    return new Promise((resolve) => {
      const body = document.createElement('div');
      const list = document.createElement('div');
      list.className = 'modal-list';
      let settled = false;
      const finish = (value: (typeof NEW_FILE_TEMPLATES)[number] | null) => {
        if (settled) return;
        settled = true;
        resolve(value);
      };
      const modal = openModal({
        title: 'Choose a file type',
        subtitle: 'The template seeds the new file; Lua templates without code start as an empty block graph.',
        body,
        narrow: true,
        onClose: () => finish(null),
      });
      for (const template of NEW_FILE_TEMPLATES) {
        const button = document.createElement('button');
        button.className = 'modal-list-item';
        button.innerHTML = `<span>${template.path}</span><span class="k">${template.label}</span>`;
        button.addEventListener('click', () => {
          finish(template);
          modal.close();
        });
        list.appendChild(button);
      }
      body.appendChild(list);
    });
  }

  private async newFolder(folder: string): Promise<void> {
    const path = await promptDialog({
      title: 'New folder',
      label: 'Folder path',
      value: folder ? `${folder}/new-folder` : 'new-folder',
      confirmLabel: 'Create folder',
    });
    if (!path) return;
    try {
      this.project.createFolder(path);
      toast(`Created folder ${path}`, 'ok');
    } catch (error) {
      toast(error instanceof Error ? error.message : String(error), 'error');
    }
  }

  private async renamePath(path: string): Promise<void> {
    const next = await promptDialog({
      title: 'Rename',
      label: 'New path',
      value: path,
      confirmLabel: 'Rename',
      hint: 'Renaming a Lua module updates matching <code>require()</code> calls in other files.',
    });
    if (!next || next === path) return;
    try {
      const renamed = this.project.renamePath(path, next);
      this.loadedPath = this.project.activePath;
      if (this.loadedPath === renamed) this.onActiveChanged();
      toast(`Renamed to ${renamed}`, 'ok');
    } catch (error) {
      toast(error instanceof Error ? error.message : String(error), 'error');
    }
  }

  private async deletePath(path: string): Promise<void> {
    const file = this.project.get(path);
    const isFolder = !file;
    const ok = await confirmDialog({
      title: isFolder ? 'Delete folder?' : 'Delete file?',
      message: isFolder
        ? `Everything under <strong>${escapeHtml(path)}/</strong> will be removed from this workspace.`
        : `<strong>${escapeHtml(path)}</strong> will be removed from this workspace. Export it first if you need a copy.`,
      confirmLabel: isFolder ? 'Delete folder' : 'Delete file',
      danger: true,
    });
    if (!ok) return;
    try {
      this.project.deletePath(path);
      toast(`Deleted ${path}`);
    } catch (error) {
      toast(error instanceof Error ? error.message : String(error), 'error');
    }
  }

  private async copyText(text: string, message: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(text);
      toast(message, 'ok');
    } catch {
      toast('Clipboard access was refused by the browser.', 'error');
    }
  }

  /* ── native bridge items ──────────────────────────────────────────────── */

  private ensureLuaFile(): ProjectFile | null {
    let file = this.project.activeFile;
    if (file?.kind === 'lua') return file;
    const target = this.project.has('main.lua') ? 'main.lua' : this.project.luaFiles()[0]?.path;
    if (!target) {
      try {
        return this.project.createFile('main.lua', '', { activate: true });
      } catch {
        return null;
      }
    }
    this.project.open(target);
    file = this.project.activeFile;
    return file?.kind === 'lua' ? file : null;
  }

  private async createNativeItem(kind: 'function' | 'struct'): Promise<void> {
    if (!this.ensureLuaFile()) {
      toast('Open or create a Lua file first — native definitions live in a Lua block graph.', 'error');
      return;
    }
    if (kind === 'function') {
      const result = await newCFunctionDialog();
      if (!result) return;
      this.engine.appendBlock({
        type: 'ffi_define_function',
        fields: { RET: result.ret, NAME: result.name, PARAMS: result.params, BODY: result.body },
      });
      this.engine.notifyGraphChange();
      this.refreshContext();
      toast(`Added native C function "${result.name}".`, 'ok');
    } else {
      const result = await newCStructDialog();
      if (!result) return;
      this.engine.appendBlock({ type: 'ffi_define_struct', fields: { NAME: result.name, FIELDS: result.fields } });
      this.engine.notifyGraphChange();
      this.refreshContext();
      toast(`Added native struct "${result.name}".`, 'ok');
    }
  }

  private insertBlock(state: unknown): void {
    if (!this.ensureLuaFile()) {
      toast('Open or create a Lua file first.', 'error');
      return;
    }
    this.engine.appendBlock(state);
    this.engine.notifyGraphChange();
    this.refreshContext();
  }

  /* ── run ──────────────────────────────────────────────────────────────── */

  private pickEntry(): string | null {
    if (this.project.has('main.lua')) return 'main.lua';
    const active = this.project.activeFile;
    if (active?.kind === 'lua') return active.path;
    return this.project.luaFiles()[0]?.path ?? null;
  }

  private setRunning(running: boolean): void {
    this.running = running;
    const button = el('btn-run');
    button.classList.toggle('is-running', running);
    if (running) {
      button.classList.add('is-loading');
      button.querySelector('span')!.textContent = 'Running';
    } else {
      button.classList.remove('is-loading');
      button.querySelector('span')!.textContent = 'Run';
    }
  }

  private async runProject(): Promise<void> {
    if (this.running) return;
    this.stashGraph();
    const active = this.project.activeFile;
    if (active?.kind === 'lua') this.project.write(active.path, this.editor.getValue());

    const entry = this.pickEntry();
    if (!entry) {
      toast('Create a Lua file before running the project.', 'error');
      return;
    }

    this.setRunning(true);
    this.console.reset();
    this.console.setStatus('running');
    this.console.setSummary(`running ${entry}…`);
    const started = performance.now();

    const bridge = buildCBridge(collectNativeSources(this.project.list()), (text) => this.console.add('c', text));
    const nativeMs = performance.now() - started;
    for (const error of bridge.info.errors) this.console.add('err', error);

    try {
      const outcome = await executeProject({
        files: this.project.list(),
        mainPath: entry,
        bridge,
        out: (lane, text) => {
          this.console.add(lane === 'lua' ? 'lua' : 'c', text);
        },
        timeoutMs: 8000,
      });
      if (outcome.returnValue) this.console.add('ok', `returned ${outcome.returnValue}`);
      if (!outcome.ok) {
        this.console.add('err', outcome.error?.message ?? 'Lua execution failed', outcome.error?.trace);
      }
      const total = performance.now() - started;
      this.console.setStatus(outcome.ok ? 'ok' : 'error');
      this.console.setSummary(
        `${outcome.ok ? 'completed' : 'failed'} · ${total.toFixed(0)} ms total · lua ${outcome.luaMs.toFixed(0)} ms · native ${nativeMs.toFixed(0)} ms · ${outcome.nativeFunctions} C fns · ${this.project.list().length} files`,
      );
    } catch (error) {
      this.console.add('err', `Runtime failed to start: ${error instanceof Error ? error.message : String(error)}`);
      this.console.setStatus('error');
      this.console.setSummary('runtime error');
    } finally {
      this.setRunning(false);
    }
  }

  /* ── import ───────────────────────────────────────────────────────────── */

  private async onImportFiles(list: FileList): Promise<void> {
    const files = Array.from(list);
    for (const file of files) {
      try {
        if (/\.zip$/i.test(file.name)) {
          const archive = await readArchive(file);
          if (archive.snapshot.files.length === 0) {
            toast('That archive contains no supported files.', 'error');
            continue;
          }
          const ok = await confirmDialog({
            title: 'Replace workspace?',
            message: `Importing <strong>${escapeHtml(file.name)}</strong> replaces the current workspace with <strong>${archive.snapshot.files.length}</strong> files. Export first if you need a copy.`,
            confirmLabel: 'Replace workspace',
          });
          if (!ok) continue;
          this.project.hydrate(archive.snapshot);
          this.loadedPath = '';
          this.contextSignature = '';
          this.refreshContext();
          this.onActiveChanged();
          if (archive.skipped.length > 0) toast(`${archive.skipped.length} unsupported archive entries were skipped.`);
          toast(`Imported ${archive.snapshot.files.length} files from ${file.name}.`, 'ok');
          continue;
        }

        if (/\.json$/i.test(file.name)) {
          const text = await file.text();
          const parsed = parseJsonImport(text);
          if (parsed.kind === 'graph' && parsed.graph) {
            const target = this.ensureLuaFile();
            if (!target) {
              toast('Open a Lua file before importing a block graph.', 'error');
              continue;
            }
            if (!target.graph && target.content.trim()) {
              const ok = await confirmDialog({
                title: 'Replace blocks?',
                message: `This will load the imported graph into <strong>${escapeHtml(target.path)}</strong> and regenerate its Lua. The existing code will be replaced.`,
                confirmLabel: 'Load graph',
              });
              if (!ok) continue;
            }
            this.engine.loadGraph(parsed.graph);
            target.graph = this.engine.saveGraph();
            target.locked = false;
            const code = this.engine.generate();
            this.lastGenerated = code;
            this.project.write(target.path, code);
            this.editor.setValue(code, { silent: true });
            this.showOverlay('none');
            this.updateChrome();
            toast(`Loaded block graph into ${target.path}.`, 'ok');
          } else if (parsed.kind === 'manifest' && parsed.snapshot) {
            this.project.hydrate(parsed.snapshot);
            this.loadedPath = '';
            this.contextSignature = '';
            this.refreshContext();
            this.onActiveChanged();
            toast('Imported project manifest.', 'ok');
          }
          continue;
        }

        if (!/\.(lua|c|cpp|cc|cxx|h|hpp|hh|txt)$/i.test(file.name)) {
          toast(`${file.name}: unsupported file type.`, 'error');
          continue;
        }

        const text = await file.text();
        const base = file.name.replace(/^.*[\\/]/, '');
        const created = this.project.createFile(base, text, { activate: true });
        if (created.kind === 'lua' && text.trim()) {
          try {
            created.graph = blocksFromLua(text).graph;
            created.locked = false;
          } catch {
            created.locked = true;
          }
        }
        toast(`Imported ${created.path}.`, 'ok');
      } catch (error) {
        toast(error instanceof Error ? error.message : String(error), 'error');
      }
    }
  }

  /* ── wiring ───────────────────────────────────────────────────────────── */

  private bindToolbar(): void {
    el('btn-run').addEventListener('click', () => void this.runProject());
    el('btn-sync').addEventListener('click', () => this.toggleSync());
    el('btn-packages').addEventListener('click', () => this.openPackages());
    el('btn-packages-foot').addEventListener('click', () => this.openPackages());
    el('btn-regenerate').addEventListener('click', () => this.regenerateFromBlocks());
    el('btn-file-export').addEventListener('click', () => {
      const file = this.project.activeFile;
      if (file) downloadFile(file);
      else toast('No active file.', 'error');
    });

    const projectName = el('project-name') as HTMLInputElement;
    projectName.value = this.project.name;
    projectName.addEventListener('change', () => {
      this.project.name = projectName.value.trim() || 'untitled';
      projectName.value = this.project.name;
      this.scheduleSave();
    });

    const exportButton = el('btn-export');
    const exportMenu = el('export-menu');
    exportButton.addEventListener('click', (event) => {
      event.stopPropagation();
      const open = exportMenu.hidden;
      exportMenu.hidden = !open;
      exportButton.setAttribute('aria-expanded', open ? 'true' : 'false');
      const active = this.project.activeFile;
      el('export-file-ext').textContent = active ? `.${active.path.split('.').pop()}` : '.lua';
    });
    exportMenu.addEventListener('click', (event) => {
      const target = (event.target as HTMLElement).closest('[data-export]') as HTMLElement | null;
      if (!target) return;
      exportMenu.hidden = true;
      exportButton.setAttribute('aria-expanded', 'false');
      const action = target.dataset.export;
      if (action === 'zip') {
        void exportProjectZip(this.project, this.pickEntry() ?? 'main.lua').then(() => toast('Exported project archive.', 'ok'));
      } else if (action === 'file') {
        const file = this.project.activeFile;
        if (file) {
          downloadFile(file);
          toast(`Downloaded ${file.path.split('/').pop()}.`, 'ok');
        } else toast('No active file.', 'error');
      } else if (action === 'graph') {
        const file = this.project.activeFile;
        if (!file || file.kind !== 'lua') {
          toast('Block graphs exist for Lua files only.', 'error');
        } else {
          try {
            this.stashGraph();
            downloadGraph(file);
            toast('Exported block graph JSON.', 'ok');
          } catch (error) {
            toast(error instanceof Error ? error.message : String(error), 'error');
          }
        }
      } else if (action === 'copy') {
        const file = this.project.activeFile;
        if (file) void this.copyText(file.content, 'File copied to clipboard.');
      }
    });
    document.addEventListener('click', (event) => {
      if (!exportMenu.hidden && !(event.target as HTMLElement).closest('.menu-wrap')) {
        exportMenu.hidden = true;
        exportButton.setAttribute('aria-expanded', 'false');
      }
    });

    const importInput = el('file-input') as HTMLInputElement;
    el('btn-import').addEventListener('click', () => importInput.click());
    importInput.addEventListener('change', () => {
      if (importInput.files && importInput.files.length > 0) void this.onImportFiles(importInput.files);
      importInput.value = '';
    });

    const consoleWrap = el('console-wrap');
    const consoleToggle = el('btn-console-toggle');
    consoleToggle.addEventListener('click', () => {
      const collapsed = consoleWrap.classList.toggle('is-collapsed');
      consoleToggle.setAttribute('aria-pressed', collapsed ? 'false' : 'true');
      el('console-resizer').hidden = collapsed;
      this.engine.resize();
    });
    el('btn-clear-console').addEventListener('click', () => this.console.clear());
    el('btn-copy-console').addEventListener('click', () => void this.copyText(this.console.asText(), 'Console copied.'));

    const panes = el('panes');
    const viewButton = el('btn-toggle-view');
    viewButton.addEventListener('click', () => {
      if (panes.classList.contains('view-blocks')) {
        panes.classList.remove('view-blocks');
        panes.classList.add('view-code');
      } else if (panes.classList.contains('view-code')) {
        panes.classList.remove('view-code');
      } else {
        panes.classList.add('view-blocks');
      }
      this.engine.resize();
      this.editor.refresh();
    });

    for (const button of document.querySelectorAll<HTMLElement>('[data-action]')) {
      const action = button.dataset.action;
      if (action === 'new-file') {
        button.addEventListener('click', () => {
          const folder = this.project.activePath.includes('/') ? this.project.activePath.slice(0, this.project.activePath.lastIndexOf('/')) : '';
          void this.newFile(folder);
        });
      } else if (action === 'new-folder') {
        button.addEventListener('click', () => {
          const folder = this.project.activePath.includes('/') ? this.project.activePath.slice(0, this.project.activePath.lastIndexOf('/')) : '';
          void this.newFolder(folder);
        });
      } else if (action === 'collapse-all') {
        button.addEventListener('click', () => this.explorer.collapseAll());
      }
    }

    el('status-cbridge').addEventListener('click', () => {
      openNativeBridge({
        project: this.project,
        build: () => buildCBridge(collectNativeSources(this.project.list()), () => {}),
        onInsertBlock: (state) => this.insertBlock(state),
        onChanged: () => this.refreshContext(),
      });
    });
  }

  private openPackages(): void {
    openPackageManager({
      project: this.project,
      onChange: () => {
        this.contextSignature = '';
        this.refreshContext();
        this.explorer.render();
        this.updatePackageCount();
      },
    });
  }

  private bindOverlay(): void {
    el('overlay-convert').addEventListener('click', () => this.enableSync());
    el('overlay-unlock').addEventListener('click', () => this.enableSync());
  }

  private bindKeyboard(): void {
    document.addEventListener('keydown', (event) => {
      const meta = event.metaKey || event.ctrlKey;
      if (meta && event.key === 'Enter') {
        event.preventDefault();
        void this.runProject();
      } else if (meta && event.key.toLowerCase() === 's') {
        event.preventDefault();
        this.stashGraph();
        void this.persistNow();
        toast('Workspace saved to this browser.', 'ok');
      } else if (meta && event.key.toLowerCase() === 'b') {
        event.preventDefault();
        el('btn-toggle-view').click();
      } else if (event.key === 'Escape' && isMenuOpen()) {
        closeMenu();
      }
    });
  }

  private bindSplitters(): void {
    const panes = el('panes');
    const splitter = el('splitter');
    const saved = Number(localStorage.getItem('selene-forge:block-w'));
    if (Number.isFinite(saved) && saved > 20 && saved < 80) panes.style.setProperty('--block-w', `${saved}%`);

    let dragging = false;
    const onMove = (event: PointerEvent) => {
      if (!dragging) return;
      const rect = panes.getBoundingClientRect();
      const percent = clamp(((event.clientX - rect.left) / rect.width) * 100, 24, 78);
      panes.style.setProperty('--block-w', `${percent}%`);
      this.engine.resize();
    };
    splitter.addEventListener('pointerdown', (event) => {
      dragging = true;
      splitter.classList.add('is-dragging');
      splitter.setPointerCapture(event.pointerId);
    });
    splitter.addEventListener('pointermove', onMove);
    splitter.addEventListener('pointerup', () => {
      dragging = false;
      splitter.classList.remove('is-dragging');
      localStorage.setItem('selene-forge:block-w', String(parseFloat(getComputedStyle(panes).getPropertyValue('--block-w'))));
      this.engine.resize();
    });
    splitter.addEventListener('keydown', (event) => {
      if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
      const current = parseFloat(getComputedStyle(panes).getPropertyValue('--block-w')) || 52;
      const next = clamp(current + (event.key === 'ArrowLeft' ? -2 : 2), 24, 78);
      panes.style.setProperty('--block-w', `${next}%`);
      localStorage.setItem('selene-forge:block-w', String(next));
      this.engine.resize();
    });

    const consoleWrap = el('console-wrap');
    const resizer = el('console-resizer');
    resizer.hidden = consoleWrap.classList.contains('is-collapsed');
    let resizing = false;
    resizer.addEventListener('pointerdown', (event) => {
      resizing = true;
      resizer.classList.add('is-dragging');
      resizer.setPointerCapture(event.pointerId);
    });
    resizer.addEventListener('pointermove', (event) => {
      if (!resizing) return;
      const work = panes.getBoundingClientRect();
      const height = clamp(work.bottom - event.clientY, 80, work.height * 0.7);
      consoleWrap.style.height = `${height}px`;
      this.engine.resize();
    });
    resizer.addEventListener('pointerup', () => {
      resizing = false;
      resizer.classList.remove('is-dragging');
      this.engine.resize();
    });
  }
}

const app = new App();
void app.boot().catch((error) => {
  console.error('[selene] boot failed', error);
  const host = document.getElementById('toast-root');
  if (host) {
    const element = document.createElement('div');
    element.className = 'toast is-error';
    element.textContent = `Selene Forge failed to start: ${error instanceof Error ? error.message : String(error)}`;
    host.appendChild(element);
  }
});
