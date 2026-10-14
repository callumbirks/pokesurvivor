// Pixel-art icons drawn from character maps, like the tiles, so the interface shares the style of
// the Mystery Dungeon sprites (port of original implementation). Shared by the game and the menus.
//   iconCanvas('coin')              the icon at 1× (a canvas)
//   drawIcon(ctx, 'coin', x, y, 18) on a canvas, snapped to a whole multiple of its size
//   iconUrl('star') / iconHtml(…)   an SVG data URL / an <img> for the DOM
//   'move:<id>'                     the move type's emblem with its family badge
//   'type:<type>'                   the type's emblem alone
//   item ids (`leftovers`, …)       held items
import { loadGameData } from '@pokesurvivor/data';

interface IconDef {
  pal: Record<string, string>;
  rows: string[];
  outline?: boolean;
}

/** Outline colour. */
const K = '#1b1528';

const MEDAL = [
  '.kkk....kkk.',
  '.krk....kqk.',
  '..krk..kqk..',
  '...krkkqk...',
  '....kkkk....',
  '...kmmmmk...',
  '..kmwmmmnk..',
  '.kmwmsmmmnk.',
  '.kmmsssmmnk.',
  '.kmmmsmmmnk.',
  '..kmmmmmnk..',
  '...kkkkkk...',
];

const UI: Record<string, IconDef> = {
  gear: {
    pal: { g: '#c9d6ff', d: '#7f93c9' },
    rows: [
      '....kkkk....',
      '.kk.kggk.kk.',
      '.kgkkggkkgk.',
      '..kggggggk..',
      'kkggkkkkggkk',
      'kgggk..kgddk',
      'kgggk..kgddk',
      'kkggkkkkddkk',
      '..kggddddk..',
      '.kgkkddkkdk.',
      '.kk.kddk.kk.',
      '....kkkk....',
    ],
  },
  full: {
    pal: { w: '#f4f8ff' },
    rows: [
      'kkkkk..kkkkk',
      'kwwwk..kwwwk',
      'kwkk....kkwk',
      'kwk......kwk',
      'kkk......kkk',
      '............',
      '............',
      'kkk......kkk',
      'kwk......kwk',
      'kwkk....kkwk',
      'kwwwk..kwwwk',
      'kkkkk..kkkkk',
    ],
  },
  phone: {
    pal: { b: '#2c519f', s: '#9fd8ff', w: '#e6f4ff' },
    rows: [
      '...kkkkkk...',
      '...kbbbbk...',
      '...kssssk...',
      '...kswssk...',
      '...kssssk...',
      '...kssssk...',
      '...kssssk...',
      '...kssssk...',
      '...kssssk...',
      '...kbbbbk...',
      '...kbwwbk...',
      '...kkkkkk...',
    ],
  },
  // Banned (the Ban upgrade: a blocked move).
  ban: {
    pal: { r: '#ff5f6d' },
    rows: [
      '...kkkkkk...',
      '..krrrrrrk..',
      '.krrkkkkrrk.',
      'krrk..krrrrk',
      'krk..krrkkrk',
      'krk.krrk.krk',
      'krkkrrk..krk',
      'krrrrk..krrk',
      '.krrkkkkrrk.',
      '..krrrrrrk..',
      '...kkkkkk...',
      '............',
    ],
  },
  heart: {
    pal: { r: '#ff5f6d', s: '#c23a4b', w: '#ffd3d8' },
    rows: [
      '............',
      '.kkk....kkk.',
      'kwwrk..krrrk',
      'kwrrrkkrrrsk',
      'krrrrrrrrrsk',
      'krrrrrrrrrsk',
      '.krrrrrrrsk.',
      '..krrrrrsk..',
      '...krrrsk...',
      '....krsk....',
      '.....kk.....',
      '............',
    ],
  },
  fist: {
    pal: { r: '#ff5f6d', s: '#c23a4b', w: '#ffd3d8', c: '#e8e8f0' },
    rows: [
      '............',
      '..kkkkkk....',
      '.krrrrrrk...',
      'krwwrrrrrkk.',
      'krwrrrrrrrrk',
      'krrrrrrrkrsk',
      'krrrrrrrkrsk',
      '.krrrrrrskk.',
      '..kssssssk..',
      '..kcccccck..',
      '..kkkkkkkk..',
      '............',
    ],
  },
  up: {
    pal: { g: '#5fe08a', d: '#2f9a52', w: '#c8ffd8' },
    rows: [
      '.....kk.....',
      '....kwgk....',
      '...kwgggk...',
      '..kwgggggk..',
      '.kwgggggggk.',
      'kkkkggggkkkk',
      '...kggggk...',
      '...kggggk...',
      '...kggddk...',
      '...kgdddk...',
      '...kddddk...',
      '...kkkkkk...',
    ],
  },
  boot: {
    pal: { b: '#4fb4ff', d: '#2a6fb0', w: '#e6f4ff', g: '#e8e8f0' },
    rows: [
      '............',
      '....kkkk....',
      '....kbbk....',
      '....kbbk....',
      '....kbbk....',
      '....kbbbkk..',
      '...kbwbbbbk.',
      '..kbbbbbbbbk',
      '..kdddddddbk',
      '..kgggggggk.',
      '...kkkkkkk..',
      '............',
    ],
  },
  // Bond (the legendaries' reward): two linked rings.
  bond: {
    pal: { y: '#ffd23f', w: '#fff3b0', p: '#ff8ad8', q: '#ffd3f1' },
    rows: [
      '.kkkkk......',
      'kwyyyyk.....',
      'kykkkyk.....',
      'kyk.kyk.....',
      'kykkkyk.....',
      'kyyyyykkkkk.',
      '.kkkkkqppppk',
      '.....kpkkkpk',
      '.....kpk.kpk',
      '.....kpkkkpk',
      '.....kpppppk',
      '......kkkkk.',
    ],
  },
  clock: {
    pal: { w: '#f4f4ff', y: '#ffd23f', o: '#c9c9e0' },
    rows: [
      '....kkkk....',
      '..kkyyyykk..',
      '.kyywwwwyyk.',
      '.kywwwkwwyk.',
      'kywwwwkwwwyk',
      'kywwwwkwwwyk',
      'kywwwwkkkwyk',
      'kywwwwwwwwyk',
      '.kywwwwwwyk.',
      '.kyyowwwyyk.',
      '..kkyyyykk..',
      '....kkkk....',
    ],
  },
  shield: {
    pal: { s: '#9fb1c9', d: '#5d6f8c', w: '#e6eef8', r: '#4fb4ff' },
    rows: [
      '............',
      '.kkkkkkkkkk.',
      '.kwwsssssdk.',
      '.kwssrrssdk.',
      '.kwssrrssdk.',
      '.kssrrrrsdk.',
      '.kssrrrrsdk.',
      '..kssrrsdk..',
      '..kssssddk..',
      '...ksssdk...',
      '....kddk....',
      '.....kk.....',
    ],
  },
  sprout: {
    pal: { g: '#5fe08a', d: '#2f9a52', b: '#8a5a2b' },
    rows: [
      '............',
      '..kkk..kkk..',
      '.kgggk.kgggk',
      '.kggggkgggdk',
      '..kdggkggdk.',
      '...kkdgdkk..',
      '.....kgk....',
      '.....kgk....',
      '...kkkdkkk..',
      '..kbbbbbbbk.',
      '..kbbbbbbbk.',
      '...kkkkkkk..',
    ],
  },
  magnet: {
    pal: { r: '#ff5f6d', s: '#c23a4b', w: '#e8e8f0' },
    rows: [
      '............',
      '..kkkkkkkk..',
      '.krrrrrrrrk.',
      'krrsskkssrrk',
      'krrk....krrk',
      'krrk....krrk',
      'krrk....krrk',
      'kwwk....kwwk',
      'kwwk....kwwk',
      'kkkk....kkkk',
      '............',
      '............',
    ],
  },
  book: {
    pal: { c: '#4fb4ff', d: '#2a6fb0', p: '#f4f4ff', y: '#ffd23f' },
    rows: [
      '............',
      '.kkkkkkkkkk.',
      '.kcccccccck.',
      '.kcyyyyyyck.',
      '.kcccccccck.',
      '.kccyyyyyck.',
      '.kcccccccck.',
      '.kcccccccck.',
      '.kddddddddk.',
      '.kppppppppk.',
      '.kkkkkkkkkk.',
      '............',
    ],
  },
  coin: {
    pal: { y: '#ffd23f', o: '#c08a10', w: '#fff4b0' },
    rows: [
      '....kkkk....',
      '..kkyyyykk..',
      '.kyywwyyyyk.',
      '.kywyyyyyok.',
      'kyyyyooyyyok',
      'kywyoyyoyyok',
      'kyyyoyyoyyok',
      'kyyyyooyyyok',
      '.kyyyyyyyok.',
      '.kooyyyyook.',
      '..kkooookk..',
      '....kkkk....',
    ],
  },
  cards: {
    pal: { a: '#ffd23f', b: '#4fb4ff', w: '#e6f4ff' },
    rows: [
      '............',
      '.kkkkkk.....',
      '.kaaaaakkkk.',
      '.kaaaakbbbbk',
      '.kaaaakbwwbk',
      '.kaaaakbwwbk',
      '.kaaaakbbbbk',
      '.kaaaakbwwbk',
      '.kkkkkkbwwbk',
      '......kbbbbk',
      '......kkkkkk',
      '............',
    ],
  },
  berry: {
    pal: { r: '#ff7a9e', s: '#c23a6b', w: '#ffd3e0', g: '#5fe08a', d: '#2f9a52' },
    rows: [
      '............',
      '.....kkk....',
      '....kgggk...',
      '..kkkgdkkk..',
      '.krrrkkrrrk.',
      'krwwrrrrrrsk',
      'krwrrrrrrrsk',
      'krrrrrrrrrsk',
      'krrrrrrrrssk',
      '.krrrrrrssk.',
      '..kkssssskk.',
      '....kkkkk...',
    ],
  },
  bomb: {
    pal: { b: '#3a3a4a', w: '#8a8aa0', f: '#ffd23f', r: '#ff7b3d' },
    rows: [
      '........r...',
      '.......rfr..',
      '......kfr...',
      '.....kfk....',
      '...kkkkkk...',
      '..kbbbbbbk..',
      '.kbwwbbbbbk.',
      '.kbwbbbbbbk.',
      '.kbbbbbbbbk.',
      '.kbbbbbbbbk.',
      '..kbbbbbbk..',
      '...kkkkkk...',
    ],
  },
  star: {
    pal: { y: '#ffd23f', o: '#c08a10', w: '#fff4b0' },
    rows: [
      '.....kk.....',
      '.....kk.....',
      '....kwyk....',
      '....kyyk....',
      'kkkkwyyykkkk',
      'kwyyyyyyyyok',
      '.kyyyyyyyok.',
      '..kyyyyyyk..',
      '..kyyyoyyk..',
      '.kyok..koyk.',
      '.kok....kok.',
      '.kk......kk.',
    ],
  },
  // Shiny mark: the red star of the games' summary screen, with a sparkle.
  shiny: {
    pal: { y: '#ff4d5e', w: '#ffd0d6', o: '#b8283a', x: '#fff6b0' },
    rows: [
      '.....kk...x.',
      '.....kk..xxx',
      '....kwyk..x.',
      '....kyyk....',
      'kkkkwyyykkkk',
      'kwyyyyyyyyok',
      '.kyyyyyyyok.',
      '..kyyyyyyk..',
      '..kyyyoyyk..',
      '.kyok..koyk.',
      '.kok....kok.',
      '.kk......kk.',
    ],
  },
  crown: {
    pal: { y: '#ffd23f', o: '#c08a10', r: '#ff5f6d' },
    rows: [
      '............',
      '............',
      'k....k....k.',
      'kk..kyk..kk.',
      'kyk.kyk.kyk.',
      'kyykyyykyyk.',
      'kyyyyyyyyyk.',
      'kyyryyyryyk.',
      'kyyyyyyyyyk.',
      'koooooooook.',
      'kkkkkkkkkkk.',
      '............',
    ],
  },
  user: {
    pal: { u: '#b9cbf0', d: '#7f93c0' },
    rows: [
      '............',
      '....kkkk....',
      '...kuuuuk...',
      '...kuuuuk...',
      '...kuuuuk...',
      '....kuuk....',
      '..kkkuukkk..',
      '.kuuuuuuuuk.',
      '.kuuuuuuuuk.',
      '.kdduuuuddk.',
      '.kkkkkkkkkk.',
      '............',
    ],
  },
  cursor: {
    pal: { y: '#ffd23f' },
    rows: [
      'k.......',
      'kk......',
      'kyk.....',
      'kyyk....',
      'kyyyk...',
      'kyyyyk..',
      'kyyyk...',
      'kyyk....',
      'kyk.....',
      'kk......',
      'k.......',
      '........',
    ],
  },
  sound: {
    pal: { w: '#e8eef8' },
    rows: [
      '............',
      '.....kk.....',
      '....kwk..k..',
      '...kwwk...k.',
      'kkkwwwk.k..k',
      'kwwwwwk..k.k',
      'kwwwwwk..k.k',
      'kkkwwwk.k..k',
      '...kwwk...k.',
      '....kwk..k..',
      '.....kk.....',
      '............',
    ],
  },
  mute: {
    pal: { w: '#e8eef8', r: '#ff5f6d' },
    rows: [
      '............',
      '.....kk.....',
      '....kwk.....',
      '...kwwk.....',
      'kkkwwwk.r..r',
      'kwwwwwk..rr.',
      'kwwwwwk..rr.',
      'kkkwwwk.r..r',
      '...kwwk.....',
      '....kwk.....',
      '.....kk.....',
      '............',
    ],
  },
  ticket: {
    pal: { y: '#ffd23f', d: '#c08a10', w: '#fff3b0', r: '#ff5f6d' },
    rows: [
      '............',
      '............',
      'kkkkkkkkkkkk',
      'kwyyydyyyyyk',
      'kyyyyyyrryyk',
      '.kyyydyrryk.',
      '.kyyyyyrryk.',
      'kyyyydyyyyyk',
      'kddddddddddk',
      'kkkkkkkkkkkk',
      '............',
      '............',
    ],
  },
  ticket10: {
    pal: { p: '#c47bff', q: '#8a3fd0', w: '#f0d8ff', y: '#ffd23f' },
    rows: [
      '............',
      '............',
      'kkkkkkkkkkkk',
      'kwpppqppyypk',
      'kppppqpyyypk',
      '.kpppqpyyyk.',
      '.kpppqppyyk.',
      'kppppqpppppk',
      'kqqqqqqqqqqk',
      'kkkkkkkkkkkk',
      '............',
      '............',
    ],
  },
  wsun: {
    pal: { y: '#ffd23f', o: '#ff9a3d' },
    rows: [
      '.....yy.....',
      '..y..yy..y..',
      '...y....y...',
      '....kkkk....',
      'yy.kyyyyk.yy',
      'yy.kyyoyk.yy',
      '...kyooyk...',
      '....kkkk....',
      '...y....y...',
      '..y..yy..y..',
      '.....yy.....',
      '............',
    ],
  },
  wrain: {
    pal: { w: '#e8eef8', g: '#9fb1c9', b: '#4fb4ff' },
    rows: [
      '............',
      '...kkkk.....',
      '..kwwwwkkk..',
      '.kwwwwwwwwk.',
      'kwwwwwwwwwgk',
      'kggggggggggk',
      '.kkkkkkkkkk.',
      '..b...b...b.',
      '.b...b...b..',
      '..b...b...b.',
      '.b...b...b..',
      '............',
    ],
  },
  wsand: {
    pal: { s: '#e0bf73', d: '#9a7a3a' },
    rows: [
      '............',
      '..ssssss....',
      '........ss..',
      'ssssssss..s.',
      '.........s..',
      '..dddddd....',
      '........dd..',
      'dddddd....d.',
      '.........d..',
      '...sssss....',
      '............',
      '............',
    ],
  },
  wsnow: {
    pal: { w: '#ffffff', c: '#9fe0ff' },
    rows: [
      '.....w......',
      '...w.w.w....',
      '....www.....',
      '.w..cwc..w..',
      '..w.cwc.w...',
      'wwwwwwwwwww.',
      '..w.cwc.w...',
      '.w..cwc..w..',
      '....www.....',
      '...w.w.w....',
      '.....w......',
      '............',
    ],
  },
  wfog: {
    pal: { g: '#c9cfdc', d: '#8f98ab' },
    rows: [
      '............',
      '............',
      '..gggggg....',
      '.g......gg..',
      '............',
      '....gggggg..',
      '..dd......d.',
      '............',
      '.ggggggg....',
      'g.......gg..',
      '............',
      '............',
    ],
  },
  // Gacha slot-machine balls (one per rarity).
  ball2: {
    pal: { r: '#3d7bff', s: '#2a56b8', w: '#cfe0ff', b: '#f4f4f4' },
    rows: [
      '....kkkk....',
      '..kkrrrrkk..',
      '.krwrrrrrrk.',
      '.krwrrrrrsk.',
      'krrrrkkrrssk',
      'kkkkkbbkkkkk',
      'kbbbkbbkbbbk',
      'kbbbbkkbbbbk',
      '.kbbbbbbbbk.',
      '.kbbbbbbbbk.',
      '..kkbbbbkk..',
      '....kkkk....',
    ],
  },
  ball3: {
    pal: { r: '#3a3a46', s: '#1d1d26', w: '#ffd23f', b: '#f4f4f4' },
    rows: [
      '....kkkk....',
      '..kkrrrrkk..',
      '.krwrrrrrrk.',
      '.krwrrrrrsk.',
      'krrrrkkrrssk',
      'kkkkkbbkkkkk',
      'kbbbkbbkbbbk',
      'kbbbbkkbbbbk',
      '.kbbbbbbbbk.',
      '.kbbbbbbbbk.',
      '..kkbbbbkk..',
      '....kkkk....',
    ],
  },
  ball4: {
    pal: { r: '#8a3fd0', s: '#5e2a96', w: '#ff8ad8', b: '#f4f4f4' },
    rows: [
      '....kkkk....',
      '..kkrrrrkk..',
      '.krwrrrrrrk.',
      '.krwrrrrrsk.',
      'krrrrkkrrssk',
      'kkkkkbbkkkkk',
      'kbbbkbbkbbbk',
      'kbbbbkkbbbbk',
      '.kbbbbbbbbk.',
      '.kbbbbbbbbk.',
      '..kkbbbbkk..',
      '....kkkk....',
    ],
  },
  ballLux: {
    pal: { r: '#30303a', s: '#18181e', w: '#ff5f6d', b: '#ffd23f' },
    rows: [
      '....kkkk....',
      '..kkrrrrkk..',
      '.krwrrrrrrk.',
      '.krwrrrrrsk.',
      'krrrrkkrrssk',
      'kkkkkbbkkkkk',
      'kbbbkbbkbbbk',
      'kbbbbkkbbbbk',
      '.kbbbbbbbbk.',
      '.kbbbbbbbbk.',
      '..kkbbbbkk..',
      '....kkkk....',
    ],
  },
  // ---------- held items (items.json ids) ----------
  leftovers: {
    pal: { r: '#ff5f6d', d: '#b8283a', w: '#ffd8d8', g: '#5fe08a' },
    rows: [
      '.....kgk....',
      '....kggk....',
      '..kkkkkkkk..',
      '.krwrrrrrrk.',
      'krwrrrrrrrdk',
      'krrrrrrrrrdk',
      'krrrrrrrrrdk',
      'krrrrrrrrddk',
      '.krrrrrrrdk.',
      '..kdrrrrdk..',
      '...kkkkkk...',
      '............',
    ],
  },
  'choice-band': {
    pal: { p: '#ff8ad8', q: '#c04a98', w: '#ffe0f4' },
    rows: [
      '............',
      '............',
      '...kkkkkk...',
      '.kkppwwppkk.',
      'kpp......ppk',
      'kq........qk',
      'kq........qk',
      'kpp......ppk',
      '.kkppppppkk.',
      '...kkkkkk...',
      '............',
      '............',
    ],
  },
  'quick-claw': {
    pal: { y: '#ffd23f', o: '#c08a10', b: '#8a5a2b' },
    rows: [
      '........kk..',
      '.......kyk..',
      '......kyok..',
      '..kk..kyok..',
      '.kyk.kyok...',
      '.kyokyok....',
      '.kyyyok..kk.',
      '.kbbbbk.kyk.',
      'kbbbbbbkyok.',
      'kbbbbbbyok..',
      '.kkkkkkkk...',
      '............',
    ],
  },
  'focus-sash': {
    pal: { o: '#ff9a3d', d: '#c0601a', w: '#ffd0a0' },
    rows: [
      '.kk.........',
      'kook........',
      'kwook.......',
      '.kwook......',
      '..kwook.....',
      '...kwook....',
      '....kwook...',
      '.....kwook..',
      '......kwook.',
      '.......koodk',
      '........kddk',
      '.........kk.',
    ],
  },
  'shell-bell': {
    pal: { p: '#ff9ec4', q: '#c05a88', w: '#ffe0ee', y: '#ffd23f' },
    rows: [
      '.....kk.....',
      '....kyyk....',
      '...kkkkkk...',
      '..kwppppqk..',
      '.kwppppppqk.',
      '.kpppppppqk.',
      'kpppppppppqk',
      'kppqpqpqppqk',
      'kkkkkkkkkkkk',
      '....kyyk....',
      '.....kk.....',
      '............',
    ],
  },
  'amulet-coin': {
    pal: { y: '#ffd23f', o: '#c08a10', w: '#fff3b0', r: '#ff5f6d' },
    rows: [
      '..kk....kk..',
      '..krk..krk..',
      '...krkkrk...',
      '....kkkk....',
      '...kyyyyk...',
      '..kywyyyok..',
      '..kyyooyok..',
      '..kyyooyok..',
      '..kyyyyyok..',
      '...kooook...',
      '....kkkk....',
      '............',
    ],
  },
  'lucky-egg': {
    pal: { w: '#fffaf0', s: '#e0d6c8', r: '#ff5f6d' },
    rows: [
      '....kkkk....',
      '...kwwwwk...',
      '..kwwrwwwk..',
      '..kwwwwwwk..',
      '.kwrwwwwrwk.',
      '.kwwwwwwwwk.',
      '.kwwwrwwwsk.',
      '.kwwwwwwwsk.',
      '.kwrwwwwssk.',
      '..kwwwwssk..',
      '...kkkkkk...',
      '............',
    ],
  },
  'life-orb': {
    pal: { p: '#c04a98', d: '#7a1f5a', w: '#ffb0e0', r: '#ff3048' },
    rows: [
      '....kkkk....',
      '..kkpppdkk..',
      '.kwwpppppdk.',
      '.kwpprrpppk.',
      'kppprrrrppdk',
      'kpprrrrrrpdk',
      'kpprrrrrrpdk',
      'kppprrrrppdk',
      '.kpppprppdk.',
      '.kdpppppddk.',
      '..kkddddkk..',
      '....kkkk....',
    ],
  },
  'choice-scarf': {
    pal: { b: '#4fb4ff', d: '#2a6fb0', w: '#cfe8ff' },
    rows: [
      '............',
      '............',
      'kkkkkkkkkk..',
      'kwbbbbbbbbk.',
      'kbbbbbbbbdk.',
      'kkkkkkkbbdk.',
      '......kbbdk.',
      '......kbbdk.',
      '.....kbbbdk.',
      '.....kbbddk.',
      '.....kkkkkk.',
      '............',
    ],
  },
  'rocky-helmet': {
    pal: { g: '#9aa6b5', d: '#5d6773', w: '#e0e6ee' },
    rows: [
      '............',
      '.k...k...k..',
      'kgk.kgk.kgk.',
      '.kkkkkkkkk..',
      'kwggggggggk.',
      'kwgggggggdk.',
      'kggggggggdk.',
      'kgggkkkkgdk.',
      'kggk....kdk.',
      'kkk......kk.',
      '............',
      '............',
    ],
  },
  'assault-vest': {
    pal: { g: '#4f8a3a', d: '#2f5a22', y: '#ffd23f' },
    rows: [
      '............',
      '.kkk....kkk.',
      'kggk....kggk',
      'kgggkkkkgggk',
      'kgggyggygggk',
      'kgggggggggdk',
      'kggyggggygdk',
      'kgggggggggdk',
      'kgggggggggdk',
      'kddddddddddk',
      'kkkkkkkkkkkk',
      '............',
    ],
  },
  // ---------- achievement medals (bronze, silver, gold) ----------
  medal1: {
    pal: { r: '#ff5f6d', q: '#b8283a', m: '#d08a4a', n: '#8a5226', w: '#ffd0a0', s: '#ffe8c8' },
    rows: MEDAL,
  },
  medal2: {
    pal: { r: '#4fb4ff', q: '#2a6fb0', m: '#c9d2de', n: '#7d8899', w: '#ffffff', s: '#ffffff' },
    rows: MEDAL,
  },
  medal3: {
    pal: { r: '#c47bff', q: '#7a3fb0', m: '#ffd23f', n: '#c08a10', w: '#fff3b0', s: '#fffbe0' },
    rows: MEDAL,
  },
  medalOff: {
    pal: { r: '#3a4870', q: '#2a3458', m: '#3a4870', n: '#2a3458', w: '#4a5a88', s: '#4a5a88' },
    rows: MEDAL,
  },
  trophy: {
    pal: { y: '#ffd23f', d: '#c08a10', w: '#fff3b0' },
    rows: [
      '............',
      '..kkkkkkkk..',
      'kkkwyyyydkkk',
      'k.kwyyyydk.k',
      'k.kwyyyydk.k',
      '.kkwyyyydkk.',
      '...kyyyyk...',
      '....kyyk....',
      '....kyyk....',
      '...kddddk...',
      '..kyyyyyyk..',
      '..kkkkkkkk..',
    ],
  },
  friends: {
    pal: { b: '#4fb4ff', d: '#2a6fb0', g: '#5fe08a', h: '#2f9a52' },
    rows: [
      '............',
      '..kkk..kkk..',
      '.kbbbkkgggk.',
      '.kbbbkkgggk.',
      '..kkk..kkk..',
      '............',
      '.kkkkkkkkkk.',
      'kbbbbkkggggk',
      'kbbbbkkggggk',
      'kddddkkhhhhk',
      'kkkkkkkkkkkk',
      '............',
    ],
  },
  ball: {
    pal: { r: '#ff4d4d', w: '#f4f4f4', s: '#c23a3a' },
    rows: [
      '....kkkk....',
      '..kkrrrrkk..',
      '.krwrrrrrrk.',
      '.krwrrrrrsk.',
      'krrrrkkrrssk',
      'kkkkkwwkkkkk',
      'kwwwkwwkwwwk',
      'kwwwwkkwwwwk',
      '.kwwwwwwwwk.',
      '.kwwwwwwwwk.',
      '..kkwwwwkk..',
      '....kkkk....',
    ],
  },
};
// Palette variants.
UI.starDim = { rows: UI.star!.rows, pal: { y: '#3a4870', o: '#2a3458', w: '#4a5a88' } };

// ---------------- type glyphs (8×8, white on the emblem) ----------------
export const TYPE_GLYPH: Record<string, string[]> = {
  normal: [
    '..####..',
    '.#....#.',
    '#......#',
    '#..##..#',
    '#..##..#',
    '#......#',
    '.#....#.',
    '..####..',
  ],
  fire: [
    '...#....',
    '...##...',
    '..###.#.',
    '.#####..',
    '.######.',
    '##.####.',
    '##..###.',
    '.######.',
  ],
  water: [
    '...##...',
    '...##...',
    '..####..',
    '.######.',
    '.##.###.',
    '.#.####.',
    '.######.',
    '..####..',
  ],
  grass: [
    '.....###',
    '...#####',
    '..######',
    '.####.##',
    '.###.###',
    '.##.####',
    '.#.####.',
    '#.......',
  ],
  electric: [
    '....###.',
    '...###..',
    '..###...',
    '.######.',
    '...###..',
    '..###...',
    '.##.....',
    '#.......',
  ],
  psychic: [
    '.######.',
    '#......#',
    '#.####.#',
    '#.#..#.#',
    '#.#.##.#',
    '#.#....#',
    '#.######',
    '#.......',
  ],
  ice: [
    '...#....',
    '.#.#.#..',
    '..###...',
    '#######.',
    '..###...',
    '.#.#.#..',
    '...#....',
    '........',
  ],
  fighting: [
    '.######.',
    '########',
    '########',
    '#.#.#.##',
    '########',
    '.#######',
    '..#####.',
    '..####..',
  ],
  poison: [
    '.....##.',
    '....####',
    '.....##.',
    '.###....',
    '#####...',
    '#####.##',
    '.###.###',
    '.....##.',
  ],
  ground: [
    '........',
    '...##...',
    '..####..',
    '.##..##.',
    '.######.',
    '##.##.##',
    '########',
    '........',
  ],
  flying: [
    '#.......',
    '##......',
    '###.....',
    '####....',
    '######..',
    '########',
    '.#######',
    '...####.',
  ],
  bug: [
    '.#....#.',
    '..#..#..',
    '..####..',
    '.##.###.',
    '########',
    '###.####',
    '.######.',
    '..####..',
  ],
  rock: [
    '...###..',
    '..#####.',
    '.###.###',
    '######.#',
    '##.#####',
    '#######.',
    '.#####..',
    '........',
  ],
  ghost: [
    '..####..',
    '.######.',
    '##.##.##',
    '##.##.##',
    '########',
    '########',
    '########',
    '#.#..#.#',
  ],
  dragon: [
    '#.......',
    '##....#.',
    '.##..##.',
    '.######.',
    '..####..',
    '.######.',
    '##.##.##',
    '#..##..#',
  ],
  dark: [
    '..####..',
    '.###....',
    '###.....',
    '###.....',
    '###.....',
    '###.....',
    '.###....',
    '..####..',
  ],
  steel: [
    '..####..',
    '.######.',
    '###..###',
    '##....##',
    '##....##',
    '###..###',
    '.######.',
    '..####..',
  ],
  fairy: [
    '...#....',
    '...#....',
    '..###...',
    '#######.',
    '..###...',
    '..#.#...',
    '.#...#..',
    '........',
  ],
};

// Move family badge (5×5).
const KIND_GLYPH: Record<string, string[]> = {
  projectile: ['..#..', '...#.', '#####', '...#.', '..#..'],
  melee: ['....#', '...#.', '..#..', '.#...', '#....'],
  beam: ['.....', '#####', '.....', '#####', '.....'],
  orbit: ['.###.', '#...#', '#...#', '#...#', '.###.'],
  nova: ['#.#.#', '.###.', '#####', '.###.', '#.#.#'],
  aura: ['.###.', '#...#', '#.#.#', '#...#', '.###.'],
  buff: ['..#..', '.###.', '#####', '..#..', '..#..'],
  boomerang: ['####.', '#....', '#....', '#....', '#....'],
  chain: ['##...', '..#..', '...##', '..#..', '##...'],
  mine: ['..#..', '.###.', '##.##', '.###.', '..#..'],
  meteor: ['....#', '...#.', '.##..', '####.', '.##..'],
  turret: ['.###.', '.#.#.', '.###.', '..#..', '#####'],
  dash: ['#.#..', '.#.#.', '..#.#', '.#.#.', '#.#..'],
  trail: ['#....', '.....', '..#..', '.....', '....#'],
  cone: ['....#', '..###', '#####', '..###', '....#'],
};
// ---------------- render ----------------

const cache = new Map<string, HTMLCanvasElement>();
const urls = new Map<string, string>();

let typeColors: ReadonlyMap<string, string> | null = null;
/** Each type's colour (types.json). */
export function typeColor(type: string): string {
  typeColors ??= new Map(loadGameData().types.types.map((t) => [t.id, t.color]));
  return typeColors.get(type) ?? '#b0a99f';
}

function shade(hex: string, k: number): string {
  const n = parseInt(hex.slice(1), 16);
  const f = (c: number) => Math.max(0, Math.min(255, Math.round(c * k)));
  return (
    '#' +
    [f((n >> 16) & 255), f((n >> 8) & 255), f(n & 255)]
      .map((v) => v.toString(16).padStart(2, '0'))
      .join('')
  );
}

function newCanvas(w: number, h: number): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const cv = document.createElement('canvas');
  cv.width = w;
  cv.height = h;
  const c = cv.getContext('2d', { willReadFrequently: true });
  if (!c) throw new Error('Canvas 2D is not available');
  return [cv, c];
}

function fromRows(def: IconDef): HTMLCanvasElement {
  const h = def.rows.length;
  const w = Math.max(...def.rows.map((r) => r.length));
  const pad = def.outline ? 1 : 0;
  const [cv, c] = newCanvas(w + pad * 2, h + pad * 2);
  const pal: Record<string, string> = { k: K, ...def.pal };
  if (def.outline) {
    c.fillStyle = K;
    def.rows.forEach((row, y) =>
      [...row].forEach((ch, x) => {
        if (ch === '.' || ch === ' ') return;
        for (const [dx, dy] of [
          [1, 0],
          [-1, 0],
          [0, 1],
          [0, -1],
        ] as const)
          c.fillRect(x + pad + dx, y + pad + dy, 1, 1);
      }),
    );
  }
  def.rows.forEach((row, y) =>
    [...row].forEach((ch, x) => {
      const col = pal[ch];
      if (ch === '.' || ch === ' ' || !col) return;
      c.fillStyle = col;
      c.fillRect(x + pad, y + pad, 1, 1);
    }),
  );
  return cv;
}

/** A type's round emblem (16×16), with an optional move-family badge. */
function emblem(type: string, kind?: string | null): HTMLCanvasElement {
  const S = 16;
  const [cv, c] = newCanvas(S, S);
  const col = typeColor(type);
  const dark = shade(col, 0.55);
  const lite = shade(col, 1.3);
  // Disc with an outline, shadow bottom-right and highlight top-left.
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const d = Math.hypot(x - 7.5, y - 7.5);
      if (d > 7.6) continue;
      let f = col;
      if (d > 6.6) f = K;
      else if (x - 7.5 + (y - 7.5) > 6) f = dark;
      else if (x - 7.5 + (y - 7.5) < -6.5) f = lite;
      c.fillStyle = f;
      c.fillRect(x, y, 1, 1);
    }
  }
  const g = TYPE_GLYPH[type] ?? TYPE_GLYPH.normal ?? [];
  c.fillStyle = dark;
  g.forEach((row, y) =>
    [...row].forEach((ch, x) => {
      if (ch === '#') c.fillRect(x + 5, y + 5, 1, 1);
    }),
  );
  c.fillStyle = '#ffffff';
  g.forEach((row, y) =>
    [...row].forEach((ch, x) => {
      if (ch === '#') c.fillRect(x + 4, y + 4, 1, 1);
    }),
  );
  const badge = kind ? KIND_GLYPH[kind] : undefined;
  if (badge) {
    c.fillStyle = K;
    c.fillRect(9, 9, 7, 7);
    c.fillStyle = '#2b3454';
    c.fillRect(10, 10, 5, 5);
    c.fillStyle = '#ffd23f';
    badge.forEach((row, y) =>
      [...row].forEach((ch, x) => {
        if (ch === '#') c.fillRect(x + 10, y + 10, 1, 1);
      }),
    );
  }
  return cv;
}

/** The icon at 1× (cached). Unknown names draw a star. */
export function iconCanvas(name: string): HTMLCanvasElement {
  let cv = cache.get(name);
  if (cv) return cv;
  if (name.startsWith('move:')) {
    const m = loadGameData().moveById.get(name.slice(5));
    cv = emblem(m ? m.type : 'normal', m ? m.kind : null);
  } else if (name.startsWith('type:')) {
    cv = emblem(name.slice(5));
  } else {
    cv = fromRows(UI[name] ?? (UI.star as IconDef));
  }
  cache.set(name, cv);
  return cv;
}

/** Is there a drawn icon with this name (items, interface icons)? */
export const hasIcon = (name: string): boolean =>
  name.startsWith('move:') || name.startsWith('type:') || name in UI;

function svgDoc(w: number, h: number, rects: string): string {
  return (
    'data:image/svg+xml,' +
    encodeURIComponent(
      `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" shape-rendering="crispEdges">${rects}</svg>`,
    )
  );
}

/** The canvas as SVG text, one rect per run of equal pixels (cheaper than toDataURL). */
function svgOf(cv: HTMLCanvasElement): string {
  const w = cv.width;
  const h = cv.height;
  const ctx = cv.getContext('2d', { willReadFrequently: true });
  if (!ctx) return svgDoc(w, h, '');
  const d = ctx.getImageData(0, 0, w, h).data;
  let out = '';
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w;) {
      const i = (y * w + x) * 4;
      const a = d[i + 3] ?? 0;
      if (!a) {
        x++;
        continue;
      }
      let n = 1;
      while (
        x + n < w &&
        d[i + n * 4] === d[i] &&
        d[i + n * 4 + 1] === d[i + 1] &&
        d[i + n * 4 + 2] === d[i + 2] &&
        d[i + n * 4 + 3] === a
      )
        n++;
      const hex =
        '#' +
        ((1 << 24) | ((d[i] ?? 0) << 16) | ((d[i + 1] ?? 0) << 8) | (d[i + 2] ?? 0))
          .toString(16)
          .slice(1);
      out += `<rect x="${x}" y="${y}" width="${n}" height="1" fill="${hex}"${a < 255 ? ` fill-opacity="${(a / 255).toFixed(3)}"` : ''}/>`;
      x += n;
    }
  }
  return svgDoc(w, h, out);
}

/** The icon as an SVG data URL (for `<img>` and CSS). */
export function iconUrl(name: string): string {
  let u = urls.get(name);
  if (!u) {
    u = svgOf(iconCanvas(name));
    urls.set(name, u);
  }
  return u;
}

/** The size rounded to a whole multiple of the icon's resolution (no uneven pixels). */
function snapSize(name: string, size: number): number {
  const w = iconCanvas(name).width;
  return w * Math.max(1, Math.round(size / w));
}

/** A pixelated `<img>` element. */
export function iconImg(name: string, size = 20): HTMLImageElement {
  const cv = iconCanvas(name);
  const w = snapSize(name, size);
  const img = document.createElement('img');
  img.className = 'pix';
  img.src = iconUrl(name);
  img.width = w;
  img.height = (w * cv.height) / cv.width;
  img.alt = '';
  img.draggable = false;
  img.style.imageRendering = 'pixelated';
  return img;
}

/** Draws the icon in a `size` box at (x, y), snapped to a whole multiple of its resolution. */
export function drawIcon(
  ctx: CanvasRenderingContext2D,
  name: string,
  x: number,
  y: number,
  size: number,
  /**
   * Snap to whole device pixels under the canvas's current transform (the HUD, which is scaled):
   * every icon pixel is the same number of screen pixels at any scale or pixel ratio.
   */
  devicePixels = false,
): void {
  const cv = iconCanvas(name);
  const prev = ctx.imageSmoothingEnabled;
  ctx.imageSmoothingEnabled = false;
  if (devicePixels) {
    const m = ctx.getTransform();
    const k = Math.hypot(m.a, m.b) || 1;
    // The size on screen, a whole multiple of the icon's resolution, back in drawing units.
    const s2 = snapSize(name, size * k) / k;
    const at = (v: number, offset: number) =>
      (Math.round((v + (size - s2) / 2) * k + offset) - offset) / k;
    ctx.drawImage(cv, at(x, m.e), at(y, m.f), s2, (s2 * cv.height) / cv.width);
  } else {
    const s2 = snapSize(name, size);
    x += (size - s2) / 2;
    y += (size - s2) / 2;
    ctx.drawImage(cv, Math.round(x), Math.round(y), s2, (s2 * cv.height) / cv.width);
  }
  ctx.imageSmoothingEnabled = prev;
}

/**
 * The shiny sparkle, pixel by pixel: a cross that grows, sprouts diagonal tips and fades, as in
 * the games. `phase` 0–1, `px` the pixel size.
 */
export function drawTwinkle(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  phase: number,
  px = 2,
): void {
  const st = phase < 0.15 ? 0 : phase < 0.32 ? 1 : phase < 0.62 ? 2 : phase < 0.82 ? 1 : 0;
  const X = Math.round(x / px) * px;
  const Y = Math.round(y / px) * px;
  const dot = (dx: number, dy: number, c: string) => {
    ctx.fillStyle = c;
    ctx.fillRect(X + dx * px, Y + dy * px, px, px);
  };
  const ARM = '#fff3a8';
  const TIP = '#9ae6ff';
  dot(0, 0, '#ffffff');
  if (st >= 1)
    for (const [dx, dy] of [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
    ] as const)
      dot(dx, dy, ARM);
  if (st >= 2) {
    for (const [dx, dy] of [
      [2, 0],
      [-2, 0],
      [0, 2],
      [0, -2],
    ] as const)
      dot(dx, dy, ARM);
    for (const [dx, dy] of [
      [3, 0],
      [-3, 0],
      [0, 3],
      [0, -3],
      [1, 1],
      [-1, 1],
      [1, -1],
      [-1, -1],
    ] as const)
      dot(dx, dy, TIP);
  }
}
