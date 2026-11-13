import * as Blockly from 'blockly/core';
import { FieldMultilineInput } from '@blockly/field-multilineinput';
import { Order, luaGenerator } from 'blockly/lua';
import {
  argCodes,
  bodyOf,
  codeOf,
  currentArity,
  fieldValue,
  rebuildValueInputs,
  variadicState,
} from './shared';

let installed = false;

/** C function signatures the FFI blocks can call; set by the bridge manager. */
let nativeFunctions: Array<{ name: string; returnType: string; params: Array<{ type: string; name: string }> }> = [];
let nativeStructs: string[] = ['Point'];

export function setNativeRegistry(
  functions: Array<{ name: string; returnType: string; params: Array<{ type: string; name: string }> }>,
  structs: string[],
): void {
  nativeFunctions = functions;
  nativeStructs = structs.length ? structs : ['Point'];
}

function nativeFunctionOptions(): Array<[string, string]> {
  if (nativeFunctions.length === 0) return [['(no C functions found)', '']];
  return nativeFunctions.map((fn) => [`${fn.name}  ·  ${fn.returnType}`, fn.name]);
}

function structOptions(): Array<[string, string]> {
  return nativeStructs.map((name) => [name, name]);
}

const C_TYPES: Array<[string, string]> = [
  ['int', 'int'],
  ['long', 'long'],
  ['double', 'double'],
  ['float', 'float'],
  ['char*', 'char*'],
  ['void', 'void'],
];

/* ── Standard library catalogue ──────────────────────────────────────────── */

interface StdlibEntry {
  label: string;
  code: string;
  min: number;
  max: number;
}

const STDLIB: StdlibEntry[] = [
  { label: 'string.format(fmt, …)', code: 'string.format', min: 1, max: 8 },
  { label: 'string.rep(s, n)', code: 'string.rep', min: 2, max: 3 },
  { label: 'string.sub(s, i, j)', code: 'string.sub', min: 2, max: 3 },
  { label: 'string.upper(s)', code: 'string.upper', min: 1, max: 1 },
  { label: 'string.lower(s)', code: 'string.lower', min: 1, max: 1 },
  { label: 'string.len(s)', code: 'string.len', min: 1, max: 1 },
  { label: 'string.find(s, pat)', code: 'string.find', min: 2, max: 4 },
  { label: 'string.match(s, pat)', code: 'string.match', min: 2, max: 3 },
  { label: 'string.gsub(s, pat, rep)', code: 'string.gsub', min: 3, max: 4 },
  { label: 'string.byte(s, i)', code: 'string.byte', min: 1, max: 3 },
  { label: 'string.char(…codes)', code: 'string.char', min: 1, max: 8 },
  { label: 'math.floor(x)', code: 'math.floor', min: 1, max: 1 },
  { label: 'math.ceil(x)', code: 'math.ceil', min: 1, max: 1 },
  { label: 'math.abs(x)', code: 'math.abs', min: 1, max: 1 },
  { label: 'math.sqrt(x)', code: 'math.sqrt', min: 1, max: 1 },
  { label: 'math.max(…)', code: 'math.max', min: 2, max: 8 },
  { label: 'math.min(…)', code: 'math.min', min: 2, max: 8 },
  { label: 'math.random(m, n)', code: 'math.random', min: 0, max: 2 },
  { label: 'math.sin(x)', code: 'math.sin', min: 1, max: 1 },
  { label: 'math.cos(x)', code: 'math.cos', min: 1, max: 1 },
  { label: 'math.fmod(a, b)', code: 'math.fmod', min: 2, max: 2 },
  { label: 'table.concat(t, sep)', code: 'table.concat', min: 1, max: 3 },
  { label: 'table.insert(t, v)', code: 'table.insert', min: 2, max: 3 },
  { label: 'table.remove(t, i)', code: 'table.remove', min: 1, max: 2 },
  { label: 'table.sort(t, cmp)', code: 'table.sort', min: 1, max: 2 },
  { label: 'table.unpack(t, i, j)', code: 'table.unpack', min: 1, max: 3 },
  { label: 'tostring(v)', code: 'tostring', min: 1, max: 1 },
  { label: 'tonumber(v, base)', code: 'tonumber', min: 1, max: 2 },
  { label: 'type(v)', code: 'type', min: 1, max: 1 },
  { label: 'pairs(t)', code: 'pairs', min: 1, max: 1 },
  { label: 'ipairs(t)', code: 'ipairs', min: 1, max: 1 },
  { label: 'next(t, k)', code: 'next', min: 1, max: 2 },
  { label: 'assert(v, msg)', code: 'assert', min: 1, max: 2 },
  { label: 'error(msg, level)', code: 'error', min: 1, max: 2 },
  { label: 'pcall(f, …)', code: 'pcall', min: 1, max: 8 },
  { label: 'select(n, …)', code: 'select', min: 1, max: 8 },
  { label: 'io.write(…)', code: 'io.write', min: 1, max: 8 },
  { label: 'io.read(fmt)', code: 'io.read', min: 0, max: 1 },
  { label: 'os.clock()', code: 'os.clock', min: 0, max: 0 },
  { label: 'os.time()', code: 'os.time', min: 0, max: 1 },
  { label: 'os.date(fmt, t)', code: 'os.date', min: 0, max: 2 },
];

function stdlibOptions(): Array<[string, string]> {
  return STDLIB.map((entry) => [entry.label, entry.code]);
}

function stdlibEntry(code: string): StdlibEntry | undefined {
  return STDLIB.find((entry) => entry.code === code);
}

/* ── Static block definitions ────────────────────────────────────────────── */

const STATIC_BLOCKS = [
  /* Control flow */
  {
    type: 'lua_while',
    message0: 'while %1 do %2 %3 end',
    args0: [
      { type: 'input_value', name: 'COND' },
      { type: 'input_dummy' },
      { type: 'input_statement', name: 'DO' },
    ],
    previousStatement: null,
    nextStatement: null,
    style: 'control_style',
    tooltip: 'Repeat the body while the condition is truthy.',
  },
  {
    type: 'lua_repeat',
    message0: 'repeat %1 %2 until %3',
    args0: [
      { type: 'input_statement', name: 'DO' },
      { type: 'input_dummy' },
      { type: 'input_value', name: 'COND' },
    ],
    previousStatement: null,
    nextStatement: null,
    style: 'control_style',
    tooltip: 'Repeat the body until the condition becomes truthy (runs at least once).',
  },
  {
    type: 'lua_for',
    message0: 'for %1 = %2 to %3 step %4 do %5 %6 end',
    args0: [
      { type: 'field_input', name: 'VAR', text: 'i' },
      { type: 'input_value', name: 'FROM' },
      { type: 'input_value', name: 'TO' },
      { type: 'field_input', name: 'STEP', text: '' },
      { type: 'input_dummy' },
      { type: 'input_statement', name: 'DO' },
    ],
    previousStatement: null,
    nextStatement: null,
    style: 'control_style',
    tooltip: 'Numeric for loop. Leave step empty for the default of 1.',
  },
  {
    type: 'lua_for_in',
    message0: 'for %1 in %2 do %3 %4 end',
    args0: [
      { type: 'field_input', name: 'NAMES', text: 'k, v' },
      { type: 'input_value', name: 'EXPR' },
      { type: 'input_dummy' },
      { type: 'input_statement', name: 'DO' },
    ],
    previousStatement: null,
    nextStatement: null,
    style: 'control_style',
    tooltip: 'Generic for loop, e.g. for k, v in pairs(t) do … end.',
  },
  {
    type: 'lua_break',
    message0: 'break',
    previousStatement: null,
    nextStatement: null,
    style: 'control_style',
    tooltip: 'Exit the enclosing loop.',
  },
  {
    type: 'lua_do',
    message0: 'do %1 %2 end',
    args0: [
      { type: 'input_statement', name: 'DO' },
      { type: 'input_dummy' },
    ],
    previousStatement: null,
    nextStatement: null,
    style: 'control_style',
    tooltip: 'A scoped block: locals declared inside stay inside.',
  },

  /* Variables & scope */
  {
    type: 'lua_local',
    message0: 'local %1 = %2',
    args0: [
      { type: 'field_input', name: 'NAMES', text: 'x' },
      { type: 'input_value', name: 'VALUE' },
    ],
    previousStatement: null,
    nextStatement: null,
    style: 'vars_style',
    tooltip: 'Declare locals. Use "a, b" for multiple names and plug in a call for multiple returns.',
  },
  {
    type: 'lua_assign',
    message0: '%1 = %2',
    args0: [
      { type: 'field_input', name: 'TARGET', text: 'x' },
      { type: 'input_value', name: 'VALUE' },
    ],
    previousStatement: null,
    nextStatement: null,
    style: 'vars_style',
    tooltip: 'Assign to a variable, field (t.x), index (t[k]) or a comma separated list.',
  },
  {
    type: 'lua_var_get',
    message0: 'var %1',
    args0: [{ type: 'field_input', name: 'NAME', text: 'x' }],
    output: null,
    style: 'vars_style',
    tooltip: 'Read a variable or any global.',
  },
  {
    type: 'lua_module_table',
    message0: 'local %1 = { }',
    args0: [{ type: 'field_input', name: 'NAME', text: 'M' }],
    previousStatement: null,
    nextStatement: null,
    style: 'vars_style',
    tooltip: 'Create the module table that this file will return.',
  },

  /* Functions & closures */
  {
    type: 'lua_def_function',
    message0: 'function %1 (%2) %3 %4 end',
    args0: [
      { type: 'field_input', name: 'NAME', text: 'my_function' },
      { type: 'field_input', name: 'PARAMS', text: '' },
      { type: 'input_statement', name: 'STACK' },
      { type: 'input_dummy' },
    ],
    previousStatement: null,
    nextStatement: null,
    style: 'funcs_style',
    tooltip: 'Declare a global function. Add a return block inside for a result.',
  },
  {
    type: 'lua_def_local_function',
    message0: 'local function %1 (%2) %3 %4 end',
    args0: [
      { type: 'field_input', name: 'NAME', text: 'helper' },
      { type: 'field_input', name: 'PARAMS', text: '' },
      { type: 'input_statement', name: 'STACK' },
      { type: 'input_dummy' },
    ],
    previousStatement: null,
    nextStatement: null,
    style: 'funcs_style',
    tooltip: 'Declare a file-local function (also the natural way to write module internals).',
  },
  {
    type: 'lua_function_expr',
    message0: 'function (%1) %2 return %3 end',
    args0: [
      { type: 'field_input', name: 'PARAMS', text: '' },
      { type: 'input_statement', name: 'STACK' },
      { type: 'input_value', name: 'RETURN' },
    ],
    output: null,
    style: 'funcs_style',
    tooltip: 'An anonymous function / closure value.',
  },
  {
    type: 'lua_return',
    message0: 'return %1',
    args0: [{ type: 'input_value', name: 'VALUE' }],
    previousStatement: null,
    style: 'funcs_style',
    tooltip: 'Return a value (must be the last statement of a block).',
  },

  /* Tables & metatables */
  {
    type: 'lua_field',
    message0: '%1 . %2',
    args0: [
      { type: 'input_value', name: 'TABLE' },
      { type: 'field_input', name: 'FIELD', text: 'field' },
    ],
    output: null,
    style: 'tables_style',
    tooltip: 'Dot index: t.field',
  },
  {
    type: 'lua_index',
    message0: '%1 [ %2 ]',
    args0: [
      { type: 'input_value', name: 'TABLE' },
      { type: 'input_value', name: 'KEY' },
    ],
    output: null,
    style: 'tables_style',
    tooltip: 'Bracket index: t[key]',
  },
  {
    type: 'lua_index_set',
    message0: '%1 [ %2 ] = %3',
    args0: [
      { type: 'input_value', name: 'TABLE' },
      { type: 'input_value', name: 'KEY' },
      { type: 'input_value', name: 'VALUE' },
    ],
    previousStatement: null,
    nextStatement: null,
    style: 'tables_style',
    tooltip: 'Assign into a table by key.',
  },
  {
    type: 'lua_setmetatable',
    message0: 'setmetatable( %1 , %2 )',
    args0: [
      { type: 'input_value', name: 'TABLE' },
      { type: 'input_value', name: 'METATABLE' },
    ],
    previousStatement: null,
    nextStatement: null,
    style: 'tables_style',
    tooltip: 'Attach a metatable (__index, __add, __tostring, …) to a table.',
  },
  {
    type: 'lua_len',
    message0: '# %1',
    args0: [{ type: 'input_value', name: 'VALUE' }],
    output: null,
    style: 'tables_style',
    tooltip: 'Length operator: works on strings and sequence tables.',
  },

  /* Modules & packages */
  {
    type: 'lua_require',
    message0: 'require %1',
    args0: [{ type: 'field_input', name: 'MODULE', text: 'json' }],
    output: null,
    style: 'modules_style',
    tooltip: 'Load a project module or installed package. Accepts dotted paths.',
  },
  {
    type: 'lua_export',
    message0: 'export %1 . %2 = %3',
    args0: [
      { type: 'field_input', name: 'MODULE', text: 'M' },
      { type: 'field_input', name: 'NAME', text: 'name' },
      { type: 'input_value', name: 'VALUE' },
    ],
    previousStatement: null,
    nextStatement: null,
    style: 'modules_style',
    tooltip: 'Expose a function or value on the module table.',
  },

  /* Operators & literals */
  {
    type: 'lua_nil',
    message0: 'nil',
    output: null,
    style: 'logic_style',
    tooltip: 'The nil value.',
  },
  {
    type: 'lua_vararg',
    message0: '...',
    output: null,
    style: 'logic_style',
    tooltip: 'Extra arguments of the enclosing function.',
  },
  {
    type: 'lua_unop',
    message0: '%1 %2',
    args0: [
      {
        type: 'field_dropdown',
        name: 'OP',
        options: [
          ['not', 'not'],
          ['-', '-'],
          ['#', '#'],
          ['~', '~'],
        ],
      },
      { type: 'input_value', name: 'VALUE' },
    ],
    output: null,
    style: 'logic_style',
    tooltip: 'Unary operator.',
  },
  {
    type: 'lua_bitwise',
    message0: '%1 %2 %3',
    args0: [
      { type: 'input_value', name: 'A' },
      {
        type: 'field_dropdown',
        name: 'OP',
        options: [
          ['&', '&'],
          ['|', '|'],
          ['~', '~'],
          ['<<', '<<'],
          ['>>', '>>'],
        ],
      },
      { type: 'input_value', name: 'B' },
    ],
    output: null,
    style: 'logic_style',
    tooltip: 'Bitwise operator (Lua 5.3+).',
  },
  {
    type: 'lua_idiv',
    message0: '%1 // %2',
    args0: [
      { type: 'input_value', name: 'A' },
      { type: 'input_value', name: 'B' },
    ],
    output: null,
    style: 'logic_style',
    tooltip: 'Floor division (Lua 5.3+).',
  },
  {
    type: 'lua_comment',
    message0: 'note %1',
    args0: [{ type: 'field_multilineinput', name: 'TEXT', text: 'explain this section' }],
    previousStatement: null,
    nextStatement: null,
    style: 'logic_style',
    tooltip: 'A Lua comment kept in the generated source.',
  },

  /* C / C++ interop */
  {
    type: 'ffi_define_function',
    message0: 'native %1 %2 ( %3 ) body %4 %5',
    args0: [
      { type: 'field_dropdown', name: 'RET', options: C_TYPES },
      { type: 'field_input', name: 'NAME', text: 'c_helper' },
      { type: 'field_input', name: 'PARAMS', text: 'int value' },
      { type: 'input_dummy' },
      { type: 'field_multilineinput', name: 'BODY', text: 'return value * 2;' },
    ],
    previousStatement: null,
    nextStatement: null,
    style: 'native_style',
    tooltip: 'Define a C function compiled in the browser and callable from Lua through the bridge.',
  },
  {
    type: 'ffi_define_struct',
    message0: 'native struct %1 { %2 }',
    args0: [
      { type: 'field_input', name: 'NAME', text: 'Point' },
      { type: 'field_multilineinput', name: 'FIELDS', text: 'int x;\nint y;' },
    ],
    previousStatement: null,
    nextStatement: null,
    style: 'native_style',
    tooltip: 'Define a C struct type usable with the struct conversion blocks.',
  },
  {
    type: 'ffi_register',
    message0: 'lua_register %1 → C %2',
    args0: [
      { type: 'field_input', name: 'LUA_NAME', text: 'c_helper' },
      { type: 'field_input', name: 'C_NAME', text: 'c_helper' },
    ],
    previousStatement: null,
    nextStatement: null,
    style: 'native_style',
    tooltip: 'Expose a compiled C function as a Lua global (mirrors lua_register).',
  },
  {
    type: 'ffi_struct_to_lua',
    message0: 'C struct %1 → Lua table',
    args0: [{ type: 'input_value', name: 'STRUCT' }],
    output: null,
    style: 'native_style',
    tooltip: 'Copy a C struct (or struct pointer) into a plain Lua table.',
  },
];

/* ── Programmatic blocks ─────────────────────────────────────────────────── */

function defineCallStatement(): void {
  Blockly.Blocks['lua_call'] = {
    init(this: Blockly.Block) {
      const block = this as Blockly.Block & { arity_?: number; rebuild_?: (n: number) => void; changeArity_?: (d: number) => void };
      block.appendDummyInput('HEAD')
        .appendField('call')
        .appendField(new Blockly.FieldTextInput('print'), 'NAME')
        .appendField('(');
      block.setPreviousStatement(true);
      block.setNextStatement(true);
      block.setStyle('funcs_style');
      block.setTooltip('Call a function. Dotted names (math.floor) and methods (obj:method) are supported.');
      block.arity_ = 1;
      block.rebuild_ = (count: number) => {
        rebuildValueInputs(block, count, {
          close: ')',
          min: 0,
          onDelta: (delta) => block.changeArity_?.(delta),
        });
      };
      block.changeArity_ = (delta: number) => {
        const next = Math.max(0, currentArity(block, 1) + delta);
        block.arity_ = next;
        block.rebuild_?.(next);
      };
      variadicState(block, (count) => block.rebuild_?.(count));
      block.rebuild_(1);
    },
  };
}

function defineCallValue(): void {
  Blockly.Blocks['lua_call_value'] = {
    init(this: Blockly.Block) {
      const block = this as Blockly.Block & { arity_?: number; rebuild_?: (n: number) => void; changeArity_?: (d: number) => void };
      block.appendDummyInput('HEAD')
        .appendField('call')
        .appendField(new Blockly.FieldTextInput('math.floor'), 'NAME')
        .appendField('(');
      block.setOutput(true, null);
      block.setStyle('funcs_style');
      block.setTooltip('Call a function and use its result.');
      block.arity_ = 1;
      block.rebuild_ = (count: number) => {
        rebuildValueInputs(block, count, {
          close: ')',
          min: 0,
          onDelta: (delta) => block.changeArity_?.(delta),
        });
      };
      block.changeArity_ = (delta: number) => {
        const next = Math.max(0, currentArity(block, 1) + delta);
        block.arity_ = next;
        block.rebuild_?.(next);
      };
      variadicState(block, (count) => block.rebuild_?.(count));
      block.rebuild_(1);
    },
  };
}

function definePrint(): void {
  Blockly.Blocks['lua_print'] = {
    init(this: Blockly.Block) {
      const block = this as Blockly.Block & { arity_?: number; rebuild_?: (n: number) => void; changeArity_?: (d: number) => void };
      block.appendDummyInput('HEAD').appendField('print(');
      block.setPreviousStatement(true);
      block.setNextStatement(true);
      block.setStyle('stdlib_style');
      block.setTooltip('Write values to the Selene console.');
      block.arity_ = 1;
      block.rebuild_ = (count: number) => {
        rebuildValueInputs(block, count, {
          close: ')',
          min: 0,
          onDelta: (delta) => block.changeArity_?.(delta),
        });
      };
      block.changeArity_ = (delta: number) => {
        const next = Math.max(0, currentArity(block, 1) + delta);
        block.arity_ = next;
        block.rebuild_?.(next);
      };
      variadicState(block, (count) => block.rebuild_?.(count));
      block.rebuild_(1);
    },
  };
}

function defineTables(): void {
  Blockly.Blocks['lua_table_array'] = {
    init(this: Blockly.Block) {
      const block = this as Blockly.Block & { arity_?: number; rebuild_?: (n: number) => void; changeArity_?: (d: number) => void };
      block.appendDummyInput('HEAD').appendField('table {');
      block.setOutput(true, null);
      block.setStyle('tables_style');
      block.setTooltip('Array-style table constructor.');
      block.arity_ = 1;
      block.rebuild_ = (count: number) => {
        rebuildValueInputs(block, count, {
          close: '}',
          min: 0,
          onDelta: (delta) => block.changeArity_?.(delta),
        });
      };
      block.changeArity_ = (delta: number) => {
        const next = Math.max(0, currentArity(block, 1) + delta);
        block.arity_ = next;
        block.rebuild_?.(next);
      };
      variadicState(block, (count) => block.rebuild_?.(count));
      block.rebuild_(1);
    },
  };

  Blockly.Blocks['lua_table_dict'] = {
    init(this: Blockly.Block) {
      const block = this as Blockly.Block & { arity_?: number; rebuild_?: (n: number) => void; changeArity_?: (d: number) => void };
      block.appendDummyInput('HEAD').appendField('table {');
      block.setOutput(true, null);
      block.setStyle('tables_style');
      block.setTooltip('Dictionary-style table constructor.');
      block.arity_ = 1;

      block.rebuild_ = (count: number) => {
        if (block.getInput('CTRL')) block.removeInput('CTRL');
        for (const input of [...block.inputList]) {
          if (input.name?.startsWith('ARG')) block.removeInput(input.name);
        }
        for (let index = 0; index < count; index += 1) {
          const input = block.appendValueInput(`ARG${index}`);
          if (index > 0) input.appendField(', ');
          input.appendField(new Blockly.FieldTextInput(index === 0 ? 'key' : `key${index + 1}`), `K${index}`);
          input.appendField(' = ');
        }
        const control = block.appendDummyInput('CTRL');
        control.appendField('}');
        control.appendField(
          new Blockly.FieldImage(
            'data:image/svg+xml;charset=utf-8,' +
              encodeURIComponent(
                '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 14 14"><circle cx="7" cy="7" r="6.2" fill="rgba(255,255,255,0.10)"/><path d="M4 7h6" fill="none" stroke="#dbe3f4" stroke-width="1.5" stroke-linecap="round"/></svg>',
              ),
            13,
            13,
            'Remove pair',
            () => block.changeArity_?.(-1),
          ),
        );
        control.appendField(
          new Blockly.FieldImage(
            'data:image/svg+xml;charset=utf-8,' +
              encodeURIComponent(
                '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 14 14"><circle cx="7" cy="7" r="6.2" fill="rgba(255,255,255,0.10)"/><path d="M4 7h6M7 4v6" fill="none" stroke="#dbe3f4" stroke-width="1.5" stroke-linecap="round"/></svg>',
              ),
            13,
            13,
            'Add pair',
            () => block.changeArity_?.(1),
          ),
        );
        block.arity_ = Math.max(0, count);
      };

      block.changeArity_ = (delta: number) => {
        const next = Math.max(0, currentArity(block, 1) + delta);
        block.arity_ = next;
        block.rebuild_?.(next);
      };

      variadicState(block, (count) => block.rebuild_?.(count));
      block.rebuild_(1);
    },
  };
}

function defineStdlib(): void {
  Blockly.Blocks['lua_stdlib_value'] = {
    init(this: Blockly.Block) {
      const block = this as Blockly.Block & {
        arity_?: number;
        rebuild_?: (n: number) => void;
        changeArity_?: (d: number) => void;
        lastFn_?: string;
        busy_?: boolean;
      };
      let current = 'string.format';
      block.lastFn_ = current;
      const dropdown = new Blockly.FieldDropdown(
        () => {
          const options = stdlibOptions();
          if (!options.some((option) => option[1] === current)) options.unshift([current, current]);
          return options;
        },
        (value) => {
          current = String(value);
          return value;
        },
      );
      block.appendDummyInput('HEAD').appendField('std').appendField(dropdown, 'FN').appendField('(');
      block.setOutput(true, null);
      block.setStyle('stdlib_style');
      block.setTooltip('Call a standard library function.');
      block.arity_ = 2;

      block.rebuild_ = (count: number) => {
        rebuildValueInputs(block, count, {
          close: ')',
          min: 0,
          onDelta: (delta) => block.changeArity_?.(delta),
        });
      };
      block.changeArity_ = (delta: number) => {
        const next = Math.max(0, currentArity(block, 1) + delta);
        block.arity_ = next;
        block.rebuild_?.(next);
      };
      variadicState(block, (count) => block.rebuild_?.(count));
      block.rebuild_(2);

      block.setOnChange(() => {
        if (block.busy_) return;
        const code = String(block.getFieldValue('FN') ?? '');
        if (code === block.lastFn_) return;
        block.lastFn_ = code;
        const entry = stdlibEntry(code);
        if (!entry) return;
        block.busy_ = true;
        block.arity_ = Math.max(entry.min, 1);
        block.rebuild_?.(block.arity_);
        block.busy_ = false;
      });
    },
  };
}

function defineConcat(): void {
  Blockly.Blocks['lua_concat'] = {
    init(this: Blockly.Block) {
      const block = this as Blockly.Block & { arity_?: number; rebuild_?: (n: number) => void; changeArity_?: (d: number) => void };
      block.appendDummyInput('HEAD').appendField('join');
      block.setOutput(true, null);
      block.setStyle('stdlib_style');
      block.setTooltip('Concatenate two or more values with the Lua .. operator.');
      block.arity_ = 2;
      block.rebuild_ = (count: number) => {
        rebuildValueInputs(block, count, {
          min: 2,
          onDelta: (delta) => block.changeArity_?.(delta),
        });
      };
      block.changeArity_ = (delta: number) => {
        const next = Math.max(2, currentArity(block, 2) + delta);
        block.arity_ = next;
        block.rebuild_?.(next);
      };
      variadicState(block, (count) => block.rebuild_?.(count));
      block.rebuild_(2);
    },
  };
}

function defineFFICall(): void {
  Blockly.Blocks['ffi_call'] = {
    init(this: Blockly.Block) {
      const block = this as Blockly.Block & {
        arity_?: number;
        rebuild_?: (n: number) => void;
        changeArity_?: (d: number) => void;
        lastFn_?: string;
        busy_?: boolean;
      };
      let current = nativeFunctions[0]?.name ?? '';
      block.lastFn_ = current;
      const dropdown = new Blockly.FieldDropdown(
        () => {
          const options = nativeFunctionOptions();
          if (current && !options.some((option) => option[1] === current)) options.unshift([current, current]);
          return options;
        },
        (value) => {
          current = String(value);
          return value;
        },
      );
      block.appendDummyInput('HEAD').appendField('C call').appendField(dropdown, 'FN').appendField('(');
      block.setOutput(true, null);
      block.setStyle('native_style');
      block.setTooltip('Call a C function compiled by the in-browser native bridge.');
      block.arity_ = 0;

      block.rebuild_ = (count: number) => {
        rebuildValueInputs(block, count, {
          close: ')',
          min: 0,
          onDelta: (delta) => block.changeArity_?.(delta),
        });
      };
      block.changeArity_ = (delta: number) => {
        const next = Math.max(0, currentArity(block, 1) + delta);
        block.arity_ = next;
        block.rebuild_?.(next);
      };
      variadicState(block, (count) => block.rebuild_?.(count));
      block.rebuild_(nativeFunctions[0]?.params.length ?? 0);

      block.setOnChange(() => {
        if (block.busy_) return;
        const name = String(block.getFieldValue('FN') ?? '');
        if (name === block.lastFn_) return;
        block.lastFn_ = name;
        const fn = nativeFunctions.find((candidate) => candidate.name === name);
        block.busy_ = true;
        block.arity_ = fn ? fn.params.length : 0;
        block.rebuild_?.(block.arity_);
        block.busy_ = false;
      });
    },
  };

  Blockly.Blocks['ffi_struct_new'] = {
    init(this: Blockly.Block) {
      let current = nativeStructs[0] ?? 'Point';
      const dropdown = new Blockly.FieldDropdown(
        () => {
          const options = structOptions();
          if (!options.some((option) => option[1] === current)) options.unshift([current, current]);
          return options;
        },
        (value) => {
          current = String(value);
          return value;
        },
      );
      this.appendDummyInput()
        .appendField('C struct')
        .appendField(dropdown, 'TYPE')
        .appendField('from table');
      this.appendValueInput('TABLE').setCheck(null);
      this.setOutput(true, null);
      this.setStyle('native_style');
      this.setTooltip('Allocate a C struct and copy fields from a Lua table.');
    },
  };
}

/* ── Registration ────────────────────────────────────────────────────────── */

export function installCustomBlocks(): void {
  if (installed) return;
  installed = true;

  try {
    Blockly.fieldRegistry.register('field_multilineinput', FieldMultilineInput);
  } catch {
    /* already registered by a previous hot reload */
  }
  FieldMultilineInput.enterCommits = false;

  Blockly.common.defineBlocksWithJsonArray(STATIC_BLOCKS as unknown as object[]);
  defineCallStatement();
  defineCallValue();
  definePrint();
  defineTables();
  defineStdlib();
  defineConcat();
  defineFFICall();

  registerGenerators();
}

/* ── Lua generators ──────────────────────────────────────────────────────── */

function registerGenerators(): void {
  const gen = luaGenerator;
  const q = (value: string) => gen.quote_(value);

  gen.forBlock['lua_while'] = (block, generator) => {
    const cond = generator.valueToCode(block, 'COND', Order.AND) || 'true';
    const body = generator.statementToCode(block, 'DO');
    return `while ${cond} do\n${body}end\n`;
  };

  gen.forBlock['lua_repeat'] = (block, generator) => {
    const cond = generator.valueToCode(block, 'COND', Order.AND) || 'true';
    const body = generator.statementToCode(block, 'DO');
    return `repeat\n${body}until ${cond}\n`;
  };

  gen.forBlock['lua_for'] = (block, generator) => {
    const variable = fieldValue(block, 'VAR') || 'i';
    const from = generator.valueToCode(block, 'FROM', Order.NONE) || '1';
    const to = generator.valueToCode(block, 'TO', Order.NONE) || '10';
    const stepRaw = fieldValue(block, 'STEP').trim();
    const step = stepRaw ? `, ${stepRaw}` : '';
    const body = generator.statementToCode(block, 'DO');
    return `for ${variable} = ${from}, ${to}${step} do\n${body}end\n`;
  };

  gen.forBlock['lua_for_in'] = (block, generator) => {
    const names = fieldValue(block, 'NAMES') || 'k, v';
    const expression = generator.valueToCode(block, 'EXPR', Order.NONE) || 'pairs({})';
    const body = generator.statementToCode(block, 'DO');
    return `for ${names} in ${expression} do\n${body}end\n`;
  };

  gen.forBlock['lua_break'] = () => 'break\n';
  gen.forBlock['lua_do'] = (block, generator) => {
    const body = generator.statementToCode(block, 'DO');
    return `do\n${body}end\n`;
  };

  gen.forBlock['lua_local'] = (block, generator) => {
    const names = fieldValue(block, 'NAMES').trim() || 'value';
    const value = generator.valueToCode(block, 'VALUE', Order.NONE);
    return `local ${names}${value ? ` = ${value}` : ''}\n`;
  };

  gen.forBlock['lua_assign'] = (block, generator) => {
    const target = fieldValue(block, 'TARGET').trim() || 'value';
    const value = generator.valueToCode(block, 'VALUE', Order.NONE) || 'nil';
    return `${target} = ${value}\n`;
  };

  gen.forBlock['lua_var_get'] = (block) => [fieldValue(block, 'NAME') || 'value', Order.ATOMIC];

  gen.forBlock['lua_module_table'] = (block) => `local ${fieldValue(block, 'NAME') || 'M'} = {}\n`;

  gen.forBlock['lua_def_function'] = (block, generator) => {
    const name = fieldValue(block, 'NAME') || 'my_function';
    const params = fieldValue(block, 'PARAMS');
    const body = generator.statementToCode(block, 'STACK');
    return `function ${name}(${params})\n${body}end\n`;
  };

  gen.forBlock['lua_def_local_function'] = (block, generator) => {
    const name = fieldValue(block, 'NAME') || 'helper';
    const params = fieldValue(block, 'PARAMS');
    const body = generator.statementToCode(block, 'STACK');
    return `local function ${name}(${params})\n${body}end\n`;
  };

  gen.forBlock['lua_function_expr'] = (block, generator) => {
    const params = fieldValue(block, 'PARAMS');
    const stack = generator.statementToCode(block, 'STACK');
    const result = generator.valueToCode(block, 'RETURN', Order.NONE);
    const lines: string[] = [];
    lines.push(`function(${params})`);
    if (stack) lines.push(stack.replace(/\n$/, ''));
    if (result) lines.push(`${generator.INDENT}return ${result}`);
    lines.push('end');
    return [lines.join('\n'), Order.ATOMIC];
  };

  gen.forBlock['lua_return'] = (block, generator) => {
    const value = generator.valueToCode(block, 'VALUE', Order.NONE);
    return value ? `return ${value}\n` : 'return\n';
  };

  gen.forBlock['lua_field'] = (block, generator) => {
    const base = generator.valueToCode(block, 'TABLE', Order.HIGH) || '{}';
    const field = fieldValue(block, 'FIELD') || 'field';
    return [`${base}.${field}`, Order.HIGH];
  };

  gen.forBlock['lua_index'] = (block, generator) => {
    const base = generator.valueToCode(block, 'TABLE', Order.HIGH) || '{}';
    const key = generator.valueToCode(block, 'KEY', Order.NONE) || 'nil';
    return [`${base}[${key}]`, Order.HIGH];
  };

  gen.forBlock['lua_index_set'] = (block, generator) => {
    const base = generator.valueToCode(block, 'TABLE', Order.HIGH) || '{}';
    const key = generator.valueToCode(block, 'KEY', Order.NONE) || 'nil';
    const value = generator.valueToCode(block, 'VALUE', Order.NONE) || 'nil';
    return `${base}[${key}] = ${value}\n`;
  };

  gen.forBlock['lua_setmetatable'] = (block, generator) => {
    const table = generator.valueToCode(block, 'TABLE', Order.NONE) || '{}';
    const metatable = generator.valueToCode(block, 'METATABLE', Order.NONE) || '{}';
    return `setmetatable(${table}, ${metatable})\n`;
  };

  gen.forBlock['lua_len'] = (block, generator) => {
    const value = generator.valueToCode(block, 'VALUE', Order.UNARY);
    return [`#${value || 'nil'}`, Order.UNARY];
  };

  gen.forBlock['lua_require'] = (block) => {
    const module = fieldValue(block, 'MODULE') || 'json';
    return [`require(${q(module)})`, Order.HIGH];
  };

  gen.forBlock['lua_export'] = (block, generator) => {
    const table = fieldValue(block, 'MODULE') || 'M';
    const name = fieldValue(block, 'NAME') || 'name';
    const value = generator.valueToCode(block, 'VALUE', Order.NONE) || 'nil';
    return /^[A-Za-z_]\w*$/.test(name) ? `${table}.${name} = ${value}\n` : `${table}[${q(name)}] = ${value}\n`;
  };

  gen.forBlock['lua_nil'] = () => ['nil', Order.ATOMIC];
  gen.forBlock['lua_vararg'] = () => ['...', Order.ATOMIC];

  gen.forBlock['lua_unop'] = (block, generator) => {
    const op = fieldValue(block, 'OP') || 'not';
    const value = generator.valueToCode(block, 'VALUE', Order.UNARY) || 'nil';
    return [op === 'not' ? `not ${value}` : `${op}${value}`, Order.UNARY];
  };

  gen.forBlock['lua_bitwise'] = (block, generator) => {
    const a = generator.valueToCode(block, 'A', Order.MULTIPLICATIVE) || '0';
    const b = generator.valueToCode(block, 'B', Order.MULTIPLICATIVE) || '0';
    return [`${a} ${fieldValue(block, 'OP')} ${b}`, Order.ADDITIVE];
  };

  gen.forBlock['lua_concat'] = (block) => {
    const parts = argCodes(block);
    return [parts.length > 0 ? parts.join(' .. ') : '""', Order.CONCATENATION];
  };

  gen.forBlock['lua_idiv'] = (block, generator) => {
    const a = generator.valueToCode(block, 'A', Order.MULTIPLICATIVE) || '0';
    const b = generator.valueToCode(block, 'B', Order.MULTIPLICATIVE) || '1';
    return [`${a} // ${b}`, Order.MULTIPLICATIVE];
  };

  gen.forBlock['lua_comment'] = (block) => {
    const text = fieldValue(block, 'TEXT') || '';
    const lines = text.split('\n');
    return `${lines.map((line) => `-- ${line}`.trimEnd()).join('\n')}\n`;
  };

  gen.forBlock['lua_call'] = (block, generator) => {
    const name = fieldValue(block, 'NAME') || 'noop';
    const args = argCodes(block).join(', ');
    return `${name}(${args})\n`;
  };

  gen.forBlock['lua_call_value'] = (block, generator) => {
    const name = fieldValue(block, 'NAME') || 'noop';
    const args = argCodes(block).join(', ');
    return [`${name}(${args})`, Order.HIGH];
  };

  gen.forBlock['lua_print'] = (block) => `print(${argCodes(block).join(', ')})\n`;

  gen.forBlock['lua_table_array'] = (block) => {
    const items = argCodes(block);
    return [`{${items.length ? ` ${items.join(', ')} ` : ''}}`, Order.ATOMIC];
  };

  gen.forBlock['lua_table_dict'] = (block, generator) => {
    const parts: string[] = [];
    let index = 0;
    for (const input of block.inputList) {
      if (!input.name?.startsWith('ARG') || !input.connection) continue;
      const key = (block.getFieldValue(`K${index}`) as string | null) ?? `key${index}`;
      const value = generator.valueToCode(block, input.name, Order.NONE) || 'nil';
      const renderedKey = /^[A-Za-z_]\w*$/.test(key) ? key : `[${q(key)}]`;
      parts.push(`${renderedKey} = ${value}`);
      index += 1;
    }
    return [`{${parts.length ? ` ${parts.join(', ')} ` : ''}}`, Order.ATOMIC];
  };

  gen.forBlock['lua_stdlib_value'] = (block, generator) => {
    const code = fieldValue(block, 'FN') || 'tostring';
    const args = argCodes(block).join(', ');
    return [`${code}(${args})`, Order.HIGH];
  };

  gen.forBlock['ffi_call'] = (block) => {
    const fn = fieldValue(block, 'FN');
    if (!fn) return ['nil', Order.ATOMIC];
    const args = argCodes(block).join(', ');
    return [`_C.call(${q(fn)}${args ? `, ${args}` : ''})`, Order.HIGH];
  };

  gen.forBlock['ffi_struct_new'] = (block, generator) => {
    const type = fieldValue(block, 'TYPE') || 'Point';
    const table = generator.valueToCode(block, 'TABLE', Order.NONE) || '{}';
    return [`_C.struct(${q(type)}, ${table})`, Order.HIGH];
  };

  gen.forBlock['ffi_struct_to_lua'] = (block, generator) => {
    const value = generator.valueToCode(block, 'STRUCT', Order.NONE) || 'nil';
    return [`_C.tolua(${value})`, Order.HIGH];
  };

  gen.forBlock['ffi_register'] = (block) => {
    const luaName = fieldValue(block, 'LUA_NAME') || 'native';
    const cName = fieldValue(block, 'C_NAME') || luaName;
    return `_C.register(${q(luaName)}, ${q(cName)})\n`;
  };

  gen.forBlock['ffi_define_function'] = (block) => {
    const ret = fieldValue(block, 'RET') || 'int';
    const name = fieldValue(block, 'NAME') || 'c_helper';
    const params = fieldValue(block, 'PARAMS');
    return `-- native C: ${ret} ${name}(${params})\n`;
  };

  gen.forBlock['ffi_define_struct'] = (block) => {
    const name = fieldValue(block, 'NAME') || 'Point';
    return `-- native C struct: ${name}\n`;
  };
}

/** The full static block type list, used by the converter and toolboxes. */
export const LUA_BLOCK_TYPES = STATIC_BLOCKS.map((block) => block.type);
