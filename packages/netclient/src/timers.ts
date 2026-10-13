// Timers exist in browsers, Web Workers and Node alike; typed here instead of pulling in the DOM
// or Node type libraries (this package must stay DOM-free).
interface Timers {
  setTimeout(callback: () => void, ms?: number): unknown;
  clearTimeout(handle: unknown): void;
  setInterval(callback: () => void, ms?: number): unknown;
  clearInterval(handle: unknown): void;
}

export const timers = globalThis as unknown as Timers;
