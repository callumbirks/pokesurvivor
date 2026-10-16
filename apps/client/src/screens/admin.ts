// The admin page (`#admin`, hidden: no link anywhere, and the route doesn't exist for players;
// every admin endpoint checks `users.is_admin` on the server too). One tab per admin tool; add
// a section to `SECTIONS` for a new one.
import { t } from '@pokesurvivor/data';
import type { App, Screen } from '../app/app.js';
import { h, replace } from '../app/dom.js';
import { liveTuningPanel } from './admin-tuning.js';
import { screenBox } from './common.js';

export interface AdminSection {
  id: string;
  title: () => string;
  render(app: App): Screen;
}

const SECTIONS: AdminSection[] = [
  { id: 'tuning', title: () => t('admin.tuning'), render: liveTuningPanel },
];

export function adminScreen(app: App, params: URLSearchParams): Screen {
  const box = screenBox(app, { id: 'admin', title: t('admin.title') });
  const tabs = h('nav', { class: 'admin-tabs', role: 'tablist' });
  const host = h('div', { class: 'admin-section' });
  box.body.append(tabs, host);
  let panel: Screen | null = null;

  const show = (id: string) => {
    const section = SECTIONS.find((s) => s.id === id) ?? SECTIONS[0]!;
    panel?.destroy?.();
    panel = section.render(app);
    replace(host, panel.el);
    replace(
      tabs,
      SECTIONS.map((s) =>
        h(
          'button',
          {
            class: ['btn', 'small', s.id === section.id ? 'primary' : 'ghost'],
            role: 'tab',
            'aria-selected': s.id === section.id ? 'true' : 'false',
            on: { click: () => show(s.id) },
          },
          s.title(),
        ),
      ),
    );
  };
  show(params.get('section') ?? SECTIONS[0]!.id);
  return { el: box.el, destroy: () => panel?.destroy?.() };
}
