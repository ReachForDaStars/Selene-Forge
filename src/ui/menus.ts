export interface MenuItem {
  label: string;
  hint?: string;
  danger?: boolean;
  separator?: boolean;
  onSelect?: () => void;
}

let root: HTMLElement | null = null;
let open = false;

function host(): HTMLElement {
  if (!root) root = document.getElementById('menu-root');
  return root ?? document.body;
}

export function closeMenu(): void {
  const element = host();
  element.innerHTML = '';
  open = false;
}

export function openContextMenu(x: number, y: number, items: MenuItem[]): void {
  closeMenu();
  const element = host();
  const backdrop = document.createElement('div');
  backdrop.className = 'ctx-backdrop';
  backdrop.addEventListener('pointerdown', closeMenu);
  backdrop.addEventListener('contextmenu', (event) => event.preventDefault());

  const menu = document.createElement('div');
  menu.className = 'menu';
  menu.setAttribute('role', 'menu');

  for (const item of items) {
    if (item.separator) {
      const separator = document.createElement('div');
      separator.className = 'menu-sep';
      menu.appendChild(separator);
      continue;
    }
    const button = document.createElement('button');
    button.className = `menu-item${item.danger ? ' danger' : ''}`;
    button.setAttribute('role', 'menuitem');
    const label = document.createElement('span');
    label.textContent = item.label;
    button.appendChild(label);
    if (item.hint) {
      const hint = document.createElement('kbd');
      hint.textContent = item.hint;
      button.appendChild(hint);
    }
    button.addEventListener('click', () => {
      closeMenu();
      item.onSelect?.();
    });
    menu.appendChild(button);
  }

  element.appendChild(backdrop);
  element.appendChild(menu);
  open = true;

  const rect = menu.getBoundingClientRect();
  const left = Math.min(x, window.innerWidth - rect.width - 8);
  const top = Math.min(y, window.innerHeight - rect.height - 8);
  menu.style.left = `${Math.max(8, left)}px`;
  menu.style.top = `${Math.max(8, top)}px`;
}

export function isMenuOpen(): boolean {
  return open;
}

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && open) closeMenu();
});
