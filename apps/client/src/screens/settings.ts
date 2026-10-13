// Settings: sound, graphics, controls, account and about (legacy settings-ui.js). Edits the
// settings store, which saves locally and syncs the account's copy.
import { t } from '@pokesurvivor/data';
import type { App, Screen } from '../app/app.js';
import { h, replace } from '../app/dom.js';
import { settings, type Quality } from '../settings.js';
import { screenBox, tabs } from './common.js';

type Tab = 'sound' | 'graphics' | 'controls' | 'account' | 'about';
let tab: Tab = 'sound';

const row = (title: string, sub: string | null, control: Node) =>
  h(
    'div',
    { class: 'set-row' },
    h('div', { class: 'grow' }, h('b', null, title), sub ? h('small', null, sub) : null),
    control,
  );

function toggle(key: 'damageNumbers' | 'calmMode' | 'showFps' | 'muted'): HTMLElement {
  const on = settings.get()[key];
  return h(
    'button',
    {
      class: ['btn', 'small', 'switch', on && 'gold'],
      role: 'switch',
      'aria-checked': on ? 'true' : 'false',
      dataset: { testid: `set-${key}` },
      on: { click: () => settings.set({ [key]: !settings.get()[key] }) },
    },
    on ? t('settings.yes') : t('settings.no'),
  );
}

function slider(
  key: 'musicVolume' | 'sfxVolume' | 'stickScale',
  min: number,
  max: number,
  step: number,
): HTMLElement {
  const input = h('input', {
    type: 'range',
    min,
    max,
    step,
    value: String(settings.get()[key]),
    dataset: { testid: `set-${key}` },
  });
  const out = h('span', { class: 'val' });
  const show = () =>
    (out.textContent =
      key === 'stickScale'
        ? `×${Number(input.value).toFixed(1)}`
        : `${Math.round(Number(input.value) * 100)}%`);
  show();
  input.addEventListener('input', () => {
    show();
    settings.set({ [key]: Number(input.value) });
  });
  return h('span', { class: 'slider' }, input, out);
}

export interface SettingsOptions {
  /** Opened from a run's pause menu: the back button calls this instead of going to the menu. */
  onBack?: () => void;
}

export function settingsScreen(
  app: App,
  _params?: URLSearchParams,
  opts: SettingsOptions = {},
): Screen {
  const box = screenBox(app, {
    id: 'settings',
    title: t('menu.settings'),
    wide: false,
    onBack: opts.onBack,
  });
  const tabRow = h('div');
  const body = h('div', { class: 'set-body' });
  box.body.append(tabRow, body);
  box.el.querySelector('.box')?.classList.add('settings');

  const render = () => {
    replace(
      tabRow,
      tabs<Tab>(
        (['sound', 'graphics', 'controls', 'account', 'about'] as const).map((id) => ({
          id,
          label: t(`settings.${id}`),
          testid: `set-tab-${id}`,
        })),
        tab,
        (next) => ((tab = next), render()),
        'tabs wrap',
      ),
    );
    const s = settings.get();
    if (tab === 'sound') {
      replace(
        body,
        row(t('settings.music'), null, slider('musicVolume', 0, 1, 0.05)),
        row(t('settings.effects'), null, slider('sfxVolume', 0, 1, 0.05)),
        row(t('settings.muteAll'), null, toggle('muted')),
      );
    } else if (tab === 'graphics') {
      const qualities: Quality[] = ['auto', 'high', 'medium', 'low'];
      replace(
        body,
        h('h4', { class: 'set-h' }, t('settings.quality')),
        h('p', { class: 'small muted' }, t('settings.howManyEffectsAndParticles')),
        h(
          'div',
          { class: 'chips set-chips' },
          qualities.map((q) =>
            h(
              'button',
              {
                class: ['chip', s.quality === q && 'on'],
                on: { click: () => settings.set({ quality: q }) },
              },
              t(`settings.${q}`),
            ),
          ),
        ),
        h('h4', { class: 'set-h' }, t('settings.display')),
        row(
          t('settings.damageNumbers'),
          t('settings.theNumbersThatPopUp'),
          toggle('damageNumbers'),
        ),
        row(
          t('settings.lessShakingAndFlashing'),
          t('settings.theCameraShakesLessAnd'),
          toggle('calmMode'),
        ),
        row(t('settings.showFps'), t('settings.framesPerSecondInThe'), toggle('showFps')),
        document.fullscreenEnabled
          ? row(
              t('settings.fullscreen'),
              t('settings.withoutBrowserBars'),
              h(
                'button',
                {
                  class: 'btn small',
                  on: {
                    click: () =>
                      void (
                        document.fullscreenElement
                          ? document.exitFullscreen()
                          : document.documentElement.requestFullscreen()
                      ).catch(() => {}),
                  },
                },
                t('settings.turnOn'),
              ),
            )
          : null,
        h('h4', { class: 'set-h' }, t('settings.language')),
        row(
          t('settings.language'),
          t('app.languageOnlyEnglish'),
          h('select', { class: 'field', disabled: true }, h('option', null, 'English')),
        ),
      );
    } else if (tab === 'controls') {
      replace(
        body,
        h('h4', { class: 'set-h' }, t('settings.onMobileOrTablet')),
        row(
          t('settings.joystickSize'),
          t('settings.howFarYouNeedTo'),
          slider('stickScale', 0.5, 2, 0.1),
        ),
        h('p', { class: 'small muted' }, t('settings.putYourFingerAnywhereAnd')),
        h('h4', { class: 'set-h' }, t('settings.onPc')),
        h(
          'div',
          { class: 'keys' },
          h('kbd', null, 'WASD / ← ↑ → ↓'),
          h('span', null, t('app.keyMove')),
          h('kbd', null, '1–4'),
          h('span', null, t('app.keySlot')),
          h('kbd', null, 'Q / E'),
          h('span', null, t('app.keyCycle')),
          h('kbd', null, 'R'),
          h('span', null, t('app.keyReroll')),
          h('kbd', null, 'Esc'),
          h('span', null, t('pause.pause')),
        ),
      );
    } else if (tab === 'account') {
      const logout = h(
        'button',
        { class: 'btn', dataset: { testid: 'logout' } },
        t('settings.logOut'),
      );
      logout.addEventListener('click', () => void app.act(logout, () => app.logout()));
      replace(
        body,
        row(
          t('settings.nickname'),
          t('settings.itSUniqueAndCan'),
          h('b', null, app.user?.username ?? ''),
        ),
        row(
          t('settings.accountType'),
          t('settings.savedInTheCloud'),
          h('span', { class: 'sync ok' }),
        ),
        h('div', { class: 'row', style: 'margin-top:12px' }, logout),
      );
    } else {
      replace(
        body,
        h('div', { class: 'about-logo' }, 'PokéSurvivor'),
        h('p', { class: 'small' }, t('settings.fanGameNoAdsOr', { 0: '' })),
        h('h4', { class: 'set-h' }, t('settings.credits')),
        h('ul', { class: 'credits' }, h('li', null, t('settings.pmdSpritecollabAndItsArtists'))),
        h(
          'p',
          { class: 'small' },
          h('a', { href: '/legacy/', target: '_blank', rel: 'noopener' }, t('app.legacyGame')),
        ),
      );
    }
  };

  render();
  const off = settings.subscribe((_s, changed) => {
    // Sliders update themselves; redraw for the rest (toggles, chips).
    if (changed.some((k) => k !== 'musicVolume' && k !== 'sfxVolume' && k !== 'stickScale'))
      render();
  });
  return { el: box.el, destroy: off };
}
