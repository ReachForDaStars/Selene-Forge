import {
  arrayOf,
  CError,
  CHAR,
  DOUBLE,
  INT,
  pointerTo,
  scalarType,
  structType,
  VOID,
  type CDeclarator,
  type CExpr,
  type CParam,
  type CProgram,
  type CStat,
  type CType,
  type FuncDef,
  type GlobalDecl,
  type StructDef,
} from './types';

/* ── Tokenizer ───────────────────────────────────────────────────────────── */

type TokenKind = 'id' | 'num' | 'str' | 'char' | 'punc' | 'eof';

interface Token {
  k: TokenKind;
  v: string;
  num?: number;
  line: number;
}

const PUNCTUATORS = [
  '<<=',
  '>>=',
  '...',
  '->',
  '++',
  '--',
  '<<',
  '>>',
  '<=',
  '>=',
  '==',
  '!=',
  '&&',
  '||',
  '+=',
  '-=',
  '*=',
  '/=',
  '%=',
  '&=',
  '|=',
  '^=',
  '::',
];

const TYPE_KEYWORDS = new Set([
  'const',
  'static',
  'extern',
  'inline',
  'volatile',
  'register',
  'auto',
  'typedef',
  'signed',
  'unsigned',
  'long',
  'short',
  'int',
  'char',
  'float',
  'double',
  'void',
  'bool',
  '_Bool',
  'struct',
  'union',
  'enum',
]);

interface Macro {
  num?: number;
  str?: string;
}

function decodeEscape(source: string, index: number): { text: string; next: number } {
  const char = source[index];
  switch (char) {
    case 'n':
      return { text: '\n', next: index + 1 };
    case 't':
      return { text: '\t', next: index + 1 };
    case 'r':
      return { text: '\r', next: index + 1 };
    case '0':
      return { text: '\0', next: index + 1 };
    case '\\':
      return { text: '\\', next: index + 1 };
    case '"':
      return { text: '"', next: index + 1 };
    case "'":
      return { text: "'", next: index + 1 };
    case 'a':
      return { text: '\x07', next: index + 1 };
    case 'b':
      return { text: '\b', next: index + 1 };
    case 'f':
      return { text: '\f', next: index + 1 };
    case 'v':
      return { text: '\v', next: index + 1 };
    case 'x': {
      const match = /^[0-9a-fA-F]{1,2}/.exec(source.slice(index + 1));
      if (!match) return { text: 'x', next: index + 1 };
      return { text: String.fromCharCode(parseInt(match[0], 16)), next: index + 1 + match[0].length };
    }
    default:
      if (char >= '0' && char <= '7') {
        const match = /^[0-7]{1,3}/.exec(source.slice(index));
        if (match) return { text: String.fromCharCode(parseInt(match[0], 8)), next: index + match[0].length };
      }
      return { text: char ?? '', next: index + 1 };
  }
}

export function tokenizeC(file: string, source: string): { tokens: Token[]; macros: Map<string, Macro> } {
  const tokens: Token[] = [];
  const macros = new Map<string, Macro>();
  let index = 0;
  let line = 1;
  const length = source.length;
  let atLineStart = true;

  while (index < length) {
    const char = source[index];
    if (char === '\n') {
      line += 1;
      index += 1;
      atLineStart = true;
      continue;
    }
    if (char === ' ' || char === '\t' || char === '\r' || char === '\f') {
      index += 1;
      continue;
    }
    if (char === '/' && source[index + 1] === '/') {
      while (index < length && source[index] !== '\n') index += 1;
      continue;
    }
    if (char === '/' && source[index + 1] === '*') {
      index += 2;
      while (index < length && !(source[index] === '*' && source[index + 1] === '/')) {
        if (source[index] === '\n') line += 1;
        index += 1;
      }
      index += 2;
      continue;
    }
    if (char === '#' && atLineStart) {
      let end = index;
      while (end < length && source[end] !== '\n') end += 1;
      const directive = source.slice(index + 1, end).trim();
      const defineMatch = /^define\s+([A-Za-z_]\w*)(\s+(.*))?$/.exec(directive);
      if (defineMatch && defineMatch[3] !== undefined && !defineMatch[1].includes('(')) {
        const raw = defineMatch[3].trim();
        const numberMatch = /^-?(0x[0-9a-fA-F]+|\d+(?:\.\d+)?)[uUlLfF]*$/.exec(raw);
        if (numberMatch) macros.set(defineMatch[1], { num: Number(numberMatch[1]) });
        else if (/^".*"$/.test(raw)) macros.set(defineMatch[1], { str: raw.slice(1, -1) });
      }
      index = end;
      continue;
    }
    atLineStart = false;

    if (char === '"' || char === "'") {
      const quote = char;
      let cursor = index + 1;
      let text = '';
      while (cursor < length && source[cursor] !== quote) {
        if (source[cursor] === '\\') {
          const decoded = decodeEscape(source, cursor + 1);
          text += decoded.text;
          cursor = decoded.next;
          continue;
        }
        if (source[cursor] === '\n') break;
        text += source[cursor];
        cursor += 1;
      }
      cursor += 1;
      if (quote === '"') {
        tokens.push({ k: 'str', v: text, line });
      } else {
        tokens.push({ k: 'char', v: text, num: text.charCodeAt(0) || 0, line });
      }
      index = cursor;
      continue;
    }

    if (/[0-9]/.test(char) || (char === '.' && /[0-9]/.test(source[index + 1] ?? ''))) {
      const start = index;
      if (char === '0' && /[xX]/.test(source[index + 1] ?? '')) {
        index += 2;
        while (index < length && /[0-9a-fA-F]/.test(source[index])) index += 1;
        const raw = source.slice(start, index).replace(/[uUlL]+$/, '');
        const suffixMatch = /[uUlL]+$/.exec(source.slice(start, index));
        index = start + raw.length + (suffixMatch ? suffixMatch[0].length : 0);
        tokens.push({ k: 'num', v: raw, num: parseInt(raw, 16), line });
        continue;
      }
      while (index < length && /[0-9.]/.test(source[index])) index += 1;
      if (/[eE]/.test(source[index] ?? '')) {
        index += 1;
        if (/[+-]/.test(source[index] ?? '')) index += 1;
        while (index < length && /[0-9]/.test(source[index])) index += 1;
      }
      const raw = source.slice(start, index);
      while (index < length && /[uUlLfF]/.test(source[index])) index += 1;
      tokens.push({ k: 'num', v: raw, num: Number(raw), line });
      continue;
    }

    if (/[A-Za-z_$]/.test(char)) {
      const start = index;
      index += 1;
      while (index < length && /[A-Za-z0-9_$]/.test(source[index])) index += 1;
      tokens.push({ k: 'id', v: source.slice(start, index), line });
      continue;
    }

    let matched = false;
    for (const punctuator of PUNCTUATORS) {
      if (source.startsWith(punctuator, index)) {
        tokens.push({ k: 'punc', v: punctuator, line });
        index += punctuator.length;
        matched = true;
        break;
      }
    }
    if (matched) continue;
    if ('+-*/%&|^~!<>=(){}[];,.:?'.includes(char)) {
      tokens.push({ k: 'punc', v: char, line });
      index += 1;
      continue;
    }
    throw new CError(`Unexpected character "${char}"`, file, line);
  }

  tokens.push({ k: 'eof', v: '', line });
  return { tokens, macros };
}

/* ── Parser ──────────────────────────────────────────────────────────────── */

export interface CContext {
  structs: Map<string, StructDef>;
  typedefs: Map<string, CType>;
  enums: Map<string, number>;
}

export function createCContext(): CContext {
  return { structs: new Map(), typedefs: new Map(), enums: new Map() };
}

const BINARY_PRECEDENCE: Record<string, number> = {
  '||': 1,
  '&&': 2,
  '|': 3,
  '^': 4,
  '&': 5,
  '==': 6,
  '!=': 6,
  '<': 7,
  '>': 7,
  '<=': 7,
  '>=': 7,
  '<<': 8,
  '>>': 8,
  '+': 9,
  '-': 9,
  '*': 10,
  '/': 10,
  '%': 10,
};

const ASSIGNMENT_OPS = new Set(['=', '+=', '-=', '*=', '/=', '%=', '&=', '|=', '^=', '<<=', '>>=']);

class CParser {
  private tokens: Token[];
  private pos = 0;
  private macros: Map<string, Macro>;
  private file: string;
  private ctx: CContext;
  private program: CProgram;

  constructor(file: string, source: string, ctx: CContext) {
    this.file = file;
    this.ctx = ctx;
    const { tokens, macros } = tokenizeC(file, source);
    this.tokens = tokens;
    this.macros = macros;
    this.program = { file, structs: [], functions: [], globals: [] };
  }

  private peek(offset = 0): Token {
    return this.tokens[Math.min(this.pos + offset, this.tokens.length - 1)];
  }

  private next(): Token {
    const token = this.tokens[this.pos];
    if (this.pos < this.tokens.length - 1) this.pos += 1;
    return token;
  }

  private check(value: string): boolean {
    return this.peek().v === value && (this.peek().k === 'punc' || this.peek().k === 'id');
  }

  private accept(value: string): boolean {
    if (this.check(value)) {
      this.next();
      return true;
    }
    return false;
  }

  private expect(value: string): void {
    if (!this.accept(value)) {
      const token = this.peek();
      throw new CError(`Expected "${value}" but found "${token.v || 'end of file'}"`, this.file, token.line);
    }
  }

  private expectIdent(context: string): string {
    const token = this.peek();
    if (token.k !== 'id') throw new CError(`Expected identifier ${context}`, this.file, token.line);
    this.next();
    return token.v;
  }

  parseProgram(): CProgram {
    this.parseTopLevel(true);
    return this.program;
  }

  private parseTopLevel(allowDeclarations: boolean): void {
    while (this.peek().k !== 'eof' && !this.check('}')) {
      if (this.accept(';')) continue;

      if (this.check('namespace') || this.check('class') || this.check('using') || this.check('template')) {
        const keyword = this.next().v;
        if (keyword === 'class' || keyword === 'template') {
          throw new CError(
            `C++ ${keyword} is outside the supported native subset (use structs and free functions)`,
            this.file,
            this.peek().line,
          );
        }
        if (keyword === 'using') {
          while (this.peek().k !== 'eof' && !this.check(';')) this.next();
          this.accept(';');
          continue;
        }
        if (keyword === 'namespace') {
          if (this.peek().k === 'id') this.next();
          this.expect('{');
          this.parseTopLevel(false);
          this.expect('}');
          continue;
        }
      }

      if (this.check('extern') && this.peek(1).k === 'str') {
        this.next();
        this.next();
        this.expect('{');
        this.parseTopLevel(false);
        this.expect('}');
        continue;
      }

      const specs = this.parseDeclSpecs();
      if (this.accept(';')) continue;
      this.parseDeclarationTail(specs.type, specs.isTypedef, allowDeclarations);
    }
  }

  /** `typedef struct { ... } Vec2;` — give the anonymous record the typedef name. */
  private nameAnonymousStruct(alias: string, type: CType): void {
    if (type.kind !== 'struct' || !type.name || !type.name.startsWith('__anon_')) return;
    const def = this.ctx.structs.get(type.name);
    if (!def) return;
    this.ctx.structs.delete(type.name);
    def.name = alias;
    type.name = alias;
    this.ctx.structs.set(alias, def);
  }

  private parseDeclarationTail(baseType: CType, isTypedef: boolean, allowDeclarations: boolean): void {
    const declarators: Array<CDeclarator & { isFunction: boolean; params: CParam[]; vararg: boolean }> = [];
    do {
      declarators.push(this.parseDeclarator(baseType));
    } while (this.accept(','));

    const first = declarators[0];
    if (first.isFunction && this.check('{')) {
      if (isTypedef) throw new CError('Function typedefs are not supported', this.file, this.peek().line);
      const body = this.parseBlock();
      const signature = `${first.name}(${first.params.map((param) => `${param.type.name ?? 'int'} ${param.name}`).join(', ')})`;
      const func: FuncDef = {
        name: first.name,
        returnType: first.type,
        params: first.params,
        body,
        line: this.peek().line,
        file: this.file,
        signature,
      };
      this.program.functions.push(func);
      return;
    }

    this.expect(';');
    for (const declarator of declarators) {
      if (declarator.isFunction) continue; // prototype
      if (isTypedef) {
        this.ctx.typedefs.set(declarator.name, declarator.type);
        this.nameAnonymousStruct(declarator.name, declarator.type);
        continue;
      }
      if (!allowDeclarations) continue;
      const global: GlobalDecl = {
        name: declarator.name,
        type: declarator.type,
        init: declarator.init,
        line: this.peek().line,
      };
      this.program.globals.push(global);
    }
  }

  private parseDeclSpecs(): { type: CType; isTypedef: boolean } {
    let isTypedef = false;
    let unsigned = false;
    let signed = false;
    let longs = 0;
    let shorts = 0;
    let base: 'void' | 'char' | 'short' | 'int' | 'long' | 'float' | 'double' | 'bool' | null = null;
    let resolved: CType | null = null;

    while (true) {
      const token = this.peek();
      if (token.k !== 'id') break;
      const word = token.v;
      if (word === 'typedef') {
        isTypedef = true;
        this.next();
        continue;
      }
      if (['const', 'volatile', 'static', 'extern', 'inline', 'register', 'auto', 'restrict'].includes(word)) {
        this.next();
        continue;
      }
      if (word === 'unsigned') {
        unsigned = true;
        this.next();
        continue;
      }
      if (word === 'signed') {
        signed = true;
        this.next();
        continue;
      }
      if (word === 'long') {
        longs += 1;
        this.next();
        continue;
      }
      if (word === 'short') {
        shorts += 1;
        this.next();
        continue;
      }
      if (word === 'struct' || word === 'union') {
        this.next();
        resolved = this.parseStructSpecifier();
        continue;
      }
      if (word === 'enum') {
        this.next();
        resolved = this.parseEnumSpecifier();
        continue;
      }
      if (word === '_Bool' || word === 'bool') {
        base = 'bool';
        this.next();
        continue;
      }
      if (word === 'void' || word === 'char' || word === 'int' || word === 'float' || word === 'double') {
        base = word;
        this.next();
        continue;
      }
      if (this.ctx.typedefs.has(word)) {
        resolved = this.ctx.typedefs.get(word)!;
        this.next();
        continue;
      }
      if (this.ctx.enums.has(word)) {
        resolved = INT;
        this.next();
        continue;
      }
      break;
    }

    if (resolved) return { type: resolved, isTypedef };
    void signed;
    if (longs > 0 && (!base || base === 'int')) base = 'long';
    else if (shorts > 0 && (!base || base === 'int')) base = 'short';
    if (!base) base = 'int';
    if (base === 'void' && unsigned) throw new CError('void cannot be unsigned', this.file, this.peek().line);
    return { type: scalarType(base, unsigned), isTypedef };
  }

  private parseStructSpecifier(): CType {
    let tag = '';
    if (this.peek().k === 'id') tag = this.next().v;
    if (this.check('{')) {
      this.next();
      const fields: Array<{ name: string; type: CType }> = [];
      while (!this.check('}') && this.peek().k !== 'eof') {
        const specs = this.parseDeclSpecs();
        if (this.accept(';')) continue;
        do {
          const declarator = this.parseDeclarator(specs.type);
          fields.push({ name: declarator.name, type: declarator.type });
        } while (this.accept(','));
        this.expect(';');
      }
      this.expect('}');
      if (!tag) tag = `__anon_${this.ctx.structs.size}_${this.file.replace(/\W/g, '_')}`;
      const def: StructDef = { name: tag, fields };
      this.ctx.structs.set(tag, def);
      this.program.structs.push(def);
      return structType(tag);
    }
    if (!tag) throw new CError('Anonymous struct requires a body', this.file, this.peek().line);
    if (!this.ctx.structs.has(tag)) {
      // Forward declaration: register a placeholder that later definitions replace.
      this.ctx.structs.set(tag, { name: tag, fields: [] });
    }
    return structType(tag);
  }

  private parseEnumSpecifier(): CType {
    if (this.peek().k === 'id') this.next();
    if (this.check('{')) {
      this.next();
      let nextValue = 0;
      while (!this.check('}') && this.peek().k !== 'eof') {
        const name = this.expectIdent('in enum');
        if (this.accept('=')) {
          const expr = this.parseAssignment();
          if (expr.k === 'num') nextValue = expr.value;
        }
        this.ctx.enums.set(name, nextValue);
        nextValue += 1;
        if (!this.accept(',')) break;
      }
      this.expect('}');
    }
    return INT;
  }

  private parseDeclarator(baseType: CType): CDeclarator & { isFunction: boolean; params: CParam[]; vararg: boolean } {
    let type = baseType;
    while (this.accept('*')) {
      type = pointerTo(type);
      while (['const', 'volatile', 'restrict'].includes(this.peek().v)) this.next();
    }
    while (this.accept('&')) {
      // C++ reference: treated as a value parameter in this subset.
      while (['const', 'volatile'].includes(this.peek().v)) this.next();
    }
    let name = '';
    if (this.check('(')) {
      throw new CError('Function pointers are outside the supported native subset', this.file, this.peek().line);
    }
    name = this.expectIdent('in declaration');
    let isFunction = false;
    let params: CParam[] = [];
    let vararg = false;

    while (this.check('[')) {
      this.next();
      let length: number | null = null;
      if (!this.check(']')) {
        const constant = this.parseAssignment();
        if (constant.k === 'num') length = Math.max(1, Math.trunc(constant.value));
        else if (constant.k === 'id' && this.macros.get(constant.name)?.num !== undefined) {
          length = Math.trunc(this.macros.get(constant.name)!.num!);
        }
      }
      this.expect(']');
      type = arrayOf(type, length);
    }

    if (this.check('(')) {
      this.next();
      isFunction = true;
      if (this.check('void') && this.peek(1).v === ')') {
        this.next();
      } else if (!this.check(')')) {
        do {
          if (this.check('...')) {
            this.next();
            vararg = true;
            break;
          }
          const specs = this.parseDeclSpecs();
          let paramType = specs.type;
          while (this.accept('*')) paramType = pointerTo(paramType);
          while (this.accept('&')) {
            /* reference as value */
          }
          let paramName = `arg${params.length}`;
          if (this.peek().k === 'id') paramName = this.next().v;
          while (this.check('[')) {
            this.next();
            if (!this.check(']')) this.next();
            this.expect(']');
            paramType = pointerTo(paramType);
          }
          params.push({ name: paramName, type: paramType });
        } while (this.accept(','));
      }
      this.expect(')');
    }

    let init: CExpr | null = null;
    if (this.accept('=')) init = this.parseInitializer();
    return { name, type, init, isFunction, params, vararg };
  }

  private parseInitializer(): CExpr {
    if (this.check('{')) {
      const token = this.next();
      const items: CExpr[] = [];
      while (!this.check('}') && this.peek().k !== 'eof') {
        items.push(this.parseAssignment());
        if (!this.accept(',')) break;
      }
      this.expect('}');
      return { k: 'init', items, line: token.line };
    }
    return this.parseAssignment();
  }

  /* ── statements ───────────────────────────────────────────────────────── */

  private parseBlock(): CStat {
    const token = this.expect2('{');
    const body: CStat[] = [];
    while (!this.check('}') && this.peek().k !== 'eof') {
      body.push(this.parseStatement());
    }
    this.expect('}');
    return { k: 'block', body, line: token.line };
  }

  private expect2(value: string): Token {
    const token = this.peek();
    this.expect(value);
    return token;
  }

  private looksLikeDeclaration(): boolean {
    const token = this.peek();
    if (token.k !== 'id') return false;
    if (TYPE_KEYWORDS.has(token.v)) return true;
    return this.ctx.typedefs.has(token.v);
  }

  private parseStatement(): CStat {
    const token = this.peek();
    if (this.check('{')) return this.parseBlock();
    if (this.accept(';')) return { k: 'empty', line: token.line };
    if (this.check('if')) {
      this.next();
      this.expect('(');
      const cond = this.parseExpression();
      this.expect(')');
      const then = this.parseStatement();
      const otherwise = this.accept('else') ? this.parseStatement() : null;
      return { k: 'if', cond, then, otherwise, line: token.line };
    }
    if (this.check('while')) {
      this.next();
      this.expect('(');
      const cond = this.parseExpression();
      this.expect(')');
      const body = this.parseStatement();
      return { k: 'while', cond, body, line: token.line };
    }
    if (this.check('do')) {
      this.next();
      const body = this.parseStatement();
      this.expect('while');
      this.expect('(');
      const cond = this.parseExpression();
      this.expect(')');
      this.expect(';');
      return { k: 'do', body, cond, line: token.line };
    }
    if (this.check('for')) {
      this.next();
      this.expect('(');
      let init: CStat | CExpr | null = null;
      if (!this.check(';')) {
        if (this.looksLikeDeclaration()) {
          const specs = this.parseDeclSpecs();
          const decls: CDeclarator[] = [];
          do {
            decls.push(this.parseDeclarator(specs.type));
          } while (this.accept(','));
          init = { k: 'decl', decls, line: token.line };
        } else {
          init = this.parseExpression();
        }
      }
      this.expect(';');
      const cond = this.check(';') ? null : this.parseExpression();
      this.expect(';');
      const step = this.check(')') ? null : this.parseExpression();
      this.expect(')');
      const body = this.parseStatement();
      return { k: 'for', init, cond, step, body, line: token.line };
    }
    if (this.check('switch')) {
      this.next();
      this.expect('(');
      const value = this.parseExpression();
      this.expect(')');
      this.expect('{');
      const clauses: Array<{ value: CExpr | null; body: CStat[] }> = [];
      let current: { value: CExpr | null; body: CStat[] } | null = null;
      while (!this.check('}') && this.peek().k !== 'eof') {
        if (this.check('case')) {
          this.next();
          const caseValue = this.parseAssignment();
          this.expect(':');
          current = { value: caseValue, body: [] };
          clauses.push(current);
          continue;
        }
        if (this.check('default')) {
          this.next();
          this.expect(':');
          current = { value: null, body: [] };
          clauses.push(current);
          continue;
        }
        const statement = this.parseStatement();
        if (!current) {
          current = { value: null, body: [] };
          clauses.push(current);
        }
        current.body.push(statement);
      }
      this.expect('}');
      return { k: 'switch', value, clauses, line: token.line };
    }
    if (this.check('return')) {
      this.next();
      const value = this.check(';') ? null : this.parseExpression();
      this.expect(';');
      return { k: 'return', value, line: token.line };
    }
    if (this.check('break')) {
      this.next();
      this.expect(';');
      return { k: 'break', line: token.line };
    }
    if (this.check('continue')) {
      this.next();
      this.expect(';');
      return { k: 'continue', line: token.line };
    }
    if (this.check('std') && this.peek(1).v === '::') {
      return this.parseStream();
    }
    if (this.check('cout') || this.check('cerr')) {
      return this.parseStream();
    }
    if (this.looksLikeDeclaration()) {
      const specs = this.parseDeclSpecs();
      const decls: CDeclarator[] = [];
      do {
        decls.push(this.parseDeclarator(specs.type));
      } while (this.accept(','));
      this.expect(';');
      return { k: 'decl', decls, line: token.line };
    }
    const expr = this.parseExpression();
    this.expect(';');
    return { k: 'expr', expr, line: token.line };
  }

  /** C++ `std::cout << a << "\n";` support, mapped onto console output. */
  private parseStream(): CStat {
    const line = this.peek().line;
    if (this.check('std')) {
      this.next();
      this.expect('::');
    }
    const target = this.next().v;
    const args: CExpr[] = [];
    while (this.accept('<<')) {
      if (this.check('std') && this.peek(1).v === '::') {
        this.next();
        this.expect('::');
        const name = this.next().v;
        args.push(name === 'endl' ? { k: 'str', value: '\n', line } : { k: 'id', name, line });
        continue;
      }
      if (this.check('endl')) {
        this.next();
        args.push({ k: 'str', value: '\n', line });
        continue;
      }
      args.push(this.parseAssignment());
    }
    this.expect(';');
    void target;
    return { k: 'expr', expr: { k: 'call', callee: '__cout', args, line }, line };
  }

  /* ── expressions ──────────────────────────────────────────────────────── */

  private parseExpression(): CExpr {
    let left = this.parseAssignment();
    while (this.check(',')) {
      const token = this.next();
      const right = this.parseAssignment();
      left = { k: 'comma', left, right, line: token.line };
    }
    return left;
  }

  private parseAssignment(): CExpr {
    const left = this.parseConditional();
    if (ASSIGNMENT_OPS.has(this.peek().v) && this.peek().k === 'punc') {
      const operator = this.next();
      const value = this.parseAssignment();
      return { k: 'assign', op: operator.v, target: left, value, line: operator.line };
    }
    return left;
  }

  private parseConditional(): CExpr {
    const cond = this.parseBinary(0);
    if (this.check('?')) {
      const token = this.next();
      const then = this.parseExpression();
      this.expect(':');
      const otherwise = this.parseConditional();
      return { k: 'ternary', cond, then, otherwise, line: token.line };
    }
    return cond;
  }

  private parseBinary(minPrecedence: number): CExpr {
    let left = this.parseUnary();
    while (true) {
      const token = this.peek();
      if (token.k !== 'punc') break;
      const precedence = BINARY_PRECEDENCE[token.v];
      if (precedence === undefined || precedence <= minPrecedence) break;
      this.next();
      const right = this.parseBinary(precedence);
      left = { k: 'bin', op: token.v, left, right, line: token.line };
    }
    return left;
  }

  private looksLikeTypeName(): boolean {
    const token = this.peek();
    if (token.k !== 'id') return false;
    return TYPE_KEYWORDS.has(token.v) || this.ctx.typedefs.has(token.v);
  }

  private parseTypeName(): CType {
    const specs = this.parseDeclSpecs();
    let type = specs.type;
    while (this.accept('*')) type = pointerTo(type);
    return type;
  }

  private parseUnary(): CExpr {
    const token = this.peek();
    if (token.k === 'punc' && ['!', '~', '-', '+', '*', '&'].includes(token.v)) {
      this.next();
      const operand = this.parseUnary();
      return { k: 'un', op: token.v, operand, line: token.line };
    }
    if (token.k === 'punc' && (token.v === '++' || token.v === '--')) {
      this.next();
      const target = this.parseUnary();
      return { k: 'incdec', op: token.v as '++' | '--', prefix: true, target, line: token.line };
    }
    if (token.k === 'id' && token.v === 'sizeof') {
      this.next();
      if (this.check('(') && this.looksLikeTypeNameAt(1)) {
        this.next();
        const type = this.parseTypeName();
        this.expect(')');
        return { k: 'sizeofType', type, line: token.line };
      }
      return { k: 'sizeofExpr', expr: this.parseUnary(), line: token.line };
    }
    if (token.k === 'punc' && token.v === '(' && this.looksLikeTypeNameAt(1)) {
      const saved = this.pos;
      this.next();
      try {
        const type = this.parseTypeName();
        this.expect(')');
        if (this.startsExpression()) {
          const expr = this.parseUnary();
          return { k: 'cast', type, expr, line: token.line };
        }
      } catch {
        /* fall through to parenthesised expression */
      }
      this.pos = saved;
    }
    return this.parsePostfix();
  }

  private looksLikeTypeNameAt(offset: number): boolean {
    const token = this.peek(offset);
    if (token.k !== 'id') return false;
    return TYPE_KEYWORDS.has(token.v) || this.ctx.typedefs.has(token.v);
  }

  private startsExpression(): boolean {
    const token = this.peek();
    if (token.k === 'num' || token.k === 'str' || token.k === 'char' || token.k === 'id') return true;
    return token.k === 'punc' && ['(', '-', '!', '~', '+', '*', '&'].includes(token.v);
  }

  private parsePostfix(): CExpr {
    let expression = this.parsePrimary();
    while (true) {
      const token = this.peek();
      if (token.k !== 'punc') break;
      if (token.v === '(') {
        this.next();
        const args: CExpr[] = [];
        if (!this.check(')')) {
          do {
            args.push(this.parseAssignment());
          } while (this.accept(','));
        }
        this.expect(')');
        if (expression.k !== 'id') {
          throw new CError('Only direct function calls are supported by the native bridge', this.file, token.line);
        }
        expression = { k: 'call', callee: expression.name, args, line: token.line };
        continue;
      }
      if (token.v === '[') {
        this.next();
        const index = this.parseExpression();
        this.expect(']');
        expression = { k: 'index', base: expression, index, line: token.line };
        continue;
      }
      if (token.v === '.' || token.v === '->') {
        this.next();
        const name = this.expectIdent('after member access');
        expression = { k: 'member', base: expression, name, arrow: token.v === '->', line: token.line };
        continue;
      }
      if (token.v === '++' || token.v === '--') {
        this.next();
        expression = { k: 'incdec', op: token.v as '++' | '--', prefix: false, target: expression, line: token.line };
        continue;
      }
      break;
    }
    return expression;
  }

  private parsePrimary(): CExpr {
    const token = this.peek();
    if (token.k === 'num') {
      this.next();
      return { k: 'num', value: token.num ?? 0, line: token.line };
    }
    if (token.k === 'char') {
      this.next();
      return { k: 'num', value: token.num ?? 0, line: token.line };
    }
    if (token.k === 'str') {
      let value = '';
      while (this.peek().k === 'str') value += this.next().v;
      return { k: 'str', value, line: token.line };
    }
    if (this.check('(')) {
      this.next();
      const expr = this.parseExpression();
      this.expect(')');
      return expr;
    }
    if (token.k === 'id') {
      this.next();
      if (token.v === 'true' || token.v === 'false') return { k: 'num', value: token.v === 'true' ? 1 : 0, line: token.line };
      if (token.v === 'nullptr' || token.v === 'NULL') return { k: 'num', value: 0, line: token.line };
      const macro = this.macros.get(token.v);
      if (macro?.num !== undefined) return { k: 'num', value: macro.num, line: token.line };
      if (macro?.str !== undefined) return { k: 'str', value: macro.str, line: token.line };
      if (this.ctx.enums.has(token.v)) return { k: 'num', value: this.ctx.enums.get(token.v)!, line: token.line };
      return { k: 'id', name: token.v, line: token.line };
    }
    throw new CError(`Unexpected token "${token.v || 'end of file'}" in expression`, this.file, token.line);
  }
}

export function parseCProgram(file: string, source: string, ctx: CContext): CProgram {
  return new CParser(file, source, ctx).parseProgram();
}

export { VOID, CHAR, DOUBLE, INT };
