/** Types and AST for the in-browser C subset compiler. */

export type ScalarName = 'void' | 'char' | 'short' | 'int' | 'long' | 'float' | 'double' | 'bool';

export interface CType {
  kind: 'scalar' | 'ptr' | 'array' | 'struct';
  /** Scalar name, or struct tag. */
  name?: string;
  unsigned?: boolean;
  of?: CType;
  /** Array length; null for an unsized array. */
  length?: number | null;
}

export const scalarType = (name: ScalarName, unsigned = false): CType => ({ kind: 'scalar', name, unsigned });
export const pointerTo = (of: CType): CType => ({ kind: 'ptr', of });
export const arrayOf = (of: CType, length: number | null): CType => ({ kind: 'array', of, length });
export const structType = (name: string): CType => ({ kind: 'struct', name });

export const INT = scalarType('int');
export const CHAR = scalarType('char');
export const DOUBLE = scalarType('double');
export const VOID = scalarType('void');

export function isNumeric(type: CType): boolean {
  return type.kind === 'scalar' && type.name !== 'void';
}

export function isPointerLike(type: CType): boolean {
  return type.kind === 'ptr' || type.kind === 'array';
}

export function describeType(type: CType): string {
  if (type.kind === 'ptr') return `${describeType(type.of ?? VOID)}*`;
  if (type.kind === 'array') return `${describeType(type.of ?? INT)}[${type.length ?? ''}]`;
  if (type.kind === 'struct') return `struct ${type.name ?? '?'}`;
  return `${type.unsigned ? 'unsigned ' : ''}${type.name ?? 'int'}`;
}

export interface CParam {
  name: string;
  type: CType;
}

export interface CExprBase {
  line: number;
}

export type CExpr =
  | (CExprBase & { k: 'num'; value: number })
  | (CExprBase & { k: 'str'; value: string })
  | (CExprBase & { k: 'id'; name: string })
  | (CExprBase & { k: 'bin'; op: string; left: CExpr; right: CExpr })
  | (CExprBase & { k: 'assign'; op: string; target: CExpr; value: CExpr })
  | (CExprBase & { k: 'un'; op: string; operand: CExpr })
  | (CExprBase & { k: 'incdec'; op: '++' | '--'; prefix: boolean; target: CExpr })
  | (CExprBase & { k: 'call'; callee: string; args: CExpr[] })
  | (CExprBase & { k: 'index'; base: CExpr; index: CExpr })
  | (CExprBase & { k: 'member'; base: CExpr; name: string; arrow: boolean })
  | (CExprBase & { k: 'cast'; type: CType; expr: CExpr })
  | (CExprBase & { k: 'sizeofType'; type: CType })
  | (CExprBase & { k: 'sizeofExpr'; expr: CExpr })
  | (CExprBase & { k: 'ternary'; cond: CExpr; then: CExpr; otherwise: CExpr })
  | (CExprBase & { k: 'comma'; left: CExpr; right: CExpr })
  | (CExprBase & { k: 'init'; items: CExpr[] });

export interface CDeclarator {
  name: string;
  type: CType;
  init: CExpr | null;
}

export type CStat =
  | { k: 'block'; body: CStat[]; line: number }
  | { k: 'decl'; decls: CDeclarator[]; line: number }
  | { k: 'expr'; expr: CExpr; line: number }
  | { k: 'if'; cond: CExpr; then: CStat; otherwise: CStat | null; line: number }
  | { k: 'while'; cond: CExpr; body: CStat; line: number }
  | { k: 'do'; body: CStat; cond: CExpr; line: number }
  | {
      k: 'for';
      init: CStat | CExpr | null;
      cond: CExpr | null;
      step: CExpr | null;
      body: CStat;
      line: number;
    }
  | { k: 'switch'; value: CExpr; clauses: Array<{ value: CExpr | null; body: CStat[] }>; line: number }
  | { k: 'return'; value: CExpr | null; line: number }
  | { k: 'break'; line: number }
  | { k: 'continue'; line: number }
  | { k: 'empty'; line: number };

export interface StructDef {
  name: string;
  fields: Array<{ name: string; type: CType }>;
}

export interface FuncDef {
  name: string;
  returnType: CType;
  params: CParam[];
  body: CStat;
  line: number;
  file: string;
  /** Source text of the whole definition, for display. */
  signature: string;
}

export interface GlobalDecl {
  name: string;
  type: CType;
  init: CExpr | null;
  line: number;
}

export interface CProgram {
  file: string;
  structs: StructDef[];
  functions: FuncDef[];
  globals: GlobalDecl[];
}

export class CError extends Error {
  line: number;
  file: string;
  constructor(message: string, file: string, line: number) {
    super(message);
    this.name = 'CError';
    this.line = line;
    this.file = file;
  }

  format(): string {
    return `${this.file}:${this.line}: ${this.message}`;
  }
}

/* ── Runtime values ──────────────────────────────────────────────────────── */

export interface CStructValue {
  k: 'struct';
  typeName: string;
  /** Field order is preserved from the struct definition. */
  fields: Map<string, CValue>;
}

export interface CArrayValue {
  k: 'array';
  of: CType;
  items: CValue[];
}

export interface CStringPointer {
  k: 'strptr';
  value: string;
  index: number;
}

export interface CPointerValue {
  k: 'ptr';
  to: CType;
  /** Backing storage: an array cell or scalar cell. */
  array: CArrayValue | null;
  /** Scalar backing cell for `&variable` pointers. */
  cell?: Cell | null;
  /** Index into the backing array (or 0 for scalars). */
  index: number;
  /** Fallback for pointers we cannot resolve (e.g. returned from malloc + casts). */
  raw?: number;
}

export type CValue = number | CStructValue | CArrayValue | CStringPointer | CPointerValue;

export interface Cell {
  type: CType;
  value: CValue;
}

export function isStructValue(value: unknown): value is CStructValue {
  return typeof value === 'object' && value !== null && (value as CStructValue).k === 'struct';
}

export function isArrayValue(value: unknown): value is CArrayValue {
  return typeof value === 'object' && value !== null && (value as CArrayValue).k === 'array';
}

export function isStringPointer(value: unknown): value is CStringPointer {
  return typeof value === 'object' && value !== null && (value as CStringPointer).k === 'strptr';
}

export function isPointerValue(value: unknown): value is CPointerValue {
  return typeof value === 'object' && value !== null && (value as CPointerValue).k === 'ptr';
}
