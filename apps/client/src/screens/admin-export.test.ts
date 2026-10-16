import { describe, expect, it } from 'vitest';
import { exportQuery } from './admin-export.js';

const none = {
  from: '',
  to: '',
  minMinutes: '',
  maxMinutes: '',
  mode: '',
  players: '',
  dex: '',
  username: '',
  configVersion: '',
  outcome: '',
  includeFlagged: false,
};

describe('run export filters', () => {
  it('leaves out empty filters', () => {
    expect(exportQuery(none)).toBe('');
  });

  it('turns the form into the export query', () => {
    const q = new URLSearchParams(
      exportQuery({
        from: '2026-10-01',
        to: '2026-10-05',
        minMinutes: '20',
        maxMinutes: '30.5',
        mode: 'coop',
        players: '2',
        dex: '25',
        username: ' Ash ',
        configVersion: '3',
        outcome: 'all-down',
        includeFlagged: true,
      }),
    );
    expect(Object.fromEntries(q)).toEqual({
      from: '2026-10-01T00:00:00Z',
      to: '2026-10-05T23:59:59.999Z',
      minDurationS: '1200',
      maxDurationS: '1830',
      mode: 'coop',
      players: '2',
      dex: '25',
      username: 'Ash',
      configVersion: '3',
      outcome: 'all-down',
      includeFlagged: 'true',
    });
  });
});
