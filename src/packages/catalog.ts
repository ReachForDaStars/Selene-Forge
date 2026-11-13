/**
 * Curated, dependency-free Lua packages. Each entry is installed as real `.lua`
 * files under `packages/`, so they are ordinary project modules after install.
 */

export interface PackageFile {
  path: string;
  content: string;
}

export interface CatalogPackage {
  id: string;
  name: string;
  version: string;
  description: string;
  tags: string[];
  summary: string;
  files: PackageFile[];
}

const JSON_LUA = String.raw`-- json — pure Lua encoder/decoder (Selene Forge package 1.2.0)
local json = {}

local escapes = {
  ['"'] = '\\"',
  ['\\'] = '\\\\',
  ['\b'] = '\\b',
  ['\f'] = '\\f',
  ['\n'] = '\\n',
  ['\r'] = '\\r',
  ['\t'] = '\\t',
}

local function encodeString(value)
  local encoded = value:gsub('[%z\1-\31\\"]', function(char)
    return escapes[char] or string.format('\\u%04x', string.byte(char))
  end)
  return '"' .. encoded .. '"'
end

local function encodeValue(value, stack)
  local kind = type(value)
  if kind == 'nil' then return 'null' end
  if kind == 'boolean' then return value and 'true' or 'false' end
  if kind == 'number' then
    if value ~= value or value == math.huge or value == -math.huge then return 'null' end
    return string.format('%.14g', value)
  end
  if kind == 'string' then return encodeString(value) end
  if kind ~= 'table' then error('json.encode: cannot encode ' .. kind, 2) end
  if stack[value] then error('json.encode: circular reference', 2) end
  stack[value] = true

  local count = 0
  local max = 0
  local isArray = true
  for key in pairs(value) do
    count = count + 1
    if type(key) == 'number' and key > max then max = key end
    if type(key) ~= 'number' or key < 1 or key % 1 ~= 0 then isArray = false end
  end

  local parts = {}
  if isArray and count == max then
    for index = 1, max do
      parts[index] = encodeValue(value[index], stack)
    end
    stack[value] = nil
    return '[' .. table.concat(parts, ',') .. ']'
  end

  for key, entry in pairs(value) do
    local name = key
    if type(name) ~= 'string' then name = tostring(name) end
    parts[#parts + 1] = encodeString(name) .. ':' .. encodeValue(entry, stack)
  end
  stack[value] = nil
  return '{' .. table.concat(parts, ',') .. '}'
end

function json.encode(value)
  return encodeValue(value, {})
end

local function skipWhitespace(text, index)
  local _, stop = text:find('[^ \t\r\n]', index)
  return stop or (#text + 1)
end

local function parseString(text, index)
  local out = {}
  index = index + 1
  while index <= #text do
    local char = text:sub(index, index)
    if char == '"' then
      return table.concat(out), index + 1
    elseif char == '\\' then
      local escape = text:sub(index + 1, index + 1)
      local simple = { n = '\n', t = '\t', r = '\r', b = '\b', f = '\f', ['"'] = '"', ['\\'] = '\\', ['/'] = '/' }
      if simple[escape] then
        out[#out + 1] = simple[escape]
        index = index + 2
      elseif escape == 'u' then
        local hex = text:sub(index + 2, index + 5)
        local code = tonumber(hex, 16)
        if code and utf8 then out[#out + 1] = utf8.char(code) else out[#out + 1] = '?' end
        index = index + 6
      else
        error('json.decode: invalid escape "\\' .. escape .. '" at ' .. index, 2)
      end
    else
      out[#out + 1] = char
      index = index + 1
    end
  end
  error('json.decode: unterminated string', 2)
end

local function parseNumber(text, index)
  local start = index
  while index <= #text and text:sub(index, index):match('[%-%+%d%.eE]') do
    index = index + 1
  end
  local value = tonumber(text:sub(start, index - 1))
  if not value then error('json.decode: invalid number at ' .. start, 2) end
  return value, index
end

local parseValue

local function parseObject(text, index)
  local object = {}
  index = skipWhitespace(text, index + 1)
  if text:sub(index, index) == '}' then return object, index + 1 end
  while true do
    index = skipWhitespace(text, index)
    if text:sub(index, index) ~= '"' then error('json.decode: expected key at ' .. index, 2) end
    local key
    key, index = parseString(text, index)
    index = skipWhitespace(text, index)
    if text:sub(index, index) ~= ':' then error("json.decode: expected ':' at " .. index, 2) end
    local value
    value, index = parseValue(text, skipWhitespace(text, index + 1))
    object[key] = value
    index = skipWhitespace(text, index)
    local delimiter = text:sub(index, index)
    if delimiter == ',' then
      index = index + 1
    elseif delimiter == '}' then
      return object, index + 1
    else
      error("json.decode: expected ',' or '}' at " .. index, 2)
    end
  end
end

local function parseArray(text, index)
  local array = {}
  index = skipWhitespace(text, index + 1)
  if text:sub(index, index) == ']' then return array, index + 1 end
  while true do
    local value
    value, index = parseValue(text, index)
    array[#array + 1] = value
    index = skipWhitespace(text, index)
    local delimiter = text:sub(index, index)
    if delimiter == ',' then
      index = skipWhitespace(text, index + 1)
    elseif delimiter == ']' then
      return array, index + 1
    else
      error("json.decode: expected ',' or ']' at " .. index, 2)
    end
  end
end

parseValue = function(text, index)
  index = skipWhitespace(text, index)
  local char = text:sub(index, index)
  if char == '{' then return parseObject(text, index) end
  if char == '[' then return parseArray(text, index) end
  if char == '"' then return parseString(text, index) end
  if text:sub(index, index + 3) == 'null' then return nil, index + 4 end
  if text:sub(index, index + 3) == 'true' then return true, index + 4 end
  if text:sub(index, index + 4) == 'false' then return false, index + 5 end
  if char == '' then error('json.decode: unexpected end of input', 2) end
  return parseNumber(text, index)
end

function json.decode(text)
  if type(text) ~= 'string' then error('json.decode: expected a string', 2) end
  local value, index = parseValue(text, 1)
  index = skipWhitespace(text, index)
  if index <= #text then
    error('json.decode: trailing characters at ' .. index, 2)
  end
  return value
end

function json.tryDecode(text)
  local ok, value = pcall(json.decode, text)
  if ok then return value, nil end
  return nil, value
end

return json
`;

const VECTOR_LUA = String.raw`-- vector — 2D/3D vector math (Selene Forge package 1.1.0)
local vector = {}

local Vec3 = {}
Vec3.__index = Vec3

local function vec3(x, y, z)
  return setmetatable({ x = x or 0, y = y or 0, z = z or 0 }, Vec3)
end

function vector.new2(x, y)
  return vec3(x or 0, y or 0, 0)
end

function vector.new3(x, y, z)
  return vec3(x or 0, y or 0, z or 0)
end

function Vec3:clone()
  return vec3(self.x, self.y, self.z)
end

function Vec3:add(other)
  return vec3(self.x + other.x, self.y + other.y, self.z + (other.z or 0))
end

function Vec3:sub(other)
  return vec3(self.x - other.x, self.y - other.y, self.z - (other.z or 0))
end

function Vec3:scale(factor)
  return vec3(self.x * factor, self.y * factor, self.z * factor)
end

function Vec3:dot(other)
  return self.x * other.x + self.y * other.y + self.z * (other.z or 0)
end

function Vec3:length()
  return math.sqrt(self:dot(self))
end

function Vec3:normalize()
  local magnitude = self:length()
  if magnitude == 0 then return vec3(0, 0, 0) end
  return self:scale(1 / magnitude)
end

function Vec3:lerp(other, alpha)
  return vec3(
    self.x + (other.x - self.x) * alpha,
    self.y + (other.y - self.y) * alpha,
    self.z + ((other.z or 0) - self.z) * alpha
  )
end

function Vec3:__tostring()
  return string.format('(%.3f, %.3f, %.3f)', self.x, self.y, self.z)
end

Vec3.__add = Vec3.add
Vec3.__sub = Vec3.sub
Vec3.__eq = function(a, b)
  return a.x == b.x and a.y == b.y and a.z == b.z
end

function vector.add(a, b) return a:add(b) end
function vector.sub(a, b) return a:sub(b) end
function vector.scale(a, factor) return a:scale(factor) end
function vector.dot(a, b) return a:dot(b) end
function vector.length(a) return a:length() end
function vector.normalize(a) return a:normalize() end
function vector.lerp(a, b, alpha) return a:lerp(b, alpha) end
function vector.tostring(a) return tostring(a) end

function vector.cross(a, b)
  return vec3(
    a.y * (b.z or 0) - a.z * b.y,
    a.z * b.x - a.x * (b.z or 0),
    a.x * b.y - a.y * b.x
  )
end

function vector.distance(a, b)
  return a:sub(b):length()
end

return vector
`;

const STATEMACHINE_LUA = String.raw`-- statemachine — finite state machine (Selene Forge package 1.0.0)
local machine = {}

local Machine = {}
Machine.__index = Machine

function machine.new(config)
  config = config or {}
  local self = setmetatable({
    states = {},
    current = nil,
    previous = nil,
    time = 0,
    stateTime = 0,
  }, Machine)

  for name, handlers in pairs(config.states or {}) do
    self.states[name] = handlers
  end
  if config.initial then
    self:change(config.initial)
  end
  return self
end

function machine.isMachine(value)
  return getmetatable(value) == Machine
end

function Machine:add(name, handlers)
  self.states[name] = handlers or {}
  return self
end

function Machine:is(name)
  return self.current == name
end

function Machine:get()
  return self.current
end

function Machine:change(name)
  local nextState = self.states[name]
  if not nextState then
    error("statemachine: unknown state '" .. tostring(name) .. "'", 2)
  end
  local previousState = self.current and self.states[self.current]
  if previousState and previousState.leave then
    previousState.leave(self, name)
  end
  self.previous = self.current
  self.current = name
  self.stateTime = 0
  if nextState.enter then
    nextState.enter(self, self.previous)
  end
  return self
end

function Machine:update(dt)
  dt = dt or 0
  self.time = self.time + dt
  self.stateTime = self.stateTime + dt
  local state = self.current and self.states[self.current]
  if state and state.update then
    state.update(self, dt)
  end
  return self
end

return machine
`;

const TWEEN_LUA = String.raw`-- tween — numeric tweening with easing (Selene Forge package 1.0.0)
local tween = {}

local Tweener = {}
Tweener.__index = Tweener

tween.easings = {
  linear = function(t) return t end,
  quad = function(t) return t * t end,
  cubic = function(t) return t * t * t end,
  inQuad = function(t) return t * t end,
  outQuad = function(t) return 1 - (1 - t) * (1 - t) end,
  inOutQuad = function(t)
    if t < 0.5 then return 2 * t * t end
    return 1 - ((-2 * t + 2) ^ 2) / 2
  end,
  outCubic = function(t) return 1 - (1 - t) ^ 3 end,
  inOutCubic = function(t)
    if t < 0.5 then return 4 * t * t * t end
    return 1 - ((-2 * t + 2) ^ 3) / 2
  end,
  backOut = function(t)
    local c = 1.70158
    return 1 + (c + 1) * (t - 1) ^ 3 + c * (t - 1) ^ 2
  end,
}

function tween.new(duration, subject, target, easing)
  local ease = easing or 'linear'
  if type(ease) == 'string' then
    ease = tween.easings[ease] or tween.easings.linear
  end
  return setmetatable({
    duration = duration or 1,
    elapsed = 0,
    subject = subject or {},
    target = target or {},
    from = {},
    easing = ease,
    finished = false,
  }, Tweener)
end

function Tweener:start()
  self.from = {}
  for key, value in pairs(self.target) do
    if type(value) == 'number' then
      self.from[key] = self.subject[key] or 0
    end
  end
  self.elapsed = 0
  self.finished = false
  return self
end

function Tweener:update(dt)
  if self.finished then return self end
  if next(self.from) == nil then self:start() end
  self.elapsed = math.min(self.duration, self.elapsed + (dt or 0))
  local progress = 1
  if self.duration > 0 then progress = self.elapsed / self.duration end
  local eased = self.easing(progress)
  for key, value in pairs(self.target) do
    if type(value) == 'number' then
      local start = self.from[key] or 0
      self.subject[key] = start + (value - start) * eased
    end
  end
  self.finished = self.elapsed >= self.duration
  return self
end

function Tweener:isFinished()
  return self.finished
end

function Tweener:reset()
  self.elapsed = 0
  self.finished = false
  return self:start()
end

return tween
`;

const CLASS_LUA = String.raw`-- class — lightweight OOP helper (Selene Forge package 1.1.0)
local function class(parent)
  local cls = {}
  cls.__index = cls
  cls.super = parent
  cls.className = 'Object'

  if parent then
    setmetatable(cls, { __index = parent })
  end

  setmetatable(cls, {
    __index = parent,
    __call = function(self, ...)
      return self:new(...)
    end,
  })

  function cls:new(...)
    local instance = setmetatable({}, self)
    if instance.init then
      instance:init(...)
    end
    return instance
  end

  function cls:extend(name)
    local child = class(self)
    if name then child.className = name end
    return child
  end

  function cls:isInstanceOf(other)
    local current = self
    local mt = getmetatable(self)
    if mt and rawget(mt, '__call') == nil and rawget(mt, '__index') ~= nil then
      current = mt
    end
    while current do
      if current == other then return true end
      current = rawget(current, 'super')
    end
    return false
  end

  return cls
end

return class
`;

export const PACKAGE_CATALOG: CatalogPackage[] = [
  {
    id: 'json',
    name: 'json',
    version: '1.2.0',
    description: 'Encode and decode JSON with ordered objects, arrays, escapes and helpful errors.',
    tags: ['serialization', 'data', 'pure-lua'],
    summary: 'json.encode(value) · json.decode(text) · json.tryDecode(text)',
    files: [{ path: 'packages/json.lua', content: JSON_LUA }],
  },
  {
    id: 'vector',
    name: 'vector',
    version: '1.1.0',
    description: 'Vec2/Vec3 values with operator overloads, dot/cross products, normals and lerp.',
    tags: ['math', 'geometry', 'games'],
    summary: 'vector.new2/3, add, sub, scale, dot, cross, length, normalize, lerp',
    files: [{ path: 'packages/vector.lua', content: VECTOR_LUA }],
  },
  {
    id: 'statemachine',
    name: 'statemachine',
    version: '1.0.0',
    description: 'Tiny finite state machine with enter/update/leave hooks and state timers.',
    tags: ['logic', 'games', 'control'],
    summary: 'machine.new{ initial = "idle" } · machine:change(name) · machine:update(dt)',
    files: [{ path: 'packages/statemachine.lua', content: STATEMACHINE_LUA }],
  },
  {
    id: 'tween',
    name: 'tween',
    version: '1.0.0',
    description: 'Numeric tweening with easing curves — animate any table of numbers.',
    tags: ['animation', 'math', 'ui'],
    summary: 'tween.new(duration, subject, target, easing) · tweener:update(dt)',
    files: [{ path: 'packages/tween.lua', content: TWEEN_LUA }],
  },
  {
    id: 'class',
    name: 'class',
    version: '1.1.0',
    description: 'Classic prototype-style classes with inheritance, constructors and instanceof.',
    tags: ['oop', 'structure'],
    summary: 'local class = require("class") · local Animal = class() · Animal:extend()',
    files: [{ path: 'packages/class.lua', content: CLASS_LUA }],
  },
];

export function findPackage(id: string): CatalogPackage | undefined {
  return PACKAGE_CATALOG.find((entry) => entry.id === id);
}

export function packageFiles(list: CatalogPackage[]): PackageFile[] {
  return list.flatMap((entry) => entry.files);
}
