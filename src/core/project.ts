import { Emitter } from './emitter';
import {
  basename,
  isUnder,
  kindOf,
  moduleNameForPath,
  normalizePath,
  parentFolders,
  replacePrefix,
  uniquePath,
} from './paths';
import type { BlockGraph, FileKind, ProjectFile, ProjectSnapshot } from './types';

export type ProjectEvent = 'files' | 'content' | 'tabs' | 'active' | 'packages';

let fileSeq = 0;
function nextId(): string {
  fileSeq += 1;
  return `f${Date.now().toString(36)}${fileSeq.toString(36)}`;
}

export interface CreateFileOptions {
  activate?: boolean;
  kind?: FileKind;
  graph?: BlockGraph | null;
  locked?: boolean;
}

/** In-memory multi-file project with virtual folders and tab state. */
export class Project extends Emitter<ProjectEvent> {
  name = 'untitled';
  readonly folders = new Set<string>();
  private files = new Map<string, ProjectFile>();
  openTabs: string[] = [];
  activePath = '';
  installed: string[] = [];

  /* ── reads ─────────────────────────────────────────────────────────────── */

  get(path: string): ProjectFile | undefined {
    return this.files.get(path);
  }

  contentOf(path: string): string {
    return this.files.get(path)?.content ?? '';
  }

  has(path: string): boolean {
    return this.files.has(path);
  }

  list(): ProjectFile[] {
    return [...this.files.values()].sort((a, b) => a.path.localeCompare(b.path));
  }

  luaFiles(): ProjectFile[] {
    return this.list().filter((file) => file.kind === 'lua');
  }

  cFiles(): ProjectFile[] {
    return this.list().filter((file) => file.kind === 'c' || file.kind === 'cpp');
  }

  get activeFile(): ProjectFile | null {
    return this.files.get(this.activePath) ?? null;
  }

  get activeTabFile(): ProjectFile | null {
    return this.files.get(this.activePath) ?? null;
  }

  /* ── structure ─────────────────────────────────────────────────────────── */

  createFile(path: string, content = '', options: CreateFileOptions = {}): ProjectFile {
    const normalized = normalizePath(path);
    if (this.folders.has(normalized)) throw new Error(`"${normalized}" is a folder.`);
    const unique = uniquePath(normalized, (candidate) => this.files.has(candidate) || this.folders.has(candidate));
    const file: ProjectFile = {
      id: nextId(),
      path: unique,
      content,
      kind: options.kind ?? kindOf(unique),
      graph: options.graph ?? null,
      locked: options.locked ?? false,
    };
    this.files.set(unique, file);
    for (const folder of parentFolders(unique)) this.folders.add(folder);
    if (options.activate !== false) {
      this.open(unique);
    }
    this.emit('files');
    return file;
  }

  createFolder(path: string): string {
    const normalized = normalizePath(path);
    const unique = uniquePath(normalized, (candidate) => this.files.has(candidate) || this.folders.has(candidate));
    for (const folder of [...parentFolders(unique), unique]) this.folders.add(folder);
    this.emit('files');
    return unique;
  }

  /** Rename a file or folder. Returns the new path. */
  renamePath(oldPath: string, rawNewPath: string): string {
    const newBase = normalizePath(rawNewPath);
    const file = this.files.get(oldPath);
    if (file) {
      const target = uniquePath(newBase, (candidate) => candidate !== oldPath && (this.files.has(candidate) || this.folders.has(candidate)));
      if (target === oldPath) return oldPath;
      this.files.delete(oldPath);
      file.path = target;
      file.kind = kindOf(target);
      this.files.set(target, file);
      for (const folder of parentFolders(target)) this.folders.add(folder);

      this.openTabs = this.openTabs.map((tab) => (tab === oldPath ? target : tab));
      if (this.activePath === oldPath) this.activePath = target;

      if (file.kind === 'lua') this.rewriteRequires(moduleNameForPath(oldPath), moduleNameForPath(target), target);
      this.emit('tabs');
      this.emit('active');
      this.emit('files');
      return target;
    }

    if (this.folders.has(oldPath)) {
      const targetBase = uniquePath(newBase, (candidate) => this.folders.has(candidate) || this.files.has(candidate));
      const moved: Array<[string, string]> = [];
      for (const path of this.files.keys()) {
        if (isUnder(path, oldPath)) moved.push([path, replacePrefix(path, oldPath, targetBase)]);
      }
      for (const [from, to] of moved) {
        const entry = this.files.get(from);
        if (!entry) continue;
        this.files.delete(from);
        entry.path = to;
        entry.kind = kindOf(to);
        this.files.set(to, entry);
        this.openTabs = this.openTabs.map((tab) => (tab === from ? to : tab));
        if (this.activePath === from) this.activePath = to;
        if (entry.kind === 'lua') this.rewriteRequires(moduleNameForPath(from), moduleNameForPath(to), to);
      }
      for (const folder of [...this.folders]) {
        if (isUnder(folder, oldPath)) {
          this.folders.delete(folder);
          this.folders.add(replacePrefix(folder, oldPath, targetBase));
        }
      }
      for (const folder of parentFolders(targetBase)) this.folders.add(folder);
      this.folders.add(targetBase);
      this.emit('tabs');
      this.emit('active');
      this.emit('files');
      return targetBase;
    }

    throw new Error(`"${oldPath}" does not exist.`);
  }

  deletePath(path: string): void {
    if (this.files.has(path)) {
      this.files.delete(path);
      this.openTabs = this.openTabs.filter((tab) => tab !== path);
      if (this.activePath === path) this.activePath = this.openTabs[this.openTabs.length - 1] ?? '';
      this.emit('files');
      this.emit('tabs');
      this.emit('active');
      return;
    }
    if (!this.folders.has(path)) throw new Error(`"${path}" does not exist.`);
    for (const filePath of [...this.files.keys()]) {
      if (isUnder(filePath, path)) this.files.delete(filePath);
    }
    for (const folder of [...this.folders]) {
      if (isUnder(folder, path)) this.folders.delete(folder);
    }
    this.openTabs = this.openTabs.filter((tab) => this.files.has(tab));
    if (!this.files.has(this.activePath)) this.activePath = this.openTabs[this.openTabs.length - 1] ?? '';
    this.emit('files');
    this.emit('tabs');
    this.emit('active');
  }

  /* ── content ───────────────────────────────────────────────────────────── */

  write(path: string, content: string): void {
    const file = this.files.get(path);
    if (!file || file.content === content) return;
    file.content = content;
    this.emit('content', path);
  }

  setGraph(path: string, graph: BlockGraph | null): void {
    const file = this.files.get(path);
    if (!file) return;
    file.graph = graph;
  }

  setLocked(path: string, locked: boolean): void {
    const file = this.files.get(path);
    if (!file || file.locked === locked) return;
    file.locked = locked;
    this.emit('files');
  }

  /* ── tabs ──────────────────────────────────────────────────────────────── */

  open(path: string): void {
    if (!this.files.has(path)) return;
    if (!this.openTabs.includes(path)) this.openTabs.push(path);
    this.activePath = path;
    this.emit('tabs');
    this.emit('active');
  }

  closeTab(path: string): void {
    this.openTabs = this.openTabs.filter((tab) => tab !== path);
    if (this.activePath === path) {
      this.activePath = this.openTabs[this.openTabs.length - 1] ?? '';
      this.emit('active');
    }
    this.emit('tabs');
  }

  setActive(path: string): void {
    if (!this.files.has(path)) return;
    if (!this.openTabs.includes(path)) this.openTabs.push(path);
    this.activePath = path;
    this.emit('active');
  }

  /* ── packages ──────────────────────────────────────────────────────────── */

  markInstalled(id: string): void {
    if (!this.installed.includes(id)) {
      this.installed.push(id);
      this.emit('packages');
    }
  }

  markRemoved(id: string): void {
    const next = this.installed.filter((entry) => entry !== id);
    if (next.length !== this.installed.length) {
      this.installed = next;
      this.emit('packages');
    }
  }

  /* ── helpers ───────────────────────────────────────────────────────────── */

  /** Update `require("old")` strings in every Lua file after a rename. */
  private rewriteRequires(oldName: string, newName: string, skipPath: string): void {
    if (oldName === newName) return;
    const escaped = oldName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const pattern = new RegExp(`(require\\s*\\(\\s*)(['"])${escaped}\\2(\\s*\\))`, 'g');
    for (const file of this.files.values()) {
      if (file.kind !== 'lua' || file.path === skipPath) continue;
      if (!file.content.includes(oldName)) continue;
      const updated = file.content.replace(pattern, (_match, open, quote, close) => `${open}${quote}${newName}${quote}${close}`);
      if (updated !== file.content) {
        file.content = updated;
        this.emit('content', file.path);
      }
    }
  }

  labelFor(path: string): string {
    return basename(path);
  }

  /* ── persistence ───────────────────────────────────────────────────────── */

  /** Replace the whole workspace (used by ZIP / manifest import). */
  hydrate(snapshot: ProjectSnapshot): void {
    this.files.clear();
    this.folders.clear();
    this.openTabs = [];
    this.activePath = '';
    this.installed = [];
    this.name = snapshot.name || 'untitled';
    for (const folder of snapshot.folders ?? []) this.folders.add(folder);
    let index = 0;
    for (const file of snapshot.files ?? []) {
      index += 1;
      const entry: ProjectFile = {
        id: file.id || `h${index}`,
        path: file.path,
        content: file.content ?? '',
        kind: file.kind || kindOf(file.path),
        graph: file.graph ?? null,
        locked: Boolean(file.locked),
      };
      this.files.set(entry.path, entry);
      for (const folder of parentFolders(entry.path)) this.folders.add(folder);
    }
    this.installed = [...(snapshot.installed ?? [])];
    this.openTabs = (snapshot.openTabs ?? []).filter((path) => this.files.has(path));
    const active = snapshot.activePath && this.files.has(snapshot.activePath) ? snapshot.activePath : this.list()[0]?.path ?? '';
    this.activePath = active;
    if (active && !this.openTabs.includes(active)) this.openTabs.push(active);
    this.emit('files');
    this.emit('tabs');
    this.emit('packages');
    this.emit('active');
  }

  toSnapshot(): ProjectSnapshot {
    return {
      version: 1,
      name: this.name,
      files: this.list().map((file) => ({ ...file })),
      folders: [...this.folders].sort(),
      openTabs: [...this.openTabs],
      activePath: this.activePath,
      installed: [...this.installed],
      savedAt: Date.now(),
    };
  }

  static fromSnapshot(snapshot: ProjectSnapshot | null): Project {
    const project = new Project();
    if (!snapshot) return project;
    project.name = snapshot.name || 'untitled';
    for (const folder of snapshot.folders ?? []) project.folders.add(folder);
    for (const file of snapshot.files ?? []) {
      const entry: ProjectFile = {
        id: file.id || nextId(),
        path: file.path,
        content: file.content ?? '',
        kind: file.kind || kindOf(file.path),
        graph: file.graph ?? null,
        locked: Boolean(file.locked),
      };
      project.files.set(entry.path, entry);
      for (const folder of parentFolders(entry.path)) project.folders.add(folder);
    }
    project.installed = [...(snapshot.installed ?? [])];
    project.openTabs = (snapshot.openTabs ?? []).filter((path) => project.files.has(path));
    const active = snapshot.activePath && project.files.has(snapshot.activePath) ? snapshot.activePath : project.openTabs[0];
    project.activePath = active ?? project.list()[0]?.path ?? '';
    if (project.activePath && !project.openTabs.includes(project.activePath)) project.openTabs.push(project.activePath);
    return project;
  }
}
