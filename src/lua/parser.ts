import type { Chunk, Expr, Stat, TableExpr, TableField } from './ast';
import { LuaSyntaxError, parseNumberLiteral, tokenize, type Token } from './lexer';

const BINARY_PRECEDENCE: Record<string, [number, number]> = {
  or: [1, 1],
  and: [2, 2],
  '<': [3, 3],
  '>': [3, 3],
  '<=': [3, 3],
  '>=': [3, 3],
  '~=': [3, 3],
  '==': [3, 3],
  '|': [4, 4],
  '~': [5, 5],
  '&': [6, 6],
  '<<': [7, 7],
  '>>': [7, 7],
  '..': [9, 8], // right associative
  '+': [10, 10],
  '-': [10, 10],
  '*': [11, 11],
  '/': [11, 11],
  '//': [11, 11],
  '%': [11, 11],
  '^': [14, 13], // right associative
};

const UNARY_PRECEDENCE = 12;
const BLOCK_FOLLOW = new Set(['end', 'else', 'elseif', 'until', 'eof']);

class Parser {
  private tokens: Token[];
  private position = 0;

  constructor(source: string) {
    this.tokens = tokenize(source);
  }

  private peek(offset = 0): Token {
    return this.tokens[Math.min(this.position + offset, this.tokens.length - 1)];
  }

  private next(): Token {
    const token = this.tokens[this.position];
    if (this.position < this.tokens.length - 1) this.position += 1;
    return token;
  }

  private check(value: string): boolean {
    const token = this.peek();
    return token.value === value && (token.type === 'symbol' || token.type === 'keyword');
  }

  private accept(value: string): boolean {
    if (this.check(value)) {
      this.next();
      return true;
    }
    return false;
  }

  private expect(value: string): Token {
    const token = this.peek();
    if (token.value === value && (token.type === 'symbol' || token.type === 'keyword')) return this.next();
    throw new LuaSyntaxError(`Expected "${value}" but found "${token.value || 'end of file'}"`, token.line, token.col);
  }

  private expectName(context: string): string {
    const token = this.peek();
    if (token.type !== 'name') {
      throw new LuaSyntaxError(`Expected a name ${context} but found "${token.value || 'end of file'}"`, token.line, token.col);
    }
    this.next();
    return token.value;
  }

  parseChunk(): Chunk {
    const line = this.peek().line;
    const body = this.parseBlock();
    if (this.peek().type !== 'eof') {
      const token = this.peek();
      throw new LuaSyntaxError(`Unexpected "${token.value}" after chunk end`, token.line, token.col);
    }
    return { type: 'Chunk', body, line };
  }

  private parseBlock(): Stat[] {
    const stats: Stat[] = [];
    while (!BLOCK_FOLLOW.has(this.peek().value) || this.peek().type !== 'keyword') {
      if (this.peek().type === 'eof') break;
      if (this.accept(';')) continue;
      stats.push(this.parseStatement());
    }
    return stats;
  }

  private parseStatement(): Stat {
    const token = this.peek();
    if (token.type === 'keyword') {
      switch (token.value) {
        case 'if':
          return this.parseIf();
        case 'while':
          return this.parseWhile();
        case 'repeat':
          return this.parseRepeat();
        case 'for':
          return this.parseFor();
        case 'do':
          return this.parseDo();
        case 'function':
          return this.parseFunctionDecl(false);
        case 'local':
          return this.parseLocal();
        case 'return':
          return this.parseReturn();
        case 'break':
          this.next();
          return { type: 'Break', line: token.line };
        case 'goto': {
          this.next();
          const label = this.expectName('after goto');
          return { type: 'Goto', label, line: token.line };
        }
        default:
          break;
      }
    }
    if (this.check('::')) {
      this.next();
      const label = this.expectName('in label');
      this.expect('::');
      return { type: 'Label', label, line: token.line };
    }
    return this.parseExpressionStatement();
  }

  private parseIf(): Stat {
    const line = this.expect('if').line;
    const clauses: Array<{ cond: Expr; body: Stat[] }> = [];
    const cond = this.parseExpression();
    this.expect('then');
    clauses.push({ cond, body: this.parseBlock() });
    while (this.check('elseif')) {
      this.next();
      const elseifCond = this.parseExpression();
      this.expect('then');
      clauses.push({ cond: elseifCond, body: this.parseBlock() });
    }
    let elseBody: Stat[] | null = null;
    if (this.check('else')) {
      this.next();
      elseBody = this.parseBlock();
    }
    this.expect('end');
    return { type: 'If', clauses, elseBody, line };
  }

  private parseWhile(): Stat {
    const line = this.expect('while').line;
    const cond = this.parseExpression();
    this.expect('do');
    const body = this.parseBlock();
    this.expect('end');
    return { type: 'While', cond, body, line };
  }

  private parseRepeat(): Stat {
    const line = this.expect('repeat').line;
    const body = this.parseBlock();
    this.expect('until');
    const cond = this.parseExpression();
    return { type: 'Repeat', body, cond, line };
  }

  private parseDo(): Stat {
    const line = this.expect('do').line;
    const body = this.parseBlock();
    this.expect('end');
    return { type: 'Do', body, line };
  }

  private parseFor(): Stat {
    const line = this.expect('for').line;
    const firstName = this.expectName('after "for"');
    if (this.check('=')) {
      this.next();
      const start = this.parseExpression();
      this.expect(',');
      const limit = this.parseExpression();
      const step = this.accept(',') ? this.parseExpression() : null;
      this.expect('do');
      const body = this.parseBlock();
      this.expect('end');
      return { type: 'NumberFor', name: firstName, start, limit, step, body, line };
    }
    const names = [firstName];
    while (this.accept(',')) names.push(this.expectName('in for name list'));
    this.expect('in');
    const exprs = this.parseExpressionList();
    this.expect('do');
    const body = this.parseBlock();
    this.expect('end');
    return { type: 'GenericFor', names, exprs, body, line };
  }

  private parseFunctionDecl(local: boolean): Stat {
    const line = this.expect('function').line;
    const target: string[] = [this.expectName('after "function"')];
    while (this.accept('.')) target.push(this.expectName('in function name'));
    let method: string | null = null;
    if (this.accept(':')) method = this.expectName('after ":"');
    const { params, vararg, body } = this.parseFunctionBody();
    return { type: 'FunctionDecl', local, target, method, params, vararg, body, line };
  }

  private parseLocal(): Stat {
    const line = this.expect('local').line;
    if (this.check('function')) {
      this.next();
      const name = this.expectName('after "local function"');
      const { params, vararg, body } = this.parseFunctionBody();
      return { type: 'FunctionDecl', local: true, target: [name], method: null, params, vararg, body, line };
    }
    const names = [this.expectName('in local declaration')];
    // Lua 5.4 attributes: local x <const> = 1
    if (this.check('<')) {
      this.next();
      this.expectName('in attribute');
      this.expect('>');
    }
    while (this.accept(',')) {
      names.push(this.expectName('in local name list'));
      if (this.check('<')) {
        this.next();
        this.expectName('in attribute');
        this.expect('>');
      }
    }
    const exprs = this.accept('=') ? this.parseExpressionList() : [];
    return { type: 'Local', names, exprs, line };
  }

  private parseReturn(): Stat {
    const line = this.expect('return').line;
    const follow = this.peek();
    let exprs: Expr[] = [];
    if (!(follow.type === 'eof' || (follow.type === 'keyword' && BLOCK_FOLLOW.has(follow.value)) || this.check(';'))) {
      exprs = this.parseExpressionList();
    }
    this.accept(';');
    return { type: 'Return', exprs, line };
  }

  private parseExpressionStatement(): Stat {
    const line = this.peek().line;
    const first = this.parseSuffixedExpression();
    if (this.check('=') || this.check(',')) {
      const targets: Expr[] = [first];
      while (this.accept(',')) targets.push(this.parseSuffixedExpression());
      this.expect('=');
      const exprs = this.parseExpressionList();
      for (const target of targets) {
        if (target.type !== 'Name' && target.type !== 'Index') {
          throw new LuaSyntaxError('Cannot assign to this expression', target.line, 1);
        }
      }
      return { type: 'Assign', targets, exprs, line };
    }
    if (first.type !== 'Call') {
      throw new LuaSyntaxError('Statement is neither an assignment nor a function call', line, 1);
    }
    return { type: 'CallStat', call: first, line };
  }

  private parseFunctionBody(): { params: string[]; vararg: boolean; body: Stat[] } {
    this.expect('(');
    const params: string[] = [];
    let vararg = false;
    if (!this.check(')')) {
      if (this.accept('...')) {
        vararg = true;
      } else {
        params.push(this.expectName('in parameter list'));
        while (this.accept(',')) {
          if (this.accept('...')) {
            vararg = true;
            break;
          }
          params.push(this.expectName('in parameter list'));
        }
      }
    }
    this.expect(')');
    const body = this.parseBlock();
    this.expect('end');
    return { params, vararg, body };
  }

  private parseExpressionList(): Expr[] {
    const exprs = [this.parseExpression()];
    while (this.accept(',')) exprs.push(this.parseExpression());
    return exprs;
  }

  private parseExpression(minPrecedence = 0): Expr {
    let left: Expr;
    const token = this.peek();
    const isUnary =
      (token.type === 'keyword' && token.value === 'not') ||
      (token.type === 'symbol' && ['-', '#', '~'].includes(token.value));
    if (isUnary) {
      this.next();
      const operand = this.parseExpression(UNARY_PRECEDENCE);
      left = { type: 'UnOp', op: token.value, operand, line: token.line };
    } else {
      left = this.parseSimpleExpression();
    }

    while (true) {
      const op = this.peek();
      if (op.type !== 'symbol' && op.type !== 'keyword') break;
      const precedence = BINARY_PRECEDENCE[op.value];
      if (!precedence) break;
      const [leftPower, rightPower] = precedence;
      if (leftPower <= minPrecedence) break;
      this.next();
      const right = this.parseExpression(rightPower);
      left = { type: 'BinOp', op: op.value, left, right, line: op.line };
    }
    return left;
  }

  private parseSimpleExpression(): Expr {
    const token = this.peek();
    switch (token.type) {
      case 'number':
        this.next();
        return { type: 'Number', value: parseNumberLiteral(token.value), raw: token.value, line: token.line };
      case 'string':
        this.next();
        return { type: 'String', value: token.value, line: token.line };
      case 'name':
        return this.parseSuffixedExpression();
      case 'keyword':
        if (token.value === 'nil') {
          this.next();
          return { type: 'Nil', line: token.line };
        }
        if (token.value === 'true' || token.value === 'false') {
          this.next();
          return { type: 'Bool', value: token.value === 'true', line: token.line };
        }
        if (token.value === 'function') {
          this.next();
          const { params, vararg, body } = this.parseFunctionBody();
          return { type: 'Function', params, vararg, body, line: token.line };
        }
        break;
      case 'symbol':
        if (token.value === '...') {
          this.next();
          return { type: 'Vararg', line: token.line };
        }
        if (token.value === '{') return this.parseTable();
        break;
      default:
        break;
    }
    throw new LuaSyntaxError(`Unexpected token "${token.value || 'end of file'}" in expression`, token.line, token.col);
  }

  private parseSuffixedExpression(): Expr {
    let expression: Expr;
    const token = this.peek();
    if (token.type === 'name') {
      this.next();
      expression = { type: 'Name', name: token.value, line: token.line };
    } else if (this.check('(')) {
      this.next();
      const inner = this.parseExpression();
      this.expect(')');
      expression = { type: 'Paren', expr: inner, line: token.line };
    } else {
      throw new LuaSyntaxError(`Unexpected token "${token.value || 'end of file'}"`, token.line, token.col);
    }

    while (true) {
      if (this.accept('.')) {
        const key = this.expectName('after "."');
        expression = {
          type: 'Index',
          base: expression,
          key: { type: 'String', value: key, line: token.line },
          dot: true,
          line: expression.line,
        };
        continue;
      }
      if (this.check('[')) {
        this.next();
        const key = this.parseExpression();
        this.expect(']');
        expression = { type: 'Index', base: expression, key, dot: false, line: expression.line };
        continue;
      }
      if (this.accept(':')) {
        const method = this.expectName('after ":"');
        const args = this.parseCallArguments();
        expression = { type: 'Call', base: expression, method, args, line: expression.line };
        continue;
      }
      if (this.check('(') || this.check('{') || this.peek().type === 'string') {
        const args = this.parseCallArguments();
        expression = { type: 'Call', base: expression, args, line: expression.line };
        continue;
      }
      break;
    }
    return expression;
  }

  private parseCallArguments(): Expr[] {
    if (this.peek().type === 'string') {
      const token = this.next();
      return [{ type: 'String', value: token.value, line: token.line }];
    }
    if (this.check('{')) return [this.parseTable()];
    this.expect('(');
    if (this.check(')')) {
      this.next();
      return [];
    }
    const args = this.parseExpressionList();
    this.expect(')');
    return args;
  }

  private parseTable(): TableExpr {
    const line = this.expect('{').line;
    const fields: TableField[] = [];
    while (!this.check('}')) {
      if (this.peek().type === 'eof') {
        throw new LuaSyntaxError('Unterminated table constructor', this.peek().line, this.peek().col);
      }
      if (this.check('[')) {
        this.next();
        const key = this.parseExpression();
        this.expect(']');
        this.expect('=');
        fields.push({ kind: 'keyed', key, value: this.parseExpression() });
      } else if (this.peek().type === 'name' && this.peek(1).value === '=') {
        const key = this.next().value;
        this.expect('=');
        fields.push({ kind: 'named', key, value: this.parseExpression() });
      } else {
        fields.push({ kind: 'array', value: this.parseExpression() });
      }
      if (!this.accept(',') && !this.accept(';')) break;
    }
    this.expect('}');
    return { type: 'Table', fields, line };
  }
}

/** Parse a Lua chunk; throws `LuaSyntaxError` with line/column info. */
export function parseLua(source: string): Chunk {
  return new Parser(source).parseChunk();
}

export interface ParseFailure {
  message: string;
  line: number;
  col: number;
}

export function tryParseLua(source: string): { ast: Chunk | null; error: ParseFailure | null } {
  try {
    return { ast: parseLua(source), error: null };
  } catch (error) {
    if (error instanceof LuaSyntaxError) {
      return { ast: null, error: { message: error.message, line: error.line, col: error.col } };
    }
    return { ast: null, error: { message: error instanceof Error ? error.message : String(error), line: 1, col: 1 } };
  }
}
