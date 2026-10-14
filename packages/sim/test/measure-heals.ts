// `pnpm --filter @pokesurvivor/sim heals`: same targets/DPS as the shield fixture.
import { measureShields } from './measure-shields.js';

for (const minute of [3, 8, 15]) {
  for (const [healers, shielders] of [
    [0, 0],
    [1, 0],
    [3, 0],
    [1, 1],
    [3, 3],
  ] as const) {
    console.log(JSON.stringify(measureShields(minute, shielders, healers)));
  }
}
