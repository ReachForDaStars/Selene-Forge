import * as Blockly from 'blockly/core';
import { Order, luaGenerator } from 'blockly/lua';

type LuaGenerator = typeof luaGenerator;

function svgIcon(glyph: string): string {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 14 14"><circle cx="7" cy="7" r="6.2" fill="rgba(255,255,255,0.10)"/><path d="${glyph}" fill="none" stroke="#dbe3f4" stroke-width="1.5" stroke-linecap="round"/></svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

export const ICON_PLUS = svgIcon('M4 7h6M7 4v6');
export const ICON_MINUS = svgIcon('M4 7h6');

/** Quote a Lua string literal using the generator helper. */
export function luaString(value: string): string {
  return luaGenerator.quote_(value);
}

export function fieldValue(block: Blockly.Block, name: string): string {
  return (block.getFieldValue(name) as string | null) ?? '';
}

export function codeOf(block: Blockly.Block, name: string, order: number = Order.NONE, fallback = 'nil'): string {
  return luaGenerator.valueToCode(block, name, order) || fallback;
}

export function bodyOf(block: Blockly.Block, name: string): string {
  return luaGenerator.statementToCode(block, name);
}

/** Collect every value input sharing a prefix, in render order. */
export function argCodes(block: Blockly.Block, prefix = 'ARG', fallback = 'nil'): string[] {
  const codes: string[] = [];
  for (const input of block.inputList) {
    if (!input.name || !input.name.startsWith(prefix) || !input.connection) continue;
    const target = input.connection.targetBlock();
    codes.push(target ? luaGenerator.valueToCode(block, input.name, Order.NONE) || fallback : fallback);
  }
  return codes;
}

export function argTargets(block: Blockly.Block, prefix = 'ARG'): Array<Blockly.Block | null> {
  const targets: Array<Blockly.Block | null> = [];
  for (const input of block.inputList) {
    if (!input.name || !input.name.startsWith(prefix) || !input.connection) continue;
    targets.push(input.connection.targetBlock());
  }
  return targets;
}

export interface ArityOptions {
  prefix?: string;
  controlName?: string;
  close?: string;
  min?: number;
  /** Label rendered before the +/− controls. */
  tail?: string;
  onDelta: (delta: number) => void;
}

/**
 * Rebuild a block's variadic value inputs. The control row always comes last so
 * append order stays valid after every mutation.
 */
export function rebuildValueInputs(block: Blockly.Block, count: number, options: ArityOptions): void {
  const prefix = options.prefix ?? 'ARG';
  const controlName = options.controlName ?? 'CTRL';
  const minimum = options.min ?? 0;

  if (block.getInput(controlName)) block.removeInput(controlName);
  for (const input of [...block.inputList]) {
    if (input.name && input.name.startsWith(prefix)) block.removeInput(input.name);
  }

  for (let index = 0; index < count; index += 1) {
    const input = block.appendValueInput(`${prefix}${index}`);
    if (index > 0) input.appendField(', ');
  }

  const control = block.appendDummyInput(controlName);
  if (options.close) control.appendField(options.close);
  if (options.tail) control.appendField(options.tail);
  control.appendField(
    new Blockly.FieldImage(ICON_MINUS, 13, 13, 'Remove', () => {
      options.onDelta(-1);
    }),
  );
  control.appendField(
    new Blockly.FieldImage(ICON_PLUS, 13, 13, 'Add', () => {
      options.onDelta(1);
    }),
  );

  (block as Blockly.Block & { arity_?: number }).arity_ = Math.max(minimum, count);
}

/** Read the persistent variadic count. */
export function currentArity(block: Blockly.Block, fallback = 1): number {
  const value = (block as Blockly.Block & { arity_?: number }).arity_;
  return typeof value === 'number' ? value : fallback;
}

/** Install the standard save/load extra-state handlers for variadic blocks. */
export function variadicState(block: Blockly.Block, rebuild: (count: number) => void): void {
  const target = block as Blockly.Block & {
    saveExtraState?: () => Record<string, unknown>;
    loadExtraState?: (state: Record<string, unknown>) => void;
    arity_?: number;
  };
  target.saveExtraState = () => ({ arity: target.arity_ ?? 1 });
  target.loadExtraState = (state) => {
    const arity = typeof state?.arity === 'number' ? state.arity : 1;
    target.arity_ = arity;
    rebuild(arity);
  };
}

/** A Lua identifier-safe slug. */
export function slug(value: string): string {
  return value.replace(/[^a-zA-Z0-9_]/g, '_');
}

/** Deterministic small hash for generated block type names. */
export function hashType(value: string): string {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

/** Multi-line C body as a Lua comment-safe single line summary. */
export function firstLine(value: string): string {
  const line = value.split('\n').find((entry) => entry.trim().length > 0) ?? '';
  return line.trim();
}

export type { LuaGenerator };
