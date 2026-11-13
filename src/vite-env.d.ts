/// <reference types="vite/client" />

declare module '*.wasm?url' {
  const src: string;
  export default src;
}

declare module 'wasmoon/dist/glue.wasm?url' {
  const src: string;
  export default src;
}
