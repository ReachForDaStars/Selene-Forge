import type { CBridgeBuild } from '../cbridge/bridge';
import { describeSignature } from '../cbridge/bridge';
import type { Project } from '../core/project';
import { openModal } from './dialogs';
import { escapeHtml, toast } from './toast';

export interface NativeBridgeContext {
  project: Project;
  build: () => CBridgeBuild;
  onInsertBlock: (state: unknown) => void;
  onChanged: () => void;
}

export interface NewCFunctionResult {
  ret: string;
  name: string;
  params: string;
  body: string;
}

const C_RETURN_TYPES = ['int', 'long', 'double', 'float', 'char*', 'void'];

function field(labelText: string, input: HTMLElement, hint?: string): HTMLElement {
  const wrapper = document.createElement('div');
  wrapper.className = 'field';
  const label = document.createElement('label');
  label.textContent = labelText;
  wrapper.appendChild(label);
  wrapper.appendChild(input);
  if (hint) {
    const hintElement = document.createElement('span');
    hintElement.className = 'field-hint';
    hintElement.innerHTML = hint;
    wrapper.appendChild(hintElement);
  }
  return wrapper;
}

export function newCFunctionDialog(): Promise<NewCFunctionResult | null> {
  return new Promise((resolve) => {
    const body = document.createElement('div');

    const info = document.createElement('div');
    info.className = 'callout';
    info.innerHTML =
      'Implemented by the in-browser native bridge — a typed C subset with <code>int</code>, <code>double</code>, <code>char*</code>, pointers, arrays, <code>struct</code>s, <code>for</code>/<code>while</code>/<code>if</code> and <code>printf</code>. It compiles when you press Run.';
    body.appendChild(info);

    const row = document.createElement('div');
    row.className = 'field-row-3';
    const retSelect = document.createElement('select');
    for (const type of C_RETURN_TYPES) {
      const option = document.createElement('option');
      option.value = type;
      option.textContent = type;
      retSelect.appendChild(option);
    }
    const nameInput = document.createElement('input');
    nameInput.value = 'c_helper';
    nameInput.spellcheck = false;
    const paramsInput = document.createElement('input');
    paramsInput.value = 'int value';
    paramsInput.spellcheck = false;
    row.append(field('Returns', retSelect), field('Name', nameInput), field('Parameters', paramsInput, 'Comma separated, e.g. <code>int a, double b</code>'));
    body.appendChild(row);

    const bodyInput = document.createElement('textarea');
    bodyInput.value = 'return value * 2;';
    bodyInput.spellcheck = false;
    bodyInput.style.minHeight = '140px';
    body.appendChild(field('Body', bodyInput, 'Runs on the C bridge. Use <code>printf()</code> to log from native code.'));

    let settled = false;
    const finish = (value: NewCFunctionResult | null) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };

    const submit = (close: () => void) => {
      const name = nameInput.value.trim();
      if (!/^[A-Za-z_]\w*$/.test(name)) {
        toast('C function names must be valid C identifiers.', 'error');
        return;
      }
      finish({
        ret: retSelect.value,
        name,
        params: paramsInput.value.trim(),
        body: bodyInput.value,
      });
      close();
    };

    openModal({
      title: 'New native C function',
      subtitle: 'Declares a C function block in the active Lua file; the definition is compiled at run time.',
      body,
      wide: true,
      actions: [
        { label: 'Add function block', variant: 'primary', keepOpen: true, onClick: (close) => submit(close) },
        { label: 'Cancel', variant: 'ghost', keepOpen: true, onClick: (close) => { finish(null); close(); } },
      ],
      onClose: () => finish(null),
    });
  });
}

export function newCStructDialog(): Promise<{ name: string; fields: string } | null> {
  return new Promise((resolve) => {
    const body = document.createElement('div');
    const info = document.createElement('div');
    info.className = 'callout';
    info.innerHTML = 'Structs cross the bridge as Lua tables. Field types use the supported C subset: <code>int</code>, <code>double</code>, <code>char</code>, pointers.';
    body.appendChild(info);

    const nameInput = document.createElement('input');
    nameInput.value = 'Point';
    nameInput.spellcheck = false;
    body.appendChild(field('Struct name', nameInput));

    const fieldsInput = document.createElement('textarea');
    fieldsInput.value = 'int x;\nint y;';
    fieldsInput.spellcheck = false;
    fieldsInput.style.minHeight = '120px';
    body.appendChild(field('Fields', fieldsInput, 'One declaration per line.'));

    let settled = false;
    const finish = (value: { name: string; fields: string } | null) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };

    openModal({
      title: 'New native C struct',
      subtitle: 'Adds a struct definition block plus a toolbox-visible struct type.',
      body,
      actions: [
        {
          label: 'Add struct block',
          variant: 'primary',
          keepOpen: true,
          onClick: (close) => {
            const name = nameInput.value.trim();
            if (!/^[A-Za-z_]\w*$/.test(name)) {
              toast('Struct names must be valid C identifiers.', 'error');
              return;
            }
            finish({ name, fields: fieldsInput.value });
            close();
          },
        },
        { label: 'Cancel', variant: 'ghost', keepOpen: true, onClick: (close) => { finish(null); close(); } },
      ],
      onClose: () => finish(null),
    });
  });
}

export function openNativeBridge(context: NativeBridgeContext): void {
  const body = document.createElement('div');
  const build = context.build();

  const intro = document.createElement('div');
  intro.className = 'callout';
  intro.innerHTML =
    'The bridge compiles every <code>.c</code>/<code>.cpp</code> file and every <code>Define C Function</code> block into one native translation unit, then binds it to Lua as <code>_C.call(name, …)</code> and <code>lua_register</code> globals.';
  body.appendChild(intro);

  if (build.info.errors.length > 0) {
    const errors = document.createElement('div');
    errors.className = 'callout is-error';
    errors.innerHTML = build.info.errors.map((error) => `<div>${escapeHtml(error)}</div>`).join('');
    body.appendChild(errors);
  }

  const functionsTitle = document.createElement('div');
  functionsTitle.className = 'field-label';
  functionsTitle.textContent = `C functions (${build.info.functions.length})`;
  functionsTitle.style.margin = '4px 0 8px';
  body.appendChild(functionsTitle);

  const list = document.createElement('div');
  list.className = 'ffi-list';
  if (build.info.functions.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'ffi-empty';
    empty.textContent = 'No native functions yet. Create one below, or add a .c file in the explorer.';
    list.appendChild(empty);
  }

  for (const fn of build.info.functions) {
    const row = document.createElement('div');
    row.className = 'ffi-row';
    const signature = document.createElement('span');
    signature.className = 'ffi-sig';
    signature.innerHTML = `<code>${escapeHtml(describeSignature(fn))}</code>`;
    row.appendChild(signature);

    const callButton = document.createElement('button');
    callButton.className = 'btn btn-ghost btn-sm';
    callButton.textContent = 'Insert call';
    callButton.addEventListener('click', () => {
      context.onInsertBlock({ type: 'ffi_call', fields: { FN: fn.name }, extraState: { arity: fn.params.length } });
      toast(`Inserted _C.call("${fn.name}") block.`, 'ok');
    });
    row.appendChild(callButton);
    list.appendChild(row);
  }
  body.appendChild(list);

  const structsTitle = document.createElement('div');
  structsTitle.className = 'field-label';
  structsTitle.textContent = `Structs (${build.info.structs.length})`;
  structsTitle.style.margin = '16px 0 8px';
  body.appendChild(structsTitle);

  const structList = document.createElement('div');
  structList.className = 'ffi-list';
  if (build.info.structs.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'ffi-empty';
    empty.textContent = 'No struct types defined.';
    structList.appendChild(empty);
  }
  for (const struct of build.info.structs) {
    const row = document.createElement('div');
    row.className = 'ffi-row';
    const signature = document.createElement('span');
    signature.className = 'ffi-sig';
    signature.innerHTML = `<code>struct ${escapeHtml(struct.name)} { ${escapeHtml(struct.fields.map((entry) => `${entry.type} ${entry.name}`).join('; '))} }</code>`;
    row.appendChild(signature);
    const button = document.createElement('button');
    button.className = 'btn btn-ghost btn-sm';
    button.textContent = 'Insert struct';
    button.addEventListener('click', () => {
      context.onInsertBlock({ type: 'ffi_struct_new', fields: { TYPE: struct.name } });
      toast(`Inserted ${struct.name} struct block.`, 'ok');
    });
    row.appendChild(button);
    structList.appendChild(row);
  }
  body.appendChild(structList);

  openModal({
    title: 'C / C++ bridge',
    subtitle: 'Native functions available to Lua right now',
    body,
    wide: true,
    actions: [
      {
        label: '＋ New C function',
        variant: 'ghost',
        keepOpen: true,
        onClick: async () => {
          const result = await newCFunctionDialog();
          if (!result) return;
          context.onInsertBlock({
            type: 'ffi_define_function',
            fields: { RET: result.ret, NAME: result.name, PARAMS: result.params, BODY: result.body },
          });
          context.onChanged();
          toast(`Added native C function "${result.name}".`, 'ok');
        },
      },
      {
        label: '＋ New struct',
        variant: 'ghost',
        keepOpen: true,
        onClick: async () => {
          const result = await newCStructDialog();
          if (!result) return;
          context.onInsertBlock({ type: 'ffi_define_struct', fields: { NAME: result.name, FIELDS: result.fields } });
          context.onChanged();
          toast(`Added native struct "${result.name}".`, 'ok');
        },
      },
      { label: 'Close', variant: 'primary' },
    ],
  });
}
