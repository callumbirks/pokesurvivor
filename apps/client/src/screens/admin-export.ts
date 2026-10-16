// Admin: export finished runs' balance records (docs/run-export.md). Filters, a live count of
// the matching records, and a download link: the server streams the file (`GET
// /api/admin/runs/export`), so it never has to fit in the page's memory.
import { loadGameData, t } from '@pokesurvivor/data';
import type { App, Screen } from '../app/app.js';
import { h } from '../app/dom.js';
import { toastError } from '../app/toast.js';

/** The filters as query parameters (empty ones left out). Exported for tests. */
export function exportQuery(f: {
  from: string;
  to: string;
  minMinutes: string;
  maxMinutes: string;
  mode: string;
  players: string;
  dex: string;
  username: string;
  configVersion: string;
  outcome: string;
  includeFlagged: boolean;
}): string {
  const q = new URLSearchParams();
  // Whole days: from the start of `from` to the end of `to` (UTC).
  if (f.from) q.set('from', `${f.from}T00:00:00Z`);
  if (f.to) q.set('to', `${f.to}T23:59:59.999Z`);
  const seconds = (m: string) => String(Math.round(Number(m) * 60));
  if (f.minMinutes.trim()) q.set('minDurationS', seconds(f.minMinutes));
  if (f.maxMinutes.trim()) q.set('maxDurationS', seconds(f.maxMinutes));
  if (f.mode) q.set('mode', f.mode);
  if (f.players) q.set('players', f.players);
  if (f.dex) q.set('dex', f.dex);
  if (f.username.trim()) q.set('username', f.username.trim());
  if (f.configVersion.trim()) q.set('configVersion', f.configVersion.trim());
  if (f.outcome) q.set('outcome', f.outcome);
  if (f.includeFlagged) q.set('includeFlagged', 'true');
  return q.toString();
}

const option = (value: string, label: string) => h('option', { value }, label);

export function runExportPanel(app: App): Screen {
  let destroyed = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let asked = 0;

  const input = (testid: string, attrs: Record<string, string | number>) =>
    h('input', { class: 'admin-input', dataset: { testid }, ...attrs, on: { input: changed } });
  const select = (testid: string, options: HTMLOptionElement[]) =>
    h('select', { class: 'admin-input', dataset: { testid }, on: { change: changed } }, ...options);

  const from = input('export-from', { type: 'date' });
  const to = input('export-to', { type: 'date' });
  const minMinutes = input('export-min', { type: 'number', min: 0, step: 1 });
  const maxMinutes = input('export-max', { type: 'number', min: 0, step: 1 });
  const mode = select('export-mode', [
    option('', t('admin.exportAny')),
    option('solo', t('admin.exportSolo')),
    option('coop', t('admin.exportCoop')),
  ]);
  const players = select('export-players', [
    option('', t('admin.exportAny')),
    ...[1, 2, 3, 4].map((n) => option(String(n), String(n))),
  ]);
  const dex = select('export-dex', [
    option('', t('admin.exportAny')),
    ...loadGameData().pokedex.map((p) =>
      option(String(p.dex), `${String(p.dex).padStart(3, '0')} ${p.name}`),
    ),
  ]);
  const username = input('export-username', { type: 'text', maxlength: 32 });
  const configVersion = input('export-config', { type: 'number', min: 0, step: 1 });
  const outcome = select('export-outcome', [
    option('', t('admin.exportAny')),
    option('all-down', t('admin.exportAllDown')),
    option('everyone-left', t('admin.exportEveryoneLeft')),
    option('none', t('admin.exportNoEnd')),
  ]);
  const includeFlagged = h('input', {
    type: 'checkbox',
    dataset: { testid: 'export-flagged' },
    on: { change: changed },
  });

  const count = h('p', { class: 'admin-status', dataset: { testid: 'export-count' } });
  const download = h(
    'a',
    { class: 'btn primary', dataset: { testid: 'export-download' }, download: '' },
    t('admin.exportDownload'),
  );

  const query = () =>
    exportQuery({
      from: from.value,
      to: to.value,
      minMinutes: minMinutes.value,
      maxMinutes: maxMinutes.value,
      mode: mode.value,
      players: players.value,
      dex: dex.value,
      username: username.value,
      configVersion: configVersion.value,
      outcome: outcome.value,
      includeFlagged: includeFlagged.checked,
    });

  /** The count of what the filters match (the latest request wins). */
  async function recount(): Promise<void> {
    const q = query();
    download.href = `/api/admin/runs/export${q ? `?${q}` : ''}`;
    const mine = ++asked;
    count.textContent = t('admin.exportCounting');
    try {
      const r = await app.api.runExportCount(q);
      if (destroyed || mine !== asked) return;
      count.textContent =
        r.flagged > 0 && !includeFlagged.checked
          ? t('admin.exportCountFlagged', { 0: r.count, 1: r.flagged })
          : t('admin.exportCount', { 0: r.count });
    } catch (err) {
      if (destroyed || mine !== asked) return;
      count.textContent = '';
      toastError(err);
    }
  }

  function changed(): void {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => void recount(), 300);
  }

  const field = (label: string, control: HTMLElement) =>
    h('label', { class: 'admin-field' }, h('span', null, label), control);

  const el = h(
    'div',
    { class: 'admin-export', dataset: { testid: 'admin-export' } },
    h('p', { class: 'admin-intro' }, t('admin.exportIntro')),
    h(
      'div',
      { class: 'admin-filters' },
      field(t('admin.exportFrom'), from),
      field(t('admin.exportTo'), to),
      field(t('admin.exportMinMinutes'), minMinutes),
      field(t('admin.exportMaxMinutes'), maxMinutes),
      field(t('admin.exportMode'), mode),
      field(t('admin.exportPlayers'), players),
      field(t('admin.exportPokemon'), dex),
      field(t('admin.exportUsername'), username),
      field(t('admin.exportConfig'), configVersion),
      field(t('admin.exportOutcome'), outcome),
      h(
        'label',
        { class: 'admin-field admin-check' },
        includeFlagged,
        h('span', null, t('admin.exportIncludeFlagged')),
      ),
    ),
    h('div', { class: 'admin-actions' }, download, count),
  );
  void recount();
  return {
    el,
    destroy: () => {
      destroyed = true;
      if (timer) clearTimeout(timer);
    },
  };
}
