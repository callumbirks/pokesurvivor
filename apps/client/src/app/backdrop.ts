// The living world behind the menus (port of legacy game.js `Backdrop`): the run map with a
// cast of Pokémon wandering about, now and then "attacking" the air, under a slowly drifting
// camera that changes biome every 30 s, with the vignette. Drawn with the game's own renderer
// (`game/scene/`) and moved with the sim's collision (`WorldView.move`).
//
// Calm mode (settings) and the system's reduced-motion preference keep it still: the camera
// and the Pokémon stand, and it's only redrawn when something loads or the window resizes.
import { DT, type MovingBody } from '@pokesurvivor/sim';
import { settings } from '../settings.js';
import type { AnimationName } from '@pokesurvivor/data';
import { Animator, dirFromAngle, drawShadow, initSprites } from '../sprites.js';
import { Camera } from '../game/scene/camera.js';
import { FX } from '../game/scene/fx.js';
import { WorldRenderer, drawVignette } from '../game/scene/world.js';

/** The menu's world (legacy's seed) and cast. */
const SEED = 4242;
const CAST = [1, 4, 7, 25, 133, 52, 39, 35, 16, 43, 60, 69, 74, 92, 129, 147, 113, 143, 54, 79];
/** Seconds per biome, and how many biomes it cycles through (legacy: the first three). */
const BIOME_SECONDS = 30;
const BIOMES = 3;
/** Redraw interval while still (calm mode): sprite sheets that finish loading show up. */
const STILL_REDRAW_MS = 500;

interface Wanderer {
  anim: Animator;
  body: MovingBody;
  /** Walking direction (unit vector, or 0 standing) and speed. */
  dx: number;
  dy: number;
  speed: number;
  /** Seconds until the next decision. */
  t: number;
}

const rand = (a: number, b: number) => a + Math.random() * (b - a);
const reducedMotion = () =>
  typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

export class MenuBackdrop {
  readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D | null;
  private readonly world = new WorldRenderer(SEED);
  private readonly camera = new Camera();
  private readonly fx = new FX();
  private wanderers: Wanderer[] = [];
  private visible = false;
  private raf = 0;
  private stillTimer: ReturnType<typeof setTimeout> | null = null;
  private last = 0;
  private time = 0;
  private acc = 0;
  private biomeT = 0;
  private biome = 0;
  /** Camera drift: the camera's own position, followed with damping. */
  private cx = 0;
  private cy = 0;

  constructor(parent: HTMLElement) {
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'backdrop';
    this.canvas.setAttribute('aria-hidden', 'true');
    parent.prepend(this.canvas);
    this.ctx = this.canvas.getContext('2d');
    this.world.sync(0, null, {}, true);
    addEventListener('resize', () => this.kick());
    settings.subscribe((_s, changed) => {
      if (changed.includes('calmMode')) this.kick();
    });
    void initSprites().then(() => {
      this.spawnAll();
      this.kick();
    });
  }

  /** Shown behind every screen but the run. */
  show(on: boolean): void {
    if (on === this.visible) return;
    this.visible = on;
    this.canvas.classList.toggle('hidden', !on);
    if (on) this.kick();
    else this.halt();
  }

  get still(): boolean {
    return settings.get().calmMode || reducedMotion();
  }

  /** (Re)starts drawing: the animation loop, or one still frame. */
  private kick(): void {
    if (!this.visible) return;
    this.halt();
    this.resize();
    this.last = performance.now();
    if (this.still) this.drawStill();
    else this.raf = requestAnimationFrame((now) => this.frame(now));
  }

  private halt(): void {
    cancelAnimationFrame(this.raf);
    if (this.stillTimer) clearTimeout(this.stillTimer);
    this.stillTimer = null;
  }

  private resize(): void {
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = this.canvas.clientWidth || innerWidth;
    const h = this.canvas.clientHeight || innerHeight;
    this.canvas.width = Math.round(w * dpr);
    this.canvas.height = Math.round(h * dpr);
    this.camera.resize(w, h, dpr);
  }

  private drawStill(): void {
    this.draw();
    this.stillTimer = setTimeout(() => this.drawStill(), STILL_REDRAW_MS);
  }

  private frame(now: number): void {
    const dt = Math.min(0.1, (now - this.last) / 1000);
    this.last = now;
    this.step(dt);
    this.draw();
    this.raf = requestAnimationFrame((n) => this.frame(n));
  }

  // ---------------------------------------------------------------- the cast

  private spawnAll(): void {
    this.wanderers = CAST.map((dex) => this.spawn(dex, true));
  }

  /** Somewhere free in (or, `anywhere`, around) the view. */
  private spawn(dex: number, anywhere: boolean): Wanderer {
    const cam = this.camera;
    const k = anywhere ? 0.6 : 0.7;
    const body: MovingBody = {
      x: 0,
      y: 0,
      r: 12,
      vx: 0,
      vy: 0,
      types: [],
      inLiquid: false,
      walking: false,
      moveAngle: 0,
    };
    for (let i = 0; i < 20; i++) {
      body.x = cam.x + rand(-1, 1) * cam.w * k;
      body.y = cam.y + rand(-1, 1) * cam.h * k;
      if (this.world.terrainAt(body.x, body.y) === 'floor') break;
    }
    const anim = new Animator(dex, 1);
    anim.dir = Math.floor(Math.random() * 8);
    return { anim, body, dx: 0, dy: 0, speed: 0, t: rand(0, 2) };
  }

  private step(dt: number): void {
    this.time += dt;
    this.world.update(dt);
    // A slow drift of the camera.
    this.cx += Math.cos(this.time * 0.05) * 14 * dt;
    this.cy += Math.sin(this.time * 0.037) * 10 * dt;
    this.camera.follow(this.cx, this.cy, dt);

    this.biomeT += dt;
    if (this.biomeT > BIOME_SECONDS) {
      this.biomeT = 0;
      this.biome = (this.biome + 1) % BIOMES;
      this.world.sync(this.biome, null, {});
    }

    for (const wd of this.wanderers) {
      wd.t -= dt;
      if (wd.t <= 0) {
        // Wander, stop, or "attack" the air now and then.
        wd.t = rand(1, 3.5);
        const r = Math.random();
        if (r < 0.55) {
          const a = Math.random() * Math.PI * 2;
          wd.dx = Math.cos(a);
          wd.dy = Math.sin(a);
          wd.speed = rand(25, 55);
        } else {
          wd.dx = wd.dy = wd.speed = 0;
          if (r > 0.85) {
            const anims: AnimationName[] = ['Attack', 'Shoot', 'Charge'];
            wd.anim.play(anims[Math.floor(Math.random() * anims.length)] ?? 'Attack');
          }
        }
      }
      const moving = wd.speed > 0;
      if (moving) wd.anim.dir = dirFromAngle(Math.atan2(wd.dy, wd.dx));
      wd.anim.loop(moving ? 'Walk' : 'Idle');
      wd.anim.update(dt);
    }
    // Movement in the sim's fixed ticks, with its walls and solid props.
    this.acc += dt;
    while (this.acc >= DT) {
      this.acc -= DT;
      for (const wd of this.wanderers)
        if (wd.speed > 0) this.world.view.move(wd.body, wd.dx, wd.dy, wd.speed);
    }
    // Off camera: comes back somewhere in view.
    for (const [i, wd] of this.wanderers.entries())
      if (!this.camera.sees(wd.body.x, wd.body.y, 120))
        this.wanderers[i] = this.spawn(wd.anim.dex, false);
  }

  private draw(): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const cam = this.camera;
    const w = this.canvas.width / cam.dpr;
    const h = this.canvas.height / cam.dpr;
    ctx.setTransform(cam.dpr, 0, 0, cam.dpr, 0, 0);
    ctx.imageSmoothingEnabled = false;
    ctx.save();
    ctx.scale(cam.scale, cam.scale);
    cam.apply(ctx);
    this.world.drawGround(ctx, cam);
    this.world.drawLiquid(ctx, cam, this.time);
    // Props and Pokémon sorted by their feet, as in the game.
    const items: { y: number; draw: () => void }[] = [];
    for (const p of this.world.visibleProps(cam))
      items.push({
        y: p.flat ? p.y - 4000 : p.y,
        draw: () => this.world.drawProp(ctx, p, this.time, this.fx),
      });
    for (const wd of this.wanderers)
      items.push({
        y: wd.body.y,
        draw: () => {
          drawShadow(ctx, wd.anim.dex, wd.body.x, wd.body.y);
          wd.anim.draw(ctx, wd.body.x, wd.body.y);
        },
      });
    items.sort((a, b) => a.y - b.y);
    for (const it of items) it.draw();
    ctx.restore();
    drawVignette(ctx, w, h);
  }
}
