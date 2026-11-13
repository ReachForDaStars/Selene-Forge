import type { ProjectAnalysis } from '../lua/analyze';
import { ensureModuleBlocks } from './dynamicModules';
import type { ModuleInfo } from '../core/types';

type ToolboxItem = Record<string, unknown>;

function block(type: string, extra: Record<string, unknown> = {}): ToolboxItem {
  return { kind: 'block', type, ...extra };
}

function category(name: string, style: string, contents: ToolboxItem[], expanded = false): ToolboxItem {
  return { kind: 'category', name, style, contents, expanded };
}

/** A shadow number block for numeric sockets. */
function numberShadow(value: number): ToolboxItem {
  return { shadow: { type: 'math_number', fields: { NUM: value } } };
}

function textShadow(value: string): ToolboxItem {
  return { shadow: { type: 'text', fields: { TEXT: value } } };
}

const VARIABLE_SHADOW = (name: string): ToolboxItem => ({ shadow: { type: 'lua_var_get', fields: { NAME: name } } });

function moduleCategory(module: ModuleInfo): ToolboxItem {
  const entries = ensureModuleBlocks([module]);
  const contents: ToolboxItem[] = [block('lua_require', { fields: { MODULE: module.moduleName } })];
  for (const entry of entries) {
    contents.push(block(entry.type));
  }
  if (module.exports.some((entry) => entry.kind === 'value')) {
    contents.push(block('lua_export', { fields: { MODULE: 'M', NAME: module.exports.find((e) => e.kind === 'value')?.name ?? 'value' } }));
  }
  return {
    kind: 'category',
    name: module.isPackage ? `📦 ${module.label}` : module.label,
    style: 'modules_category',
    contents,
  };
}

export interface ToolboxOptions {
  analysis: ProjectAnalysis;
  /** Called from toolbox buttons. */
  onCreateNativeFunction: string;
  onCreateNativeStruct: string;
}

export function buildToolbox(options: ToolboxOptions): Record<string, unknown> {
  const { analysis } = options;
  const projectModules = analysis.modules.filter((module) => !module.isPackage);
  const packageModules = analysis.modules.filter((module) => module.isPackage);

  const moduleContents: ToolboxItem[] = [
    block('lua_require', { fields: { MODULE: projectModules[0]?.moduleName ?? 'json' } }),
    block('lua_export'),
    block('lua_module_table'),
  ];
  for (const module of projectModules) moduleContents.push(moduleCategory(module));

  const packageContents: ToolboxItem[] = [];
  if (packageModules.length === 0) {
    packageContents.push(block('lua_require', { fields: { MODULE: 'json' } }));
  }
  for (const module of packageModules) packageContents.push(moduleCategory(module));

  return {
    kind: 'categoryToolbox',
    contents: [
      category(
        'Control Flow',
        'control_category',
        [
          block('controls_if'),
          block('lua_while', { inputs: { COND: { shadow: { type: 'logic_boolean', fields: { BOOL: 'TRUE' } } } } }),
          block('lua_repeat'),
          block('lua_for', {
            inputs: { FROM: numberShadow(1), TO: numberShadow(10) },
          }),
          block('lua_for_in', {
            fields: { NAMES: 'k, v' },
            inputs: {
              EXPR: {
                shadow: {
                  type: 'lua_call_value',
                  fields: { NAME: 'pairs' },
                  inputs: { ARG0: VARIABLE_SHADOW('t') },
                },
              },
            },
          }),
          block('lua_do'),
          block('lua_break'),
        ],
        true,
      ),
      category('Variables & Scope', 'vars_category', [
        block('lua_local', { fields: { NAMES: 'x' }, inputs: { VALUE: numberShadow(0) } }),
        block('lua_assign', { fields: { TARGET: 'x' }, inputs: { VALUE: numberShadow(1) } }),
        block('lua_var_get'),
        block('lua_module_table'),
        block('lua_comment'),
      ]),
      category('Functions & Closures', 'funcs_category', [
        block('lua_def_function'),
        block('lua_def_local_function'),
        block('lua_function_expr'),
        block('lua_call', { fields: { NAME: 'print' }, inputs: { ARG0: textShadow('hello') } }),
        block('lua_call_value', { fields: { NAME: 'math.floor' }, inputs: { ARG0: numberShadow(1.5) } }),
        block('lua_return'),
      ]),
      category('Tables & Metatables', 'tables_category', [
        block('lua_table_array', {
          extraState: { arity: 2 },
          inputs: { ARG0: numberShadow(1), ARG1: numberShadow(2) },
        }),
        block('lua_table_dict', {
          fields: { K0: 'name' },
          inputs: { ARG0: textShadow('Lua') },
        }),
        block('lua_field', { fields: { FIELD: 'field' }, inputs: { TABLE: VARIABLE_SHADOW('t') } }),
        block('lua_index', { inputs: { TABLE: VARIABLE_SHADOW('t'), KEY: numberShadow(1) } }),
        block('lua_index_set', { inputs: { TABLE: VARIABLE_SHADOW('t'), KEY: numberShadow(1), VALUE: numberShadow(0) } }),
        block('lua_setmetatable'),
        block('lua_len', { inputs: { VALUE: VARIABLE_SHADOW('t') } }),
      ]),
      {
        kind: 'category',
        name: 'Modules & Packages',
        style: 'modules_category',
        contents: moduleContents,
        expanded: true,
      },
      {
        kind: 'category',
        name: 'Packages',
        style: 'modules_category',
        contents: packageContents,
      },
      {
        kind: 'category',
        name: 'C / C++ Bridge',
        style: 'native_category',
        contents: [
          { kind: 'button', text: '＋ New C function…', callbackKey: options.onCreateNativeFunction },
          { kind: 'button', text: '＋ New struct…', callbackKey: options.onCreateNativeStruct },
          { kind: 'sep' },
          block('ffi_call'),
          block('ffi_register'),
          block('ffi_struct_new', {
            inputs: {
              TABLE: {
                shadow: {
                  type: 'lua_table_dict',
                  extraState: { arity: 2 },
                  fields: { K0: 'x', K1: 'y' },
                  inputs: { ARG0: numberShadow(0), ARG1: numberShadow(0) },
                },
              },
            },
          }),
          block('ffi_struct_to_lua'),
          { kind: 'sep' },
          block('ffi_define_function'),
          block('ffi_define_struct'),
        ],
        expanded: true,
      },
      category('Math, Logic & StdLib', 'stdlib_category', [
        block('math_number', { fields: { NUM: 1 } }),
        block('math_arithmetic', { inputs: { A: numberShadow(1), B: numberShadow(1) } }),
        block('math_modulo', { inputs: { DIVIDEND: numberShadow(10), DIVISOR: numberShadow(3) } }),
        block('logic_compare', { inputs: { A: numberShadow(1), B: numberShadow(1) } }),
        block('logic_operation'),
        block('lua_unop', { inputs: { VALUE: VARIABLE_SHADOW('x') } }),
        block('lua_bitwise'),
        block('lua_idiv'),
        block('lua_concat'),
        block('lua_nil'),
        block('lua_vararg'),
        { kind: 'sep' },
        block('lua_print', { inputs: { ARG0: textShadow('hello from Selene') } }),
        block('lua_stdlib_value', {
          fields: { FN: 'string.format' },
          inputs: { ARG0: textShadow('%s = %d') },
        }),
        block('text', { fields: { TEXT: 'text' } }),
        block('logic_boolean'),
      ]),
    ],
  };
}

/** The toolbox shown before a project has been analysed. */
export function emptyAnalysis(): ProjectAnalysis {
  return { modules: [], byModuleName: new Map() };
}

/**
 * Blockly's toolbox parser is strict about block types. Any placeholder entries
 * (defensive) are stripped before the toolbox reaches the workspace.
 */
export function sanitizeToolbox(toolbox: Record<string, unknown>): Record<string, unknown> {
  const walk = (items: unknown[]): unknown[] =>
    items
      .filter((item) => Boolean(item) && typeof item === 'object')
      .map((item) => {
        const entry = item as Record<string, unknown>;
        if (Array.isArray(entry.contents)) {
          return { ...entry, contents: walk(entry.contents) };
        }
        return entry;
      })
      .filter((item) => (item as Record<string, unknown>).kind !== 'block' || Boolean((item as Record<string, unknown>).type));
  const contents = Array.isArray(toolbox.contents) ? walk(toolbox.contents) : [];
  return { ...toolbox, contents };
}
