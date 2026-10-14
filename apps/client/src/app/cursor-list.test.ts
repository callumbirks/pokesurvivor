// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest';
import { CursorList, h } from './dom.js';

afterEach(() => {
  document.body.replaceChildren();
});

function list(onSelect?: (item: HTMLElement) => void) {
  const el = h('nav');
  document.body.append(el);
  const fill = (disabled: string[] = []) =>
    el.replaceChildren(
      ...['a', 'b', 'c'].map((id) =>
        h('button', {
          class: 'cursor-item',
          disabled: disabled.includes(id),
          dataset: { testid: id },
        }),
      ),
    );
  fill();
  const cl = new CursorList(el, { onSelect, navDefault: true });
  const item = (id: string) => el.querySelector<HTMLElement>(`[data-testid="${id}"]`)!;
  const on = () => [...el.querySelectorAll<HTMLElement>('.on')].map((e) => e.dataset.testid);
  return { el, cl, fill, item, on };
}

describe('CursorList', () => {
  it('selects what the pointer is over and what gets the focus, one at a time', () => {
    const seen: string[] = [];
    const { item, on } = list((i) => seen.push(i.dataset.testid ?? ''));
    item('b').dispatchEvent(
      new PointerEvent('pointerover', { bubbles: true, pointerType: 'mouse' }),
    );
    expect(on()).toEqual(['b']);
    // Pointing focuses it, so the keys and the pad carry on from there.
    expect(document.activeElement).toBe(item('b'));
    item('c').focus();
    expect(on()).toEqual(['c']);
    expect(item('c').hasAttribute('data-nav-default')).toBe(true);
    expect(item('b').hasAttribute('data-nav-default')).toBe(false);
    expect(seen).toEqual(['b', 'c']);
  });

  it('keeps the selection when the items are rebuilt, or falls back if it is disabled now', () => {
    const { cl, fill, item, on } = list();
    cl.select(item('b'));
    fill();
    cl.refresh(item('a'));
    expect(on()).toEqual(['b']);
    fill(['b']);
    cl.refresh(item('a'));
    expect(on()).toEqual(['a']);
  });

  it('ignores disabled items', () => {
    const { fill, item, on } = list();
    fill(['c']);
    item('c').dispatchEvent(
      new PointerEvent('pointerover', { bubbles: true, pointerType: 'mouse' }),
    );
    expect(on()).toEqual([]);
  });
});
