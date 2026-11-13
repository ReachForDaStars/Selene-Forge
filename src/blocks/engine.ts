import * as Blockly from 'blockly/core';
import * as En from 'blockly/msg/en';
import 'blockly/blocks';
import { luaGenerator } from 'blockly/lua';
import type { ProjectAnalysis } from '../lua/analyze';
import type { BlockGraph, CBridgeInfo, ProjectFile } from '../core/types';
import { installCustomBlocks, setNativeRegistry } from './customBlocks';
import { blocksFromLua } from './fromAst';
import { SELENE_THEME } from './theme';
import { buildToolbox, emptyAnalysis, sanitizeToolbox } from './toolbox';

// `blockly/core` ships no message catalogue; without it Blockly cannot build
// aria labels or localised block text.
Blockly.setLocale(En as unknown as Record<string, string>);

type ToolboxDefinition = NonNullable<Blockly.BlocklyOptions['toolbox']>;

function asToolbox(definition: Record<string, unknown>): ToolboxDefinition {
  return definition as unknown as ToolboxDefinition;
}

export const BUTTON_NEW_C_FUNCTION = 'SELENE_NEW_C_FUNCTION';
export const BUTTON_NEW_C_STRUCT = 'SELENE_NEW_C_STRUCT';

export interface EngineCallbacks {
  onGraphChange: () => void;
  onCreateNativeFunction: () => void;
  onCreateNativeStruct: () => void;
}

export class BlockEngine {
  readonly workspace: Blockly.WorkspaceSvg;
  private callbacks: EngineCallbacks;
  private suppress = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private analysis: ProjectAnalysis = emptyAnalysis();

  constructor(host: HTMLElement, callbacks: EngineCallbacks) {
    installCustomBlocks();
    this.callbacks = callbacks;

    this.workspace = Blockly.inject(host, {
      toolbox: asToolbox(
        sanitizeToolbox(
          buildToolbox({
            analysis: emptyAnalysis(),
            onCreateNativeFunction: BUTTON_NEW_C_FUNCTION,
            onCreateNativeStruct: BUTTON_NEW_C_STRUCT,
          }),
        ),
      ),
      theme: SELENE_THEME,
      renderer: 'zelos',
      grid: { spacing: 24, length: 3, colour: '#1c2637', snap: true },
      zoom: { controls: true, wheel: true, startScale: 0.9, maxScale: 2.2, minScale: 0.25, pinch: true, scaleSpeed: 1.2 },
      move: { scrollbars: true, drag: true, wheel: true },
      scrollbars: true,
      trashcan: true,
      sounds: false,
      comments: true,
      collapse: true,
    });

    this.workspace.registerButtonCallback(BUTTON_NEW_C_FUNCTION, () => this.callbacks.onCreateNativeFunction());
    this.workspace.registerButtonCallback(BUTTON_NEW_C_STRUCT, () => this.callbacks.onCreateNativeStruct());

    this.workspace.addChangeListener((event: Blockly.Events.Abstract) => {
      if (this.suppress > 0) return;
      if (event.isUiEvent) return;
      const type = (event as unknown as { type?: string }).type ?? '';
      if (type === 'ui' || type === 'viewport_change' || type === 'theme_change' || type === 'finished_loading') return;
      this.scheduleChange();
    });

    const resizeObserver = new ResizeObserver(() => {
      Blockly.svgResize(this.workspace);
    });
    resizeObserver.observe(host);
    this.resizeObserver = resizeObserver;
  }

  private resizeObserver: ResizeObserver | null = null;

  private scheduleChange(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      this.callbacks.onGraphChange();
    }, 160);
  }

  /** Refresh toolbox entries and the FFI dropdown registry. */
  setProjectContext(analysis: ProjectAnalysis, bridge: CBridgeInfo): void {
    this.analysis = analysis;
    setNativeRegistry(
      bridge.functions.map((fn) => ({ name: fn.name, returnType: fn.returnType, params: fn.params })),
      bridge.structs.map((entry) => entry.name),
    );
    const toolbox = asToolbox(
      sanitizeToolbox(
        buildToolbox({
          analysis,
          onCreateNativeFunction: BUTTON_NEW_C_FUNCTION,
          onCreateNativeStruct: BUTTON_NEW_C_STRUCT,
        }),
      ),
    );
    try {
      this.workspace.updateToolbox(toolbox);
    } catch (error) {
      console.warn('[selene] toolbox update failed', error);
    }
  }

  get currentAnalysis(): ProjectAnalysis {
    return this.analysis;
  }

  runSilently(work: () => void): void {
    this.suppress += 1;
    Blockly.Events.disable();
    try {
      work();
    } finally {
      Blockly.Events.enable();
      this.suppress = Math.max(0, this.suppress - 1);
    }
  }

  loadGraph(graph: BlockGraph | null): void {
    this.runSilently(() => {
      this.workspace.clear();
      if (graph && graph.blocks) {
        try {
          Blockly.serialization.workspaces.load(graph as Record<string, unknown>, this.workspace);
        } catch (error) {
          console.warn('[selene] could not load block graph', error);
        }
      }
      this.workspace.clearUndo();
    });
  }

  loadFile(file: ProjectFile | null): void {
    this.loadGraph(file?.graph ?? null);
  }

  saveGraph(): BlockGraph {
    return Blockly.serialization.workspaces.save(this.workspace) as BlockGraph;
  }

  /** Generate Lua from the current workspace. Never throws. */
  generate(): string {
    try {
      const code = luaGenerator.workspaceToCode(this.workspace);
      return code.replace(/[ \t]+$/gm, '').replace(/\n{3,}/g, '\n\n').replace(/\s+$/, '');
    } catch (error) {
      console.error('[selene] code generation failed', error);
      return '';
    }
  }

  /** Parse Lua and replace the workspace with matching blocks. */
  loadCode(source: string): { ok: boolean; error: string | null } {
    try {
      const { graph } = blocksFromLua(source);
      this.loadGraph(graph);
      return { ok: true, error: null };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  isEmpty(): boolean {
    return this.workspace.getAllBlocks(false).length === 0;
  }

  blockCount(): number {
    return this.workspace.getAllBlocks(false).length;
  }

  appendBlock(state: unknown): void {
    this.runSilently(() => {
      try {
        Blockly.serialization.blocks.append(
          state as unknown as Parameters<typeof Blockly.serialization.blocks.append>[0],
          this.workspace,
        );
      } catch (error) {
        console.warn('[selene] could not append block', error);
      }
    });
    this.workspace.cleanUp();
  }

  /** Force a graph-change notification (used after programmatic block insertion). */
  notifyGraphChange(): void {
    this.callbacks.onGraphChange();
  }

  centerOnBlocks(): void {
    const top = this.workspace.getTopBlocks(true);
    if (top.length > 0) this.workspace.centerOnBlock(top[0].id);
  }

  resize(): void {
    Blockly.svgResize(this.workspace);
  }

  dispose(): void {
    this.resizeObserver?.disconnect();
    if (this.timer) clearTimeout(this.timer);
    this.workspace.dispose();
  }
}
