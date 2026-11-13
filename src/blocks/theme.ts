import * as Blockly from 'blockly/core';

export const CATEGORY_COLOURS = {
  control: '#ff8a66',
  variables: '#f4c95d',
  functions: '#6ee7a8',
  tables: '#5aa9ff',
  modules: '#b98cff',
  native: '#ff6f9d',
  stdlib: '#43d9e6',
  logic: '#a9b6cf',
} as const;

function shades(primary: string): { colourPrimary: string; colourSecondary: string; colourTertiary: string } {
  // Simple darkening of a #rrggbb colour for Blockly's shading layers.
  const value = primary.replace('#', '');
  const r = parseInt(value.slice(0, 2), 16);
  const g = parseInt(value.slice(2, 4), 16);
  const b = parseInt(value.slice(4, 6), 16);
  const mix = (channel: number, amount: number) => Math.max(0, Math.min(255, Math.round(channel * amount)));
  const hex = (n: number) => n.toString(16).padStart(2, '0');
  return {
    colourPrimary: primary,
    colourSecondary: `#${hex(mix(r, 0.82))}${hex(mix(g, 0.82))}${hex(mix(b, 0.82))}`,
    colourTertiary: `#${hex(mix(r, 0.58))}${hex(mix(g, 0.58))}${hex(mix(b, 0.58))}`,
  };
}

export const SELENE_THEME = Blockly.Theme.defineTheme('selene', {
  name: 'selene',
  base: Blockly.Themes.Classic,
  blockStyles: {
    control_style: shades(CATEGORY_COLOURS.control),
    vars_style: shades(CATEGORY_COLOURS.variables),
    funcs_style: shades(CATEGORY_COLOURS.functions),
    tables_style: shades(CATEGORY_COLOURS.tables),
    modules_style: shades(CATEGORY_COLOURS.modules),
    native_style: shades(CATEGORY_COLOURS.native),
    stdlib_style: shades(CATEGORY_COLOURS.stdlib),
    logic_style: shades(CATEGORY_COLOURS.logic),
  },
  categoryStyles: {
    control_category: { colour: CATEGORY_COLOURS.control },
    vars_category: { colour: CATEGORY_COLOURS.variables },
    funcs_category: { colour: CATEGORY_COLOURS.functions },
    tables_category: { colour: CATEGORY_COLOURS.tables },
    modules_category: { colour: CATEGORY_COLOURS.modules },
    native_category: { colour: CATEGORY_COLOURS.native },
    stdlib_category: { colour: CATEGORY_COLOURS.stdlib },
    logic_category: { colour: CATEGORY_COLOURS.logic },
  },
  componentStyles: {
    workspaceBackgroundColour: '#090d15',
    toolboxBackgroundColour: '#0e131d',
    toolboxForegroundColour: '#c3cddf',
    flyoutBackgroundColour: '#121927',
    flyoutForegroundColour: '#c3cddf',
    flyoutOpacity: 0.98,
    scrollbarColour: '#2b364b',
    scrollbarOpacity: 0.7,
    insertionMarkerColour: '#aab7ff',
    insertionMarkerOpacity: 0.45,
    cursorColour: '#aab7ff',
    markerColour: '#7be8c3',
  },
  fontStyle: {
    family: "'Inter', ui-sans-serif, system-ui, -apple-system, 'Segoe UI', sans-serif",
    weight: '500',
    size: 11,
  },
  startHats: false,
});
