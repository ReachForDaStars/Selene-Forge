import { LuaFactory, LuaMultiReturn } from 'wasmoon';
import glueWasmUrl from 'wasmoon/dist/glue.wasm?url';
import { CError } from '../cbridge/types';
import type { CBridgeBuild } from '../cbridge/bridge';
import type { ProjectFile } from '../core/types';

export type OutputLane = 'lua' | 'c' | 'sys';

export interface RunInput {
  files: ProjectFile[];
  mainPath: string;
  bridge: CBridgeBuild;
  out: (lane: OutputLane, text: string) => void;
  timeoutMs?: number;
}

export interface RunOutcome {
  ok: boolean;
  error: { message: string; trace?: string } | null;
  returnValue: string | null;
  luaMs: number;
  moduleCount: number;
  nativeFunctions: number;
}

type MultiReturnConstructor = new (...values: unknown[]) => LuaMultiReturn;

/** wasmoon models multiple returns as an array subclass; the constructor is variadic. */
function multi(...values: unknown[]): LuaMultiReturn {
  return new (LuaMultiReturn as unknown as MultiReturnConstructor)(...values);
}

let factory: LuaFactory | null = null;

function getFactory(): LuaFactory {
  if (!factory) factory = new LuaFactory(glueWasmUrl);
  return factory;
}

/** Preload and compile the Lua wasm module in the background. */
export async function warmupLua(): Promise<void> {
  try {
    await getFactory().getLuaModule();
  } catch (error) {
    console.warn('[selene] Lua wasm warmup failed', error);
  }
}

function luaQuote(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n').replace(/\r/g, '\\r')}"`;
}

function resolveModule(files: ProjectFile[], rawName: string): { path: string; content: string } | null {
  const byPath = new Map(files.filter((file) => file.kind === 'lua').map((file) => [file.path, file.content]));
  const trimmed = rawName.trim().replace(/\\/g, '/').replace(/^\.\//, '');
  const withoutExt = trimmed.replace(/\.lua$/i, '');
  const direct = trimmed.endsWith('.lua') ? trimmed : `${trimmed}.lua`;
  const slashed = withoutExt.replace(/\./g, '/');
  const candidates = [
    direct,
    `${withoutExt}.lua`,
    `${slashed}.lua`,
    `packages/${slashed}.lua`,
    `packages/${withoutExt}.lua`,
    `${slashed}/init.lua`,
    `packages/${slashed}/init.lua`,
  ];
  for (const candidate of candidates) {
    const content = byPath.get(candidate);
    if (content !== undefined) return { path: candidate, content };
  }
  return null;
}

function bootstrapLua(timeoutMs: number): string {
  return `
local __emit = __selene_print
local __read = __selene_read
local __resolve = __selene_resolve
local __now = __selene_now

local __module_cache = {}
local __module_loading = {}

local function __load_module(name)
  local key = tostring(name)
  local cached = __module_cache[key]
  if cached ~= nil then return cached end
  if __module_loading[key] then
    error("loop or previous error loading module '" .. key .. "'", 0)
  end
  local path = __resolve(key)
  if not path then
    error("module '" .. key .. "' was not found in this project (looked for .lua files and packages/)", 0)
  end
  __module_loading[key] = true
  local source = __read(path)
  if not source then
    __module_loading[key] = nil
    error("cannot read module file '" .. path .. "'", 0)
  end
  local chunk, compile_error = load(source, "@" .. path)
  if not chunk then
    __module_loading[key] = nil
    error(compile_error, 0)
  end
  local value = chunk(key, path)
  __module_loading[key] = nil
  if value == nil then value = true end
  __module_cache[key] = value
  return value
end

function require(name)
  local key = tostring(name)
  local loaded = package.loaded[key]
  if loaded ~= nil then return loaded end
  local preload = package.preload and package.preload[key]
  if preload then
    local value = preload(key)
    if value == nil then value = true end
    package.loaded[key] = value
    return value
  end
  return __load_module(key)
end

function print(...)
  local count = select('#', ...)
  local parts = {}
  for index = 1, count do
    parts[index] = tostring((select(index, ...)))
  end
  __emit(table.concat(parts, '\\t'))
end

if io then
  io.write = function(...)
    local count = select('#', ...)
    for index = 1, count do
      __emit(tostring((select(index, ...))))
    end
    return true
  end
  io.flush = function() return true end
  io.read = function() return nil end
end

_C = {
  call = function(name, ...)
    local value, table_flag, runtime_error = __selene_c_call(tostring(name), ...)
    if runtime_error then
      error(runtime_error, 2)
    end
    if table_flag == 1 then
      local loader = load("return " .. tostring(value))
      if not loader then return nil end
      local ok, decoded = pcall(loader)
      if not ok then return nil end
      return decoded
    end
    return value
  end,
  register = function(lua_name, c_name)
    if type(lua_name) ~= 'string' or not lua_name:match('^[%a_][%w_]*$') then
      error('lua_register: "' .. tostring(lua_name) .. '" is not a valid Lua identifier', 2)
    end
    local target = tostring(c_name)
    _G[lua_name] = function(...)
      return _C.call(target, ...)
    end
    return true
  end,
  struct = function(type_name, fields)
    return __selene_c_struct(tostring(type_name), fields or {})
  end,
  tolua = function(value)
    local dumped = __selene_c_dump(value)
    if type(dumped) ~= 'string' or dumped == '' then return value end
    local loader = load("return " .. dumped)
    if not loader then return nil end
    local ok, decoded = pcall(loader)
    if not ok then return nil end
    return decoded
  end,
}

local function __render(value, depth, seen)
  local kind = type(value)
  if kind == 'nil' then return 'nil' end
  if kind == 'string' then
    local quoted = string.format('%q', value)
    if #quoted > 200 then quoted = string.sub(quoted, 1, 197) .. '..."' end
    return quoted
  end
  if kind == 'number' or kind == 'boolean' then return tostring(value) end
  if kind == 'function' then return '<function>' end
  if kind == 'thread' then return '<thread>' end
  if kind ~= 'table' then return '<' .. kind .. '>' end
  if depth >= 4 then return '{ ... }' end
  if seen[value] then return '<cycle>' end
  seen[value] = true
  local parts = {}
  local count = 0
  for key, entry in pairs(value) do
    count = count + 1
    if count > 24 then
      parts[#parts + 1] = '...'
      break
    end
    local key_text
    if type(key) == 'string' and key:match('^[%a_][%w_]*$') then
      key_text = key
    elseif type(key) == 'string' then
      key_text = '[' .. string.format('%q', key) .. ']'
    else
      key_text = '[' .. tostring(key) .. ']'
    end
    parts[#parts + 1] = key_text .. ' = ' .. __render(entry, depth + 1, seen)
  end
  seen[value] = nil
  if #parts == 0 then return '{}' end
  return '{ ' .. table.concat(parts, ', ') .. ' }'
end

local result = { ok = false, value = nil, error = nil, trace = nil }
local chunk, compile_error = load(__selene_main, '@' .. __selene_main_path)
if not chunk then
  result.error = compile_error
  return result
end

local deadline = __now() + ${timeoutMs}
debug.sethook(function()
  if __now() > deadline then
    error(string.format('execution timed out after %d ms', ${timeoutMs}), 2)
  end
end, '', 20000)

local ok, value = xpcall(chunk, function(reason)
  local message = tostring(reason)
  if type(reason) == 'table' and reason.message then
    message = tostring(reason.message)
  end
  return { message = message, trace = debug.traceback('', 2) }
end)

debug.sethook()

if ok then
  result.ok = true
  result.value = __render(value, 0, {})
else
  result.ok = false
  result.error = value.message
  result.trace = value.trace
end

return result
`;
}

function cleanTrace(trace: string | undefined): string | undefined {
  if (!trace) return undefined;
  const lines = trace
    .split('\n')
    .map((line) => line.trimEnd())
    .filter((line) => line.length > 0 && !line.startsWith('[C]: in function \'error\'') && !line.startsWith('[C]: in ?'));
  return lines.join('\n');
}

/** Execute `mainPath` in a fresh Lua 5.4 VM with project modules and the C bridge. */
export async function executeProject(input: RunInput): Promise<RunOutcome> {
  const startedAt = performance.now();
  const main = input.files.find((file) => file.path === input.mainPath);
  if (!main) {
    return {
      ok: false,
      error: { message: `Entry file "${input.mainPath}" does not exist.` },
      returnValue: null,
      luaMs: 0,
      moduleCount: 0,
      nativeFunctions: input.bridge.info.functions.length,
    };
  }

  const engine = await getFactory().createEngine({
    openStandardLibs: true,
    injectObjects: true,
    enableProxy: true,
    traceAllocations: false,
  });

  const timeoutMs = input.timeoutMs ?? 8000;

  try {
    engine.global.set('__selene_main', main.content);
    engine.global.set('__selene_main_path', main.path);
    engine.global.set('__selene_print', (text: unknown) => {
      input.out('lua', String(text ?? ''));
    });
    engine.global.set('__selene_read', (path: unknown) => {
      const file = input.files.find((entry) => entry.path === String(path));
      return file ? file.content : false;
    });
    engine.global.set('__selene_resolve', (name: unknown) => {
      const resolved = resolveModule(input.files, String(name));
      return resolved ? resolved.path : false;
    });
    engine.global.set('__selene_now', () => performance.now());

    const interpreter = input.bridge.interpreter;

    engine.global.set('__selene_c_call', (name: unknown, ...args: unknown[]) => {
      const functionName = String(name);
      try {
        const value = interpreter.callExternal(functionName, args);
        if (typeof value === 'object' && value !== null) {
          return multi(interpreter.dumpLua(value), 1, false);
        }
        return multi(value ?? 0, 0, false);
      } catch (error) {
        const message = error instanceof CError ? error.format() : error instanceof Error ? error.message : String(error);
        return multi(0, 0, `native bridge: ${message}`);
      }
    });

    engine.global.set('__selene_c_struct', (typeName: unknown, fields: unknown) => {
      try {
        return interpreter.makeStruct(String(typeName), (fields ?? {}) as Record<string, unknown>);
      } catch (error) {
        const message = error instanceof CError ? error.format() : error instanceof Error ? error.message : String(error);
        throw new Error(`native bridge: ${message}`);
      }
    });

    engine.global.set('__selene_c_dump', (value: unknown) => {
      try {
        return interpreter.dumpLua(value);
      } catch {
        return '';
      }
    });

    const luaStart = performance.now();
    const raw = await engine.doString(bootstrapLua(timeoutMs));
    const luaMs = performance.now() - luaStart;
    const result = (raw ?? {}) as { ok?: boolean; value?: string; error?: string; trace?: string };

    void startedAt;
    return {
      ok: Boolean(result.ok),
      error: result.ok ? null : { message: String(result.error ?? 'Unknown Lua error'), trace: cleanTrace(result.trace) },
      returnValue: result.ok && result.value && result.value !== 'nil' ? String(result.value) : null,
      luaMs,
      moduleCount: input.files.filter((file) => file.kind === 'lua').length,
      nativeFunctions: input.bridge.info.functions.length,
    };
  } finally {
    try {
      engine.global.close();
    } catch {
      /* ignore */
    }
  }
}

export { luaQuote };
