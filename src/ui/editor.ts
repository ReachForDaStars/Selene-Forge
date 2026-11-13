import { basicSetup } from 'codemirror';
import { Compartment, EditorState } from '@codemirror/state';
import { EditorView, keymap } from '@codemirror/view';
import { indentWithTab } from '@codemirror/commands';
import { HighlightStyle, StreamLanguage, syntaxHighlighting } from '@codemirror/language';
import { lua } from '@codemirror/legacy-modes/mode/lua';
import { cpp } from '@codemirror/lang-cpp';
import { json } from '@codemirror/lang-json';
import { tags as t } from '@lezer/highlight';
import type { Extension } from '@codemirror/state';
import type { FileKind } from '../core/types';

const seleneTheme = EditorView.theme(
  {
    '&': { color: '#dbe4f3', backgroundColor: '#0a0e16', height: '100%' },
    '.cm-content': { caretColor: '#aab7ff' },
    '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection': {
      backgroundColor: 'rgba(122, 145, 255, 0.22)',
    },
    '.cm-gutters': { backgroundColor: '#090d14', color: '#45516a', border: 'none' },
    '.cm-activeLineGutter': { backgroundColor: 'rgba(170, 183, 255, 0.07)', color: '#9fb0d8' },
    '.cm-activeLine': { backgroundColor: 'rgba(170, 183, 255, 0.045)' },
    '.cm-scroller': { fontFamily: "ui-monospace, 'SFMono-Regular', 'JetBrains Mono', Menlo, Consolas, monospace" },
    '.cm-foldPlaceholder': { backgroundColor: '#182132', border: '1px solid #202a3b', color: '#9aa5ba' },
  },
  { dark: true },
);

const seleneHighlight = HighlightStyle.define([
  { tag: [t.keyword, t.controlKeyword, t.moduleKeyword], color: '#c7a6ff' },
  { tag: [t.operator, t.operatorKeyword], color: '#8fd0ff' },
  { tag: [t.string, t.special(t.string)], color: '#9fe8b8' },
  { tag: [t.number, t.bool, t.null], color: '#ffc98b' },
  { tag: [t.comment, t.blockComment, t.lineComment], color: '#5c6b85', fontStyle: 'italic' },
  { tag: [t.function(t.variableName), t.function(t.propertyName)], color: '#8fb8ff' },
  { tag: [t.variableName, t.propertyName], color: '#dbe4f3' },
  { tag: [t.typeName, t.className, t.namespace], color: '#7be8c3' },
  { tag: [t.definition(t.variableName), t.definition(t.propertyName)], color: '#e7ecf6' },
  { tag: [t.punctuation, t.bracket, t.separator], color: '#7d8aa3' },
  { tag: t.invalid, color: '#ff7f8f' },
]);

function languageFor(kind: FileKind): Extension {
  if (kind === 'c' || kind === 'cpp' || kind === 'h') return cpp();
  if (kind === 'json') return json();
  return StreamLanguage.define(lua);
}

export interface EditorCallbacks {
  onChange?: (value: string) => void;
  onCursor?: (line: number, column: number) => void;
}

export class CodeEditor {
  private view: EditorView;
  private language = new Compartment();
  private callbacks: EditorCallbacks;
  private silent = false;
  private changeTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(host: HTMLElement, callbacks: EditorCallbacks) {
    this.callbacks = callbacks;
    const state = EditorState.create({
      doc: '',
      extensions: [
        basicSetup,
        keymap.of([indentWithTab]),
        seleneTheme,
        syntaxHighlighting(seleneHighlight),
        this.language.of(languageFor('lua')),
        EditorView.lineWrapping,
        EditorView.updateListener.of((update) => {
          if (update.docChanged && !this.silent) {
            if (this.changeTimer) clearTimeout(this.changeTimer);
            this.changeTimer = setTimeout(() => {
              this.changeTimer = null;
              this.callbacks.onChange?.(update.state.doc.toString());
            }, 220);
          }
          if (update.selectionSet || update.docChanged) {
            const head = update.state.selection.main.head;
            const line = update.state.doc.lineAt(head);
            this.callbacks.onCursor?.(line.number, head - line.from + 1);
          }
        }),
      ],
    });
    this.view = new EditorView({ state, parent: host });
  }

  setLanguage(kind: FileKind): void {
    this.view.dispatch({ effects: this.language.reconfigure(languageFor(kind)) });
  }

  setValue(value: string, options: { silent?: boolean } = {}): void {
    if (this.view.state.doc.toString() === value) return;
    this.silent = true;
    this.view.dispatch({ changes: { from: 0, to: this.view.state.doc.length, insert: value } });
    this.silent = false;
    if (!options.silent) this.callbacks.onChange?.(value);
  }

  getValue(): string {
    return this.view.state.doc.toString();
  }

  focus(): void {
    this.view.focus();
  }

  refresh(): void {
    this.view.requestMeasure();
  }

  scrollToTop(): void {
    this.view.dispatch({ selection: { anchor: 0 }, scrollIntoView: true });
  }
}
