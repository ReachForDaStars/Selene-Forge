import { escapeHtml } from './toast';
import type { RuntimeLog } from '../core/types';

export type ConsoleStatus = 'idle' | 'running' | 'ok' | 'error';

const LANE_LABEL: Record<RuntimeLog['lane'], string> = {
  lua: 'lua',
  c: 'c',
  sys: 'sys',
  ok: 'ok',
  err: 'err',
};

const LANE_CLASS: Record<RuntimeLog['lane'], string> = {
  lua: 'lane-lua',
  c: 'lane-c',
  sys: 'lane-sys',
  ok: 'lane-ok',
  err: 'lane-err',
};

export class ConsoleView {
  private body: HTMLElement;
  private summary: HTMLElement;
  private dot: HTMLElement;
  private entries: RuntimeLog[] = [];
  private seq = 0;
  private startedAt = performance.now();

  constructor(body: HTMLElement, summary: HTMLElement, dot: HTMLElement) {
    this.body = body;
    this.summary = summary;
    this.dot = dot;
    this.renderPlaceholder();
  }

  private renderPlaceholder(): void {
    this.body.innerHTML = `<div class="console-empty"><span>Ready.</span> Press <kbd>⌘/Ctrl</kbd> <kbd>Enter</kbd> to run the project — print() and C printf() output appear here.</div>`;
  }

  reset(): void {
    this.entries = [];
    this.seq = 0;
    this.startedAt = performance.now();
    this.body.innerHTML = '';
  }

  clear(): void {
    this.entries = [];
    this.renderPlaceholder();
    this.setStatus('idle');
    this.summary.textContent = 'idle';
  }

  add(lane: RuntimeLog['lane'], text: string, trace?: string): RuntimeLog {
    this.seq += 1;
    const elapsed = performance.now() - this.startedAt;
    const entry: RuntimeLog = {
      id: this.seq,
      lane,
      text,
      trace,
      time: `${elapsed.toFixed(0)}ms`,
    };
    this.entries.push(entry);
    const empty = this.body.querySelector('.console-empty');
    if (empty) empty.remove();

    const row = document.createElement('div');
    row.className = `log-entry${lane === 'err' ? ' is-error' : lane === 'ok' ? ' is-ok' : lane === 'sys' ? ' is-muted' : ''}`;
    const time = document.createElement('span');
    time.className = 'log-time';
    time.textContent = entry.time;
    const badge = document.createElement('span');
    badge.className = `log-lane ${LANE_CLASS[lane]}`;
    badge.textContent = LANE_LABEL[lane];
    const body = document.createElement('span');
    body.className = 'log-text';
    body.innerHTML = escapeHtml(text);
    if (trace) {
      const traceElement = document.createElement('span');
      traceElement.className = 'trace';
      traceElement.textContent = trace;
      body.appendChild(traceElement);
    }
    row.append(time, badge, body);
    this.body.appendChild(row);
    this.body.scrollTop = this.body.scrollHeight;
    return entry;
  }

  setStatus(status: ConsoleStatus): void {
    this.dot.className = `dot-status is-${status}`;
  }

  setSummary(text: string): void {
    this.summary.textContent = text;
  }

  asText(): string {
    return this.entries.map((entry) => `[${entry.time}] ${entry.lane}: ${entry.text}${entry.trace ? `\n${entry.trace}` : ''}`).join('\n');
  }
}
