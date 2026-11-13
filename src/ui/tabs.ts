import type { Project } from '../core/project';
import { openContextMenu } from './menus';

export interface TabHandlers {
  onActivate: (path: string) => void;
  onClose: (path: string) => void;
  onCloseOthers: (path: string) => void;
  onDownload: (path: string) => void;
}

export class TabBar {
  private root: HTMLElement;
  private project: Project;
  private handlers: TabHandlers;

  constructor(root: HTMLElement, project: Project, handlers: TabHandlers) {
    this.root = root;
    this.project = project;
    this.handlers = handlers;
  }

  render(): void {
    this.root.innerHTML = '';
    const tabs = this.project.openTabs.filter((path) => this.project.has(path));
    if (tabs.length === 0) {
      const empty = document.createElement('span');
      empty.className = 'tabs-empty';
      empty.textContent = 'No open files';
      this.root.appendChild(empty);
      return;
    }

    for (const path of tabs) {
      const file = this.project.get(path);
      if (!file) continue;
      const tab = document.createElement('div');
      tab.className = `tab${path === this.project.activePath ? ' is-active' : ''}`;
      tab.setAttribute('role', 'tab');
      tab.setAttribute('aria-selected', path === this.project.activePath ? 'true' : 'false');
      tab.title = path;

      const name = document.createElement('span');
      name.className = 'tab-name';
      name.textContent = file.path.split('/').pop() ?? file.path;
      tab.appendChild(name);

      if (file.locked && file.kind === 'lua') {
        const dot = document.createElement('span');
        dot.className = 'tab-dot';
        dot.title = 'Custom code override';
        tab.appendChild(dot);
      }

      const close = document.createElement('button');
      close.className = 'tab-close';
      close.textContent = '×';
      close.setAttribute('aria-label', `Close ${name.textContent}`);
      close.addEventListener('click', (event) => {
        event.stopPropagation();
        this.handlers.onClose(path);
      });
      tab.appendChild(close);

      tab.addEventListener('click', () => this.handlers.onActivate(path));
      tab.addEventListener('auxclick', (event) => {
        if (event.button === 1) this.handlers.onClose(path);
      });
      tab.addEventListener('contextmenu', (event) => {
        event.preventDefault();
        openContextMenu(event.clientX, event.clientY, [
          { label: 'Close', onSelect: () => this.handlers.onClose(path) },
          { label: 'Close others', onSelect: () => this.handlers.onCloseOthers(path) },
          { separator: true, label: '' },
          { label: 'Download file', onSelect: () => this.handlers.onDownload(path) },
        ]);
      });
      this.root.appendChild(tab);
    }
  }
}
