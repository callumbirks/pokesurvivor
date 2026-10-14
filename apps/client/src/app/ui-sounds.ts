// Interface sounds (original implementation `wireSounds`): a soft tick when the pointer moves onto something
// clickable, and a click, or "back" on back buttons, when it's pressed. Buttons with their own
// sound (a purchase, a pull, picking a partner) set `data-sfx`: another effect's name, or "none"
// when they play it themselves (usually once the server said yes).
import { audio, type SfxName } from '../audio.js';

const CLICKABLE =
  '.btn, .cursor-item, .tab, .chip, .gen-tab, .cell:not(.locked), .answer, button.tb-cell';

/** The sound for a click on `el` (null: none). */
export function clickSound(el: Element): SfxName | null {
  if (el.matches(':disabled, [aria-disabled="true"]')) return 'error';
  const own = (el as HTMLElement).dataset.sfx;
  if (own === 'none') return null;
  if (own) return own as SfxName;
  if (el.matches('[data-back], [data-testid="back"]')) return 'back';
  return 'click';
}

export function wireUiSounds(root: Document = document): void {
  let lastHover: Element | null = null;
  root.addEventListener('pointerover', (e) => {
    const el = (e.target as Element | null)?.closest?.(CLICKABLE) ?? null;
    if (el && el !== lastHover && !el.matches(':disabled')) audio.sfx('hover');
    lastHover = el;
  });
  root.addEventListener(
    'click',
    (e) => {
      const el = (e.target as Element | null)?.closest?.(CLICKABLE);
      if (!el) return;
      const sfx = clickSound(el);
      if (sfx) audio.sfx(sfx);
    },
    true,
  );
  // Sliders tick when let go; drop-downs when changed.
  root.addEventListener('change', (e) => {
    const t = e.target;
    if (t instanceof HTMLInputElement && t.type === 'range') audio.sfx('click');
    else if (t instanceof HTMLSelectElement) audio.sfx('select');
  });
}
