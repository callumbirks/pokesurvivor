import type { RunCaps } from '../economy/config.js';

/** Local limits chosen to exercise accepted claims, capped claims and checkpoint crediting. */
export const testRunCaps: RunCaps = {
  maxDurationS: 3600,
  maxLevel: 80,
  killsPerMinute: 200,
  bossesPerMinute: 2,
  coinsFlat: 50,
  coinsPerMinute: 100,
  ticketsX1Flat: 1,
  ticketsX1PerMinute: 0.8,
  ticketsX10Flat: 0,
  ticketsX10PerMinute: 0.2,
  shiniesFlat: 1,
  shiniesPerMinute: 0.2,
  shiniesMax: 5,
  chestsFlat: 1,
  chestsPerMinute: 0.5,
  itemsFlat: 1,
  itemsPerMinute: 0.5,
  evolutionsFlat: 1,
  evolutionsPerMinute: 0.5,
  riftWinsFlat: 1,
  riftWinsPerMinute: 0.5,
  rescuesFlat: 1,
  rescuesPerMinute: 0.5,
  rescuesMax: 3,
};
