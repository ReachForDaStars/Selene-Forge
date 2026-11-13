import type { FileKind } from './types';

const KIND_BY_EXT: Record<string, FileKind> = {
  lua: 'lua',
  c: 'c',
  cpp: 'cpp',
  cc: 'cpp',
  cxx: 'cpp',
  h: 'h',
  hpp: 'h',
  hh: 'h',
  json: 'json',
};

export function extensionOf(path: string): string {
  const base = path.slice(path.lastIndexOf('/') + 1);
  const dot = base.lastIndexOf('.');
  return dot <= 0 ? '' : base.slice(dot + 1).toLowerCase();
}

export function kindOf(path: string): FileKind {
  return KIND_BY_EXT[extensionOf(path)] ?? 'lua';
}

export function isCFamily(kind: FileKind): boolean {
  return kind === 'c' || kind === 'cpp' || kind === 'h';
}

export function basename(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1);
}

export function dirname(path: string): string {
  const index = path.lastIndexOf('/');
  return index === -1 ? '' : path.slice(0, index);
}

export function stem(path: string): string {
  const base = basename(path);
  const dot = base.lastIndexOf('.');
  return dot <= 0 ? base : base.slice(0, dot);
}

/** Normalize a user supplied path; throws on traversal or absolute paths. */
export function normalizePath(input: string): string {
  const cleaned = input
    .trim()
    .replace(/\\/g, '/')
    .replace(/^\.\//, '')
    .replace(/^\/+/, '')
    .replace(/\/+/g, '/')
    .replace(/\/$/, '');
  if (!cleaned) throw new Error('Path cannot be empty.');
  const segments = cleaned.split('/');
  for (const segment of segments) {
    if (!segment || segment === '.' || segment === '..') {
      throw new Error(`Invalid path segment in "${input}".`);
    }
    if (/[<>:"|?*\u0000-\u001f]/.test(segment)) {
      throw new Error(`Path segment "${segment}" contains invalid characters.`);
    }
  }
  return segments.join('/');
}

export function parentFolders(path: string): string[] {
  const parts = path.split('/');
  const folders: string[] = [];
  for (let index = 1; index < parts.length; index += 1) {
    folders.push(parts.slice(0, index).join('/'));
  }
  return folders;
}

export function isUnder(path: string, folder: string): boolean {
  return path === folder || path.startsWith(`${folder}/`);
}

export function replacePrefix(path: string, oldPrefix: string, newPrefix: string): string {
  if (!isUnder(path, oldPrefix)) return path;
  return `${newPrefix}${path.slice(oldPrefix.length)}`;
}

/** Make `path` unique given a predicate. Appends `-2`, `-3`, ... before the extension. */
export function uniquePath(path: string, exists: (candidate: string) => boolean): string {
  if (!exists(path)) return path;
  const slash = path.lastIndexOf('/');
  const dir = slash === -1 ? '' : path.slice(0, slash + 1);
  const base = path.slice(slash + 1);
  const dot = base.lastIndexOf('.');
  const name = dot <= 0 ? base : base.slice(0, dot);
  const ext = dot <= 0 ? '' : base.slice(dot);
  for (let index = 2; index < 1000; index += 1) {
    const candidate = `${dir}${name}-${index}${ext}`;
    if (!exists(candidate)) return candidate;
  }
  return `${dir}${name}-${Date.now()}${ext}`;
}

/** Dotted module name used by `require`: `packages/json.lua` → `packages.json`. */
export function moduleNameForPath(path: string): string {
  const withoutExt = path.replace(/\.lua$/i, '');
  const segments = withoutExt.split('/');
  if (segments.length > 1 && segments[segments.length - 1] === 'init') segments.pop();
  return segments.join('.');
}

/** All accepted require spellings for a file, most specific first. */
export function requireCandidates(path: string): string[] {
  const withoutExt = path.replace(/\.lua$/i, '');
  const direct = withoutExt.replace(/\//g, '.');
  const candidates = [direct];
  if (withoutExt.endsWith('/init')) {
    candidates.push(withoutExt.slice(0, -'/init'.length).replace(/\//g, '.'));
  }
  if (path.startsWith('packages/')) {
    candidates.push(withoutExt.slice('packages/'.length).replace(/\//g, '.'));
  }
  return [...new Set(candidates.filter(Boolean))];
}
