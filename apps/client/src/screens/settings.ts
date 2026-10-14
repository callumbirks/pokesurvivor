// Settings: sound, graphics, controls, account and about (original implementation). Edits the
// settings store, which saves locally and syncs the account's copy.
import { loadChangelog, t, versionLabel } from '@pokesurvivor/data';
import type { App, Screen } from '../app/app.js';
import { h, replace } from '../app/dom.js';
import { glyph, type PadButton } from '../glyphs.js';
import {
  CROSSHAIR_COLORS,
  settings,
  type AimMode,
  type CrosshairColor,
  type Quality,
  type Settings,
} from '../settings.js';
import { HUD_SIZE_MAX, HUD_SIZE_MIN, hudScale } from '../game/hudscale.js';
import { screenBox, tabs } from './common.js';

type Tab = 'sound' | 'graphics' | 'controls' | 'account' | 'about';
/** The original game this one is based on (Settings → About). */
const ORIGINAL_GAME_URL = 'https://pokesurvivor.com';
let tab: Tab = 'sound';

const row = (title: string, sub: string | null, control: Node) =>
  h(
    'div',
    { class: 'set-row' },
    h('div', { class: 'grow' }, h('b', null, title), sub ? h('small', null, sub) : null),
    control,
  );

function toggle(key: 'damageNumbers' | 'calmMode' | 'showFps' | 'netStats' | 'muted'): HTMLElement {
  const on = settings.get()[key];
  return h(
    'button',
    {
      class: ['btn', 'small', 'switch', on && 'primary'],
      role: 'switch',
      'aria-checked': on ? 'true' : 'false',
      dataset: { testid: `set-${key}` },
      on: { click: () => settings.set({ [key]: !settings.get()[key] }) },
    },
    on ? t('settings.yes') : t('settings.no'),
  );
}

/**
 * The settings edited with a slider. The screen must not redraw when one of them changes: that
 * would replace the `<input type=range>` mid-drag and end the drag after one step.
 */
export const SLIDER_KEYS = [
  'musicVolume',
  'sfxVolume',
  'stickScale',
  'crosshairScale',
  'hudSize',
] as const satisfies readonly (keyof Settings)[];
type SliderKey = (typeof SLIDER_KEYS)[number];
const isSliderKey = (k: keyof Settings): k is SliderKey =>
  (SLIDER_KEYS as readonly string[]).includes(k);

function slider(
  key: Exclude<SliderKey, 'hudSize'>,
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
        : key === 'crosshairScale'
          ? `×${Number(Number(input.value).toFixed(2))}`
          : `${Math.round(Number(input.value) * 100)}%`);
  show();
  input.addEventListener('input', () => {
    show();
    settings.set({ [key]: Number(input.value) });
  });
  return h('span', { class: 'slider' }, input, out);
}

/**
 * HUD size: an Auto button (the default: it grows with the window, shown as e.g. "Auto (150%)")
 * and a fixed scale, 75–200%. Moving the slider turns Auto off; pressing Auto turns it back on.
 * It updates itself in place (it's in `SLIDER_KEYS`), so a drag isn't cut short.
 */
function hudSizeControl(): HTMLElement {
  const input = h('input', {
    type: 'range',
    min: HUD_SIZE_MIN,
    max: HUD_SIZE_MAX,
    step: 0.05,
    dataset: { testid: 'set-hudSize' },
  });
  const out = h('span', { class: 'val' });
  const auto = h('button', {
    class: 'chip',
    type: 'button',
    dataset: { testid: 'set-hudSize-auto' },
  });
  const pct = (k: number) => `${Math.round(k * 100)}%`;
  const show = () => {
    const size = settings.get().hudSize;
    // On Auto the slider shows the automatic size for this window, dimmed.
    const k = size === 'auto' ? hudScale(innerWidth, innerHeight, 'auto') : size;
    input.value = String(k);
    out.textContent = pct(k);
    auto.textContent =
      size === 'auto' ? t('settings.hudSizeAutoNow', { 0: pct(k) }) : t('settings.hudSizeAuto');
    auto.classList.toggle('on', size === 'auto');
    auto.setAttribute('aria-pressed', size === 'auto' ? 'true' : 'false');
    slider.classList.toggle('dim', size === 'auto');
  };
  input.addEventListener('input', () => {
    settings.set({ hudSize: Number(input.value) });
    show();
  });
  auto.addEventListener('click', () => {
    settings.set({ hudSize: 'auto' });
    show();
  });
  const slider = h('span', { class: 'slider' }, input, out);
  show();
  return h('span', { class: 'hud-size' }, auto, slider);
}

const COLOUR_NAMES = {
  magenta: 'settings.colourMagenta',
  white: 'settings.colourWhite',
  red: 'settings.colourRed',
  green: 'settings.colourGreen',
  cyan: 'settings.colourCyan',
  yellow: 'settings.colourYellow',
  orange: 'settings.colourOrange',
  black: 'settings.colourBlack',
} as const satisfies Record<CrosshairColor, string>;
const colourName = (c: CrosshairColor) => t(COLOUR_NAMES[c]);

/** The crosshair colour: one swatch per colour, the chosen one ringed. A click redraws the tab. */
function crosshairSwatches(): HTMLElement {
  const on = settings.get().crosshairColor;
  return h(
    'div',
    { class: 'chips swatches', role: 'radiogroup', 'aria-label': t('settings.crosshairColour') },
    (Object.keys(CROSSHAIR_COLORS) as CrosshairColor[]).map((c) =>
      h(
        'button',
        {
          class: ['chip', 'swatch', on === c && 'on'],
          role: 'radio',
          'aria-checked': on === c ? 'true' : 'false',
          'aria-label': colourName(c),
          title: colourName(c),
          dataset: { testid: `set-crosshair-${c}` },
          on: { click: () => settings.set({ crosshairColor: c }) },
        },
        h('span', { class: 'dot', style: `background:${CROSSHAIR_COLORS[c]}` }),
      ),
    ),
  );
}

/** A row of the gamepad's controls: its glyphs, then what they do. */
function padKey(buttons: PadButton[], what: string): Node[] {
  return [
    h(
      'span',
      { class: 'glyphs' },
      buttons.map((b) => glyph(b)),
    ),
    h('span', null, what),
  ];
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
  box.box.classList.add('settings');
  // The build's version in the corner: the newest release bundled from changelog.json, "+dev"
  // with unreleased changes on top, "dev" before the first release.
  box.box.append(
    h(
      'span',
      { class: 'version-tag', dataset: { testid: 'version' } },
      versionLabel(loadChangelog()),
    ),
  );

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
        row(t('settings.hudSize'), t('settings.hudSizeHelp'), hudSizeControl()),
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
        row(t('settings.showNetStats'), t('settings.netStatsHelp'), toggle('netStats')),
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
      const aimModes: AimMode[] = ['auto', 'manual'];
      replace(
        body,
        h('h4', { class: 'set-h' }, t('settings.aiming')),
        h('p', { class: 'small muted' }, t('settings.aimingHelp')),
        h(
          'div',
          { class: 'chips set-chips' },
          aimModes.map((m) =>
            h(
              'button',
              {
                class: ['chip', s.aimMode === m && 'on'],
                dataset: { testid: `set-aim-${m}` },
                'aria-pressed': s.aimMode === m ? 'true' : 'false',
                on: { click: () => settings.set({ aimMode: m }) },
              },
              t(m === 'auto' ? 'settings.aimAuto' : 'settings.aimManual'),
            ),
          ),
        ),
        row(t('settings.crosshairColour'), t('settings.crosshairColourHelp'), crosshairSwatches()),
        row(
          t('settings.crosshairSize'),
          t('settings.crosshairSizeHelp'),
          slider('crosshairScale', 0.25, 3, 0.05),
        ),
        h('h4', { class: 'set-h' }, t('settings.onMobileOrTablet')),
        row(
          t('settings.joystickSize'),
          t('settings.howFarYouNeedTo'),
          slider('stickScale', 0.5, 2, 0.1),
        ),
        h('p', { class: 'small muted' }, t('settings.putYourFingerAnywhereAnd')),
        h('p', { class: 'small muted' }, t('settings.manualAimTouch')),
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
          h('kbd', null, 'T'),
          h('span', null, t('app.keyAim')),
          h('kbd', null, 'Esc'),
          h('span', null, t('pause.pause')),
        ),
        h('h4', { class: 'set-h' }, t('settings.onGamepad')),
        h('p', { class: 'small muted' }, t('settings.gamepadHelp')),
        h(
          'div',
          { class: 'keys', dataset: { testid: 'pad-keys' } },
          padKey(['lstick'], t('app.keyMove')),
          padKey(['a', 'b', 'x', 'y'], t('app.keyPadSlot')),
          padKey(['lb', 'rb'], t('app.keyCycle')),
          padKey(['dpad'], t('app.keyMenuMove')),
          padKey(['a'], t('app.keyConfirm')),
          padKey(['select'], t('app.keyReroll')),
          padKey(['r3'], t('app.keyAim')),
          padKey(['rstick', 'rt'], t('app.keyAimStick')),
          padKey(['start'], t('pause.pause')),
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
        h(
          'p',
          { class: 'center' },
          h(
            'a',
            {
              href: ORIGINAL_GAME_URL,
              target: '_blank',
              rel: 'noopener',
              dataset: { testid: 'original-game' },
            },
            t('settings.basedOn'),
          ),
        ),
        h('p', { class: 'small' }, t('settings.fanGameNoAdsOr')),
        h('h4', { class: 'set-h' }, t('settings.credits')),
        h(
          'ul',
          { class: 'credits' },
          h('li', null, t('settings.musicCredit')),
          h('li', null, t('settings.pmdSpritecollabAndItsArtists')),
          h('li', null, t('settings.creditFont')),
          h('li', null, t('settings.kenneyInputPrompts')),
          h('li', null, t('settings.creditData')),
        ),
      );
    }
  };

  render();
  const off = settings.subscribe((_s, changed) => {
    // Sliders update themselves; redraw for the rest (toggles, chips).
    // A slider's own changes don't redraw (see `SLIDER_KEYS`); anything else does.
    if (changed.some((k) => !isSliderKey(k))) render();
  });
  return { el: box.el, destroy: off };
}
