let root: HTMLElement | null = null;

function host(): HTMLElement {
  if (!root) root = document.getElementById('toast-root');
  return root ?? document.body;
}

export function toast(message: string, kind: 'info' | 'ok' | 'error' = 'info', timeout = 4200): void {
  const element = document.createElement('div');
  element.className = `toast${kind === 'error' ? ' is-error' : kind === 'ok' ? ' is-ok' : ''}`;
  element.innerHTML = kind === 'error' ? `<strong>Error</strong> ${escapeHtml(message)}` : message;
  host().appendChild(element);
  const remove = () => {
    element.style.opacity = '0';
    element.style.transform = 'translateY(4px)';
    setTimeout(() => element.remove(), 160);
  };
  const timer = setTimeout(remove, timeout);
  element.addEventListener('click', () => {
    clearTimeout(timer);
    remove();
  });
}

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => {
    switch (char) {
      case '&':
        return '&amp;';
      case '<':
        return '&lt;';
      case '>':
        return '&gt;';
      case '"':
        return '&quot;';
      default:
        return '&#39;';
    }
  });
}
