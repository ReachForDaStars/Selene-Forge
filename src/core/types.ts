/** Shared domain model for Selene Forge. */

export type FileKind = 'lua' | 'c' | 'cpp' | 'h' | 'json';

/** Blockly workspace serialization payload (verbatim). */
export type BlockGraph = {
  languageVersion?: number;
  blocks?: unknown[];
  [key: string]: unknown;
};

export interface ProjectFile {
  id: string;
  /** Virtual path, always POSIX style and relative to the project root. */
  path: string;
  content: string;
  kind: FileKind;
  /** Block graph for `.lua` files. `null` means the file has no visual graph yet. */
  graph: BlockGraph | null;
  /** Custom Code Override: manual code is authoritative and blocks are frozen. */
  locked: boolean;
}

export interface ProjectSnapshot {
  version: number;
  name: string;
  files: ProjectFile[];
  folders: string[];
  openTabs: string[];
  activePath: string;
  installed: string[];
  savedAt: number;
}

export interface ModuleExport {
  name: string;
  params: string[];
  kind: 'function' | 'value';
  /** True when exported as `function M:name(...)`, i.e. takes implicit `self`. */
  method: boolean;
}

export interface ModuleInfo {
  path: string;
  /** Dotted require name, e.g. `packages.json`. */
  moduleName: string;
  label: string;
  exports: ModuleExport[];
  requires: string[];
  isPackage: boolean;
  error: string | null;
}

export interface CFuncParam {
  type: string;
  name: string;
}

export interface CFunctionInfo {
  name: string;
  returnType: string;
  params: CFuncParam[];
  source: string;
  line: number;
}

export interface CStructInfo {
  name: string;
  fields: CFuncParam[];
  source: string;
  line: number;
}

export interface CBridgeInfo {
  functions: CFunctionInfo[];
  structs: CStructInfo[];
  errors: string[];
  sourceFiles: string[];
  /** C sources contributed by visual blocks, keyed by block id. */
  blockSources: string[];
}

export interface RuntimeLog {
  id: number;
  lane: 'lua' | 'c' | 'sys' | 'ok' | 'err';
  text: string;
  trace?: string;
  time: string;
}

export interface ExecutionResult {
  ok: boolean;
  logs: RuntimeLog[];
  error: { message: string; trace?: string } | null;
  durationMs: number;
  /** Total value returned by the main chunk, rendered. */
  returnValue: string | null;
  stats: {
    files: number;
    modules: number;
    nativeFunctions: number;
    luaMs: number;
    cMs: number;
    memoryKb?: number;
  };
}

export type SyncMode = 'sync' | 'locked' | 'code';
