import { describe, expect, it } from 'vitest';
import { typeColor } from '../icons.js';
import { hurtColor } from './events.js';

describe('damage number colours', () => {
  const hit = { shielded: false, label: null, moveType: 'fire' } as const;

  it("uses the attack's type colour", () => {
    expect(hurtColor(hit)).toBe(typeColor('fire'));
    expect(hurtColor({ ...hit, moveType: 'water' })).toBe(typeColor('water'));
    expect(typeColor('fire')).not.toBe(typeColor('water'));
  });

  it('is white for untyped hits (bombs, traps) and older servers', () => {
    expect(hurtColor({ ...hit, moveType: null })).toBe('#ffffff');
    expect(hurtColor({ shielded: false, label: null })).toBe('#ffffff');
  });

  it('lets the hit label and the shield win over the type', () => {
    expect(hurtColor({ ...hit, label: 'crit' })).toBe('#ff9a3c');
    expect(hurtColor({ ...hit, label: 'super' })).toBe('#ffe14d');
    expect(hurtColor({ ...hit, label: 'weak' })).toBe('#a3abb8');
    expect(hurtColor({ ...hit, shielded: true })).toBe('#9fd8ff');
  });
});
