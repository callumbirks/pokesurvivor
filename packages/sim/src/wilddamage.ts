import type { TuningFile } from '@pokesurvivor/data';

/**
 * A tuning curve (`spawner.damageCurve`, `spawner.hpCurve`) at a minute. Data-validated points start
 * at zero. Clamp before/after the measured interval.
 */
export function wildDamageMultiplier(
  points: TuningFile['spawner']['damageCurve'],
  minute: number,
): number {
  const first = points[0]!;
  if (minute <= first.minute) return first.multiplier;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1]!;
    const b = points[i]!;
    if (minute <= b.minute) {
      const fraction = (minute - a.minute) / (b.minute - a.minute);
      return a.multiplier + (b.multiplier - a.multiplier) * fraction;
    }
  }
  return points.at(-1)!.multiplier;
}

/** Applied after type, armour and melee protection, before weather. Zero disables the cap. */
export function capRegularHit(damage: number, maxHp: number, fraction: number): number {
  return fraction > 0 ? Math.min(damage, maxHp * fraction) : damage;
}
