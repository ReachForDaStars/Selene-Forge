import { createCContext, parseCProgram, type CContext } from './parser';
import { CInterpreter } from './interp';
import { CError, describeType, type CProgram, type FuncDef, type StructDef } from './types';
import type { CBridgeInfo, CFunctionInfo, CStructInfo } from '../core/types';
import type { NativeSource } from './nativeSources';

export interface CBridgeBuild {
  info: CBridgeInfo;
  interpreter: CInterpreter;
  context: CContext;
  programs: CProgram[];
}

function sourceLabel(source: NativeSource): string {
  return source.origin === 'block' ? source.path.split('#')[0]?.replace(/^native\//, '') || 'blocks' : source.path;
}

/**
 * Compile every native translation unit in one shared namespace. All C files and
 * block-embedded C definitions behave like a single translation unit, which is
 * what the C bridge guarantees.
 */
export function buildCBridge(sources: NativeSource[], print: (text: string) => void): CBridgeBuild {
  const context = createCContext();
  const programs: CProgram[] = [];
  const errors: string[] = [];

  for (const source of sources) {
    try {
      programs.push(parseCProgram(sourceLabel(source), source.source, context));
    } catch (error) {
      if (error instanceof CError) errors.push(error.format());
      else errors.push(`${source.path}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  const interpreter = new CInterpreter(context, programs, { print, maxSteps: 4_000_000 });
  errors.push(...interpreter.errors);

  const functions: CFunctionInfo[] = interpreter.functionList.map((fn: FuncDef) => ({
    name: fn.name,
    returnType: describeType(fn.returnType),
    params: fn.params.map((param) => ({ type: describeType(param.type), name: param.name })),
    source: fn.file,
    line: fn.line,
  }));

  const structs: CStructInfo[] = [...context.structs.values()]
    .filter((entry: StructDef) => entry.fields.length > 0)
    .map((entry) => ({
      name: entry.name,
      fields: entry.fields.map((field) => ({ type: describeType(field.type), name: field.name })),
      source: sources.find((source) => source.source.includes(entry.name))?.path ?? 'native',
      line: 1,
    }));

  const info: CBridgeInfo = {
    functions,
    structs,
    errors,
    sourceFiles: sources.filter((source) => source.origin === 'file').map((source) => source.path),
    blockSources: sources.filter((source) => source.origin === 'block').map((source) => source.path),
  };

  return { info, interpreter, context, programs };
}

/** Lightweight signature scan used for UI lists before a full compile. */
export function describeSignature(fn: CFunctionInfo): string {
  return `${fn.returnType} ${fn.name}(${fn.params.map((param) => `${param.type} ${param.name}`).join(', ')})`;
}
