import { describe, expect, it } from 'vitest';
import { BUSY_ROUTES, routes } from './index.js';

describe('routes', () => {
  it('marks the gacha, shop, collection and settings busy, and nothing else', () => {
    expect([...BUSY_ROUTES].sort()).toEqual(['collection', 'gacha', 'settings', 'shop']);
  });

  it('only lets the login screen through logged out', () => {
    expect(
      Object.entries(routes)
        .filter(([, r]) => r.public)
        .map(([n]) => n),
    ).toEqual(['login']);
  });
});
