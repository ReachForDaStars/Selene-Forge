import { findPackage } from '../packages/catalog';
import type { ProjectFile, ProjectSnapshot } from '../core/types';

const MAIN_LUA = `local json = require("packages.json")
local vector = require("packages.vector")
local inventory = require("lib.inventory")

local function describe(item)
  if item.qty > 1 then
    return item.name .. " x" .. item.qty
  end
  return item.name
end

local items = {
  { name = "moonstone", qty = 3, price = 12.5 },
  { name = "silver key", qty = 1, price = 4 }
}

local total = 0
for index, item in ipairs(items) do
  total = total + item.qty * item.price
  print(describe(item))
end

local position = vector.new2(0, 0)
local moved = vector.add(position, vector.new2(3, 4))
local scaled = _C.call("c_vec2_scale", { x = moved.x, y = moved.y }, 2.0)

print("total:", total)
print("vector:", vector.tostring(moved))
print("restock count:", inventory.restock(items))
print("cheapest:", inventory.cheapest(items).name)
print("native sum:", _C.call("c_sum", 20, 22))
print("native fib:", _C.call("c_fib", 20))
print("native damage:", _C.call("c_damage", 12.5, 1.6))
print("scaled:", scaled.x, scaled.y)
print("json:", json.encode({ total = total, scaled = scaled }))

return { total = total, position = moved }
`;

const INVENTORY_LUA = `-- lib/inventory.lua — a small module required by main.lua
local inventory = {}

function inventory.restock(items, amount)
  amount = amount or 10
  for _, item in ipairs(items) do
    item.qty = item.qty + amount
  end
  return #items
end

function inventory.total(items)
  local sum = 0
  for _, item in ipairs(items) do
    sum = sum + item.qty * item.price
  end
  return sum
end

function inventory.cheapest(items)
  local best = nil
  for _, item in ipairs(items) do
    if best == nil or item.price < best.price then
      best = item
    end
  end
  return best
end

return inventory
`;

const BRIDGE_C = `/* native/bridge.c
 * Compiled in the browser by the Selene C bridge and callable from Lua with
 * _C.call("name", ...) or through lua_register blocks.
 */
#include <stdio.h>

int c_sum(int a, int b) {
  return a + b;
}

int c_fib(int n) {
  int a = 0;
  int b = 1;
  for (int i = 0; i < n; i++) {
    int next = a + b;
    a = b;
    b = next;
  }
  return a;
}

double c_damage(double base, double multiplier) {
  double result = base * multiplier;
  if (result < 0) {
    result = 0;
  }
  printf("native c_damage(%.2f, %.2f) = %.2f\\n", base, multiplier, result);
  return result;
}

typedef struct {
  double x;
  double y;
} Vec2;

Vec2 c_vec2_scale(Vec2 value, double factor) {
  value.x = value.x * factor;
  value.y = value.y * factor;
  return value;
}
`;

export function createDefaultSnapshot(): ProjectSnapshot {
  const now = Date.now();
  const files: ProjectFile[] = [
    { id: 'sample-main', path: 'main.lua', content: MAIN_LUA, kind: 'lua', graph: null, locked: false },
    { id: 'sample-inventory', path: 'lib/inventory.lua', content: INVENTORY_LUA, kind: 'lua', graph: null, locked: false },
    { id: 'sample-bridge', path: 'native/bridge.c', content: BRIDGE_C, kind: 'c', graph: null, locked: false },
  ];

  for (const id of ['json', 'vector']) {
    const entry = findPackage(id);
    if (!entry) continue;
    for (const file of entry.files) {
      files.push({
        id: `sample-${id}-${file.path.replace(/\W/g, '-')}`,
        path: file.path,
        content: file.content,
        kind: 'lua',
        graph: null,
        locked: true,
      });
    }
  }

  return {
    version: 1,
    name: 'selene-starter',
    files,
    folders: ['lib', 'native', 'packages'],
    openTabs: ['main.lua', 'lib/inventory.lua', 'native/bridge.c'],
    activePath: 'main.lua',
    installed: ['json', 'vector'],
    savedAt: now,
  };
}
