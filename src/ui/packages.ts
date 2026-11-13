import { PACKAGE_CATALOG, findPackage, type CatalogPackage } from '../packages/catalog';
import type { Project } from '../core/project';
import { openModal } from './dialogs';
import { toast } from './toast';

export interface PackageManagerContext {
  project: Project;
  onChange: () => void;
}

function upsert(project: Project, path: string, content: string): void {
  if (project.has(path)) project.write(path, content);
  else project.createFile(path, content, { activate: false });
}

export function installPackage(project: Project, entry: CatalogPackage): void {
  for (const file of entry.files) upsert(project, file.path, file.content);
  project.markInstalled(entry.id);
}

export function removePackage(project: Project, entry: CatalogPackage): void {
  for (const file of entry.files) {
    if (project.has(file.path)) project.deletePath(file.path);
  }
  project.markRemoved(entry.id);
}

export function openPackageManager(context: PackageManagerContext): void {
  const { project } = context;
  let query = '';
  let filter: 'all' | 'installed' = 'all';

  const body = document.createElement('div');
  const toolbar = document.createElement('div');
  toolbar.className = 'pkg-toolbar';

  const search = document.createElement('input');
  search.className = 'pkg-search';
  search.placeholder = 'Search curated pure-Lua packages…';
  search.spellcheck = false;
  search.addEventListener('input', () => {
    query = search.value.trim().toLowerCase();
    renderGrid();
  });
  toolbar.appendChild(search);

  const tabs = document.createElement('div');
  tabs.className = 'pkg-tabs';
  const allTab = document.createElement('button');
  allTab.className = 'pkg-tab is-active';
  allTab.textContent = 'All';
  const installedTab = document.createElement('button');
  installedTab.className = 'pkg-tab';
  installedTab.textContent = 'Installed';
  const setFilter = (next: 'all' | 'installed') => {
    filter = next;
    allTab.classList.toggle('is-active', next === 'all');
    installedTab.classList.toggle('is-active', next === 'installed');
    renderGrid();
  };
  allTab.addEventListener('click', () => setFilter('all'));
  installedTab.addEventListener('click', () => setFilter('installed'));
  tabs.append(allTab, installedTab);
  toolbar.appendChild(tabs);
  body.appendChild(toolbar);

  const grid = document.createElement('div');
  grid.className = 'pkg-grid';
  body.appendChild(grid);

  const note = document.createElement('div');
  note.className = 'pkg-note';
  note.innerHTML =
    'Packages are plain Lua files written into <code>packages/</code>. After installing, they are immediately available to <code>require()</code>, to the Modules toolbox, and to the module analyzer — no network or build step.';
  body.appendChild(note);

  const renderGrid = () => {
    grid.innerHTML = '';
    const installed = new Set(project.installed);
    const matches = PACKAGE_CATALOG.filter((entry) => {
      if (filter === 'installed' && !installed.has(entry.id)) return false;
      if (!query) return true;
      return `${entry.name} ${entry.description} ${entry.tags.join(' ')}`.toLowerCase().includes(query);
    });

    if (matches.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'pkg-empty';
      empty.textContent = filter === 'installed' ? 'No packages installed yet.' : 'No packages match that search.';
      grid.appendChild(empty);
      return;
    }

    for (const entry of matches) {
      const isInstalled = installed.has(entry.id);
      const card = document.createElement('div');
      card.className = `pkg-card${isInstalled ? ' is-installed' : ''}`;

      const head = document.createElement('div');
      head.className = 'pkg-head';
      const name = document.createElement('span');
      name.className = 'pkg-name';
      name.textContent = entry.name;
      const version = document.createElement('span');
      version.className = 'pkg-ver';
      version.textContent = `v${entry.version}`;
      head.append(name, version);
      if (isInstalled) {
        const chip = document.createElement('span');
        chip.className = 'pkg-installed-chip';
        chip.textContent = 'installed';
        head.appendChild(chip);
      }
      card.appendChild(head);

      const description = document.createElement('p');
      description.className = 'pkg-desc';
      description.textContent = entry.description;
      card.appendChild(description);

      const meta = document.createElement('div');
      meta.className = 'pkg-meta';
      for (const tag of entry.tags) {
        const tagElement = document.createElement('span');
        tagElement.className = 'pkg-tag';
        tagElement.textContent = tag;
        meta.appendChild(tagElement);
      }
      card.appendChild(meta);

      const summary = document.createElement('div');
      summary.className = 'field-hint';
      summary.style.fontFamily = 'var(--mono)';
      summary.textContent = entry.summary;
      card.appendChild(summary);

      const actions = document.createElement('div');
      actions.className = 'pkg-actions';
      if (isInstalled) {
        const remove = document.createElement('button');
        remove.className = 'btn btn-ghost btn-sm';
        remove.textContent = 'Uninstall';
        remove.addEventListener('click', () => {
          if (!project.has(entry.files[0].path)) {
            toast(`${entry.name} files are already gone; clearing the installed flag.`);
          }
          removePackage(project, entry);
          context.onChange();
          renderGrid();
          toast(`Removed ${entry.name}.`, 'ok');
        });
        actions.appendChild(remove);
      } else {
        const install = document.createElement('button');
        install.className = 'btn btn-sm';
        install.textContent = 'Install';
        install.addEventListener('click', () => {
          installPackage(project, entry);
          context.onChange();
          renderGrid();
          toast(`Installed ${entry.name} → packages/${entry.id}.lua · require("packages.${entry.id}")`, 'ok');
        });
        actions.appendChild(install);
      }
      card.appendChild(actions);
      grid.appendChild(card);
    }
  };

  renderGrid();

  openModal({
    title: 'Package manager',
    subtitle: 'Curated, dependency-free Lua libraries installed straight into your virtual filesystem.',
    body,
    wide: true,
    actions: [{ label: 'Done', variant: 'primary' }],
  });

  setTimeout(() => search.focus(), 40);
}

export function isInstalled(project: Project, id: string): boolean {
  return project.installed.includes(id) || Boolean(findPackage(id)?.files.every((file) => project.has(file.path)));
}
