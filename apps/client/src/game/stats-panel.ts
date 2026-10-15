// The HUD's stats panel (Settings → "Show stats"): the player's own Pokémon's stats under the HP
// bar. Attack, speed and max HP show their value with everything applied and the multiplier over
// the species base; the stats with no base show only the multiplier or amount. The sim computes
// them (`playerStats`, sent to the viewer only); this formats and draws.
import { t } from '@pokesurvivor/data';
import type { SelfStats } from '@pokesurvivor/netclient';

export interface StatCell {
  label: string;
  /** The value (attack, speed, max HP) or the amount (damage reduction, regen). */
  value: string;
  /** "×1.45": over the base, or the stat's own multiplier. */
  mult: string;
  /** Not at its neutral value (a bonus, or a penalty): drawn highlighted. */
  changed: boolean;
}

const x2 = (v: number) => `×${v.toFixed(2)}`;
const changed = (v: number, neutral: number) => Math.abs(v - neutral) >= 0.005;

/**
 * The panel's rows, three cells each. `momentum`: the live Momentum multiplier, which attack
 * includes (it's sent apart, as it changes with every kill). Crit only shows once there is some.
 */
export function statRows(s: SelfStats, momentum: number): StatCell[][] {
  const atk = s.attack * momentum;
  const atkMul = atk / Math.max(1e-9, s.attackBase);
  const speMul = s.speed / Math.max(1e-9, s.speedBase);
  const hpMul = s.maxHp / Math.max(1e-9, s.hpBase);
  const cell = (label: string, value: string, mult: string, on: boolean): StatCell => ({
    label,
    value,
    mult,
    changed: on,
  });
  return [
    [
      // Attack is a multiplier of move damage: shown ×100, so a species' base reads ~100.
      cell(t('hud.statAtk'), String(Math.round(atk * 100)), x2(atkMul), changed(atkMul, 1)),
      cell(t('hud.statSpe'), String(Math.round(s.speed)), x2(speMul), changed(speMul, 1)),
      cell(t('hud.statHp'), String(Math.round(s.maxHp)), x2(hpMul), changed(hpMul, 1)),
    ],
    [
      cell(t('hud.statCooldown'), '', x2(s.cooldown), changed(s.cooldown, 1)),
      cell(
        t('hud.statDefense'),
        `${Math.round(s.damageReduction * 100)}%`,
        '',
        s.damageReduction >= 0.005,
      ),
      cell(t('hud.statRegen'), `+${s.regen.toFixed(1)}/s`, '', s.regen >= 0.05),
    ],
    [
      cell(t('hud.statMagnet'), '', x2(s.magnet), changed(s.magnet, 1)),
      cell(t('hud.statXp'), '', x2(s.xp), changed(s.xp, 1)),
      ...(s.crit > 0 ? [cell(t('hud.statCrit'), `${Math.round(s.crit * 100)}%`, '', true)] : []),
    ],
  ];
}

/** The rows to draw: none when the setting is off or no stats have arrived yet. */
export function visibleStatRows(
  show: boolean,
  stats: SelfStats | null | undefined,
  momentum: number,
): StatCell[][] | null {
  return show && stats ? statRows(stats, momentum) : null;
}

const PALETTE = {
  bg: '#272223',
  ink: '#141012',
  text: '#f2e9d8',
  muted: '#a3968a',
  gold: '#ffd65c',
};
const CELL_W = 82;
const ROW_H = 13;
const PAD = 5;

/** Draws the panel at (x, y) in HUD px; returns its height. */
export function drawStatsPanel(
  ctx: CanvasRenderingContext2D,
  rows: StatCell[][],
  font: (weight: number, size: number) => string,
  x: number,
  y: number,
): number {
  const w = CELL_W * 3 + PAD * 2 - 6;
  const h = rows.length * ROW_H + PAD * 2 - 2;
  ctx.save();
  ctx.textAlign = 'left';
  ctx.fillStyle = 'rgba(20,16,18,.55)';
  ctx.fillRect(x + 2, y + 2, w, h);
  ctx.fillStyle = PALETTE.bg;
  ctx.globalAlpha = 0.92;
  ctx.fillRect(x, y, w, h);
  ctx.globalAlpha = 1;
  ctx.strokeStyle = PALETTE.ink;
  ctx.lineWidth = 1;
  ctx.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);
  rows.forEach((row, r) => {
    const ty = y + PAD + 8 + r * ROW_H;
    row.forEach((c, i) => {
      let cx = x + PAD + i * CELL_W;
      ctx.font = font(700, 9);
      ctx.fillStyle = PALETTE.muted;
      ctx.fillText(c.label, cx, ty);
      cx += ctx.measureText(c.label).width + 4;
      ctx.font = font(800, 9);
      if (c.value) {
        ctx.fillStyle = c.changed && !c.mult ? PALETTE.gold : PALETTE.text;
        ctx.fillText(c.value, cx, ty);
        cx += ctx.measureText(c.value).width + 3;
      }
      if (c.mult) {
        ctx.fillStyle = c.changed ? PALETTE.gold : PALETTE.muted;
        ctx.fillText(c.mult, cx, ty);
      }
    });
  });
  ctx.restore();
  return h;
}
