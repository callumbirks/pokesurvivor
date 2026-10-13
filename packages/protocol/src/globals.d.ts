// The few platform globals this package uses; they exist in Node and in browsers alike. Declared
// here instead of pulling in the DOM or Node type libraries.
declare class TextEncoder {
  encode(input?: string): Uint8Array;
}
declare class TextDecoder {
  decode(input?: Uint8Array): string;
}
