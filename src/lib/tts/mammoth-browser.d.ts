/**
 * mammoth ships types for its Node entry but not for the browser bundle,
 * which is the only one this app may load — the Node entry drags fs/path
 * shims into the client chunk. The surface used is one function.
 */
declare module "mammoth/mammoth.browser" {
  const mammoth: {
    extractRawText(input: { arrayBuffer: ArrayBuffer }): Promise<{ value: string }>;
  };
  export default mammoth;
}
