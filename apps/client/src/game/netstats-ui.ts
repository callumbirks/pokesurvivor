// The network stats panel (Settings → Graphics → "Show network stats", or `?netstats` in the
// URL): a small window in the corner with the verdict line and the numbers behind it
// (`net/netstats.ts`). Co-op shows everything; solo has no network, so only the frame times.
// It collects all the time (cheap), and redraws a few times a second while shown.
import { t } from '@pokesurvivor/data';
import type { NetClient, RoomConnection } from '@pokesurvivor/netclient';
import { settings } from '../settings.js';
import { el } from './dom.js';
import { NETSTATS, NetStats, verdict, type NetStatsSummary } from './net/netstats.js';

/** What the panel reads from the socket (co-op only). */
export type NetStatsClient = Pick<NetClient, 'on'> & Partial<Pick<NetClient, 'stats'>>;

/** Shown when the setting is on, or the page was opened with `?netstats`. */
export function netStatsWanted(): boolean {
  return settings.get().netStats || new URLSearchParams(location.search).has('netstats');
}

const ms = (v: number | null) => (v === null ? '–' : String(Math.round(v)));
const rate = (v: number | null) => (v === null ? '–' : v.toFixed(v >= 10 ? 0 : 1));

type Tone = 'good' | 'warn' | 'bad' | 'idle';

export class NetStatsPanel {
  readonly stats = new NetStats();
  readonly el: HTMLElement;
  private readonly cells = new Map<string, HTMLElement>();
  private readonly offs: (() => void)[] = [];
  private nextDraw = 0;
  private active = false;
  private top = '';

  constructor(
    parent: HTMLElement,
    private readonly conn: RoomConnection,
    private readonly client: NetStatsClient | null,
  ) {
    const now = () => conn.now?.() ?? Date.now();
    const cell = (key: string, cls = 'v') => {
      const c = el('span', { class: cls, data: { stat: key } });
      this.cells.set(key, c);
      return c;
    };
    const verdictCell = (key: string, label: string) =>
      el('span', { class: 'ps-ns-verdict' }, el('b', null, label), ' ', cell(key, 'tone'));
    const row = (label: string, ...cells: HTMLElement[]) =>
      el('div', { class: 'ps-ns-row' }, el('span', { class: 'k' }, label), ...cells);
    const net = !!client;
    this.el = el(
      'div',
      { class: 'ps-netstats hidden', data: { testid: 'netstats' } },
      el(
        'div',
        { class: 'ps-ns-verdicts' },
        net ? verdictCell('network', t('netstats.network')) : null,
        verdictCell('browser', t('netstats.browser')),
        net ? verdictCell('server', t('netstats.server')) : null,
      ),
      net ? row(t('netstats.ping'), cell('rtt'), cell('rttRolling', 'd')) : null,
      net ? row(t('netstats.snapshots'), cell('snapRate'), cell('gap', 'd')) : null,
      net ? row(t('netstats.jitter'), cell('jitter'), cell('jitterNote', 'd')) : null,
      net ? row(t('netstats.inputs'), cell('inputRate'), cell('unacked', 'd')) : null,
      net ? row(t('netstats.corrections'), cell('corrections'), cell('maxCorrection', 'd')) : null,
      row(t('netstats.frames'), cell('fps'), cell('worstFrame', 'd')),
      net ? row(t('netstats.server'), cell('serverLag'), cell('serverWorst', 'd')) : null,
    );
    parent.append(this.el);
    this.offs.push(
      conn.on('snapshot', (s) => this.stats.snapshot(now(), s.tick, s.paused)),
      conn.on('start', () => this.stats.restart()),
      settings.subscribe((_, changed) => {
        if (changed.includes('netStats')) this.nextDraw = 0;
      }),
    );
    if (client)
      this.offs.push(
        client.on('rtt', (rtt) => this.stats.rtt(now(), rtt)),
        client.on('lag', (lag) => this.stats.serverLag(now(), lag)),
        client.on('state', (s) => {
          if (s !== 'open') this.stats.disconnected();
        }),
      );
  }

  /** Keeps the panel under the HUD's top-left block (`top`: its bottom edge, CSS px). */
  placeBelow(top: number): void {
    const px = `${Math.round(top) + 6}px`;
    if (this.top !== px) this.el.style.setProperty('--ns-top', (this.top = px));
  }

  /** A prediction correction (`Predictor.onCorrection`). */
  correction(units: number): void {
    this.stats.correction(this.conn.now?.() ?? Date.now(), units);
  }

  /**
   * Every rendered frame: `frameMs` is how long since the last one. `running`: the run is on
   * screen (not loading or results), so the panel may show.
   */
  frame(frameMs: number, running: boolean): void {
    const now = this.conn.now?.() ?? Date.now();
    this.stats.frame(now, frameMs);
    const show = running && netStatsWanted();
    if (show !== this.active) {
      this.active = show;
      this.el.classList.toggle('hidden', !show);
      this.nextDraw = 0;
    }
    if (!show || now < this.nextDraw) return;
    this.nextDraw = now + NETSTATS.refreshMs;
    const c = this.client?.stats?.();
    this.draw(
      this.stats.summary(now, {
        perSecond: c ? c.inputsPerSecond : null,
        unacked: this.client ? this.conn.unackedInputs().length : null,
      }),
    );
  }

  private set(key: string, text: string, tone?: Tone): void {
    const c = this.cells.get(key);
    if (!c) return;
    if (c.textContent !== text) c.textContent = text;
    if (tone !== undefined && c.dataset.tone !== tone) c.dataset.tone = tone;
  }

  private draw(s: NetStatsSummary): void {
    const v = verdict(s);
    const network = v.network ?? null;
    this.set(
      'network',
      network ? t(`netstats.${network}`) : '…',
      network === 'good' ? 'good' : network === 'jittery' ? 'warn' : network ? 'bad' : 'idle',
    );
    this.set(
      'browser',
      v.browser ? t(`netstats.${v.browser}`) : '…',
      v.browser === 'smooth' ? 'good' : v.browser ? 'warn' : 'idle',
    );
    this.set('server', t(`netstats.${v.server}`), v.server === 'ok' ? 'good' : 'bad');

    this.set(
      'rtt',
      t('netstats.ms', { 0: ms(s.rtt.current ?? this.client?.stats?.().rttMs ?? null) }),
    );
    this.set('rttRolling', t('netstats.medianP95', { 0: ms(s.rtt.median), 1: ms(s.rtt.p95) }));
    this.set('snapRate', t('netstats.perSecond', { 0: rate(s.snapshots.perSecond) }));
    const gap = s.snapshots.maxGapMs;
    this.set(
      'gap',
      t('netstats.maxGap', { 0: ms(gap) }),
      gap !== null && gap > NETSTATS.gapWarnMs ? 'warn' : 'idle',
    );
    this.set('jitter', t('netstats.ms', { 0: ms(s.snapshots.jitterMs) }));
    this.set('jitterNote', t('netstats.p95'));
    const lag = s.server.late + s.server.skipped > 0;
    this.set(
      'serverLag',
      lag
        ? t('netstats.serverLag', { 0: s.server.late, 1: s.server.skipped })
        : t('netstats.serverOnTime'),
      lag ? 'warn' : 'idle',
    );
    this.set('serverWorst', lag ? t('netstats.behind', { 0: s.server.worstMs }) : '');
    this.set('inputRate', t('netstats.perSecond', { 0: rate(s.inputs.perSecond) }));
    this.set('unacked', t('netstats.unacked', { 0: s.inputs.unacked ?? '–' }));
    this.set('corrections', t('netstats.inWindow', { 0: s.corrections.count }));
    this.set(
      'maxCorrection',
      t('netstats.maxUnits', { 0: s.corrections.maxUnits.toFixed(1) }),
      s.corrections.maxUnits >= NETSTATS.correctionWarn ? 'warn' : 'idle',
    );
    this.set('fps', t('netstats.fps', { 0: rate(s.frames.fps) }));
    const worst = s.frames.worstMs;
    this.set(
      'worstFrame',
      t('netstats.worstFrame', { 0: ms(worst) }),
      worst !== null && worst > NETSTATS.slowFrameMs ? 'warn' : 'idle',
    );
  }

  dispose(): void {
    for (const off of this.offs) off();
    this.el.remove();
  }
}
