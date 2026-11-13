import type { Chunk, Expr, Stat } from '../lua/ast';
import { tryParseLua } from '../lua/parser';
import type { BlockGraph } from '../core/types';

interface BlockState {
  type: string;
  fields?: Record<string, unknown>;
  inputs?: Record<string, unknown>;
  extraState?: unknown;
  next?: { block: BlockState };
  x?: number;
  y?: number;
}

export class UnsupportedLuaError extends Error {
  line: number;
  constructor(message: string, line: number) {
    super(`${message} (line ${line})`);
    this.name = 'UnsupportedLuaError';
    this.line = line;
  }
}

export interface ConvertResult {
  graph: BlockGraph;
  warnings: string[];
}

function state(type: string, fields?: Record<string, unknown>, inputs?: Record<string, unknown>, extraState?: unknown): BlockState {
  const block: BlockState = { type };
  if (fields && Object.keys(fields).length) block.fields = fields;
  if (inputs && Object.keys(inputs).length) block.inputs = inputs;
  if (extraState !== undefined) block.extraState = extraState;
  return block;
}

function value(expr: Expr): { block: BlockState } {
  return { block: convertExpr(expr) };
}

function chain(blocks: BlockState[]): BlockState | undefined {
  if (blocks.length === 0) return undefined;
  for (let index = 0; index < blocks.length - 1; index += 1) {
    blocks[index].next = { block: blocks[index + 1] };
  }
  return blocks[0];
}

function luaQuote(input: string): string {
  return `"${input.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n').replace(/\r/g, '\\r').replace(/\t/g, '\\t')}"`;
}

/** Reconstruct a callable name (`math.floor`, `obj:method`, `require("x").f`). */
function callableText(expr: Expr): string | null {
  switch (expr.type) {
    case 'Name':
      return expr.name;
    case 'Paren':
      return callableText(expr.expr);
    case 'Index': {
      const base = callableText(expr.base);
      if (!base) return null;
      if (expr.dot && expr.key.type === 'String') return `${base}.${expr.key.value}`;
      if (expr.key.type === 'String') return `${base}[${luaQuote(expr.key.value)}]`;
      if (expr.key.type === 'Number') return `${base}[${expr.key.value}]`;
      return null;
    }
    case 'Call': {
      if (expr.method || expr.args.length !== 1) return null;
      const base = callableText(expr.base);
      if (!base) return null;
      if (expr.args[0].type === 'String' && expr.base.type === 'Name' && expr.base.name === 'require') {
        return `require(${luaQuote(expr.args[0].value)})`;
      }
      return null;
    }
    default:
      return null;
  }
}

function convertCall(expr: Extract<Expr, { type: 'Call' }>, asStatement: boolean): BlockState {
  let callee: string | null;
  if (expr.method) {
    const base = callableText(expr.base);
    callee = base ? `${base}:${expr.method}` : null;
  } else {
    callee = callableText(expr.base);
  }
  if (!callee) throw new UnsupportedLuaError(`Unsupported call target in "${describe(expr)}"`, expr.line);
  const inputs: Record<string, unknown> = {};
  expr.args.forEach((argument, index) => {
    inputs[`ARG${index}`] = value(argument);
  });
  if (asStatement && !expr.method && callee === 'print') {
    return state('lua_print', undefined, inputs, { arity: expr.args.length });
  }
  return state(asStatement ? 'lua_call' : 'lua_call_value', { NAME: callee }, inputs, { arity: expr.args.length });
}

function describe(expr: Expr): string {
  switch (expr.type) {
    case 'Name':
      return expr.name;
    case 'String':
      return JSON.stringify(expr.value);
    case 'Call':
      return 'function call';
    case 'Index':
      return 'index expression';
    default:
      return expr.type;
  }
}

function convertTable(expr: Extract<Expr, { type: 'Table' }>): BlockState {
  const allArray = expr.fields.every((field) => field.kind === 'array');
  if (allArray) {
    const inputs: Record<string, unknown> = {};
    expr.fields.forEach((field, index) => {
      if (field.kind !== 'array') return;
      inputs[`ARG${index}`] = value(field.value);
    });
    return state('lua_table_array', undefined, inputs, { arity: expr.fields.length });
  }
  const allNamed = expr.fields.every((field) => field.kind === 'named' || (field.kind === 'keyed' && field.key.type === 'String'));
  if (!allNamed) throw new UnsupportedLuaError('Mixed table constructors cannot be mapped back to blocks', expr.line);
  const fields: Record<string, unknown> = {};
  const inputs: Record<string, unknown> = {};
  expr.fields.forEach((field, index) => {
    if (field.kind === 'array') return;
    const key = field.kind === 'named' ? field.key : field.key.type === 'String' ? field.key.value : '';
    fields[`K${index}`] = key;
    inputs[`ARG${index}`] = value(field.value);
  });
  return state('lua_table_dict', fields, inputs, { arity: expr.fields.length });
}

function convertExpr(expr: Expr): BlockState {
  switch (expr.type) {
    case 'Nil':
      return state('lua_nil');
    case 'Bool':
      return state('logic_boolean', { BOOL: expr.value ? 'TRUE' : 'FALSE' });
    case 'Number':
      return state('math_number', { NUM: expr.value });
    case 'String':
      return state('text', { TEXT: expr.value });
    case 'Vararg':
      return state('lua_vararg');
    case 'Name':
      return state('lua_var_get', { NAME: expr.name });
    case 'Paren':
      return convertExpr(expr.expr);
    case 'UnOp':
      return state('lua_unop', { OP: expr.op }, { VALUE: value(expr.operand) });
    case 'BinOp': {
      const arithmetic: Record<string, string> = { '+': 'ADD', '-': 'MINUS', '*': 'MULTIPLY', '/': 'DIVIDE', '^': 'POWER' };
      if (arithmetic[expr.op]) {
        return state('math_arithmetic', { OP: arithmetic[expr.op] }, { A: value(expr.left), B: value(expr.right) });
      }
      if (expr.op === '%') return state('math_modulo', undefined, { DIVIDEND: value(expr.left), DIVISOR: value(expr.right) });
      if (expr.op === '//') return state('lua_idiv', undefined, { A: value(expr.left), B: value(expr.right) });
      const comparisons: Record<string, string> = { '==': 'EQ', '~=': 'NEQ', '<': 'LT', '<=': 'LTE', '>': 'GT', '>=': 'GTE' };
      if (comparisons[expr.op]) {
        return state('logic_compare', { OP: comparisons[expr.op] }, { A: value(expr.left), B: value(expr.right) });
      }
      if (expr.op === 'and' || expr.op === 'or') {
        return state('logic_operation', { OP: expr.op.toUpperCase() }, { A: value(expr.left), B: value(expr.right) });
      }
      if (expr.op === '..') return state('lua_concat', undefined, { A: value(expr.left), B: value(expr.right) }, { arity: 2 });
      if (['&', '|', '~', '<<', '>>'].includes(expr.op)) {
        return state('lua_bitwise', { OP: expr.op }, { A: value(expr.left), B: value(expr.right) });
      }
      throw new UnsupportedLuaError(`Unsupported operator "${expr.op}"`, expr.line);
    }
    case 'Call':
      return convertCall(expr, false);
    case 'Index': {
      if (expr.dot) {
        if (expr.key.type !== 'String') throw new UnsupportedLuaError('Dot index must use a field name', expr.line);
        return state('lua_field', { FIELD: expr.key.value }, { TABLE: value(expr.base) });
      }
      return state('lua_index', undefined, { TABLE: value(expr.base), KEY: value(expr.key) });
    }
    case 'Table':
      return convertTable(expr);
    case 'Function': {
      const body = [...expr.body];
      let returnExpr: { block: BlockState } | undefined;
      const last = body[body.length - 1];
      if (last && last.type === 'Return') {
        if (last.exprs.length > 1) throw new UnsupportedLuaError('Multiple return values are not supported in an anonymous function block', last.line);
        if (last.exprs.length === 1) returnExpr = value(last.exprs[0]);
        body.pop();
      }
      return state(
        'lua_function_expr',
        { PARAMS: expr.params.join(', ') },
        {
          STACK: stackInput(body),
          ...(returnExpr ? { RETURN: returnExpr } : {}),
        },
      );
    }
    default:
      throw new UnsupportedLuaError('Unsupported expression', (expr as Expr).line);
  }
}

function stackInput(stats: Stat[]): { block: BlockState } | undefined {
  const converted = stats.map(convertStat);
  const first = chain(converted);
  return first ? { block: first } : undefined;
}

function targetText(target: Expr): string | null {
  if (target.type === 'Name') return target.name;
  if (target.type === 'Index' && target.dot && target.key.type === 'String') {
    const base = callableText(target.base);
    return base ? `${base}.${target.key.value}` : null;
  }
  return null;
}

function convertStat(stat: Stat): BlockState {
  switch (stat.type) {
    case 'Local': {
      const names = stat.names.join(', ');
      if (stat.exprs.length === 0) return state('lua_local', { NAMES: names });
      if (stat.exprs.length === 1) return state('lua_local', { NAMES: names }, { VALUE: value(stat.exprs[0]) });
      if (stat.exprs.length === stat.names.length) {
        const blocks = stat.names.map((name, index) => state('lua_local', { NAMES: name }, { VALUE: value(stat.exprs[index]) }));
        return chain(blocks)!;
      }
      throw new UnsupportedLuaError('Local declaration with mismatched value count', stat.line);
    }
    case 'Assign': {
      if (stat.exprs.length === 0) throw new UnsupportedLuaError('Assignment without a value', stat.line);
      if (stat.exprs.length === 1 && stat.targets.length === 1) {
        const target = stat.targets[0];
        if (target.type === 'Index' && !target.dot) {
          return state('lua_index_set', undefined, {
            TABLE: value(target.base),
            KEY: value(target.key),
            VALUE: value(stat.exprs[0]),
          });
        }
        const text = targetText(target);
        if (!text) throw new UnsupportedLuaError('Unsupported assignment target', stat.line);
        return state('lua_assign', { TARGET: text }, { VALUE: value(stat.exprs[0]) });
      }
      if (stat.exprs.length === 1) {
        const texts = stat.targets.map(targetText);
        if (texts.some((text) => !text)) throw new UnsupportedLuaError('Unsupported assignment target list', stat.line);
        return state('lua_assign', { TARGET: texts.join(', ') }, { VALUE: value(stat.exprs[0]) });
      }
      if (stat.exprs.length !== stat.targets.length) {
        throw new UnsupportedLuaError('Assignment with mismatched value count', stat.line);
      }
      const blocks = stat.targets.map((target, index) => {
        const text = targetText(target);
        if (!text) throw new UnsupportedLuaError('Unsupported assignment target', target.line);
        return state('lua_assign', { TARGET: text }, { VALUE: value(stat.exprs[index]) });
      });
      return chain(blocks)!;
    }
    case 'CallStat':
      return convertCall(stat.call, true);
    case 'Do': {
      const inputs: Record<string, unknown> = {};
      const stack = stackInput(stat.body);
      if (stack) inputs.DO = stack;
      return state('lua_do', undefined, inputs);
    }
    case 'While': {
      const inputs: Record<string, unknown> = { COND: value(stat.cond) };
      const stack = stackInput(stat.body);
      if (stack) inputs.DO = stack;
      return state('lua_while', undefined, inputs);
    }
    case 'Repeat': {
      const inputs: Record<string, unknown> = { COND: value(stat.cond) };
      const stack = stackInput(stat.body);
      if (stack) inputs.DO = stack;
      return state('lua_repeat', undefined, inputs);
    }
    case 'NumberFor': {
      const inputs: Record<string, unknown> = { FROM: value(stat.start), TO: value(stat.limit) };
      if (stat.step) inputs.STEP = value(stat.step);
      const stack = stackInput(stat.body);
      if (stack) inputs.DO = stack;
      return state('lua_for', { VAR: stat.name, STEP: stat.step && stat.step.type === 'Number' ? String(stat.step.value) : '' }, inputs);
    }
    case 'GenericFor': {
      if (stat.exprs.length !== 1) throw new UnsupportedLuaError('Generic for with multiple iterator expressions', stat.line);
      const inputs: Record<string, unknown> = { EXPR: value(stat.exprs[0]) };
      const stack = stackInput(stat.body);
      if (stack) inputs.DO = stack;
      return state('lua_for_in', { NAMES: stat.names.join(', ') }, inputs);
    }
    case 'FunctionDecl': {
      const params = stat.params.join(', ');
      const inputs: Record<string, unknown> = {};
      const stack = stackInput(stat.body);
      if (stack) inputs.STACK = stack;
      if (stat.local && stat.target.length === 1) {
        return state('lua_def_local_function', { NAME: stat.target[0], PARAMS: params }, inputs);
      }
      const name = [...stat.target];
      let rendered = name.join('.');
      if (stat.method) rendered += `:${stat.method}`;
      return state('lua_def_function', { NAME: rendered, PARAMS: params }, inputs);
    }
    case 'Return': {
      if (stat.exprs.length === 0) return state('lua_return');
      if (stat.exprs.length > 1) throw new UnsupportedLuaError('Multiple return values', stat.line);
      return state('lua_return', undefined, { VALUE: value(stat.exprs[0]) });
    }
    case 'Break':
      return state('lua_break');
    case 'If': {
      const extraState = { elseIfCount: stat.clauses.length - 1, hasElse: Boolean(stat.elseBody) };
      const inputs: Record<string, unknown> = {};
      stat.clauses.forEach((clause, index) => {
        inputs[`IF${index}`] = value(clause.cond);
        const stack = stackInput(clause.body);
        if (stack) inputs[`DO${index}`] = stack;
      });
      if (stat.elseBody) {
        const stack = stackInput(stat.elseBody);
        if (stack) inputs.ELSE = stack;
      }
      return state('controls_if', undefined, inputs, extraState);
    }
    case 'Goto':
    case 'Label':
      throw new UnsupportedLuaError(`${stat.type} statements cannot be represented as blocks yet`, stat.line);
    default:
      throw new UnsupportedLuaError('Unsupported statement', (stat as Stat).line);
  }
}

/** Convert Lua source into a Blockly workspace graph. Throws `UnsupportedLuaError`. */
export function blocksFromLua(source: string): ConvertResult {
  const { ast, error } = tryParseLua(source);
  if (!ast) throw new Error(error ? `${error.message}` : 'Unable to parse Lua source.');
  return blocksFromChunk(ast);
}

export function blocksFromChunk(ast: Chunk): ConvertResult {
  const warnings: string[] = [];
  const converted = ast.body.map(convertStat);
  const first = chain(converted);
  const top = first ? [first] : [];
  top.forEach((block, index) => {
    block.x = 32;
    block.y = 24 + index * 160;
  });
  return {
    graph: { blocks: { languageVersion: 0, blocks: top } } as unknown as BlockGraph,
    warnings,
  };
}
