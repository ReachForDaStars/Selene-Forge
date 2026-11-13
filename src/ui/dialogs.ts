import { escapeHtml } from './toast';

export interface ModalAction {
  label: string;
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger';
  keepOpen?: boolean;
  onClick?: (close: () => void) => void | Promise<void>;
}

export interface ModalOptions {
  title: string;
  subtitle?: string;
  body: HTMLElement;
  actions?: ModalAction[];
  wide?: boolean;
  narrow?: boolean;
  onClose?: () => void;
}

let activeClose: (() => void) | null = null;

export function closeActiveModal(): void {
  activeClose?.();
}

export function openModal(options: ModalOptions): { close: () => void; root: HTMLElement; modal: HTMLElement } {
  const root = document.getElementById('modal-root');
  if (!root) throw new Error('Modal root missing');
  closeActiveModal();
  root.innerHTML = '';
  root.hidden = false;

  const modal = document.createElement('div');
  modal.className = `modal${options.wide ? ' modal-wide' : ''}${options.narrow ? ' modal-narrow' : ''}`;
  modal.setAttribute('role', 'dialog');
  modal.setAttribute('aria-modal', 'true');

  const head = document.createElement('div');
  head.className = 'modal-head';
  const headText = document.createElement('div');
  headText.className = 'modal-head-text';
  const title = document.createElement('h2');
  title.textContent = options.title;
  headText.appendChild(title);
  if (options.subtitle) {
    const subtitle = document.createElement('p');
    subtitle.innerHTML = options.subtitle;
    headText.appendChild(subtitle);
  }
  head.appendChild(headText);

  const closeButton = document.createElement('button');
  closeButton.className = 'modal-close';
  closeButton.setAttribute('aria-label', 'Close');
  closeButton.textContent = '×';
  head.appendChild(closeButton);
  modal.appendChild(head);

  const body = document.createElement('div');
  body.className = 'modal-body';
  body.appendChild(options.body);
  modal.appendChild(body);

  let onKey: ((event: KeyboardEvent) => void) | null = null;
  let onBackdrop: ((event: MouseEvent) => void) | null = null;

  const close = () => {
    if (!root.hidden) {
      root.hidden = true;
      root.innerHTML = '';
    }
    if (onKey) document.removeEventListener('keydown', onKey, true);
    if (onBackdrop) root.removeEventListener('click', onBackdrop);
    activeClose = null;
    options.onClose?.();
  };
  activeClose = close;

  if (options.actions && options.actions.length > 0) {
    const foot = document.createElement('div');
    foot.className = 'modal-foot';
    for (const action of options.actions) {
      const button = document.createElement('button');
      button.className = `btn${action.variant === 'primary' ? ' btn-run' : action.variant === 'ghost' ? ' btn-ghost' : action.variant === 'danger' ? ' btn-danger' : ''}`;
      if (action.variant === 'danger') {
        button.style.borderColor = 'rgba(255,127,143,.4)';
        button.style.color = 'var(--danger)';
      }
      button.textContent = action.label;
      button.addEventListener('click', async () => {
        try {
          await action.onClick?.(close);
          if (!action.keepOpen) close();
        } catch (error) {
          console.error('[selene] modal action failed', error);
        }
      });
      foot.appendChild(button);
    }
    modal.appendChild(foot);
  }

  closeButton.addEventListener('click', close);
  root.appendChild(modal);

  onBackdrop = (event: MouseEvent) => {
    if (event.target === root) close();
  };
  root.addEventListener('click', onBackdrop);
  onKey = (event: KeyboardEvent) => {
    if (event.key === 'Escape') close();
  };
  document.addEventListener('keydown', onKey, true);

  return { close, root, modal };
}

export interface PromptOptions {
  title: string;
  subtitle?: string;
  label?: string;
  value?: string;
  placeholder?: string;
  hint?: string;
  confirmLabel?: string;
  validate?: (value: string) => string | null;
  extra?: HTMLElement;
}

export function promptDialog(options: PromptOptions): Promise<string | null> {
  return new Promise((resolve) => {
    const body = document.createElement('div');
    const field = document.createElement('div');
    field.className = 'field';
    const label = document.createElement('label');
    label.textContent = options.label ?? 'Value';
    const input = document.createElement('input');
    input.value = options.value ?? '';
    input.placeholder = options.placeholder ?? '';
    input.spellcheck = false;
    input.autocomplete = 'off';
    field.appendChild(label);
    field.appendChild(input);
    body.appendChild(field);
    if (options.extra) body.appendChild(options.extra);
    const hint = document.createElement('p');
    hint.className = 'field-hint';
    hint.innerHTML = options.hint ?? '';
    body.appendChild(hint);

    let settled = false;
    const finish = (value: string | null) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };

    const submit = (close: () => void) => {
      const error = options.validate?.(input.value) ?? null;
      if (error) {
        hint.innerHTML = `<span style="color:var(--danger)">${escapeHtml(error)}</span>`;
        input.focus();
        return;
      }
      finish(input.value.trim());
      close();
    };

    const modal = openModal({
      title: options.title,
      subtitle: options.subtitle,
      body,
      narrow: true,
      actions: [
        {
          label: options.confirmLabel ?? 'Create',
          variant: 'primary',
          keepOpen: true,
          onClick: (close) => submit(close),
        },
      ],
      onClose: () => finish(null),
    });

    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        submit(modal.close);
      }
    });

    setTimeout(() => {
      input.focus();
      const dot = input.value.lastIndexOf('.');
      if (dot > 0) input.setSelectionRange(0, dot);
      else input.select();
    }, 20);
  });
}

export function confirmDialog(options: {
  title: string;
  message: string;
  confirmLabel?: string;
  danger?: boolean;
}): Promise<boolean> {
  return new Promise((resolve) => {
    const body = document.createElement('div');
    const callout = document.createElement('div');
    callout.className = 'callout';
    callout.innerHTML = options.message;
    body.appendChild(callout);

    let settled = false;
    const finish = (value: boolean) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };

    openModal({
      title: options.title,
      body,
      narrow: true,
      actions: [
        {
          label: options.confirmLabel ?? 'Delete',
          variant: options.danger ? 'danger' : 'primary',
          keepOpen: true,
          onClick: (close) => {
            finish(true);
            close();
          },
        },
        {
          label: 'Cancel',
          variant: 'ghost',
          keepOpen: true,
          onClick: (close) => {
            finish(false);
            close();
          },
        },
      ],
      onClose: () => finish(false),
    });
  });
}
