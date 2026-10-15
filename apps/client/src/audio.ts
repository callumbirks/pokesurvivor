// Synth, sequencer and sound effects (port of original implementation): everything is generated with
// Web Audio at play time, no files. Shared by the game and the menus.
//
//   audio.music('village')   switch song with a crossfade (music.json); null = silence
//   audio.sfx('coin')        a sound effect (rate-limited per effect)
//
// Volumes come from the settings store. Browsers allow sound only after the first click or key,
// so the context is created then, and the song that was asked for starts.
import { loadGameData, type MusicFile } from '@pokesurvivor/data';
import { settings, volumeOf } from './settings.js';

type Song = MusicFile[string];
type Bus = AudioNode;

interface NoteEvent {
  inst: string;
  f: number;
  len: number;
  v: number;
  drum?: false;
}
interface DrumEvent {
  inst: string;
  drum: true;
  v: number;
}
interface Compiled {
  steps: number;
  ev: (NoteEvent | DrumEvent)[][];
  bpm: number;
  swing: number;
}

export type SfxName =
  | 'hover'
  | 'click'
  | 'back'
  | 'confirm'
  | 'select'
  | 'error'
  | 'shot'
  | 'hit'
  | 'faint'
  | 'mateDown'
  | 'bossDown'
  | 'xp'
  | 'coin'
  | 'heal'
  | 'revived'
  | 'levelup'
  | 'hurt'
  | 'boss'
  | 'surge'
  | 'shiny'
  | 'shinyGet'
  | 'break'
  | 'chest'
  | 'grass'
  | 'ball'
  | 'shake'
  | 'burst'
  | 'reveal'
  | 'rift'
  | 'legend'
  | 'gameover'
  | 'biome'
  | 'pause'
  | 'buy';

export interface SfxOptions {
  /** `shot`: the move family and type (pitch). */
  kind?: string;
  type?: string;
  /** `burst` / `reveal`: gacha rarity 1–5. */
  rarity?: number;
}

const SHOT_PITCH: Record<string, number> = {
  fire: 520,
  water: 700,
  electric: 1100,
  psychic: 800,
  grass: 640,
  ice: 900,
  poison: 400,
  ghost: 350,
  dragon: 300,
  fairy: 1200,
  normal: 600,
  fighting: 450,
  rock: 260,
  ground: 240,
  steel: 750,
  bug: 980,
  dark: 330,
  flying: 820,
};

/** Minimum gap between repeats of the same effect (ms). */
const MIN_GAP: Partial<Record<SfxName, number>> = {
  hit: 45,
  faint: 60,
  mateDown: 1500,
  xp: 35,
  coin: 50,
  grass: 70,
  shot: 70,
  hover: 40,
  break: 60,
};

const NOTE: Record<string, number> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
const midiFreq = (m: number) => 440 * Math.pow(2, (m - 69) / 12);

function midiOf(name: string): number | null {
  const m = /^([A-G])(#|b)?(-?\d)$/.exec(name);
  if (!m) return null;
  const [, l = 'C', acc, oct = '4'] = m;
  return 12 * (Number(oct) + 1) + (NOTE[l] ?? 0) + (acc === '#' ? 1 : acc === 'b' ? -1 : 0);
}

/** Chord "F", "Dm", "C/E", "F#m"… → root and bass pitch classes, minor. */
function parseChord(c: string): { root: number; minor: boolean; bass: number } {
  const m = /^([A-G])(#|b)?(m?)(?:\/([A-G])(#|b)?)?$/.exec(c);
  const pc = (l: string, a?: string) =>
    ((NOTE[l] ?? 0) + (a === '#' ? 1 : a === 'b' ? -1 : 0) + 12) % 12;
  if (!m) return { root: 0, minor: false, bass: 0 };
  const root = pc(m[1] ?? 'C', m[2]);
  return { root, minor: m[3] === 'm', bass: m[4] ? pc(m[4], m[5]) : root };
}

/**
 * A song to events per step (sixteenth note). Melodies: "A4:4 C5:2 -:2" (note:length in steps).
 * Bass and arpeggios come from the chords with 16-character patterns.
 */
function compile(song: Song): Compiled {
  const bars = song.chords.length;
  const steps = bars * 16;
  const ev: (NoteEvent | DrumEvent)[][] = Array.from({ length: steps }, () => []);
  for (const tr of song.melody ?? []) {
    tr.bars.forEach((bar, bi) => {
      let s = 0;
      for (const tok of bar.trim().split(/\s+/)) {
        const [n = '-', len] = tok.split(':');
        const L = Number(len) || 1;
        const midi = n === '-' ? null : midiOf(n);
        if (midi !== null)
          ev[(bi * 16 + s) % steps]?.push({
            inst: tr.instrument,
            f: midiFreq(midi),
            len: L,
            v: tr.velocity ?? 1,
          });
        s += L;
      }
    });
  }
  const chords = song.chords.map(parseChord);
  const chordTone = (ch: { root: number; minor: boolean }, i: number, base: number) => {
    const third = ch.minor ? 3 : 4;
    const iv = [0, third, 7, 12, 12 + third, 19][i] ?? 0;
    return base + ch.root + iv;
  };
  for (let b = 0; b < bars; b++) {
    const ch = chords[b % chords.length] ?? { root: 0, minor: false, bass: 0 };
    for (const tr of song.parts ?? []) {
      const pat = tr.pattern;
      const base = 12 * (tr.octave + 1);
      for (let s = 0; s < 16; s++) {
        const c = pat[s];
        if (!c || c === '.' || c === '-') continue;
        let len = 1;
        while (s + len < 16 && pat[s + len] === '-') len++;
        const at = ev[b * 16 + s];
        if (!at) continue;
        const push = (midi: number) =>
          at.push({ inst: tr.instrument, f: midiFreq(midi), len, v: tr.velocity ?? 1 });
        if (c === 'R') push(base + (tr.useBass ? ch.bass : ch.root));
        else if (c === 'F') push(base + ch.root + 7);
        else if (c === 'O') push(base + ch.root + 12);
        else if (c === 'T') push(base + ch.root + (ch.minor ? 3 : 4));
        else if (c === 'C') for (let i = 0; i < 3; i++) push(chordTone(ch, i, base));
        else push(chordTone(ch, Number(c), base));
      }
    }
    for (const [inst, pat] of Object.entries(song.drums ?? {})) {
      for (let s = 0; s < 16; s++) {
        const c = pat[s];
        if (c && c !== '.')
          ev[b * 16 + s]?.push({ inst, drum: true, v: c === 'X' ? 1 : c === 'x' ? 0.75 : 0.45 });
      }
    }
  }
  return { steps, ev, bpm: song.bpm, swing: song.swing ?? 0 };
}

class AudioEngine {
  private ctx: AudioContext | null = null;
  private master!: DynamicsCompressorNode;
  private musicBus!: GainNode;
  private sfxBus!: GainNode;
  private reverb!: ConvolverNode;
  private noiseBuf!: AudioBuffer;
  private wanted: string | null = null;
  private current: {
    name: string;
    song: Compiled;
    bus: GainNode;
    step: number;
    next: number;
  } | null = null;
  private readonly compiled = new Map<string, Compiled>();
  private readonly last = new Map<string, number>();
  private voices = 0;
  private xpCombo = 0;
  private xpT = 0;

  constructor() {
    if (typeof window === 'undefined') return;
    // On phones a touch's pointerdown doesn't count as a gesture for sound: pointerup and
    // touchend do. Listen to all of them.
    for (const ev of ['pointerdown', 'pointerup', 'touchend', 'keydown'])
      addEventListener(ev, () => this.unlock(), { capture: true });
    settings.subscribe(() => this.applyVolumes());
    // The scheduler: plays 150 ms ahead.
    setInterval(() => this.schedule(), 25);
  }

  private init(): boolean {
    if (this.ctx) return true;
    const AC =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AC) return false;
    const ctx = (this.ctx = new AC());
    this.master = ctx.createDynamicsCompressor();
    this.master.threshold.value = -14;
    this.master.ratio.value = 4;
    const out = ctx.createGain();
    out.gain.value = 0.9;
    this.master.connect(out).connect(ctx.destination);
    this.musicBus = ctx.createGain();
    this.sfxBus = ctx.createGain();
    this.musicBus.connect(this.master);
    this.sfxBus.connect(this.master);
    // Reverb: a generated impulse response (noise decaying over 1.8 s), filled in chunks a moment
    // later so it doesn't block. Until then the music has no echo.
    this.reverb = ctx.createConvolver();
    const len = Math.floor(ctx.sampleRate * 1.8);
    const ir = ctx.createBuffer(2, len, ctx.sampleRate);
    let ch = 0;
    const fill = () => {
      const d = ir.getChannelData(ch);
      for (let i = 0; i < len; i++) {
        const g = 1 - i / len;
        d[i] = (Math.random() * 2 - 1) * g * g * Math.sqrt(g);
      }
      if (++ch < 2) setTimeout(fill, 30);
      else this.reverb.buffer = ir;
    };
    setTimeout(fill, 300);
    const wet = ctx.createGain();
    wet.gain.value = 0.3;
    this.reverb.connect(wet).connect(this.musicBus);
    this.noiseBuf = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
    const nd = this.noiseBuf.getChannelData(0);
    for (let i = 0; i < nd.length; i++) nd[i] = Math.random() * 2 - 1;
    this.applyVolumes();
    return true;
  }

  /** Call from a user gesture (done automatically on clicks, taps and keys). */
  unlock(): void {
    if (!this.init() || !this.ctx) return;
    // 'suspended' or 'interrupted' (iPhone back from another app): resume.
    if (this.ctx.state !== 'running') this.ctx.resume().catch(() => {});
    if (this.wanted && !this.current) this.startSong(this.wanted);
  }

  /** Can it play sound yet (the browser allows it only after a gesture, mostly)? */
  get running(): boolean {
    return !!this.ctx && this.ctx.state === 'running';
  }

  get track(): string | null {
    return this.current?.name ?? null;
  }

  private applyVolumes(): void {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    this.musicBus.gain.setTargetAtTime(volumeOf('music') * 0.7, t, 0.05);
    // Effects are generated quietly: ×2.4 matches them to the music (measured).
    this.sfxBus.gain.setTargetAtTime(volumeOf('sfx') * 2.4, t, 0.05);
  }

  // ---------------------------------------------------------------- building blocks

  private osc(type: OscillatorType, f: number, t: number, end: number, dest: AudioNode) {
    const o = this.ctx!.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(f, t);
    o.connect(dest);
    o.start(t);
    o.stop(end + 0.05);
    return o;
  }

  private gainEnv(
    dest: AudioNode,
    t: number,
    a: number,
    peak: number,
    dur: number,
    rel: number,
    sus = 0.7,
  ) {
    const g = this.ctx!.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(peak, t + a);
    g.gain.setTargetAtTime(peak * sus, t + a, Math.max(0.02, dur * 0.4));
    g.gain.setTargetAtTime(0.0001, t + dur, rel / 3);
    g.connect(dest);
    return g;
  }

  private noise(t: number, dur: number, dest: AudioNode) {
    const s = this.ctx!.createBufferSource();
    s.buffer = this.noiseBuf;
    s.connect(dest);
    s.start(t, Math.random() * 0.5);
    s.stop(t + dur + 0.05);
    return s;
  }

  private filt(type: BiquadFilterType, f: number, q: number, dest: AudioNode) {
    const b = this.ctx!.createBiquadFilter();
    b.type = type;
    b.frequency.value = f;
    b.Q.value = q;
    b.connect(dest);
    return b;
  }

  private send(node: AudioNode, amount: number) {
    const s = this.ctx!.createGain();
    s.gain.value = amount;
    node.connect(s).connect(this.reverb);
  }

  // ---------------------------------------------------------------- instruments

  private note(inst: string, t: number, f: number, d: number, v: number, bus: Bus): void {
    const ctx = this.ctx!;
    switch (inst) {
      case 'flute': {
        const lp = this.filt('lowpass', 3600, 0.5, bus);
        const g = this.gainEnv(lp, t, 0.045, 0.2 * v, d, 0.14, 0.82);
        this.send(g, 0.35);
        const o1 = this.osc('triangle', f, t, t + d + 0.3, g);
        const g2 = ctx.createGain();
        g2.gain.value = 0.18;
        g2.connect(g);
        const o2 = this.osc('sine', f * 2, t, t + d + 0.3, g2);
        // Vibrato that comes in slowly, like a flautist.
        const lfo = ctx.createOscillator();
        lfo.frequency.value = 5.3;
        const lg = ctx.createGain();
        lg.gain.setValueAtTime(0, t);
        lg.gain.linearRampToValueAtTime(f * 0.007, t + Math.min(0.35, d));
        lfo.connect(lg);
        lg.connect(o1.frequency);
        lg.connect(o2.frequency);
        lfo.start(t);
        lfo.stop(t + d + 0.35);
        // Breath on the attack.
        const bp = this.filt('bandpass', f * 2.2, 2, g);
        const ng = ctx.createGain();
        ng.gain.setValueAtTime(0.25, t);
        ng.gain.exponentialRampToValueAtTime(0.001, t + 0.08);
        ng.connect(bp);
        this.noise(t, 0.09, ng);
        return;
      }
      case 'bell': {
        const g = ctx.createGain();
        g.connect(bus);
        this.send(g, 0.3);
        g.gain.setValueAtTime(0.0001, t);
        g.gain.linearRampToValueAtTime(0.22 * v, t + 0.004);
        g.gain.exponentialRampToValueAtTime(0.0008, t + Math.min(d, 0.45) + 0.45);
        this.osc('sine', f, t, t + 1, g);
        const g2 = ctx.createGain();
        g2.connect(g);
        g2.gain.setValueAtTime(0.35, t);
        g2.gain.exponentialRampToValueAtTime(0.001, t + 0.09);
        this.osc('sine', f * 4, t, t + 0.12, g2);
        return;
      }
      case 'pluck': {
        const lp = ctx.createBiquadFilter();
        lp.type = 'lowpass';
        lp.Q.value = 2;
        lp.frequency.setValueAtTime(3200, t);
        lp.frequency.exponentialRampToValueAtTime(Math.max(300, f * 1.8), t + 0.22);
        const g = ctx.createGain();
        g.connect(bus);
        this.send(g, 0.2);
        g.gain.setValueAtTime(0.0001, t);
        g.gain.linearRampToValueAtTime(0.11 * v, t + 0.005);
        g.gain.exponentialRampToValueAtTime(0.0008, t + Math.min(d, 0.35) + 0.25);
        lp.connect(g);
        this.osc('sawtooth', f, t, t + 0.7, lp);
        return;
      }
      case 'bass': {
        const lp = this.filt('lowpass', 900, 0.7, bus);
        const g = this.gainEnv(lp, t, 0.008, 0.34 * v, d * 0.9, 0.08, 0.65);
        this.osc('triangle', f, t, t + d + 0.2, g);
        const g2 = ctx.createGain();
        g2.gain.value = 0.25;
        g2.connect(g);
        this.osc('square', f, t, t + d + 0.2, g2);
        return;
      }
      case 'pad': {
        const lp = this.filt('lowpass', 1100, 0.6, bus);
        const g = this.gainEnv(lp, t, 0.35, 0.05 * v, d, 0.7, 0.9);
        this.send(g, 0.5);
        this.osc('sawtooth', f * 1.004, t, t + d + 1, g);
        this.osc('sawtooth', f * 0.996, t, t + d + 1, g);
        return;
      }
      case 'lead': {
        const lp = this.filt('lowpass', 2600, 1, bus);
        const g = this.gainEnv(lp, t, 0.01, 0.075 * v, d, 0.08, 0.75);
        this.send(g, 0.2);
        const o1 = this.osc('square', f, t, t + d + 0.2, g);
        const o2 = this.osc('square', f * 1.006, t, t + d + 0.2, g);
        const lfo = ctx.createOscillator();
        lfo.frequency.value = 6;
        const lg = ctx.createGain();
        lg.gain.setValueAtTime(0, t);
        lg.gain.linearRampToValueAtTime(f * 0.008, t + 0.2);
        lfo.connect(lg);
        lg.connect(o1.frequency);
        lg.connect(o2.frequency);
        lfo.start(t);
        lfo.stop(t + d + 0.25);
        return;
      }
    }
  }

  private drum(inst: string, t: number, v: number, bus: Bus): void {
    const ctx = this.ctx!;
    switch (inst) {
      case 'kick': {
        const g = ctx.createGain();
        g.connect(bus);
        g.gain.setValueAtTime(0.55 * v, t);
        g.gain.exponentialRampToValueAtTime(0.001, t + 0.22);
        const o = this.osc('sine', 150, t, t + 0.25, g);
        o.frequency.exponentialRampToValueAtTime(42, t + 0.13);
        return;
      }
      case 'snare': {
        const hp = this.filt('highpass', 1300, 0.7, bus);
        const g = ctx.createGain();
        g.connect(hp);
        this.send(g, 0.15);
        g.gain.setValueAtTime(0.22 * v, t);
        g.gain.exponentialRampToValueAtTime(0.001, t + 0.13);
        this.noise(t, 0.15, g);
        const g2 = ctx.createGain();
        g2.connect(bus);
        g2.gain.setValueAtTime(0.12 * v, t);
        g2.gain.exponentialRampToValueAtTime(0.001, t + 0.08);
        this.osc('triangle', 190, t, t + 0.1, g2);
        return;
      }
      case 'hat': {
        const hp = this.filt('highpass', 7500, 0.7, bus);
        const g = ctx.createGain();
        g.connect(hp);
        g.gain.setValueAtTime(0.08 * v, t);
        g.gain.exponentialRampToValueAtTime(0.001, t + 0.045);
        this.noise(t, 0.05, g);
        return;
      }
      case 'shaker': {
        const bp = this.filt('bandpass', 5200, 1.2, bus);
        const g = ctx.createGain();
        g.connect(bp);
        g.gain.setValueAtTime(0.0001, t);
        g.gain.linearRampToValueAtTime(0.07 * v, t + 0.012);
        g.gain.exponentialRampToValueAtTime(0.001, t + 0.07);
        this.noise(t, 0.08, g);
        return;
      }
    }
  }

  // ---------------------------------------------------------------- music

  private startSong(name: string): void {
    const ctx = this.ctx;
    const data = loadGameData().music[name];
    if (!ctx || !data) return;
    let song = this.compiled.get(name);
    if (!song) this.compiled.set(name, (song = compile(data)));
    const bus = ctx.createGain();
    bus.gain.setValueAtTime(0.0001, ctx.currentTime);
    bus.gain.linearRampToValueAtTime(1, ctx.currentTime + 0.8);
    bus.connect(this.musicBus);
    this.current = { name, song, bus, step: 0, next: ctx.currentTime + 0.1 };
  }

  private stopCurrent(): void {
    const ctx = this.ctx;
    if (!this.current || !ctx) return;
    const b = this.current.bus;
    b.gain.cancelScheduledValues(ctx.currentTime);
    b.gain.setValueAtTime(b.gain.value, ctx.currentTime);
    b.gain.linearRampToValueAtTime(0.0001, ctx.currentTime + 0.7);
    setTimeout(() => b.disconnect(), 900);
    this.current = null;
  }

  /** Switches song (with a fade). null: silence. */
  music(name: string | null): void {
    if (this.wanted === name) return;
    this.wanted = name;
    if (!this.ctx) return; // starts on the first gesture
    this.stopCurrent();
    if (name) this.startSong(name);
  }

  private schedule(): void {
    const ctx = this.ctx;
    const c = this.current;
    if (!ctx || !c || ctx.state !== 'running') return;
    const sd = 60 / c.song.bpm / 4;
    while (c.next < ctx.currentTime + 0.15) {
      const i = c.step % c.song.steps;
      // Swing: off-beat eighths come a little late.
      const t = c.next + (i % 4 === 2 ? c.song.swing * sd : 0);
      for (const e of c.song.ev[i] ?? []) {
        if (e.drum) this.drum(e.inst, t, e.v, c.bus);
        else this.note(e.inst, t, e.f, e.len * sd, e.v, c.bus);
      }
      c.next += sd;
      c.step++;
    }
  }

  // ---------------------------------------------------------------- effects

  private tone(type: OscillatorType, f0: number, f1: number, dur: number, vol: number, at = 0) {
    const ctx = this.ctx!;
    const t = ctx.currentTime + at;
    const g = ctx.createGain();
    g.connect(this.sfxBus);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(vol, t + 0.006);
    g.gain.exponentialRampToValueAtTime(0.0005, t + dur);
    const o = this.osc(type, f0, t, t + dur, g);
    if (f1 && f1 !== f0) o.frequency.exponentialRampToValueAtTime(f1, t + dur);
  }

  private hiss(
    dur: number,
    vol: number,
    type: BiquadFilterType,
    f0: number,
    f1?: number,
    at = 0,
    q = 1,
  ) {
    const ctx = this.ctx!;
    const t = ctx.currentTime + at;
    const b = ctx.createBiquadFilter();
    b.type = type;
    b.Q.value = q;
    b.frequency.setValueAtTime(f0, t);
    if (f1) b.frequency.exponentialRampToValueAtTime(f1, t + dur);
    const g = ctx.createGain();
    b.connect(g);
    g.connect(this.sfxBus);
    g.gain.setValueAtTime(vol, t);
    g.gain.exponentialRampToValueAtTime(0.0005, t + dur);
    this.noise(t, dur, b);
  }

  private arp(type: OscillatorType, freqs: number[], gap: number, dur: number, vol: number) {
    freqs.forEach((f, i) => this.tone(type, f, f, dur, vol, i * gap));
  }

  private bells(freqs: number[], gap: number) {
    const now = this.ctx!.currentTime;
    freqs.forEach((f, i) => this.note('bell', now + i * gap, f, 0.3, 0.8, this.sfxBus));
  }

  private play(name: SfxName, o: SfxOptions): void {
    const ctx = this.ctx!;
    switch (name) {
      case 'hover':
        return this.tone('square', 1400, 1400, 0.025, 0.025);
      case 'click':
        return this.tone('square', 660, 990, 0.05, 0.06);
      case 'back':
        return this.tone('square', 880, 520, 0.07, 0.05);
      case 'confirm':
        return this.arp('triangle', [784, 988, 1319], 0.05, 0.12, 0.09);
      case 'select':
        return this.tone('square', 990, 1180, 0.04, 0.045);
      case 'error':
        return this.arp('square', [330, 262], 0.08, 0.09, 0.05);
      case 'shot': {
        const f = SHOT_PITCH[o.type ?? ''] ?? 600;
        if (o.kind === 'melee') this.hiss(0.12, 0.13, 'bandpass', 600, 2800, 0, 1.4);
        else if (o.kind === 'beam') {
          this.tone('sawtooth', f * 0.6, f * 0.35, 0.3, 0.05);
          this.hiss(0.25, 0.04, 'bandpass', f * 2, f, 0, 3);
        } else if (o.kind === 'nova') {
          this.hiss(0.2, 0.1, 'lowpass', 2400, 300);
          this.tone('sine', 140, 60, 0.16, 0.12);
        } else if (o.kind === 'aura') {
          this.tone('sine', f * 0.5, f * 0.55, 0.25, 0.04);
          this.tone('sine', f * 0.75, f * 0.8, 0.25, 0.03);
        } else if (o.kind === 'buff') this.arp('sine', [f, f * 1.25, f * 1.5], 0.05, 0.12, 0.05);
        else if (o.kind === 'orbit') this.tone('triangle', f, f * 1.5, 0.15, 0.04);
        else {
          this.tone('triangle', f * 1.5, f * 0.5, 0.09, 0.05);
          if (o.type === 'fire' || o.type === 'electric') this.hiss(0.06, 0.03, 'highpass', 3000);
        }
        return;
      }
      case 'hit':
        return this.tone('triangle', 230, 90, 0.045, 0.045);
      case 'faint':
        return this.tone('sine', 720, 240, 0.08, 0.04);
      case 'mateDown':
        // A teammate is down: an urgent two-note alarm, twice, over a low thump.
        for (const at of [0, 0.2]) {
          this.tone('square', 1175, 1175, 0.08, 0.06, at);
          this.tone('square', 880, 860, 0.1, 0.06, at + 0.09);
        }
        return this.tone('triangle', 160, 70, 0.18, 0.1);
      case 'bossDown':
        this.hiss(0.7, 0.18, 'lowpass', 1500, 100);
        return this.arp('triangle', [262, 330, 392, 523], 0.09, 0.4, 0.08);
      case 'xp': {
        const now = ctx.currentTime;
        this.xpCombo = now - this.xpT < 0.45 ? Math.min(this.xpCombo + 1, 24) : 0;
        this.xpT = now;
        return this.tone('sine', 880 * Math.pow(2, this.xpCombo / 12), 0, 0.06, 0.035);
      }
      case 'coin':
        this.tone('square', 1320, 1320, 0.05, 0.035);
        return this.tone('square', 1760, 1760, 0.14, 0.035, 0.05);
      case 'heal':
        return this.arp('triangle', [523, 659, 784, 1047], 0.06, 0.18, 0.06);
      case 'revived':
        // We're back up: the heal arpeggio a step higher and longer, with a bell on top.
        this.arp('triangle', [392, 523, 659, 784, 1047], 0.07, 0.3, 0.07);
        return this.bells([1568, 2093, 2637], 0.06);
      case 'levelup':
        this.arp('square', [523, 659, 784, 1047], 0.07, 0.14, 0.05);
        return this.arp('triangle', [1047, 1319, 1568], 0.07, 0.3, 0.05);
      case 'hurt':
        this.tone('square', 150, 70, 0.14, 0.06);
        return this.hiss(0.1, 0.06, 'lowpass', 900);
      case 'boss':
        for (const f of [82, 123, 165]) this.tone('sawtooth', f, f * 0.98, 1.3, 0.05);
        return this.drum('kick', ctx.currentTime, 1, this.sfxBus);
      case 'surge':
        return this.hiss(0.7, 0.12, 'lowpass', 500, 120);
      case 'shiny':
        return this.bells([2093, 2637, 3136, 2349, 3520, 4186], 0.07);
      case 'shinyGet':
        this.bells([2093, 2637, 3136, 2349, 3520, 4186], 0.07);
        return this.arp('square', [784, 988, 1175, 1568], 0.1, 0.35, 0.05);
      case 'break':
        this.hiss(0.16, 0.12, 'lowpass', 1100, 200);
        return this.tone('triangle', 140, 60, 0.12, 0.08);
      case 'chest':
        this.hiss(0.16, 0.12, 'lowpass', 1100, 200);
        this.tone('triangle', 140, 60, 0.12, 0.08);
        return this.arp('square', [1047, 1319, 1568, 2093], 0.06, 0.12, 0.04);
      case 'grass':
        return this.hiss(0.06, 0.03, 'highpass', 2600);
      case 'ball':
        this.tone('triangle', 220, 70, 0.12, 0.12);
        return this.hiss(0.08, 0.06, 'lowpass', 800);
      case 'shake':
        return this.tone('square', 420, 380, 0.04, 0.05);
      case 'burst': {
        this.hiss(0.5, 0.14, 'bandpass', 400, 4000, 0, 0.8);
        const r = Math.max(1, Math.min(5, o.rarity ?? 1));
        const chord = [
          [523, 659, 784],
          [587, 740, 880],
          [659, 831, 988],
          [698, 880, 1047],
          [784, 988, 1175, 1568],
        ][r - 1]!;
        for (const f of chord) this.tone('triangle', f, f, 0.6 + r * 0.15, 0.04);
        return;
      }
      case 'reveal': {
        const r = Math.max(1, Math.min(5, o.rarity ?? 1));
        return this.bells([[523, 659, 784, 988, 1319][r - 1]!], 0);
      }
      case 'rift':
        [196, 233, 277, 330].forEach((f, i) =>
          this.note('pad', ctx.currentTime + i * 0.08, f, 1.4, 1.2, this.sfxBus),
        );
        return this.hiss(0.9, 0.08, 'bandpass', 900, 300);
      case 'legend':
        this.arp('square', [523, 659, 784, 1047, 1319, 1568], 0.08, 0.3, 0.05);
        return this.bells([2093, 2637, 3136, 2349, 3520, 4186], 0.07);
      case 'gameover':
        return this.arp('triangle', [523, 440, 349, 262], 0.2, 0.35, 0.08);
      case 'biome':
        for (const f of [392, 494, 587, 784])
          this.note('pad', ctx.currentTime, f, 1.2, 1.4, this.sfxBus);
        return;
      case 'pause':
        return this.arp('square', [784, 523], 0.06, 0.07, 0.04);
      case 'buy':
        this.tone('square', 1320, 1320, 0.05, 0.035);
        this.tone('square', 1760, 1760, 0.14, 0.035, 0.05);
        return this.arp('triangle', [659, 784, 1047], 0.05, 0.12, 0.06);
    }
  }

  /** Plays an effect (skipped while muted, too soon after the same one, or with 24 voices on). */
  sfx(name: SfxName, opts: SfxOptions = {}): void {
    const ctx = this.ctx;
    if (!ctx || ctx.state !== 'running' || volumeOf('sfx') <= 0) return;
    const now = performance.now();
    const key = name === 'shot' ? `shot${opts.kind ?? ''}` : name;
    if (now - (this.last.get(key) ?? 0) < (MIN_GAP[name] ?? 0)) return;
    if (this.voices > 24) return;
    this.last.set(key, now);
    this.voices++;
    setTimeout(() => this.voices--, 150);
    try {
      this.play(name, opts);
    } catch {
      // A sound effect must never break the game.
    }
  }
}

/** The app's audio. */
export const audio = new AudioEngine();

/** Music per run biome (legacy BIOME_MUSIC), from biomes.json. */
export function biomeMusic(index: number): string {
  const list = loadGameData().biomes.runBiomes;
  return list[((index % list.length) + list.length) % list.length]?.music ?? 'forest';
}
