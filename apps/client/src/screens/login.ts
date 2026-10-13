// Login and sign-up (username + password; the server sets the session cookie).
import { t } from '@pokesurvivor/data';
import type { App, Screen } from '../app/app.js';
import { h } from '../app/dom.js';
import { errorText } from '../app/toast.js';
import { tabs } from './common.js';

const USERNAME = /^[A-Za-z0-9_]{3,16}$/;
const MIN_PASSWORD = 8;

export function loginScreen(app: App): Screen {
  let mode: 'login' | 'register' = 'login';
  const user = h('input', {
    class: 'field',
    name: 'username',
    autocomplete: 'username',
    maxlength: 16,
    spellcheck: 'false',
    required: true,
    dataset: { testid: 'login-username' },
  });
  const pass = h('input', {
    class: 'field',
    name: 'password',
    type: 'password',
    autocomplete: 'current-password',
    maxlength: 128,
    required: true,
    dataset: { testid: 'login-password' },
  });
  const err = h('p', { class: 'err', role: 'alert', dataset: { testid: 'login-error' } });
  const hint = h('small', { class: 'hint' }, t('login.n316LettersNumbersOr'));
  const submit = h(
    'button',
    { class: 'btn gold grow', type: 'submit', dataset: { testid: 'login-submit' } },
    t('login.logIn'),
  );
  const tabRow = h('div');

  const renderTabs = () => {
    tabRow.replaceChildren(
      tabs(
        [
          { id: 'login', label: t('login.logIn'), testid: 'tab-login' },
          { id: 'register', label: t('login.signUp'), testid: 'tab-register' },
        ],
        mode,
        (m) => {
          mode = m;
          renderTabs();
        },
      ),
    );
    submit.textContent = mode === 'login' ? t('login.logIn') : t('login.signUp');
    pass.autocomplete = mode === 'login' ? 'current-password' : 'new-password';
    hint.classList.toggle('hidden', mode === 'login');
    err.textContent = '';
  };
  renderTabs();

  const form = h(
    'form',
    {
      autocomplete: 'on',
      on: {
        submit: (e) => {
          e.preventDefault();
          const username = user.value.trim();
          const password = pass.value;
          err.textContent = '';
          if (mode === 'register') {
            if (!USERNAME.test(username)) return void (err.textContent = t('login.theNameMustBe3'));
            if (password.length < MIN_PASSWORD)
              return void (err.textContent = t('login.thePasswordMustBeAt2', { 0: MIN_PASSWORD }));
          }
          submit.classList.add('loading');
          submit.disabled = true;
          const call =
            mode === 'login'
              ? app.api.login(username, password)
              : app.api.register(username, password);
          call
            .then(({ user: u }) => app.loggedIn(u))
            .catch((e2: unknown) => {
              err.textContent = errorText(e2);
            })
            .finally(() => {
              submit.classList.remove('loading');
              submit.disabled = false;
            });
        },
      },
    },
    h('label', null, t('login.name')),
    user,
    hint,
    h('label', null, t('login.password')),
    pass,
    err,
    h('div', { class: 'row' }, submit),
  );

  const el = h(
    'section',
    { class: 'scr scr-login', dataset: { testid: 'screen-login' } },
    h(
      'div',
      { class: 'box login-box' },
      h(
        'div',
        { class: 'logo' },
        h('div', { class: 't1' }, 'PokéSurvivor'),
        h('div', { class: 't2' }, t('login.mysteryDungeon')),
      ),
      h('p', { class: 'login-tag' }, t('login.surviveTheHordesWithYour')),
      tabRow,
      form,
      h('p', { class: 'note center' }, t('app.savedInCloud')),
    ),
  );
  queueMicrotask(() => user.focus());
  return { el };
}
