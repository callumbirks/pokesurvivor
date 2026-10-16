// Admin: live tuning of `tuning.json` and `levelup.json`. A plain JSON editor per file showing the
// published (effective) config, validated as you type with the same schemas the server uses; the
// changes against the defaults or the published version; Save (publishes at once, no drafts);
// the history with view and revert; and "Export as patch" to bake the overrides into the repo.
import {
  loadGameData,
  t,
  TUNABLE_FILES,
  validateTunables,
  type ConfigIssue,
  type TunableConfig,
  type TunableFile,
} from '@pokesurvivor/data';
import type { ConfigVersionSummary, ConfigVersionView } from '../app/api.js';
import type { App, Screen } from '../app/app.js';
import {
  configChanges,
  formatJson,
  parseJson,
  showValue,
  type ConfigChange,
} from '../app/config-diff.js';
import { confirmDialog } from '../app/confirm-dialog.js';
import { h, replace } from '../app/dom.js';
import { setPublishedConfig } from '../live-config.js';
import { toast, toastError } from '../app/toast.js';
import { changelogDate } from './changelog.js';
import { errorView, loadingView } from './common.js';

interface Loaded {
  current: ConfigVersionView;
  defaults: TunableConfig;
  versions: ConfigVersionSummary[];
}

type Checked =
  | { kind: 'json'; file: TunableFile; error: string }
  | { kind: 'invalid'; issues: ConfigIssue[] }
  | { kind: 'valid'; config: TunableConfig };

const pretty = (v: unknown) => formatJson(v);
const when = (iso: string) =>
  `${changelogDate(iso.slice(0, 10))} ${new Date(iso).toLocaleTimeString('en-GB', {
    hour: '2-digit',
    minute: '2-digit',
  })}`;

export function liveTuningPanel(app: App): Screen {
  const el = h('div', { class: 'admin-tuning', dataset: { testid: 'admin-tuning' } });
  let destroyed = false;
  let timer: ReturnType<typeof setTimeout> | null = null;

  async function load(): Promise<void> {
    replace(el, loadingView());
    try {
      const [{ current, defaults }, { versions }] = await Promise.all([
        app.api.adminConfig(),
        app.api.configVersions(),
      ]);
      if (!destroyed) render({ current, defaults, versions });
    } catch (err) {
      if (!destroyed)
        replace(
          el,
          errorView(err, () => void load()),
        );
    }
  }

  function render({ current, defaults, versions }: Loaded): void {
    // The editor: one text per file, starting from the published config.
    const texts: Record<TunableFile, string> = {
      tuning: pretty(current.config.tuning),
      levelup: pretty(current.config.levelup),
    };
    let file: TunableFile = 'tuning';
    let diffAgainst: 'defaults' | 'current' = 'current';
    let checked: Checked = { kind: 'valid', config: current.config };

    const area = h('textarea', {
      class: 'admin-json',
      spellcheck: 'false',
      autocomplete: 'off',
      wrap: 'off',
      dataset: { testid: 'admin-json' },
      on: {
        input: () => {
          texts[file] = area.value;
          if (timer) clearTimeout(timer);
          timer = setTimeout(check, 200);
        },
      },
    });
    area.value = texts[file];
    const fileTabs = h('div', { class: 'admin-files' });
    const status = h('div', { class: 'admin-status', dataset: { testid: 'admin-status' } });
    const diffBox = h('div', { class: 'admin-diff', dataset: { testid: 'admin-diff' } });
    const note = h('input', {
      class: 'admin-note',
      type: 'text',
      maxlength: 500,
      placeholder: t('admin.note'),
      dataset: { testid: 'admin-note' },
    });
    const publish = h(
      'button',
      {
        class: 'btn primary',
        dataset: { testid: 'admin-publish' },
        on: { click: () => void save() },
      },
      t('admin.publish'),
    );
    const discard = h(
      'button',
      {
        class: 'btn ghost',
        on: {
          click: () => {
            texts.tuning = pretty(current.config.tuning);
            texts.levelup = pretty(current.config.levelup);
            area.value = texts[file];
            check();
          },
        },
      },
      t('admin.discard'),
    );

    function renderFileTabs(): void {
      replace(
        fileTabs,
        TUNABLE_FILES.map((f) =>
          h(
            'button',
            {
              class: ['btn', 'small', f === file ? 'primary' : 'ghost'],
              dataset: { testid: `admin-file-${f}` },
              on: {
                click: () => {
                  file = f;
                  area.value = texts[f];
                  renderFileTabs();
                },
              },
            },
            `${f}.json`,
          ),
        ),
      );
    }

    /** Selects a setting's key in the editor (from a problem in the list). */
    function reveal(issue: ConfigIssue): void {
      if (!(TUNABLE_FILES as readonly string[]).includes(issue.file)) return;
      file = issue.file as TunableFile;
      area.value = texts[file];
      renderFileTabs();
      const key = issue.path
        .split('.')
        .filter((k) => !/^\d+$/.test(k))
        .pop();
      const at = key ? area.value.indexOf(`"${key}"`) : -1;
      area.focus();
      if (at >= 0) area.setSelectionRange(at, at + key!.length + 2);
    }

    function check(): void {
      timer = null;
      const values: Partial<Record<TunableFile, unknown>> = {};
      for (const f of TUNABLE_FILES) {
        const r = parseJson(texts[f]);
        if (!r.ok) {
          checked = { kind: 'json', file: f, error: r.error };
          return update();
        }
        values[f] = r.value;
      }
      const v = validateTunables(loadGameData(), values);
      checked = v.ok ? { kind: 'valid', config: v.config } : { kind: 'invalid', issues: v.issues };
      update();
    }

    function changeList(changes: ConfigChange[]): HTMLElement {
      return renderChanges(changes);
    }

    function update(): void {
      if (checked.kind === 'json')
        replace(
          status,
          h(
            'p',
            { class: 'admin-bad' },
            `${checked.file}.json: `,
            t('admin.invalidJson', { 0: checked.error }),
          ),
        );
      else if (checked.kind === 'invalid')
        replace(
          status,
          h('p', { class: 'admin-bad' }, t('admin.issues', { 0: checked.issues.length })),
          h(
            'ul',
            { class: 'admin-issues', dataset: { testid: 'admin-issues' } },
            checked.issues.map((i) =>
              h(
                'li',
                null,
                h(
                  'button',
                  { class: 'admin-issue', type: 'button', on: { click: () => reveal(i) } },
                  `${i.file}.json › ${i.path || '(root)'}`,
                ),
                `: ${i.message}`,
              ),
            ),
          ),
        );
      else replace(status, h('p', { class: 'admin-good' }, t('admin.valid')));

      const config = checked.kind === 'valid' ? checked.config : null;
      const vsCurrent = config ? configChanges(current.config, config) : [];
      publish.disabled = !config || (!vsCurrent.length && !current.skipped.length);
      const base = diffAgainst === 'defaults' ? defaults : current.config;
      const changes = config ? configChanges(base, config) : [];
      replace(
        diffBox,
        h(
          'div',
          { class: 'admin-diff-head' },
          (['current', 'defaults'] as const).map((d) =>
            h(
              'button',
              {
                class: ['btn', 'small', d === diffAgainst ? 'primary' : 'ghost'],
                on: {
                  click: () => {
                    diffAgainst = d;
                    update();
                  },
                },
              },
              t(d === 'defaults' ? 'admin.diffDefaults' : 'admin.diffCurrent'),
            ),
          ),
          config
            ? h('span', { class: 'muted' }, t('admin.changeCount', { 0: changes.length }))
            : null,
        ),
        config ? changeList(changes) : null,
      );
    }

    async function save(): Promise<void> {
      if (checked.kind !== 'valid') return;
      const config = checked.config;
      const ok = await confirmDialog({
        title: t('admin.publishTitle'),
        body: [
          h('p', null, t('admin.publishBody')),
          changeList(configChanges(current.config, config)),
        ],
        confirmLabel: t('admin.publish'),
        cancelLabel: t('admin.cancel'),
        testid: 'admin-confirm',
      });
      if (!ok) return;
      const v = await app.act(publish, () =>
        app.api.publishConfig(config, current.version, note.value.trim() || undefined),
      );
      if (!v || destroyed) return;
      toast(t('admin.published', { 0: v.version }), 'good');
      setPublishedConfig({ version: v.version, ...v.config });
      void load();
    }

    async function revert(version: number): Promise<void> {
      const ok = await confirmDialog({
        title: t('admin.revertTitle', { 0: version }),
        body: [h('p', null, t('admin.revertBody'))],
        confirmLabel: t('admin.revert'),
        cancelLabel: t('admin.cancel'),
      });
      if (!ok) return;
      const v = await app.act(null, () => app.api.revertConfig(version, current.version));
      if (!v || destroyed) return;
      toast(t('admin.reverted', { 0: v.version }), 'good');
      setPublishedConfig({ version: v.version, ...v.config });
      void load();
    }

    async function exportPatch(button: HTMLButtonElement): Promise<void> {
      const patch = await app.act(button, () => app.api.configPatch());
      if (!patch) return;
      if (!Object.keys(patch.overrides).length) {
        toast(t('admin.exportNone'));
        return;
      }
      const blob = new Blob([`${JSON.stringify(patch, null, 2)}\n`], { type: 'application/json' });
      const a = h('a', {
        href: URL.createObjectURL(blob),
        download: `tuning-patch-v${patch.version}.json`,
      });
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    }

    /** One version in the history: when, who, note; view its changes, revert to it. */
    function historyRow(v: ConfigVersionSummary): HTMLElement {
      const details = h('div', { class: 'admin-version-changes hidden' });
      const view = h(
        'button',
        {
          class: 'btn small ghost',
          on: {
            click: () => {
              const open = details.classList.toggle('hidden') === false;
              view.textContent = t(open ? 'admin.hide' : 'admin.view');
              if (!open || details.childElementCount) return;
              details.append(loadingView());
              app.api.configVersion(v.version).then(
                (full) =>
                  replace(
                    details,
                    full.skipped.length ? skippedBox(full.skipped) : null,
                    changeList(configChanges(defaults, full.config)),
                  ),
                (err: unknown) => {
                  details.replaceChildren();
                  toastError(err);
                },
              );
            },
          },
        },
        t('admin.view'),
      );
      const isCurrent = v.version === current.version;
      return h(
        'li',
        {
          class: ['admin-version', isCurrent && 'current'],
          dataset: { testid: `admin-v${v.version}` },
        },
        h(
          'div',
          { class: 'admin-version-head' },
          h('b', null, t('admin.version', { 0: v.version })),
          isCurrent ? h('span', { class: 'admin-badge' }, t('admin.currentBadge')) : null,
          h('span', { class: 'muted' }, when(v.createdAt)),
          v.createdBy ? h('span', { class: 'muted' }, t('admin.by', { 0: v.createdBy })) : null,
          h('span', { class: 'muted' }, t('admin.changeCount', { 0: v.changes })),
          v.revertedFrom !== null
            ? h('span', { class: 'muted' }, t('admin.revertOf', { 0: v.revertedFrom }))
            : null,
          h('span', { class: 'admin-spacer' }),
          view,
          isCurrent
            ? null
            : h(
                'button',
                { class: 'btn small', on: { click: () => void revert(v.version) } },
                v.version === 0 ? t('admin.revertDefaults') : t('admin.revert'),
              ),
        ),
        v.note ? h('p', { class: 'admin-version-note' }, v.note) : null,
        details,
      );
    }

    const exportBtn = h(
      'button',
      {
        class: 'btn',
        dataset: { testid: 'admin-export' },
        on: { click: () => void exportPatch(exportBtn) },
      },
      t('admin.exportPatch'),
    );

    replace(
      el,
      h('p', { class: 'muted' }, t('admin.tuningIntro')),
      h(
        'div',
        { class: 'admin-current', dataset: { testid: 'admin-current' } },
        h('b', null, t('admin.current', { 0: current.version })),
        current.createdBy
          ? h('span', { class: 'muted' }, t('admin.by', { 0: current.createdBy }))
          : null,
        current.version ? h('span', { class: 'muted' }, when(current.createdAt)) : null,
        current.note ? h('span', { class: 'admin-version-note' }, current.note) : null,
      ),
      current.skipped.length ? skippedBox(current.skipped) : null,
      h(
        'div',
        { class: 'admin-grid' },
        h(
          'div',
          { class: 'admin-editor' },
          h('h3', null, t('admin.editor')),
          fileTabs,
          area,
          status,
          h('div', { class: 'admin-actions' }, note, discard, publish),
        ),
        h('div', { class: 'admin-side' }, diffBox),
      ),
      h('h3', null, t('admin.history')),
      h(
        'ul',
        { class: 'admin-history', dataset: { testid: 'admin-history' } },
        versions.map(historyRow),
      ),
      h(
        'div',
        { class: 'admin-export' },
        exportBtn,
        h('p', { class: 'muted' }, t('admin.exportHelp')),
      ),
    );
    renderFileTabs();
    update();
  }

  void load();
  return {
    el,
    destroy: () => {
      destroyed = true;
      if (timer) clearTimeout(timer);
    },
  };
}

/** The warning for stored overrides this build skips. */
function skippedBox(skipped: readonly ConfigIssue[]): HTMLElement {
  return h(
    'div',
    { class: 'admin-warning', dataset: { testid: 'admin-skipped' } },
    h('b', null, t('admin.skippedTitle')),
    h('p', null, t('admin.skippedHelp')),
    h(
      'ul',
      null,
      skipped.map((s) =>
        h(
          'li',
          null,
          `${s.file}${s.file ? '.json' : ''}${s.path ? ` › ${s.path}` : ''}: ${s.message}`,
        ),
      ),
    ),
  );
}

/** Changed settings: the path, then the old value → the new one. */
function renderChanges(changes: readonly ConfigChange[]): HTMLElement {
  if (!changes.length) return h('p', { class: 'muted' }, t('admin.noChanges'));
  return h(
    'ul',
    { class: 'admin-changes' },
    changes.map((c) =>
      h(
        'li',
        null,
        h('div', { class: 'admin-path' }, `${c.file}.json › ${c.path}`),
        h(
          'div',
          null,
          h('span', { class: 'admin-old', title: t('admin.from') }, showValue(c.from)),
          ' → ',
          h('span', { class: 'admin-new', title: t('admin.to') }, showValue(c.to)),
        ),
      ),
    ),
  );
}
