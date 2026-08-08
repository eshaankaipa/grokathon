declare module "*.wasm" {
  const value: WebAssembly.Module;
  export default value;
}

declare module "*.ttf" {
  const value: ArrayBuffer;
  export default value;
}
