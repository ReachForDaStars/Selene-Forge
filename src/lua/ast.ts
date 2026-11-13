/** Lua 5.1–5.4 AST node definitions and small helpers. */

export interface BaseNode {
  line: number;
}

export type Expr =
  | NilExpr
  | BoolExpr
  | NumberExpr
  | StringExpr
  | VarargExpr
  | NameExpr
  | BinOpExpr
  | UnOpExpr
  | CallExpr
  | IndexExpr
  | TableExpr
  | FunctionExpr
  | ParenExpr;

export interface NilExpr extends BaseNode {
  type: 'Nil';
}
export interface BoolExpr extends BaseNode {
  type: 'Bool';
  value: boolean;
}
export interface NumberExpr extends BaseNode {
  type: 'Number';
  value: number;
  raw: string;
}
export interface StringExpr extends BaseNode {
  type: 'String';
  value: string;
}
export interface VarargExpr extends BaseNode {
  type: 'Vararg';
}
export interface NameExpr extends BaseNode {
  type: 'Name';
  name: string;
}
export interface BinOpExpr extends BaseNode {
  type: 'BinOp';
  op: string;
  left: Expr;
  right: Expr;
}
export interface UnOpExpr extends BaseNode {
  type: 'UnOp';
  op: string;
  operand: Expr;
}
export interface CallExpr extends BaseNode {
  type: 'Call';
  base: Expr;
  /** Present for `obj:method(...)`. */
  method?: string;
  args: Expr[];
}
export interface IndexExpr extends BaseNode {
  type: 'Index';
  base: Expr;
  key: Expr;
  /** True for `base.key`, false for `base[key]`. */
  dot: boolean;
}
export interface TableExpr extends BaseNode {
  type: 'Table';
  fields: TableField[];
}
export type TableField =
  | { kind: 'array'; value: Expr }
  | { kind: 'named'; key: string; value: Expr }
  | { kind: 'keyed'; key: Expr; value: Expr };
export interface FunctionExpr extends BaseNode {
  type: 'Function';
  params: string[];
  vararg: boolean;
  body: Stat[];
}
export interface ParenExpr extends BaseNode {
  type: 'Paren';
  expr: Expr;
}

export type Stat =
  | LocalStat
  | AssignStat
  | CallStat
  | DoStat
  | WhileStat
  | RepeatStat
  | IfStat
  | NumberForStat
  | GenericForStat
  | FunctionDeclStat
  | ReturnStat
  | BreakStat
  | GotoStat
  | LabelStat;

export interface LocalStat extends BaseNode {
  type: 'Local';
  names: string[];
  exprs: Expr[];
}
export interface AssignStat extends BaseNode {
  type: 'Assign';
  targets: Expr[];
  exprs: Expr[];
}
export interface CallStat extends BaseNode {
  type: 'CallStat';
  call: CallExpr;
}
export interface DoStat extends BaseNode {
  type: 'Do';
  body: Stat[];
}
export interface WhileStat extends BaseNode {
  type: 'While';
  cond: Expr;
  body: Stat[];
}
export interface RepeatStat extends BaseNode {
  type: 'Repeat';
  body: Stat[];
  cond: Expr;
}
export interface IfStat extends BaseNode {
  type: 'If';
  clauses: Array<{ cond: Expr; body: Stat[] }>;
  elseBody: Stat[] | null;
}
export interface NumberForStat extends BaseNode {
  type: 'NumberFor';
  name: string;
  start: Expr;
  limit: Expr;
  step: Expr | null;
  body: Stat[];
}
export interface GenericForStat extends BaseNode {
  type: 'GenericFor';
  names: string[];
  exprs: Expr[];
  body: Stat[];
}
export interface FunctionDeclStat extends BaseNode {
  type: 'FunctionDecl';
  local: boolean;
  target: string[];
  method: string | null;
  params: string[];
  vararg: boolean;
  body: Stat[];
}
export interface ReturnStat extends BaseNode {
  type: 'Return';
  exprs: Expr[];
}
export interface BreakStat extends BaseNode {
  type: 'Break';
}
export interface GotoStat extends BaseNode {
  type: 'Goto';
  label: string;
}
export interface LabelStat extends BaseNode {
  type: 'Label';
  label: string;
}

export interface Chunk extends BaseNode {
  type: 'Chunk';
  body: Stat[];
}

export function parseNumberLiteral(raw: string): number {
  const text = raw.replace(/_/g, '');
  if (/^0[xX]/.test(text)) {
    const hex = text.slice(2);
    if (hex.includes('.') || /p/i.test(hex)) {
      const match = /^([0-9a-fA-F]*)(?:\.([0-9a-fA-F]*))?[pP]([+-]?\d+)$/.exec(hex);
      if (match) {
        const intPart = match[1] ? parseInt(match[1], 16) : 0;
        const fracPart = match[2] ? parseInt(match[2], 16) / 16 ** match[2].length : 0;
        return (intPart + fracPart) * 2 ** parseInt(match[3], 10);
      }
    }
    return parseInt(hex, 16);
  }
  return Number(text);
}

/** Depth-first walk over every AST node, useful for analyses. */
export function walk(node: Stat | Expr | Chunk | TableField, visit: (node: Stat | Expr | Chunk) => void): void {
  if ('kind' in node) {
    if (node.kind === 'named') visit(node.value);
    else visit(node.value);
    walk(node.value, visit);
    if (node.kind === 'keyed') walk(node.key, visit);
    return;
  }
  visit(node);
  switch (node.type) {
    case 'Chunk':
    case 'Do':
    case 'While':
    case 'Repeat':
      node.body.forEach((stat) => walk(stat, visit));
      if (node.type === 'While' || node.type === 'Repeat') walk(node.cond, visit);
      break;
    case 'If':
      for (const clause of node.clauses) {
        walk(clause.cond, visit);
        clause.body.forEach((stat) => walk(stat, visit));
      }
      node.elseBody?.forEach((stat) => walk(stat, visit));
      break;
    case 'NumberFor':
      walk(node.start, visit);
      walk(node.limit, visit);
      if (node.step) walk(node.step, visit);
      node.body.forEach((stat) => walk(stat, visit));
      break;
    case 'GenericFor':
      node.exprs.forEach((expr) => walk(expr, visit));
      node.body.forEach((stat) => walk(stat, visit));
      break;
    case 'Local':
      node.exprs.forEach((expr) => walk(expr, visit));
      break;
    case 'Assign':
      node.targets.forEach((expr) => walk(expr, visit));
      node.exprs.forEach((expr) => walk(expr, visit));
      break;
    case 'CallStat':
      walk(node.call, visit);
      break;
    case 'FunctionDecl':
      node.body.forEach((stat) => walk(stat, visit));
      break;
    case 'Return':
      node.exprs.forEach((expr) => walk(expr, visit));
      break;
    case 'BinOp':
      walk(node.left, visit);
      walk(node.right, visit);
      break;
    case 'UnOp':
      walk(node.operand, visit);
      break;
    case 'Call':
      walk(node.base, visit);
      node.args.forEach((expr) => walk(expr, visit));
      break;
    case 'Index':
      walk(node.base, visit);
      walk(node.key, visit);
      break;
    case 'Table':
      node.fields.forEach((field) => walk(field, visit));
      break;
    case 'Function':
      node.body.forEach((stat) => walk(stat, visit));
      break;
    case 'Paren':
      walk(node.expr, visit);
      break;
    default:
      break;
  }
}
