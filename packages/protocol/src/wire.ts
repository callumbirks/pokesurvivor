// Low-level encoding for snapshot frames: a stream of integers and strings, written either as
// bytes (zigzag varints, the wire format) or as a JSON array (same structure; for measuring and
// debugging). Unsigned integers may use the full safe range (2^53), signed ones ±2^52, so the
// varint code uses arithmetic, not 32-bit bit operations.

export interface Writer {
  /** Non-negative integer. */
  uint(n: number): void;
  /** Signed integer (zigzag). */
  int(n: number): void;
  str(s: string): void;
}

export interface Reader {
  uint(): number;
  int(): number;
  str(): string;
  /** True once everything has been read. */
  readonly done: boolean;
}

// Present in Node and browsers alike; typed here instead of pulling in the DOM or Node libraries.
const platform = globalThis as unknown as {
  TextEncoder: new () => { encode(s: string): Uint8Array };
  TextDecoder: new () => { decode(b: Uint8Array): string };
};
const encoder = new platform.TextEncoder();
const decoder = new platform.TextDecoder();

export const zigzag = (n: number): number => (n >= 0 ? n * 2 : -n * 2 - 1);
export const unzigzag = (z: number): number => (z % 2 === 0 ? z / 2 : -(z + 1) / 2);

export class BinaryWriter implements Writer {
  private buf = new Uint8Array(1024);
  private pos = 0;

  private ensure(n: number): void {
    if (this.pos + n <= this.buf.length) return;
    let size = this.buf.length * 2;
    while (size < this.pos + n) size *= 2;
    const next = new Uint8Array(size);
    next.set(this.buf.subarray(0, this.pos));
    this.buf = next;
  }

  byte(b: number): void {
    this.ensure(1);
    this.buf[this.pos++] = b & 0xff;
  }

  uint(n: number): void {
    if (!Number.isSafeInteger(n) || n < 0) throw new RangeError(`not a uint: ${n}`);
    this.ensure(8);
    let v = n;
    while (v >= 0x80) {
      this.buf[this.pos++] = (v % 0x80) | 0x80;
      v = Math.floor(v / 0x80);
    }
    this.buf[this.pos++] = v;
  }

  int(n: number): void {
    this.uint(zigzag(n));
  }

  str(s: string): void {
    const bytes = encoder.encode(s);
    this.uint(bytes.length);
    this.ensure(bytes.length);
    this.buf.set(bytes, this.pos);
    this.pos += bytes.length;
  }

  get length(): number {
    return this.pos;
  }

  finish(): Uint8Array {
    return this.buf.slice(0, this.pos);
  }
}

export class BinaryReader implements Reader {
  private pos = 0;
  constructor(private readonly buf: Uint8Array) {}

  byte(): number {
    if (this.pos >= this.buf.length) throw new RangeError('read past the end');
    return this.buf[this.pos++] ?? 0;
  }

  uint(): number {
    let result = 0;
    let mul = 1;
    for (;;) {
      const b = this.byte();
      result += (b & 0x7f) * mul;
      if (b < 0x80) return result;
      mul *= 0x80;
      if (mul > 2 ** 56) throw new RangeError('varint too long');
    }
  }

  int(): number {
    return unzigzag(this.uint());
  }

  str(): string {
    const n = this.uint();
    if (this.pos + n > this.buf.length) throw new RangeError('string past the end');
    const s = decoder.decode(this.buf.subarray(this.pos, this.pos + n));
    this.pos += n;
    return s;
  }

  get done(): boolean {
    return this.pos >= this.buf.length;
  }
}

/** The same stream as a flat JSON array (for measuring the JSON alternative and for debugging). */
export class JsonWriter implements Writer {
  readonly values: (number | string)[] = [];
  uint(n: number): void {
    this.values.push(n);
  }
  int(n: number): void {
    this.values.push(n);
  }
  str(s: string): void {
    this.values.push(s);
  }
  finish(): string {
    return JSON.stringify(this.values);
  }
}

export class JsonReader implements Reader {
  private pos = 0;
  constructor(private readonly values: readonly (number | string)[]) {}
  private next(): number | string {
    if (this.pos >= this.values.length) throw new RangeError('read past the end');
    return this.values[this.pos++] as number | string;
  }
  uint(): number {
    const v = this.next();
    if (typeof v !== 'number') throw new TypeError('expected a number');
    return v;
  }
  int(): number {
    return this.uint();
  }
  str(): string {
    const v = this.next();
    if (typeof v !== 'string') throw new TypeError('expected a string');
    return v;
  }
  get done(): boolean {
    return this.pos >= this.values.length;
  }
}
