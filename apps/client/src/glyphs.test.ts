// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import { glyphText } from './glyphs.js';

describe('glyphText', () => {
  it('keeps each control (glyphs and label) together, separated by " · "', () => {
    const line = document.createElement('p');
    line.append(...glyphText('{lstick} move · {a}{b} switch · {start} pause'));
    const groups = [...line.querySelectorAll('.glyph-group')];
    expect(groups.map((g) => g.textContent)).toEqual([' move', ' switch', ' pause']);
    expect(groups.map((g) => g.querySelectorAll('.glyph').length)).toEqual([1, 2, 1]);
    expect(line.textContent).toBe(' move ·  switch ·  pause');
  });
});
