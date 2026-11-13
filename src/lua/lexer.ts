import { parseNumberLiteral } from './ast';

export type TokenType = 'name' | 'number' | 'string' | 'keyword' | 'symbol' | 'eof';

export interface Token {
  type: TokenType;
  value: string;
  line: number;
  col: number;
}

export class LuaSyntaxError extends Error {
  line: number;
  col: number;
  constructor(message: string, line: number, col: number) {
    super(`${message} (line ${line}, column ${col})`);
    this.name = 'LuaSyntaxError';
    this.line = line;
    this.col = col;
  }
}

const KEYWORDS = new Set([
  'and',
  'break',
  'do',
  'else',
  'elseif',
  'end',
  'false',
  'for',
  'function',
  'goto',
  'if',
  'in',
  'local',
  'nil',
  'not',
  'or',
  'repeat',
  'return',
  'then',
  'true',
  'until',
  'while',
]);

const MULTI_SYMBOLS = ['...', '..', '==', '~=', '<=', '>=', '//', '::', '<<', '>>'];
const SINGLE_SYMBOLS = '+-*/%^#&~|<>=(){}[];:,.:';

function isDigit(char: string): boolean {
  return char >= '0' && char <= '9';
}

function isHexDigit(char: string): boolean {
  return isDigit(char) || (char >= 'a' && char <= 'f') || (char >= 'A' && char <= 'F');
}

function isNameStart(char: string): boolean {
  return (char >= 'a' && char <= 'z') || (char >= 'A' && char <= 'Z') || char === '_';
}

function isNameChar(char: string): boolean {
  return isNameStart(char) || isDigit(char);
}

/** Detect a long bracket (`[[`, `[=[`, ...) at `index`. Returns the level or null. */
function longBracketLevel(source: string, index: number): number | null {
  if (source[index] !== '[') return null;
  let cursor = index + 1;
  let level = 0;
  while (source[cursor] === '=') {
    level += 1;
    cursor += 1;
  }
  return source[cursor] === '[' ? level : null;
}

export function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let index = 0;
  let line = 1;
  let lineStart = 0;
  const length = source.length;

  const push = (type: TokenType, value: string, tokenLine: number, tokenCol: number) => {
    tokens.push({ type, value, line: tokenLine, col: tokenCol });
  };

  while (index < length) {
    const char = source[index];

    if (char === '\n') {
      index += 1;
      line += 1;
      lineStart = index;
      continue;
    }
    if (char === '\r' || char === ' ' || char === '\t' || char === '\f' || char === '\v') {
      index += 1;
      continue;
    }

    // Comments.
    if (char === '-' && source[index + 1] === '-') {
      const level = longBracketLevel(source, index + 2);
      if (level !== null) {
        const open = index + 2;
        const closePattern = `]${'='.repeat(level)}]`;
        const end = source.indexOf(closePattern, open + level + 2);
        const stop = end === -1 ? length : end + closePattern.length;
        for (let cursor = index; cursor < stop; cursor += 1) {
          if (source[cursor] === '\n') {
            line += 1;
            lineStart = cursor + 1;
          }
        }
        if (end === -1) throw new LuaSyntaxError('Unterminated block comment', line, index - lineStart + 1);
        index = stop;
        continue;
      }
      while (index < length && source[index] !== '\n') index += 1;
      continue;
    }

    const col = index - lineStart + 1;

    // Long strings.
    const level = longBracketLevel(source, index);
    if (level !== null) {
      const closePattern = `]${'='.repeat(level)}]`;
      const bodyStart = index + level + 2;
      const end = source.indexOf(closePattern, bodyStart);
      if (end === -1) throw new LuaSyntaxError('Unterminated long string', line, col);
      let body = source.slice(bodyStart, end);
      if (body.startsWith('\r\n')) body = body.slice(2);
      else if (body.startsWith('\n')) body = body.slice(1);
      for (const character of body) {
        if (character === '\n') line += 1;
      }
      const lastNewline = body.lastIndexOf('\n');
      if (lastNewline !== -1) lineStart = end - (body.length - lastNewline - 1);
      push('string', body, line, col);
      index = end + closePattern.length;
      continue;
    }

    // Short strings.
    if (char === '"' || char === "'") {
      const quote = char;
      let cursor = index + 1;
      let value = '';
      let terminated = false;
      while (cursor < length) {
        const current = source[cursor];
        if (current === quote) {
          cursor += 1;
          terminated = true;
          break;
        }
        if (current === '\n') break;
        if (current === '\\') {
          const next = source[cursor + 1];
          cursor += 2;
          switch (next) {
            case 'n':
              value += '\n';
              break;
            case 't':
              value += '\t';
              break;
            case 'r':
              value += '\r';
              break;
            case 'a':
              value += '\x07';
              break;
            case 'b':
              value += '\b';
              break;
            case 'f':
              value += '\f';
              break;
            case 'v':
              value += '\v';
              break;
            case '\\':
              value += '\\';
              break;
            case '"':
              value += '"';
              break;
            case "'":
              value += "'";
              break;
            case '\n':
              value += '\n';
              line += 1;
              lineStart = cursor;
              break;
            case 'z':
              while (cursor < length && /\s/.test(source[cursor])) {
                if (source[cursor] === '\n') {
                  line += 1;
                  lineStart = cursor + 1;
                }
                cursor += 1;
              }
              break;
            case 'x': {
              const hex = source.slice(cursor, cursor + 2);
              if (!/^[0-9a-fA-F]{2}$/.test(hex)) throw new LuaSyntaxError('Invalid hex escape', line, col);
              value += String.fromCharCode(parseInt(hex, 16));
              cursor += 2;
              break;
            }
            case 'u': {
              const match = /^\{([0-9a-fA-F]+)\}/.exec(source.slice(cursor));
              if (!match) throw new LuaSyntaxError('Invalid unicode escape', line, col);
              value += String.fromCodePoint(parseInt(match[1], 16));
              cursor += match[0].length;
              break;
            }
            default:
              if (next >= '0' && next <= '9') {
                let digits = next;
                while (digits.length < 3 && source[cursor] >= '0' && source[cursor] <= '9') {
                  digits += source[cursor];
                  cursor += 1;
                }
                value += String.fromCharCode(parseInt(digits, 10));
              } else {
                value += next ?? '';
              }
          }
          continue;
        }
        value += current;
        cursor += 1;
      }
      if (!terminated) throw new LuaSyntaxError('Unterminated string', line, col);
      push('string', value, line, col);
      index = cursor;
      continue;
    }

    // Numbers.
    if (isDigit(char) || (char === '.' && isDigit(source[index + 1]))) {
      let cursor = index;
      if (char === '0' && (source[cursor + 1] === 'x' || source[cursor + 1] === 'X')) {
        cursor += 2;
        while (cursor < length && (isHexDigit(source[cursor]) || source[cursor] === '.')) cursor += 1;
        if (source[cursor] === 'p' || source[cursor] === 'P') {
          cursor += 1;
          if (source[cursor] === '+' || source[cursor] === '-') cursor += 1;
          while (cursor < length && isDigit(source[cursor])) cursor += 1;
        }
      } else {
        while (cursor < length && isDigit(source[cursor])) cursor += 1;
        if (source[cursor] === '.') {
          cursor += 1;
          while (cursor < length && isDigit(source[cursor])) cursor += 1;
        }
        if (source[cursor] === 'e' || source[cursor] === 'E') {
          cursor += 1;
          if (source[cursor] === '+' || source[cursor] === '-') cursor += 1;
          while (cursor < length && isDigit(source[cursor])) cursor += 1;
        }
      }
      const raw = source.slice(index, cursor);
      push('number', raw, line, col);
      index = cursor;
      continue;
    }

    // Names & keywords.
    if (isNameStart(char)) {
      let cursor = index + 1;
      while (cursor < length && isNameChar(source[cursor])) cursor += 1;
      const value = source.slice(index, cursor);
      push(KEYWORDS.has(value) ? 'keyword' : 'name', value, line, col);
      index = cursor;
      continue;
    }

    // Symbols.
    let matched = false;
    for (const symbol of MULTI_SYMBOLS) {
      if (source.startsWith(symbol, index)) {
        push('symbol', symbol, line, col);
        index += symbol.length;
        matched = true;
        break;
      }
    }
    if (matched) continue;
    if (SINGLE_SYMBOLS.includes(char)) {
      push('symbol', char, line, col);
      index += 1;
      continue;
    }

    throw new LuaSyntaxError(`Unexpected character "${char}"`, line, col);
  }

  tokens.push({ type: 'eof', value: '', line, col: index - lineStart + 1 });
  return tokens;
}

export { parseNumberLiteral };
