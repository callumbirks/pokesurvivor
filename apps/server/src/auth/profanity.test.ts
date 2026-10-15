import { loadGameData } from '@pokesurvivor/data';
import { describe, expect, it } from 'vitest';
import { isOffensiveUsername } from './profanity.js';

function blocked(names: string[]): void {
  for (const name of names) expect(isOffensiveUsername(name), name).toBe(true);
}

function allowed(names: string[]): void {
  for (const name of names) expect(isOffensiveUsername(name), name).toBe(false);
}

describe('isOffensiveUsername', () => {
  it('blocks plain offensive words, inside longer names too', () => {
    blocked(['fuck', 'shit', 'cunt', 'nigger', 'nigga', 'whore', 'Hitler', 'nazi', 'pedo']);
    blocked(['xXfuckerXx', 'Big_Shit_99', 'KillAllNiggers', 'my_sex']);
  });

  it('folds case', () => {
    blocked(['FUCK', 'FuCk', 'sHiT', 'NiGgEr', 'hItLeR']);
  });

  it('resolves number and symbol swaps', () => {
    blocked(['f4ck', 'sh1t', '5hit', 'b1tch', 'n1gger', 'n199er', 'c0ck', 'assh0le', 'wh0re']);
    blocked(['s1ut', 'f4gg0t', 'r4pe', 'pen1s', 'd1ck', 'p3d0', 'H1tl3r', 'k1ke', '7wat']);
    // Usernames can't contain these, but the matcher handles them anyway.
    blocked(['$hit', 'a$$hole', 'b!tch', '@ss']);
  });

  it('strips separators', () => {
    blocked(['f_u_c_k', 'n_i_g_g_e_r', 's_h_i_t', 'c__u__n__t', 'sl_ut', 'Hit_ler']);
    blocked(['f-u-c-k', 'n.i.g.g.a', 'f u c k', 's.h-i_t', 'f*u*c*k']);
  });

  it('collapses repeated letters', () => {
    blocked(['fuuuuck', 'fffuck', 'shiiiit', 'niggggger', 'cuuuunt', 'whoooore']);
  });

  it('catches combinations', () => {
    blocked(['n-1_g', 'n-1_g_g_a', 'N1_gg3r', 'F_u_U_u_C_k', 'Sh_1_1_t', 'n_1_9_9_3_r', 'P_3_D_0']);
    blocked(['xX_f4_Gg_0t_Xx', 'C_0_C_K', 'Wh_0_0_r3']);
  });

  it('allows names that only look like they contain a listed word', () => {
    allowed(['Scunthorpe', 'assassin', 'Cockburn', 'Dickson', 'Dickinson', 'Penistone']);
    allowed(['Shiitake', 'Snigger', 'Niger', 'Nigel', 'Sussex', 'Bassoon', 'Cumulus', 'Analyst']);
    allowed(['Therapist', 'Grape', 'Cockatoo', 'Peacock', 'Hancock', 'Passport', 'Classic']);
    allowed(['Assault', 'Document', 'Arsenal', 'Titan', 'Titmouse', 'Japan', 'Torpedo']);
  });

  it('allows ordinary gamer tags', () => {
    allowed(['xX_Sniper_Xx', 'Ash_Ketchum', 'Pro_Gamer99', 'Mewtwo150', 'Red_2024', 'Gary_Oak']);
    allowed(['TrainerBlue', 'MistyWater', 'SpeedRunner_1', 'l33t_h4x0r', 'NoobMaster69', 'Ninja']);
  });

  it('allows every Pokémon name', () => {
    for (const { name, id } of loadGameData().pokedex) {
      expect(isOffensiveUsername(name), name).toBe(false);
      expect(isOffensiveUsername(id), id).toBe(false);
    }
    allowed(['Kakuna', 'Shellder', 'Dugtrio', 'Cofagrigus', 'Spoink', 'Rapidash', 'Sharpedo']);
    allowed(['Skuntank', 'Hoothoot', 'Seaking', 'Kingler', 'Dewgong', 'Butterfree', 'Shuckle']);
  });
});
