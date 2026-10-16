// Where each value of a JSON text is: `[start, end)` offsets by path (keys joined with `\0`;
// array items by index), so a tool can rewrite one value and leave the file's layout alone.

export interface Span {
  start: number;
  end: number;
}

export function valueSpans(text: string): Map<string, Span> {
  const spans = new Map<string, Span>();
  let i = 0;
  const ws = () => {
    while (i < text.length && ' \t\n\r'.includes(text[i]!)) i++;
  };
  const expect = (c: string) => {
    if (text[i] !== c) throw new Error(`expected "${c}" at offset ${i}`);
    i++;
  };
  const str = (): string => {
    const start = i;
    expect('"');
    while (text[i] !== '"') {
      if (i >= text.length) throw new Error('unterminated string');
      if (text[i] === '\\') i++;
      i++;
    }
    i++;
    return JSON.parse(text.slice(start, i)) as string;
  };
  const value = (path: string[]): void => {
    ws();
    const start = i;
    const c = text[i];
    if (c === '{') {
      i++;
      ws();
      if (text[i] !== '}')
        for (;;) {
          ws();
          const key = str();
          ws();
          expect(':');
          value([...path, key]);
          ws();
          if (text[i] !== ',') break;
          i++;
        }
      expect('}');
    } else if (c === '[') {
      i++;
      ws();
      let n = 0;
      if (text[i] !== ']')
        for (;;) {
          value([...path, String(n++)]);
          ws();
          if (text[i] !== ',') break;
          i++;
        }
      expect(']');
    } else if (c === '"') str();
    else {
      const m = /^(true|false|null|-?\d+(\.\d+)?([eE][+-]?\d+)?)/.exec(text.slice(i));
      if (!m) throw new Error(`unexpected "${c}" at offset ${i}`);
      i += m[0].length;
    }
    spans.set(path.join('\0'), { start, end: i });
  };
  value([]);
  return spans;
}
