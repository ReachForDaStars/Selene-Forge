import type { Project } from '../core/project';
import type { ProjectFile } from '../core/types';
import { openContextMenu } from './menus';

interface TreeNode {
  name: string;
  path: string;
  dir: boolean;
  children: TreeNode[];
}

const COLLAPSE_KEY = 'selene-forge:collapsed';

function loadCollapsed(): Set<string> {
  try {
    const raw = localStorage.getItem(COLLAPSE_KEY);
    if (raw) return new Set(JSON.parse(raw) as string[]);
  } catch {
    /* ignore */
  }
  return new Set();
}

const ICONS: Record<ProjectFile['kind'], { label: string; className: string }> = {
  lua: { label: 'L', className: 'k-lua' },
  c: { label: 'C', className: 'k-c' },
  cpp: { label: 'C+', className: 'k-cpp' },
  h: { label: 'H', className: 'k-h' },
  json: { label: '{}', className: 'k-json' },
};

export interface ExplorerHandlers {
  onOpen: (path: string) => void;
  onNewFile: (folder: string) => void;
  onNewFolder: (folder: string) => void;
  onRename: (path: string) => void;
  onDelete: (path: string) => void;
  onDownload: (path: string) => void;
  onCopyPath: (path: string) => void;
}

function buildTree(project: Project): TreeNode[] {
  const root: TreeNode = { name: '', path: '', dir: true, children: [] };
  const folders = new Map<string, TreeNode>([['', root]]);

  const ensureFolder = (path: string): TreeNode => {
    const existing = folders.get(path);
    if (existing) return existing;
    const parentPath = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
    const parent = ensureFolder(parentPath);
    const node: TreeNode = { name: path.slice(path.lastIndexOf('/') + 1), path, dir: true, children: [] };
    parent.children.push(node);
    folders.set(path, node);
    return node;
  };

  for (const folder of [...project.folders].sort((a, b) => a.localeCompare(b))) ensureFolder(folder);
  for (const file of project.list()) {
    const parentPath = file.path.includes('/') ? file.path.slice(0, file.path.lastIndexOf('/')) : '';
    const parent = ensureFolder(parentPath);
    parent.children.push({
      name: file.path.slice(file.path.lastIndexOf('/') + 1),
      path: file.path,
      dir: false,
      children: [],
    });
  }

  const sort = (node: TreeNode) => {
    node.children.sort((a, b) => {
      if (a.dir !== b.dir) return a.dir ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    node.children.forEach(sort);
  };
  sort(root);
  return root.children;
}

export class Explorer {
  private tree: HTMLElement;
  private empty: HTMLElement;
  private project: Project;
  private handlers: ExplorerHandlers;
  private collapsed: Set<string>;

  constructor(tree: HTMLElement, empty: HTMLElement, project: Project, handlers: ExplorerHandlers) {
    this.tree = tree;
    this.empty = empty;
    this.project = project;
    this.handlers = handlers;
    this.collapsed = loadCollapsed();
  }

  private persistCollapsed(): void {
    try {
      localStorage.setItem(COLLAPSE_KEY, JSON.stringify([...this.collapsed]));
    } catch {
      /* ignore */
    }
  }

  toggleFolder(path: string): void {
    if (this.collapsed.has(path)) this.collapsed.delete(path);
    else this.collapsed.add(path);
    this.persistCollapsed();
    this.render();
  }

  collapseAll(): void {
    for (const folder of this.project.folders) this.collapsed.add(folder);
    this.persistCollapsed();
    this.render();
  }

  render(): void {
    const nodes = buildTree(this.project);
    this.tree.innerHTML = '';
    this.empty.hidden = this.project.list().length > 0;
    const active = this.project.activePath;

    const renderNode = (node: TreeNode, depth: number): void => {
      const indent = 6 + depth * 12;
      const row = document.createElement('div');
      row.className = 'tree-row';
      row.setAttribute('role', 'treeitem');
      row.tabIndex = 0;
      row.style.paddingLeft = `${indent}px`;
      row.dataset.path = node.path;
      if (!node.dir && node.path === active) row.classList.add('is-active');

      const twisty = document.createElement('span');
      if (node.dir) {
        twisty.className = `tree-twisty${this.collapsed.has(node.path) ? '' : ' is-open'}`;
        twisty.textContent = '▶';
      } else {
        twisty.className = 'tree-indent';
        twisty.style.width = '10px';
      }
      row.appendChild(twisty);

      const icon = document.createElement('span');
      if (node.dir) {
        icon.className = 'tree-icon k-dir';
        icon.textContent = this.collapsed.has(node.path) ? '▸' : '▾';
      } else {
        const file = this.project.get(node.path);
        const meta = ICONS[file?.kind ?? 'lua'];
        icon.className = `tree-icon ${meta.className}`;
        icon.textContent = meta.label;
      }
      row.appendChild(icon);

      const name = document.createElement('span');
      name.className = 'tree-name';
      name.textContent = node.name;
      name.title = node.path;
      row.appendChild(name);

      if (!node.dir) {
        const file = this.project.get(node.path);
        if (file?.locked && file.kind === 'lua') {
          const badge = document.createElement('span');
          badge.className = 'tree-badge';
          badge.textContent = 'code';
          badge.title = 'Custom Code Override — blocks are not in charge';
          row.appendChild(badge);
        }
      }

      row.addEventListener('click', () => {
        if (node.dir) this.toggleFolder(node.path);
        else this.handlers.onOpen(node.path);
      });
      row.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') {
          if (node.dir) this.toggleFolder(node.path);
          else this.handlers.onOpen(node.path);
        }
      });
      row.addEventListener('contextmenu', (event) => {
        event.preventDefault();
        const parent = node.dir ? node.path : node.path.includes('/') ? node.path.slice(0, node.path.lastIndexOf('/')) : '';
        openContextMenu(
          event.clientX,
          event.clientY,
          node.dir
            ? [
                { label: 'New file here', onSelect: () => this.handlers.onNewFile(node.path) },
                { label: 'New folder here', onSelect: () => this.handlers.onNewFolder(node.path) },
                { separator: true, label: '' },
                { label: 'Rename folder…', onSelect: () => this.handlers.onRename(node.path) },
                { label: 'Delete folder', danger: true, onSelect: () => this.handlers.onDelete(node.path) },
              ]
            : [
                { label: 'Open', hint: '↵', onSelect: () => this.handlers.onOpen(node.path) },
                { label: 'New file in folder', onSelect: () => this.handlers.onNewFile(parent) },
                { separator: true, label: '' },
                { label: 'Rename…', hint: 'F2', onSelect: () => this.handlers.onRename(node.path) },
                { label: 'Download', onSelect: () => this.handlers.onDownload(node.path) },
                { label: 'Copy path', onSelect: () => this.handlers.onCopyPath(node.path) },
                { separator: true, label: '' },
                { label: 'Delete', danger: true, hint: '⌫', onSelect: () => this.handlers.onDelete(node.path) },
              ],
        );
      });

      this.tree.appendChild(row);

      if (node.dir && !this.collapsed.has(node.path)) {
        for (const child of node.children) renderNode(child, depth + 1);
      }
    };

    for (const node of nodes) renderNode(node, 0);
  }
}
