import {
  CError,
  CHAR,
  DOUBLE,
  INT,
  VOID,
  arrayOf,
  describeType,
  isArrayValue,
  isPointerValue,
  isStringPointer,
  isStructValue,
  pointerTo,
  type Cell,
  type CArrayValue,
  type CExpr,
  type CParam,
  type CProgram,
  type CStat,
  type CStringPointer,
  type CStructValue,
  type CType,
  type CValue,
  type FuncDef,
} from './types';
import type { CContext } from './parser';

export interface InterpreterOptions {
  /** Receives console output from printf, puts and std::cout. */
  print: (text: string) => void;
  maxSteps?: number;
}

type Ref =
  | { k: 'cell'; cell: Cell }
  | { k: 'item'; array: CArrayValue; index: number }
  | { k: 'field'; struct: CStructValue; name: string }
  | { k: 'str'; ptr: CStringPointer };

class ReturnSignal {
  constructor(readonly value: CValue) {}
}
class BreakSignal {}
class ContinueSignal {}

function scalarSize(name: string | undefined): number {
  switch (name) {
    case 'char':
    case 'bool':
      return 1;
    case 'short':
      return 2;
    case 'long':
    case 'double':
      return 8;
    default:
      return 4;
  }
}

export class CInterpreter {
  private ctx: CContext;
  private options: InterpreterOptions;
  private functions = new Map<string, FuncDef>();
  private globals = new Map<string, Cell>();
  private scopes: Array<Map<string, Cell>> = [];
  private steps = 0;
  private depth = 0;
  private currentFile = '';
  private currentLine = 1;
  private currentFunction = '<global>';
  private initialized = false;
  private randomState = 0x2545f491;
  readonly errors: string[] = [];

  constructor(ctx: CContext, programs: CProgram[], options: InterpreterOptions) {
    this.ctx = ctx;
    this.options = options;
    for (const program of programs) {
      for (const fn of program.functions) {
        if (this.functions.has(fn.name)) {
          this.errors.push(`${program.file}:${fn.line}: function "${fn.name}" redefined; the later definition wins.`);
        }
        this.functions.set(fn.name, { ...fn, file: program.file });
      }
      for (const global of program.globals) {
        this.globals.set(global.name, { type: global.type, value: this.defaultValue(global.type) });
        this.globalInitializers.push({ ...global, file: program.file });
      }
    }
  }

  private globalInitializers: Array<{ name: string; type: CType; init: CExpr | null; line: number; file: string }> = [];

  /* ── public API ───────────────────────────────────────────────────────── */

  get functionList(): FuncDef[] {
    return [...this.functions.values()];
  }

  hasFunction(name: string): boolean {
    return this.functions.has(name) || name in this.builtinTable;
  }

  initialize(): void {
    if (this.initialized) return;
    this.initialized = true;
    for (const global of this.globalInitializers) {
      this.currentFile = global.file;
      this.currentLine = global.line;
      if (global.init) {
        const cell = this.globals.get(global.name);
        if (cell) cell.value = this.coerce(this.eval(global.init), global.type, global.line);
      }
    }
  }

  /** Call a C function with JS/Lua values; returns a JS/Lua friendly value. */
  callExternal(name: string, args: unknown[]): unknown {
    this.initialize();
    const fn = this.functions.get(name);
    if (fn) {
      const values = fn.params.map((param: CParam, index: number) => this.fromExternal(args[index], param.type));
      const result = this.invoke(fn, values);
      return this.toExternal(result, fn.returnType);
    }
    if (name in this.builtinTable) {
      const values = args.map((arg) => this.fromExternal(arg, DOUBLE));
      return this.toExternal(this.builtinTable[name](values), DOUBLE);
    }
    throw new CError(`Unknown native function "${name}"`, 'native', 1);
  }

  /** Build a struct from a plain object (Lua table) for the bridge API. */
  makeStruct(typeName: string, fields: Record<string, unknown>): Record<string, unknown> {
    const def = this.ctx.structs.get(typeName);
    if (!def) throw new CError(`Unknown C struct "${typeName}"`, 'native', 1);
    const value: CStructValue = { k: 'struct', typeName, fields: new Map() };
    for (const field of def.fields) {
      const raw = fields[field.name];
      value.fields.set(field.name, this.fromExternal(raw, field.type));
    }
    return this.toExternal(value, { kind: 'struct', name: typeName }) as Record<string, unknown>;
  }

  /** Serialize a value into a Lua table constructor literal. */
  dumpLua(value: unknown): string {
    if (value === null || value === undefined) return '';
    if (typeof value === 'number') return Number.isFinite(value) ? String(value) : '0';
    if (typeof value === 'string') return this.luaQuote(value);
    if (typeof value !== 'object') return '';
    if (Array.isArray(value)) return `{ ${value.map((entry) => this.dumpLua(entry)).join(', ')} }`;
    const entries = Object.entries(value as Record<string, unknown>).filter(([key]) => !key.startsWith('__'));
    if (entries.length === 0) return '{}';
    const parts = entries.map(([key, entry]) => {
      const renderedKey = /^[A-Za-z_]\w*$/.test(key) ? key : `[${this.luaQuote(key)}]`;
      return `${renderedKey} = ${this.dumpLua(entry)}`;
    });
    return `{ ${parts.join(', ')} }`;
  }

  private luaQuote(value: string): string {
    return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n').replace(/\r/g, '\\r')}"`;
  }

  /* ── invocation ───────────────────────────────────────────────────────── */

  private invoke(fn: FuncDef, args: CValue[]): CValue {
    if (this.depth > 96) throw new CError(`Maximum native call depth reached in "${fn.name}"`, fn.file, this.currentLine);
    const previousFile = this.currentFile;
    const previousFunction = this.currentFunction;
    this.currentFile = fn.file;
    this.currentFunction = fn.name;
    this.depth += 1;
    const scope = new Map<string, Cell>();
    fn.params.forEach((param, index) => {
      scope.set(param.name, { type: param.type, value: this.coerce(args[index] ?? this.defaultValue(param.type), param.type, this.currentLine) });
    });
    this.scopes.push(scope);
    try {
      this.exec(fn.body);
      return this.defaultValue(fn.returnType);
    } catch (signal) {
      if (signal instanceof ReturnSignal) return this.coerce(signal.value, fn.returnType, this.currentLine);
      throw signal;
    } finally {
      this.scopes.pop();
      this.depth -= 1;
      this.currentFile = previousFile;
      this.currentFunction = previousFunction;
    }
  }

  private tick(line: number): void {
    this.steps += 1;
    this.currentLine = line;
    const limit = this.options.maxSteps ?? 4_000_000;
    if (this.steps > limit) {
      throw new CError(
        `Native execution limit reached (${limit.toLocaleString()} steps) inside ${this.currentFunction}()`,
        this.currentFile,
        line,
      );
    }
  }

  private fail(message: string, line = this.currentLine): never {
    throw new CError(message, this.currentFile || 'native', line);
  }

  /* ── statements ───────────────────────────────────────────────────────── */

  private exec(stat: CStat): void {
    this.tick(stat.line);
    switch (stat.k) {
      case 'block': {
        this.scopes.push(new Map());
        try {
          for (const child of stat.body) this.exec(child);
        } finally {
          this.scopes.pop();
        }
        return;
      }
      case 'decl':
        for (const declarator of stat.decls) {
          const type = declarator.type;
          let value = this.defaultValue(type);
          if (declarator.init) {
            value = this.applyInitializer(value, type, declarator.init);
          }
          this.declare(declarator.name, type, value);
        }
        return;
      case 'expr':
        this.eval(stat.expr);
        return;
      case 'if':
        if (this.truthy(this.eval(stat.cond))) this.exec(stat.then);
        else if (stat.otherwise) this.exec(stat.otherwise);
        return;
      case 'while':
        while (this.truthy(this.eval(stat.cond))) {
          try {
            this.exec(stat.body);
          } catch (signal) {
            if (signal instanceof BreakSignal) break;
            if (!(signal instanceof ContinueSignal)) throw signal;
          }
          this.tick(stat.line);
        }
        return;
      case 'do':
        do {
          try {
            this.exec(stat.body);
          } catch (signal) {
            if (signal instanceof BreakSignal) break;
            if (!(signal instanceof ContinueSignal)) throw signal;
          }
        } while (this.truthy(this.eval(stat.cond)));
        return;
      case 'for': {
        this.scopes.push(new Map());
        try {
          if (stat.init) {
            const statementKinds = ['block', 'decl', 'expr', 'if', 'while', 'do', 'for', 'switch', 'return', 'break', 'continue', 'empty'];
            if (statementKinds.includes(stat.init.k)) this.exec(stat.init as CStat);
            else this.eval(stat.init as CExpr);
          }
          while (!stat.cond || this.truthy(this.eval(stat.cond))) {
            try {
              this.exec(stat.body);
            } catch (signal) {
              if (signal instanceof BreakSignal) break;
              if (!(signal instanceof ContinueSignal)) throw signal;
            }
            if (stat.step) this.eval(stat.step);
            this.tick(stat.line);
          }
        } finally {
          this.scopes.pop();
        }
        return;
      }
      case 'switch': {
        const discriminant = this.eval(stat.value);
        let start = -1;
        let defaultIndex = -1;
        stat.clauses.forEach((clause, index) => {
          if (!clause.value) {
            defaultIndex = index;
            return;
          }
          const caseValue = this.eval(clause.value);
          if (start === -1 && Number(caseValue) === Number(discriminant)) start = index;
        });
        if (start === -1) start = defaultIndex;
        if (start === -1) return;
        try {
          for (let index = start; index < stat.clauses.length; index += 1) {
            for (const child of stat.clauses[index].body) this.exec(child);
          }
        } catch (signal) {
          if (!(signal instanceof BreakSignal)) throw signal;
        }
        return;
      }
      case 'return':
        throw new ReturnSignal(stat.value ? this.eval(stat.value) : this.defaultValue(INT));
      case 'break':
        throw new BreakSignal();
      case 'continue':
        throw new ContinueSignal();
      case 'empty':
        return;
      default:
        this.fail('Unsupported statement');
    }
  }

  private declare(name: string, type: CType, value: CValue): void {
    const scope = this.scopes[this.scopes.length - 1];
    if (!scope) {
      this.globals.set(name, { type, value });
      return;
    }
    scope.set(name, { type, value });
  }

  private applyInitializer(current: CValue, type: CType, init: CExpr): CValue {
    if (init.k === 'init') {
      const items = init.items.map((item) => this.eval(item));
      if (type.kind === 'array') {
        const elementType = type.of ?? INT;
        const array = current as CArrayValue;
        const length = type.length ?? items.length;
        const values: CValue[] = [];
        for (let index = 0; index < length; index += 1) {
          values.push(index < items.length ? this.coerce(items[index], elementType, init.line) : this.defaultValue(elementType));
        }
        void array;
        return { k: 'array', of: elementType, items: values };
      }
      if (type.kind === 'struct') {
        const def = this.ctx.structs.get(type.name ?? '');
        const struct = current as CStructValue;
        def?.fields.forEach((field, index) => {
          struct.fields.set(field.name, index < items.length ? this.coerce(items[index], field.type, init.line) : this.defaultValue(field.type));
        });
        return struct;
      }
      return items[0] ? this.coerce(items[0], type, init.line) : current;
    }
    return this.coerce(this.eval(init), type, init.line);
  }

  /* ── expressions ──────────────────────────────────────────────────────── */

  private eval(expr: CExpr): CValue {
    switch (expr.k) {
      case 'num':
        return expr.value;
      case 'str':
        return { k: 'strptr', value: expr.value, index: 0 };
      case 'id': {
        const cell = this.resolveCell(expr.name, expr.line);
        if (cell.type.kind === 'array') {
          return { k: 'ptr', to: cell.type.of ?? INT, array: cell.value as CArrayValue, index: 0 } satisfies CValue;
        }
        return cell.value;
      }
      case 'bin':
        return this.binary(expr.op, expr, expr.line);
      case 'assign': {
        const ref = this.refOf(expr.target);
        if (expr.op === '=') {
          const value = this.eval(expr.value);
          const current = this.readRef(ref);
          const declared = ref.k === 'cell' ? ref.cell.type : ref.k === 'field' ? this.fieldTypeOf(ref.struct, ref.name) : null;
          const coerced = declared ? this.coerce(value, declared, expr.line) : value;
          void current;
          this.writeRef(ref, coerced);
          return coerced;
        }
        const operator = expr.op.slice(0, -1);
        const current = this.readRef(ref);
        const right = this.eval(expr.value);
        const computed = this.applyBinary(operator, current, right, expr.line);
        const declared = ref.k === 'cell' ? ref.cell.type : ref.k === 'field' ? this.fieldTypeOf(ref.struct, ref.name) : null;
        const coerced = declared ? this.coerce(computed, declared, expr.line) : computed;
        this.writeRef(ref, coerced);
        return coerced;
      }
      case 'un': {
        if (expr.op === '&') {
          const ref = this.refOf(expr.operand);
          if (ref.k === 'item') return { k: 'ptr', to: ref.array.of, array: ref.array, index: ref.index, cell: null };
          if (ref.k === 'cell') {
            const isArray = ref.cell.type.kind === 'array';
            return {
              k: 'ptr',
              to: isArray ? ref.cell.type.of ?? INT : ref.cell.type,
              array: isArray ? (ref.cell.value as CArrayValue) : null,
              cell: isArray ? null : ref.cell,
              index: 0,
            };
          }
          this.fail('Cannot take the address of this expression', expr.line);
        }
        if (expr.op === '*') {
          const pointer = this.eval(expr.operand);
          if (isStringPointer(pointer)) return this.charAt(pointer, 0);
          if (!isPointerValue(pointer)) this.fail('Dereference of a non-pointer', expr.line);
          return this.readRef(this.pointerRef(pointer, expr.line));
        }
        const operand = this.eval(expr.operand);
        const numeric = Number(operand) || 0;
        switch (expr.op) {
          case '!':
            return this.truthy(operand) ? 0 : 1;
          case '-':
            return -numeric;
          case '+':
            return numeric;
          case '~':
            return ~numeric;
          default:
            this.fail(`Unsupported unary operator "${expr.op}"`, expr.line);
        }
        this.fail('Unsupported unary operator', expr.line);
      }
      case 'incdec': {
        const ref = this.refOf(expr.target);
        const current = Number(this.readRef(ref)) || 0;
        const next = expr.op === '++' ? current + 1 : current - 1;
        this.writeRef(ref, next);
        return expr.prefix ? next : current;
      }
      case 'call':
        return this.call(expr.callee, expr.args, expr.line);
      case 'index': {
        const ref = this.refOf(expr);
        return this.readRef(ref);
      }
      case 'member': {
        const ref = this.refOf(expr);
        return this.readRef(ref);
      }
      case 'cast':
        return this.coerce(this.eval(expr.expr), expr.type, expr.line);
      case 'sizeofType':
        return this.sizeOf(expr.type);
      case 'sizeofExpr': {
        if (expr.expr.k === 'id') {
          const cell = this.resolveCell(expr.expr.name, expr.line);
          return this.sizeOf(cell.type);
        }
        return 4;
      }
      case 'ternary':
        return this.truthy(this.eval(expr.cond)) ? this.eval(expr.then) : this.eval(expr.otherwise);
      case 'comma':
        this.eval(expr.left);
        return this.eval(expr.right);
      case 'init':
        this.fail('Initializer list used outside a declaration', expr.line);
      default:
        this.fail('Unsupported expression');
    }
  }

  private charAt(pointer: CStringPointer, offset: number): number {
    const index = pointer.index + offset;
    return index >= 0 && index < pointer.value.length ? pointer.value.charCodeAt(index) : 0;
  }

  private fieldTypeOf(struct: CStructValue, name: string): CType | null {
    const def = this.ctx.structs.get(struct.typeName);
    return def?.fields.find((field) => field.name === name)?.type ?? null;
  }

  private resolveCell(name: string, line: number): Cell {
    for (let index = this.scopes.length - 1; index >= 0; index -= 1) {
      const cell = this.scopes[index].get(name);
      if (cell) return cell;
    }
    const global = this.globals.get(name);
    if (global) return global;
    if (this.ctx.enums.has(name)) return { type: INT, value: this.ctx.enums.get(name)! };
    this.fail(`Use of undeclared identifier "${name}"`, line);
  }

  private refOf(expr: CExpr): Ref {
    switch (expr.k) {
      case 'id':
        return { k: 'cell', cell: this.resolveCell(expr.name, expr.line) };
      case 'un':
        if (expr.op === '*') {
          const pointer = this.eval(expr.operand);
          if (isStringPointer(pointer)) return { k: 'str', ptr: pointer };
          if (!isPointerValue(pointer)) this.fail('Dereference of a non-pointer', expr.line);
          return this.pointerRef(pointer, expr.line);
        }
        break;
      case 'index': {
        const base = this.eval(expr.base);
        const offset = Math.trunc(Number(this.eval(expr.index)) || 0);
        if (isArrayValue(base)) {
          return { k: 'item', array: base, index: offset };
        }
        if (isStringPointer(base)) {
          return { k: 'str', ptr: { ...base, index: base.index + offset } };
        }
        if (isPointerValue(base)) {
          const resolved = this.pointerRef(base, expr.line);
          if (resolved.k === 'item') return { k: 'item', array: resolved.array, index: resolved.index + offset };
          if (resolved.k === 'cell') {
            if (isArrayValue(resolved.cell.value)) return { k: 'item', array: resolved.cell.value, index: offset };
            if (offset === 0) return resolved;
          }
        }
        this.fail('Indexing a value that is not an array or pointer', expr.line);
        break;
      }
      case 'member': {
        const base = this.eval(expr.base);
        let struct: CValue = base;
        if (expr.arrow) {
          if (isPointerValue(base)) {
            const ref = this.pointerRef(base, expr.line);
            struct = this.readRef(ref);
          } else if (isStringPointer(base)) {
            this.fail('String has no fields', expr.line);
          }
        }
        if (!isStructValue(struct)) this.fail(`Member access on a non-struct value`, expr.line);
        return { k: 'field', struct, name: expr.name };
      }
      default:
        break;
    }
    this.fail('Expression is not assignable', expr.line);
  }

  private pointerRef(pointer: CValue, line: number): Ref {
    if (!isPointerValue(pointer)) this.fail('Expected a pointer', line);
    if (pointer.array) {
      return { k: 'item', array: pointer.array, index: pointer.index };
    }
    if (pointer.cell) return { k: 'cell', cell: pointer.cell };
    this.fail('Null or unresolvable pointer dereference', line);
  }

  private readRef(ref: Ref): CValue {
    switch (ref.k) {
      case 'cell':
        return ref.cell.value;
      case 'item':
        return ref.array.items[ref.index] ?? 0;
      case 'field':
        return ref.struct.fields.get(ref.name) ?? 0;
      case 'str':
        return ref.ptr.value.charCodeAt(ref.ptr.index) || 0;
    }
  }

  private writeRef(ref: Ref, value: CValue): void {
    switch (ref.k) {
      case 'cell':
        ref.cell.value = this.coerce(value, ref.cell.type, this.currentLine);
        return;
      case 'item':
        ref.array.items[ref.index] = this.coerce(value, ref.array.of, this.currentLine);
        return;
      case 'field': {
        const type = this.fieldTypeOf(ref.struct, ref.name);
        ref.struct.fields.set(ref.name, type ? this.coerce(value, type, this.currentLine) : value);
        return;
      }
      case 'str':
        this.fail('Cannot write to a string literal');
    }
  }

  private truthy(value: CValue): boolean {
    if (typeof value === 'number') return value !== 0;
    if (isStringPointer(value)) return value.value.length > value.index;
    return value !== null && value !== undefined;
  }

  private binary(op: string, expr: Extract<CExpr, { k: 'bin' }>, line: number): CValue {
    if (op === '&&') {
      if (!this.truthy(this.eval(expr.left))) return 0;
      return this.truthy(this.eval(expr.right)) ? 1 : 0;
    }
    if (op === '||') {
      if (this.truthy(this.eval(expr.left))) return 1;
      return this.truthy(this.eval(expr.right)) ? 1 : 0;
    }
    return this.applyBinary(op, this.eval(expr.left), this.eval(expr.right), line);
  }

  private applyBinary(op: string, left: CValue, right: CValue, line: number): CValue {
    if (isPointerValue(left) && (op === '+' || op === '-')) {
      const offset = Math.trunc(Number(right) || 0);
      return { ...left, index: left.index + (op === '+' ? offset : -offset) };
    }
    if (isPointerValue(right) && op === '+') {
      const offset = Math.trunc(Number(left) || 0);
      return { ...right, index: right.index + offset };
    }
    if (isPointerValue(left) && isPointerValue(right) && op === '-') {
      return left.index - right.index;
    }
    const a = typeof left === 'number' ? left : Number(left) || 0;
    const b = typeof right === 'number' ? right : Number(right) || 0;
    switch (op) {
      case '+':
        return a + b;
      case '-':
        return a - b;
      case '*':
        return a * b;
      case '/':
        if (b === 0) this.fail('Division by zero', line);
        return a / b;
      case '%':
        if (b === 0) this.fail('Modulo by zero', line);
        return Math.trunc(a) % Math.trunc(b);
      case '&':
        return a & b;
      case '|':
        return a | b;
      case '^':
        return a ^ b;
      case '<<':
        return a << b;
      case '>>':
        return a >> b;
      case '==':
        return a === b ? 1 : 0;
      case '!=':
        return a !== b ? 1 : 0;
      case '<':
        return a < b ? 1 : 0;
      case '>':
        return a > b ? 1 : 0;
      case '<=':
        return a <= b ? 1 : 0;
      case '>=':
        return a >= b ? 1 : 0;
      default:
        this.fail(`Unsupported binary operator "${op}"`, line);
    }
  }

  /* ── calls ────────────────────────────────────────────────────────────── */

  private call(callee: string, argExprs: CExpr[], line: number): CValue {
    const args = argExprs.map((arg) => this.eval(arg));
    const fn = this.functions.get(callee);
    if (fn) return this.invoke(fn, args);
    const builtin = this.builtinTable[callee];
    if (builtin) return builtin(args);
    this.fail(`Call to unknown native function "${callee}"`, line);
  }

  /* ── values ───────────────────────────────────────────────────────────── */

  private defaultValue(type: CType): CValue {
    if (type.kind === 'array') {
      const length = type.length ?? 0;
      const items: CValue[] = [];
      for (let index = 0; index < length; index += 1) items.push(this.defaultValue(type.of ?? INT));
      return { k: 'array', of: type.of ?? INT, items };
    }
    if (type.kind === 'struct') {
      const def = this.ctx.structs.get(type.name ?? '');
      const struct: CStructValue = { k: 'struct', typeName: type.name ?? '', fields: new Map() };
      def?.fields.forEach((field) => struct.fields.set(field.name, this.defaultValue(field.type)));
      return struct;
    }
    if (type.kind === 'ptr') {
      return { k: 'ptr', to: type.of ?? CHAR, array: null, cell: null, index: 0 };
    }
    return 0;
  }

  private cloneValue(value: CValue): CValue {
    if (isStructValue(value)) {
      const copy: CStructValue = { k: 'struct', typeName: value.typeName, fields: new Map() };
      for (const [key, entry] of value.fields) copy.fields.set(key, this.cloneValue(entry));
      return copy;
    }
    if (isArrayValue(value)) {
      return { k: 'array', of: value.of, items: value.items.map((entry) => this.cloneValue(entry)) };
    }
    if (isPointerValue(value)) return { ...value };
    return value;
  }

  private coerce(value: CValue, type: CType, line = this.currentLine): CValue {
    if (type.kind === 'array') {
      if (isArrayValue(value)) return value;
      if (isPointerValue(value) && value.array) return value.array;
      return this.defaultValue(type);
    }
    if (type.kind === 'struct') {
      if (isStructValue(value)) {
        if (value.typeName === type.name) return this.cloneValue(value);
        return value;
      }
      this.fail(`Cannot convert a ${typeof value} value to ${describeType(type)}`, line);
    }
    if (type.kind === 'ptr') {
      if (isStringPointer(value) && (type.of?.name === 'char' || type.of?.kind === 'scalar')) {
        if (type.of?.name === 'char') return value;
      }
      if (isPointerValue(value)) return { ...value, to: type.of ?? CHAR };
      if (typeof value === 'number') return { k: 'ptr', to: type.of ?? CHAR, array: null, cell: null, index: 0 };
      return { k: 'ptr', to: type.of ?? CHAR, array: null, cell: null, index: 0 };
    }
    if (type.name === 'char' && isStringPointer(value)) return this.charAt(value, 0);
    if (type.name === 'bool') return this.truthy(value) ? 1 : 0;
    let numeric = typeof value === 'number' ? value : Number(value) || 0;
    if (type.name === 'float' || type.name === 'double') return numeric;
    if (type.unsigned) numeric = Math.trunc(numeric) >>> 0;
    else numeric = Math.trunc(numeric);
    if (type.name === 'char') numeric = numeric & 0xff;
    if (type.name === 'short') numeric = (numeric << 16) >> 16;
    if (type.name === 'int' || type.name === 'long') numeric = numeric | 0;
    return numeric;
  }

  private sizeOf(type: CType): number {
    if (type.kind === 'array') return (type.length ?? 0) * this.sizeOf(type.of ?? INT);
    if (type.kind === 'ptr') return 8;
    if (type.kind === 'struct') {
      const def = this.ctx.structs.get(type.name ?? '');
      return def?.fields.reduce((total, field) => total + this.sizeOf(field.type), 0) ?? 0;
    }
    return scalarSize(type.name);
  }

  private fromExternal(value: unknown, type: CType): CValue {
    if (value === null || value === undefined) return this.defaultValue(type);
    if (type.kind === 'struct') {
      if (typeof value === 'object') {
        const def = this.ctx.structs.get(type.name ?? '');
        const struct: CStructValue = { k: 'struct', typeName: type.name ?? '', fields: new Map() };
        def?.fields.forEach((field) => {
          const raw = (value as Record<string, unknown>)[field.name];
          struct.fields.set(field.name, this.fromExternal(raw, field.type));
        });
        return struct;
      }
      return this.defaultValue(type);
    }
    if (type.kind === 'array') return this.defaultValue(type);
    if (type.name === 'char' && type.kind === 'scalar' && typeof value === 'string') return value.charCodeAt(0) || 0;
    if (type.kind === 'ptr' || type.name === 'char') {
      if (typeof value === 'string') return { k: 'strptr', value, index: 0 };
      if (typeof value === 'number') return value;
      if (isArrayValue(value)) return value;
    }
    if (typeof value === 'number') return value;
    if (typeof value === 'string') return { k: 'strptr', value, index: 0 };
    if (Array.isArray(value)) {
      return { k: 'array', of: type.of ?? INT, items: value.map((entry) => this.fromExternal(entry, type.of ?? INT)) } as CValue;
    }
    return 0;
  }

  private toExternal(value: CValue, type: CType): unknown {
    if (typeof value === 'number') return value;
    if (isStringPointer(value)) return value.value.slice(value.index);
    if (isStructValue(value)) {
      const result: Record<string, unknown> = {};
      for (const [key, entry] of value.fields) {
        result[key] = isStructValue(entry) ? this.toExternal(entry, { kind: 'struct', name: entry.typeName }) : typeof entry === 'number' ? entry : this.toExternal(entry, INT);
      }
      return result;
    }
    if (isArrayValue(value)) {
      return value.items.map((entry) => (typeof entry === 'number' ? entry : this.toExternal(entry, type)));
    }
    if (isPointerValue(value)) {
      if ((value.to.name === 'char' || value.to.name === undefined) && value.array) {
        let text = '';
        for (const item of value.array.items) {
          const code = Number(item) || 0;
          if (code === 0) break;
          text += String.fromCharCode(code);
        }
        return text;
      }
      return 0;
    }
    return 0;
  }

  /* ── builtins ─────────────────────────────────────────────────────────── */

  private readString(value: CValue): string {
    if (typeof value === 'string') return value;
    if (isStringPointer(value)) return value.value.slice(value.index);
    if (isArrayValue(value)) {
      let text = '';
      for (const item of value.items) {
        const code = Number(item) || 0;
        if (code === 0) break;
        text += String.fromCharCode(code);
      }
      return text;
    }
    if (isPointerValue(value) && value.array) {
      let text = '';
      for (let index = value.index; index < value.array.items.length; index += 1) {
        const code = Number(value.array.items[index]) || 0;
        if (code === 0) break;
        text += String.fromCharCode(code);
      }
      return text;
    }
    return '';
  }

  private allocate(count: number, elementType: CType): CPointerValueLike {
    const size = Math.max(1, Math.trunc(count));
    const items: CValue[] = [];
    for (let index = 0; index < size; index += 1) items.push(0);
    return { k: 'ptr', to: elementType, array: { k: 'array', of: elementType, items }, cell: null, index: 0 };
  }

  private writeChar(pointer: CValue, offset: number, code: number): void {
    if (isPointerValue(pointer) && pointer.array) {
      pointer.array.items[pointer.index + offset] = code;
    }
  }

  private formatPrintf(format: string, args: CValue[]): string {
    let output = '';
    let argIndex = 0;
    let index = 0;
    while (index < format.length) {
      const char = format[index];
      if (char !== '%') {
        output += char;
        index += 1;
        continue;
      }
      index += 1;
      if (format[index] === '%') {
        output += '%';
        index += 1;
        continue;
      }
      let flags = '';
      while (index < format.length && '-+ 0#'.includes(format[index])) {
        flags += format[index];
        index += 1;
      }
      let width = '';
      while (index < format.length && /[0-9]/.test(format[index])) {
        width += format[index];
        index += 1;
      }
      let precision: number | null = null;
      if (format[index] === '.') {
        index += 1;
        let digits = '';
        while (index < format.length && /[0-9]/.test(format[index])) {
          digits += format[index];
          index += 1;
        }
        precision = digits ? Number(digits) : 0;
      }
      while (index < format.length && /[hljztL]/.test(format[index])) index += 1;
      const spec = format[index] ?? '';
      index += 1;
      const argument = args[argIndex];
      argIndex += 1;
      let rendered = '';
      switch (spec) {
        case 'd':
        case 'i': {
          const numeric = Math.trunc(Number(argument) || 0);
          rendered = String(numeric);
          if (flags.includes('+') && numeric >= 0) rendered = `+${rendered}`;
          break;
        }
        case 'u':
          rendered = String(Math.trunc(Number(argument) || 0) >>> 0);
          break;
        case 'x':
        case 'X': {
          rendered = (Math.trunc(Number(argument) || 0) >>> 0).toString(16);
          if (spec === 'X') rendered = rendered.toUpperCase();
          if (flags.includes('#')) rendered = `0x${rendered}`;
          break;
        }
        case 'o':
          rendered = (Math.trunc(Number(argument) || 0) >>> 0).toString(8);
          break;
        case 'c':
          rendered = String.fromCharCode(typeof argument === 'number' ? argument : Number(argument) || 0);
          break;
        case 's':
          rendered = this.readString(argument ?? 0);
          if (precision !== null) rendered = rendered.slice(0, precision);
          break;
        case 'f':
        case 'F':
          rendered = (Number(argument) || 0).toFixed(precision ?? 6);
          break;
        case 'e':
        case 'E':
          rendered = (Number(argument) || 0).toExponential(precision ?? 6);
          if (spec === 'E') rendered = rendered.toUpperCase();
          break;
        case 'g':
        case 'G':
          rendered = String(Number(argument) || 0);
          break;
        case 'p':
          rendered = '0x0';
          break;
        default:
          rendered = `%${spec}`;
      }
      if (width) {
        const target = Number(width);
        if (rendered.length < target) {
          const pad = flags.includes('0') && !flags.includes('-') ? '0' : ' ';
          rendered = flags.includes('-') ? rendered.padEnd(target, pad) : rendered.padStart(target, pad);
        }
      }
      output += rendered;
    }
    void args;
    return output;
  }

  private readonly builtinTable: Record<string, (args: CValue[]) => CValue> = {
    printf: (args) => {
      const format = this.readString(args[0] ?? 0);
      const text = this.formatPrintf(format, args.slice(1));
      this.options.print(text);
      return text.length;
    },
    fprintf: (args) => {
      const format = this.readString(args[1] ?? 0);
      const text = this.formatPrintf(format, args.slice(2));
      this.options.print(text);
      return text.length;
    },
    sprintf: (args) => {
      const destination = args[0];
      const format = this.readString(args[1] ?? 0);
      const text = this.formatPrintf(format, args.slice(2));
      for (let index = 0; index < text.length; index += 1) this.writeChar(destination, index, text.charCodeAt(index));
      this.writeChar(destination, text.length, 0);
      return text.length;
    },
    puts: (args) => {
      this.options.print(`${this.readString(args[0] ?? 0)}\n`);
      return 0;
    },
    putchar: (args) => {
      const code = typeof args[0] === 'number' ? args[0] : 0;
      this.options.print(String.fromCharCode(code));
      return code;
    },
    __cout: (args) => {
      let text = '';
      for (const arg of args) {
        if (typeof arg === 'number') text += String(arg);
        else text += this.readString(arg);
      }
      this.options.print(text);
      return 0;
    },
    strlen: (args) => this.readString(args[0] ?? 0).length,
    strcmp: (args) => {
      const a = this.readString(args[0] ?? 0);
      const b = this.readString(args[1] ?? 0);
      return a < b ? -1 : a > b ? 1 : 0;
    },
    strncmp: (args) => {
      const count = Math.trunc(Number(args[2]) || 0);
      const a = this.readString(args[0] ?? 0).slice(0, count);
      const b = this.readString(args[1] ?? 0).slice(0, count);
      return a < b ? -1 : a > b ? 1 : 0;
    },
    strcpy: (args) => {
      const text = this.readString(args[1] ?? 0);
      for (let index = 0; index < text.length; index += 1) this.writeChar(args[0], index, text.charCodeAt(index));
      this.writeChar(args[0], text.length, 0);
      return args[0] ?? 0;
    },
    strcat: (args) => {
      const existing = this.readString(args[0] ?? 0);
      const addition = this.readString(args[1] ?? 0);
      for (let index = 0; index < addition.length; index += 1) {
        this.writeChar(args[0], existing.length + index, addition.charCodeAt(index));
      }
      this.writeChar(args[0], existing.length + addition.length, 0);
      return args[0] ?? 0;
    },
    atoi: (args) => {
      const parsed = parseInt(this.readString(args[0] ?? 0), 10);
      return Number.isFinite(parsed) ? parsed : 0;
    },
    atol: (args) => {
      const parsed = parseInt(this.readString(args[0] ?? 0), 10);
      return Number.isFinite(parsed) ? parsed : 0;
    },
    atof: (args) => {
      const parsed = Number.parseFloat(this.readString(args[0] ?? 0));
      return Number.isFinite(parsed) ? parsed : 0;
    },
    abs: (args) => Math.abs(Math.trunc(Number(args[0]) || 0)),
    labs: (args) => Math.abs(Math.trunc(Number(args[0]) || 0)),
    fabs: (args) => Math.abs(Number(args[0]) || 0),
    sqrt: (args) => Math.sqrt(Number(args[0]) || 0),
    pow: (args) => Math.pow(Number(args[0]) || 0, Number(args[1]) || 0),
    floor: (args) => Math.floor(Number(args[0]) || 0),
    ceil: (args) => Math.ceil(Number(args[0]) || 0),
    round: (args) => Math.round(Number(args[0]) || 0),
    trunc: (args) => Math.trunc(Number(args[0]) || 0),
    fmin: (args) => Math.min(Number(args[0]) || 0, Number(args[1]) || 0),
    fmax: (args) => Math.max(Number(args[0]) || 0, Number(args[1]) || 0),
    sin: (args) => Math.sin(Number(args[0]) || 0),
    cos: (args) => Math.cos(Number(args[0]) || 0),
    tan: (args) => Math.tan(Number(args[0]) || 0),
    log: (args) => Math.log(Number(args[0]) || 0),
    log10: (args) => Math.log10(Number(args[0]) || 0),
    exp: (args) => Math.exp(Number(args[0]) || 0),
    malloc: (args) => this.allocate(Number(args[0]) || 0, CHAR),
    calloc: (args) => this.allocate((Number(args[0]) || 0) * (Number(args[1]) || 1), CHAR),
    realloc: (args) => {
      const size = Math.trunc(Number(args[1]) || 0);
      return this.allocate(size, CHAR);
    },
    free: () => 0,
    memset: (args) => {
      const pointer = args[0];
      const value = Math.trunc(Number(args[1]) || 0);
      const count = Math.trunc(Number(args[2]) || 0);
      for (let index = 0; index < count; index += 1) this.writeChar(pointer, index, value);
      return pointer ?? 0;
    },
    memcpy: (args) => {
      const destination = args[0];
      const source = args[1];
      const count = Math.trunc(Number(args[2]) || 0);
      for (let index = 0; index < count; index += 1) {
        const value = isPointerValue(source) && source.array ? source.array.items[source.index + index] : 0;
        this.writeChar(destination, index, Number(value) || 0);
      }
      return destination ?? 0;
    },
    rand: () => {
      this.randomState = (this.randomState * 1664525 + 1013904223) >>> 0;
      return this.randomState % 32768;
    },
    srand: (args) => {
      this.randomState = (Number(args[0]) || 1) >>> 0;
      return 0;
    },
    exit: (args) => {
      this.fail(`native exit(${Math.trunc(Number(args[0]) || 0)})`);
    },
  };
}

interface CPointerValueLike {
  k: 'ptr';
  to: CType;
  array: CArrayValue;
  cell: null;
  index: number;
}

export { CError, VOID, DOUBLE, pointerTo, arrayOf, type CType, type CValue };
