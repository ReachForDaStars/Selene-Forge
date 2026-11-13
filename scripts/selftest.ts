/**
 * Headless verification of the logic that does not need a DOM:
 * Lua parsing/analysis, block-graph conversion, the C bridge, and every
 * bundled Lua package executed on the real Lua 5.4 wasm VM.
 *
 * Run with: npm run selftest
 */
import { LuaFactory } from 'wasmoon';
import path from 'node:path';
import { analyzeLuaFile } from '../src/lua/analyze';
import { tryParseLua } from '../src/lua/parser';
import { blocksFromLua } from '../src/blocks/fromAst';
import { buildCBridge } from '../src/cbridge/bridge';
import { PACKAGE_CATALOG } from '../src/packages/catalog';
import { createDefaultSnapshot } from '../src/samples/defaultProject';

let failures = 0;
const checks: string[] = [];

function check(name: string, condition: unknown, detail?: unknown): void {
  if (condition) {
    checks.push(`  ✓ ${name}`);
  } else {
    failures += 1;
    checks.push(`  ✗ ${name}${detail === undefined ? '' : ` → ${JSON.stringify(detail)}`}`);
  }
}

function section(name: string): void {
  checks.push(`\n${name}`);
}

async function main(): Promise<void> {
  const wasm = path.resolve(process.cwd(), 'node_modules/wasmoon/dist/glue.wasm');

  /* ── Lua front-end ───────────────────────────────────────────────────── */
  section('Lua lexer / parser');
  const parsed = tryParseLua(`local M = {}\nfunction M.add(a, b)\n  return a + b\nend\nreturn M\n`);
  check('parses a module', parsed.ast !== null, parsed.error);
  check('records three statements', parsed.ast?.body.length === 3, parsed.ast?.body.length);
  const failed = tryParseLua('local x = = 1');
  check('reports syntax errors', failed.ast === null && failed.error !== null);
  const tricky = tryParseLua(`
    -- comment
    local s = [==[long "string"]==]
    local t = { 1, 2; x = 3, [4] = "four" }
    for i = 10, 1, -2 do s = s .. i end
    repeat local z = 1 until z == 1
    if s ~= "" and #t > 0 then print(s) elseif false then print("x") else print("y") end
    local function f(...) return select('#', ...) end
  `);
  check('handles long strings, tables, numerics, repeat, elseif, varargs', tricky.ast !== null, tricky.error);

  /* ── analyzer ────────────────────────────────────────────────────────── */
  section('Module analyser');
  const snapshot = createDefaultSnapshot();
  const inventory = snapshot.files.find((file) => file.path === 'lib/inventory.lua')!;
  const analysis = analyzeLuaFile(inventory.path, inventory.content);
  const names = analysis.module.exports.map((entry) => entry.name).sort();
  check('finds module exports', names.join(',') === 'cheapest,restock,total', names);
  check('finds the restock signature', analysis.module.exports.find((entry) => entry.name === 'restock')?.params.join(',') === 'items,amount');
  check('module names are dotted paths', analysis.module.moduleName === 'lib.inventory', analysis.module.moduleName);
  const mainFile = snapshot.files.find((file) => file.path === 'main.lua')!;
  const mainAnalysis = analyzeLuaFile(mainFile.path, mainFile.content);
  check('finds requires', mainAnalysis.module.requires.includes('lib.inventory'), mainAnalysis.module.requires);

  /* ── Lua → blocks ────────────────────────────────────────────────────── */
  section('Lua → block graph converter');
  const converted = blocksFromLua(mainFile.content);
  const top = (converted.graph as { blocks?: { blocks?: Array<{ type: string }> } }).blocks?.blocks ?? [];
  check('converts main.lua without errors', top.length === 1, top.length);
  check('produces a statement chain', top[0]?.type === 'lua_local', top[0]?.type);
  const returnOnly = blocksFromLua('print("a")\nreturn 1\n');
  const types: string[] = [];
  const walk = (block: { type?: string; next?: { block?: unknown } } | undefined) => {
    let current: { type?: string; next?: { block?: unknown } } | undefined = block;
    while (current) {
      types.push(String(current.type));
      current = current.next?.block as typeof current;
    }
  };
  walk((returnOnly.graph as { blocks?: { blocks?: Array<{ type?: string }> } }).blocks?.blocks?.[0]);
  check('chains call + return blocks', types.join('>') === 'lua_print>lua_return', types);

  /* ── C bridge ────────────────────────────────────────────────────────── */
  section('C bridge (in-browser interpreter)');
  const bridgeSource = snapshot.files.find((file) => file.path === 'native/bridge.c')!;
  let nativeOutput = '';
  const bridge = buildCBridge([{ path: bridgeSource.path, source: bridgeSource.content, origin: 'file' }], (text) => {
    nativeOutput += text;
  });
  check('C compiles without errors', bridge.info.errors.length === 0, bridge.info.errors);
  check('discovers native functions', bridge.info.functions.length === 4, bridge.info.functions.map((fn) => fn.name));
  check('discovers the struct', bridge.info.structs.some((entry) => entry.name === 'Vec2'));
  check('c_sum works', bridge.interpreter.callExternal('c_sum', [20, 22]) === 42);
  check('c_fib loops correctly', bridge.interpreter.callExternal('c_fib', [20]) === 6765);
  const damage = bridge.interpreter.callExternal('c_damage', [12.5, 1.6]) as number;
  check('c_damage computes', Math.abs(damage - 20) < 1e-9, damage);
  check('printf is captured', nativeOutput.includes('native c_damage(12.50, 1.60)'), nativeOutput);
  const scaled = bridge.interpreter.callExternal('c_vec2_scale', [{ x: 3, y: 4 }, 2]) as { x: number; y: number };
  check('struct round-trip works', scaled && scaled.x === 6 && scaled.y === 8, scaled);
  check('lua dump builds a table literal', bridge.interpreter.dumpLua(scaled).includes('x = 6'), bridge.interpreter.dumpLua(scaled));

  const badBridge = buildCBridge([{ path: 'bad.c', source: 'int broken( { return 1; }', origin: 'file' }], () => {});
  check('C syntax errors are reported with file/line', badBridge.info.errors.some((error) => error.startsWith('bad.c:')), badBridge.info.errors);

  /* ── Lua packages on the real VM ─────────────────────────────────────── */
  section('Lua 5.4 runtime + curated packages');
  const factory = new LuaFactory(wasm);
  const lua = await factory.createEngine({ openStandardLibs: true });
  try {
    check('_VERSION is Lua 5.4', (await lua.doString('return _VERSION')) === 'Lua 5.4');
    for (const entry of PACKAGE_CATALOG) {
      const file = entry.files[0];
      lua.global.set('__source', file.content);
      const loaded = await lua.doString(`local chunk, err = load(__source, "@${file.path}"); if not chunk then return err end; return "ok"`);
      check(`${entry.name}: syntax`, loaded === 'ok', loaded);
    }

    lua.global.set('__json', PACKAGE_CATALOG.find((entry) => entry.id === 'json')!.files[0].content);
    const jsonResult = await lua.doString(`
      local json = assert(load(__json, '@packages/json.lua'))()
      local encoded = json.encode({ name = 'selene', list = { 1, 2, 3 }, nested = { ok = true } })
      local decoded = json.decode(encoded)
      local okEncoded = encoded:find('"name":"selene"', 1, true) and encoded:find('"list":%[1,2,3%]')
      return tostring(okEncoded ~= nil) .. '|' .. tostring(decoded.name) .. '|' .. tostring(#decoded.list) .. '|' .. tostring(decoded.nested.ok)
    `);
    check('json encode/decode round-trip', jsonResult === 'true|selene|3|true', jsonResult);

    lua.global.set('__vector', PACKAGE_CATALOG.find((entry) => entry.id === 'vector')!.files[0].content);
    const vectorResult = await lua.doString(`
      local vector = assert(load(__vector, '@packages/vector.lua'))()
      local a = vector.new2(3, 4)
      local b = vector.add(a, vector.new2(1, 1))
      local c = vector.cross(vector.new3(1, 0, 0), vector.new3(0, 1, 0))
      return string.format('%.3f|%.1f|%.1f|%.1f|%.1f|%.3f', vector.length(a), b.x, b.y, c.x, c.y, c.z)
    `);
    check('vector maths', vectorResult === '5.000|4.0|5.0|0.0|0.0|1.000', vectorResult);

    lua.global.set('__fsm', PACKAGE_CATALOG.find((entry) => entry.id === 'statemachine')!.files[0].content);
    const fsmResult = await lua.doString(`
      local machine = assert(load(__fsm, '@packages/statemachine.lua'))()
      local log = {}
      local m = machine.new({ initial = 'idle', states = {
        idle = { update = function(self, dt) log[#log+1] = 'idle' .. dt end },
        run = { enter = function() log[#log+1] = 'enter' end }
      }})
      m:update(1)
      m:change('run')
      m:update(2)
      return table.concat(log, ',') .. '|' .. tostring(m:is('run')) .. '|' .. tostring(m.time)
    `);
    check('state machine transitions', fsmResult === 'idle1,enter|true|3', fsmResult);

    lua.global.set('__tween', PACKAGE_CATALOG.find((entry) => entry.id === 'tween')!.files[0].content);
    const tweenResult = await lua.doString(`
      local tween = assert(load(__tween, '@packages/tween.lua'))()
      local subject = { x = 0, y = 0 }
      local t = tween.new(1, subject, { x = 10, y = 20 }, 'outQuad')
      t:update(0.5)
      local mid = string.format('%.3f,%.3f', subject.x, subject.y)
      t:update(0.5)
      return mid .. '|' .. string.format('%.1f,%.1f', subject.x, subject.y) .. '|' .. tostring(t:isFinished())
    `);
    check('tween eases and finishes', tweenResult === '7.500,15.000|10.0,20.0|true', tweenResult);

    lua.global.set('__class', PACKAGE_CATALOG.find((entry) => entry.id === 'class')!.files[0].content);
    const classResult = await lua.doString(`
      local class = assert(load(__class, '@packages/class.lua'))()
      local Animal = class()
      function Animal:init(name) self.name = name end
      function Animal:speak() return self.name .. ' makes a sound' end
      local Dog = Animal:extend('Dog')
      function Dog:speak() return self.name .. ' barks' end
      local d = Dog('Rex')
      return d:speak() .. '|' .. tostring(d:isInstanceOf(Animal))
    `);
    check('class inheritance', classResult === 'Rex barks|true', classResult);

    /* Full project execution through the module loader, mirroring the browser runtime. */
    lua.global.set('__native_call', (name: unknown, ...args: unknown[]) => {
      const result = bridge.interpreter.callExternal(String(name), args);
      return JSON.stringify(result ?? 0);
    });
    await lua.doString(`
      local jsonModule = assert(load(__json, '@packages/json.lua'))()
      _C = {
        call = function(name, ...) return jsonModule.decode(__native_call(name, ...)) end,
        register = function() end,
        struct = function(_, value) return value end,
        tolua = function(value) return value end,
      }
    `);
    const files = snapshot.files.filter((file) => file.kind === 'lua');
    for (const file of files) lua.global.set(`__file_${file.path.replace(/\W/g, '_')}`, file.content);
    const projectRun = await lua.doString(`
      local sources = {}
      ${files
        .map((file) => `sources["${file.path}"] = __file_${file.path.replace(/\W/g, '_')}`)
        .join('\n')}
      local cache = {}
      function require(name)
        local key = tostring(name)
        if cache[key] then return cache[key] end
        local candidates = { key, key:gsub('%.', '/') }
        local resolved
        for _, candidate in ipairs(candidates) do
          if sources[candidate .. '.lua'] then resolved = candidate .. '.lua' end
          if sources['packages/' .. candidate .. '.lua'] then resolved = 'packages/' .. candidate .. '.lua' end
        end
        if not resolved then error('missing module ' .. key) end
        local chunk = assert(load(sources[resolved], '@' .. resolved))
        local value = chunk(key, resolved)
        if value == nil then value = true end
        cache[key] = value
        return value
      end
      local lines = {}
      local real_print = print
      print = function(...) local parts = {} for i = 1, select('#', ...) do parts[i] = tostring((select(i, ...))) end lines[#lines+1] = table.concat(parts, '\\t') end
      local chunk = assert(load(sources['main.lua'], '@main.lua'))
      local ok, err = pcall(chunk)
      print = real_print
      return table.concat(lines, '\\n') .. '||' .. tostring(ok) .. '||' .. tostring(err)
    `);
    const output = String(projectRun);
    check('starter main.lua runs end-to-end', output.includes('total:') && output.includes('||true||'), output.slice(-200));
    check(
      'starter prints restock + native results',
      output.includes('restock count:') && output.includes('native fib:') && output.includes('6765') && output.includes('scaled:'),
      output,
    );
  } finally {
    lua.global.close();
  }

  console.log(checks.join('\n'));
  if (failures > 0) {
    console.error(`\n${failures} check(s) failed`);
    process.exit(1);
  }
  console.log('\nAll checks passed.');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
