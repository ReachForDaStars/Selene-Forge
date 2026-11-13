import * as Blockly from 'blockly/core';
import { luaGenerator, Order } from 'blockly/lua';
import type { ModuleExport, ModuleInfo } from '../core/types';
import { hashType } from './shared';

export interface ModuleBlockEntry {
  type: string;
  module: ModuleInfo;
  exportInfo: ModuleExport;
  params: string[];
}

const registry = new Map<string, ModuleBlockEntry>();

export function moduleBlockType(moduleName: string, exportName: string): string {
  return `modfn_${hashType(`${moduleName}::${exportName}`)}`;
}

export function moduleBlockEntry(module: ModuleInfo, exportInfo: ModuleExport): ModuleBlockEntry {
  const type = moduleBlockType(module.moduleName, exportInfo.name);
  const existing = registry.get(type);
  if (existing) return existing;
  return {
    type,
    module,
    exportInfo,
    params: exportInfo.method ? ['self', ...exportInfo.params] : exportInfo.params,
  };
}

function defineModuleBlock(entry: ModuleBlockEntry): void {
  const { type, module, exportInfo, params } = entry;
  if (Blockly.Blocks[type]) return;

  Blockly.Blocks[type] = {
    init(this: Blockly.Block) {
      const label = `require("${module.moduleName}").${exportInfo.name}`;
      const head = this.appendDummyInput('HEAD').appendField(label).appendField('(');
      params.forEach((param, index) => {
        const input = this.appendValueInput(`ARG${index}`);
        if (index > 0) input.appendField(', ');
        input.appendField(new Blockly.FieldLabel(param));
      });
      if (params.length === 0) head.appendField(')');
      else this.appendDummyInput('CTRL').appendField(')');
      this.setOutput(true, null);
      this.setStyle('modules_style');
      this.setTooltip(`${module.moduleName} · ${exportInfo.name}(${params.join(', ')})`);
    },
  };

  if (luaGenerator.forBlock[type]) return;
  luaGenerator.forBlock[type] = (block, generator) => {
    const args: string[] = [];
    for (let index = 0; index < params.length; index += 1) {
      args.push(generator.valueToCode(block, `ARG${index}`, Order.NONE) || 'nil');
    }
    const call = `require(${generator.quote_(module.moduleName)}).${exportInfo.name}(${args.join(', ')})`;
    return [call, Order.HIGH];
  };
}

/** Register blocks for every currently exported module function. */
export function ensureModuleBlocks(modules: ModuleInfo[]): ModuleBlockEntry[] {
  const entries: ModuleBlockEntry[] = [];
  for (const module of modules) {
    for (const exportInfo of module.exports) {
      if (exportInfo.kind !== 'function') continue;
      const entry = moduleBlockEntry(module, exportInfo);
      registry.set(entry.type, entry);
      defineModuleBlock(entry);
      entries.push(entry);
    }
  }
  return entries;
}

export function findModuleEntry(type: string): ModuleBlockEntry | undefined {
  return registry.get(type);
}
