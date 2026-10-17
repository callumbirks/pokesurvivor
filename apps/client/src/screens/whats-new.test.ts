// @vitest-environment happy-dom
// The What's new button's temporary theme (changelog.json `whatsNewTheme`).
import { loadChangelog } from '@pokesurvivor/data';
import { describe, expect, it, vi } from 'vitest';
import type * as Icons from '../icons.js';
import type { App } from '../app/app.js';
import { whatsNewButton } from './menu.js';

// The pixel icons paint on a canvas, which happy-dom doesn't have.
vi.mock('../icons.js', async (orig) => ({
  ...(await orig<typeof Icons>()),
  iconImg: (name: string) => Object.assign(document.createElement('img'), { alt: name }),
}));

const go = vi.fn();
const app = { go } as unknown as App;
const changelog = loadChangelog();

describe("the What's new button", () => {
  it('is the gold notice with the star when the theme is off', () => {
    for (const whatsNewTheme of [null, undefined]) {
      const b = whatsNewButton(app, { ...changelog, whatsNewTheme });
      expect([...b.classList]).toEqual(expect.arrayContaining(['win', 'hot', 'whats-new']));
      expect(b.classList.contains('theme-mega')).toBe(false);
      expect(b.querySelector('img')?.alt).toBe('star');
    }
  });

  it('wears the Mega theme with the Mega symbol, same label and target', () => {
    const b = whatsNewButton(app, { ...changelog, whatsNewTheme: 'mega' });
    expect(b.classList.contains('theme-mega')).toBe(true);
    expect(b.classList.contains('hot')).toBe(false);
    expect(b.querySelector('img')?.alt).toBe('mega');
    expect(b.textContent).toContain("What's new");
    b.click();
    expect(go).toHaveBeenCalledWith('changelog');
  });
});
