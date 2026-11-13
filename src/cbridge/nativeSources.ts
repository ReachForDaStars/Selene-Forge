import type { ProjectFile } from '../core/types';

export interface NativeSource {
  path: string;
  source: string;
  origin: 'file' | 'block';
}

interface GraphBlock {
  type?: string;
  id?: string;
  fields?: Record<string, unknown>;
  inputs?: Record<string, unknown>;
  next?: { block?: GraphBlock };
  [key: string]: unknown;
}

function walkBlocks(blocks: unknown[], visit: (block: GraphBlock) => void): void {
  for (const entry of blocks) {
    if (!entry || typeof entry !== 'object') continue;
    const block = entry as GraphBlock;
    visit(block);
    if (block.next?.block) walkBlocks([block.next.block], visit);
    if (block.inputs) {
      for (const value of Object.values(block.inputs)) {
        if (!value || typeof value !== 'object') continue;
        const input = value as { block?: GraphBlock; shadow?: GraphBlock };
        if (input.block) walkBlocks([input.block], visit);
        if (input.shadow) walkBlocks([input.shadow], visit);
      }
    }
  }
}

function field(block: GraphBlock, name: string): string {
  return String(block.fields?.[name] ?? '');
}

/** C sources embedded in `Define C Function` / `Define Struct` blocks. */
export function collectBlockNativeSources(files: ProjectFile[]): NativeSource[] {
  const sources: NativeSource[] = [];
  for (const file of files) {
    if (file.kind !== 'lua' || !file.graph) continue;
    const container = file.graph as { blocks?: { blocks?: unknown[] } };
    const top = container.blocks?.blocks;
    if (!Array.isArray(top)) continue;
    walkBlocks(top, (block) => {
      if (block.type === 'ffi_define_function') {
        const ret = field(block, 'RET') || 'int';
        const name = field(block, 'NAME') || 'c_helper';
        const params = field(block, 'PARAMS');
        const body = field(block, 'BODY');
        sources.push({
          path: `native/${file.path}#${name}`,
          origin: 'block',
          source: `${ret} ${name}(${params}) {\n${body}\n}\n`,
        });
      }
      if (block.type === 'ffi_define_struct') {
        const name = field(block, 'NAME') || 'Point';
        const fields = field(block, 'FIELDS');
        sources.push({
          path: `native/${file.path}#struct:${name}`,
          origin: 'block',
          source: `typedef struct {\n${fields}\n} ${name};\n`,
        });
      }
    });
  }
  return sources;
}

/** All native translation units: project `.c`/`.cpp` files plus block-embedded C. */
export function collectNativeSources(files: ProjectFile[]): NativeSource[] {
  const fileSources = files
    .filter((file) => file.kind === 'c' || file.kind === 'cpp')
    .map<NativeSource>((file) => ({ path: file.path, source: file.content, origin: 'file' }));
  return [...fileSources, ...collectBlockNativeSources(files)];
}
