import type { Chunk, Expr, Stat } from './ast';
import { walk } from './ast';
import { moduleNameForPath } from '../core/paths';
import { tryParseLua } from './parser';
import type { ModuleExport, ModuleInfo, ProjectFile } from '../core/types';

export interface FileAnalysis {
  module: ModuleInfo;
  ast: Chunk | null;
  error: string | null;
  /** Names declared as local functions at file scope, with their signatures. */
  localFunctions: Map<string, { params: string[]; method: boolean }>;
}

function keyOf(expr: Expr): string | null {
  if (expr.type === 'String') return expr.value;
  if (expr.type === 'Name') return expr.name;
  if (expr.type === 'Number') return String(expr.value);
  return null;
}

function isEmptyTable(expr: Expr | undefined): boolean {
  return Boolean(expr && expr.type === 'Table' && expr.fields.length === 0);
}

function isTableLiteral(expr: Expr | undefined): expr is Extract<Expr, { type: 'Table' }> {
  return Boolean(expr && expr.type === 'Table');
}

function signatureOf(expr: Expr): string[] | null {
  return expr.type === 'Function' ? expr.params : null;
}

/** Inspect a Lua file and derive its module contract. */
export function analyzeLuaFile(path: string, source: string): FileAnalysis {
  const moduleName = moduleNameForPath(path);
  const base: ModuleInfo = {
    path,
    moduleName,
    label: moduleName.split('.').pop() ?? moduleName,
    exports: [],
    requires: [],
    isPackage: path.startsWith('packages/'),
    error: null,
  };

  const { ast, error } = tryParseLua(source);
  if (!ast) {
    return {
      module: { ...base, error: error?.message ?? 'Unable to parse Lua source.' },
      ast: null,
      error: error?.message ?? 'Unable to parse Lua source.',
      localFunctions: new Map(),
    };
  }

  const body = ast.body;
  const tableNames = new Set<string>();
  const localFunctions = new Map<string, { params: string[]; method: boolean }>();
  let returnedModuleName: string | null = null;
  let returnedTable: Extract<Expr, { type: 'Table' }> | null = null;

  for (const stat of body) {
    if (stat.type === 'Local' || stat.type === 'Assign') {
      const names = stat.type === 'Local' ? stat.names : stat.targets.filter((target) => target.type === 'Name').map((target) => (target as { name: string }).name);
      names.forEach((name, index) => {
        if (isEmptyTable(stat.exprs[index]) || isTableLiteral(stat.exprs[0]) === false) {
          /* handled below */
        }
      });
      if (stat.type === 'Local') {
        stat.names.forEach((name, index) => {
          if (isEmptyTable(stat.exprs[index])) tableNames.add(name);
        });
      } else if (stat.targets.length === 1 && stat.targets[0].type === 'Name' && isEmptyTable(stat.exprs[0])) {
        tableNames.add(stat.targets[0].name);
      }
    }
    if (stat.type === 'FunctionDecl' && stat.local && stat.target.length === 1) {
      localFunctions.set(stat.target[0], { params: stat.params, method: Boolean(stat.method) });
    }
    if (stat.type === 'Return') {
      const first = stat.exprs[0];
      if (first?.type === 'Name') returnedModuleName = first.name;
      if (first && first.type === 'Table') returnedTable = first;
    }
  }

  // Pick the table that acts as the module namespace.
  const memberAssigned = new Set<string>();
  const collectMemberBases = (stat: Stat) => {
    if (stat.type === 'Assign') {
      for (const target of stat.targets) {
        if (target.type === 'Index' && target.base.type === 'Name') memberAssigned.add(target.base.name);
      }
    }
    if (stat.type === 'FunctionDecl' && stat.target.length >= 2) memberAssigned.add(stat.target[0]);
  };
  body.forEach(collectMemberBases);

  let moduleVar: string | null = null;
  if (returnedModuleName && tableNames.has(returnedModuleName)) moduleVar = returnedModuleName;
  else {
    const candidates = [...memberAssigned].filter((name) => tableNames.has(name) || name === 'M' || name === 'Module');
    if (candidates.length === 1) moduleVar = candidates[0];
  }

  const exports = new Map<string, ModuleExport>();

  const addFunction = (name: string, params: string[], method: boolean) => {
    exports.set(name, { name, params, kind: 'function', method });
  };
  const addValue = (name: string) => {
    if (!exports.has(name)) exports.set(name, { name, params: [], kind: 'value', method: false });
  };

  for (const stat of body) {
    if (stat.type === 'FunctionDecl' && stat.target.length >= 2 && moduleVar && stat.target[0] === moduleVar) {
      const name = stat.method ?? stat.target[stat.target.length - 1];
      addFunction(name, stat.params, Boolean(stat.method));
    }
    if (stat.type === 'Assign' && moduleVar) {
      for (const target of stat.targets) {
        if (target.type !== 'Index') continue;
        const base = target.base;
        if (base.type !== 'Name' || base.name !== moduleVar) continue;
        const key = keyOf(target.key);
        if (!key) continue;
        const valueIndex = stat.targets.indexOf(target);
        const value = stat.exprs[valueIndex] ?? stat.exprs[0];
        const params = value ? signatureOf(value) : null;
        if (params) addFunction(key, params, false);
        else addValue(key);
      }
    }
  }

  if (returnedTable) {
    let arrayIndex = 0;
    for (const field of returnedTable.fields) {
      if (field.kind === 'array') {
        const params = signatureOf(field.value);
        if (params) {
          arrayIndex += 1;
          addFunction(String(arrayIndex), params, false);
        }
      } else {
        const name = field.kind === 'named' ? field.key : keyOf(field.key);
        if (!name) continue;
        const params = signatureOf(field.value);
        if (params) addFunction(name, params, false);
        else if (field.value.type === 'Name' && localFunctions.has(field.value.name)) {
          const signature = localFunctions.get(field.value.name)!;
          addFunction(name, signature.params, signature.method);
        } else addValue(name);
      }
    }
  }

  const requires: string[] = [];
  walk(ast, (node) => {
    if (node.type === 'Call' && node.base.type === 'Name' && node.base.name === 'require' && node.args[0]?.type === 'String') {
      requires.push(node.args[0].value);
    }
  });

  return {
    module: { ...base, exports: [...exports.values()], requires: [...new Set(requires)] },
    ast,
    error: null,
    localFunctions,
  };
}

export interface ProjectAnalysis {
  modules: ModuleInfo[];
  byModuleName: Map<string, ModuleInfo>;
}

export function analyzeProject(files: ProjectFile[]): ProjectAnalysis {
  const modules: ModuleInfo[] = [];
  for (const file of files) {
    if (file.kind !== 'lua') continue;
    modules.push(analyzeLuaFile(file.path, file.content).module);
  }
  modules.sort((a, b) => a.moduleName.localeCompare(b.moduleName));
  const byModuleName = new Map(modules.map((module) => [module.moduleName, module]));
  return { modules, byModuleName };
}

/** Names a module can be required by, e.g. `packages.json` and `json`. */
export function requireNames(module: ModuleInfo): string[] {
  const names = new Set<string>([module.moduleName]);
  if (module.isPackage) {
    names.add(module.moduleName.replace(/^packages\./, ''));
  }
  return [...names];
}
