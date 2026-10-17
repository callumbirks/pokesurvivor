// A small tooltip for an element: shown while the pointer is over it, or while `focusTarget` has
// the keyboard / gamepad focus. It is one element on <body> (positioned under the anchor), so a
// scrolling grid doesn't clip it. Touch has no hover: screens show the same text elsewhere.
import { h } from './dom.js';

let tip: HTMLElement | null = null;
let owner: HTMLElement | null = null;

function show(anchor: HTMLElement, text: string): void {
  tip ??= document.body.appendChild(
    h('div', { class: 'tooltip', role: 'tooltip', dataset: { testid: 'tooltip' } }),
  );
  owner = anchor;
  tip.textContent = text;
  tip.hidden = false;
  const r = anchor.getBoundingClientRect();
  const w = tip.offsetWidth;
  const left = Math.max(4, Math.min(innerWidth - w - 4, r.left + r.width / 2 - w / 2));
  const below = r.bottom + 6 + tip.offsetHeight < innerHeight;
  tip.style.left = `${left}px`;
  tip.style.top = `${below ? r.bottom + 6 : r.top - 6 - tip.offsetHeight}px`;
  // Gone with its anchor (the screen re-rendered, or changed).
  const watch = () => {
    if (owner !== anchor) return;
    if (anchor.isConnected) requestAnimationFrame(watch);
    else hide(anchor);
  };
  requestAnimationFrame(watch);
}

function hide(anchor: HTMLElement): void {
  if (tip && owner === anchor) tip.hidden = true;
  if (owner === anchor) owner = null;
}

/** Shows `text` by `anchor` on hover, and while `focusTarget` (default: the anchor) has focus. */
export function withTooltip(
  anchor: HTMLElement,
  text: string,
  focusTarget: HTMLElement = anchor,
): HTMLElement {
  anchor.setAttribute('aria-label', text);
  anchor.addEventListener('pointerenter', (e) => {
    if (e.pointerType !== 'touch') show(anchor, text);
  });
  anchor.addEventListener('pointerleave', () => hide(anchor));
  // Mouse clicks focus buttons too: only a visible focus (keys, the pad) shows it.
  focusTarget.addEventListener('focus', () => {
    if (focusTarget.matches(':focus-visible')) show(anchor, text);
  });
  focusTarget.addEventListener('blur', () => hide(anchor));
  return anchor;
}
