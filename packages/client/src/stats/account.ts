/**
 * Claim / Login account panel for the stats overlay (owned by client-stats).
 * Claim: POSTs {token, email, password, name} to api.claim and stores the
 * ClaimResponse via saveSession. Login: uses api.login. Both share one panel
 * that toggles between modes. Uses getIdentity() for the anonymous token.
 */

import type { StatsApi } from './api.js';
import { StatsApiError } from './api.js';
import { getIdentity } from '../net/identity.js';
import { clearSession, loadSession, saveSession } from './session.js';

/** Build and append the account (claim/login) view into `container`. Returns a teardown. */
export function buildAccountView(
  container: HTMLElement,
  api: StatsApi,
  onSessionChange: () => void,
): () => void {
  container.textContent = '';

  const session = loadSession();

  if (session !== null) {
    renderLoggedIn(container, session.name, session.email, () => {
      clearSession();
      onSessionChange();
      buildAccountView(container, api, onSessionChange);
    });
    return () => {};
  }

  // Toggle between claim and login modes.
  let mode: 'claim' | 'login' = 'claim';

  const modeTitle = document.createElement('h2');
  modeTitle.className = 'bs-stats-title';
  container.appendChild(modeTitle);

  const modeDesc = document.createElement('div');
  modeDesc.className = 'bs-dim';
  container.appendChild(modeDesc);

  const form = document.createElement('div');
  form.className = 'bs-stats-form';
  container.appendChild(form);

  const errorLine = document.createElement('div');
  errorLine.className = 'bs-stats-error';
  errorLine.hidden = true;
  container.appendChild(errorLine);

  const switchBtn = document.createElement('button');
  switchBtn.type = 'button';
  switchBtn.className = 'bs-btn bs-btn-small';
  container.appendChild(switchBtn);

  // Form fields (created once; name field conditionally shown).
  const nameField = buildField('Display name', 'text', 'Captain name');
  const emailField = buildField('Email', 'email', 'you@example.com');
  const passwordField = buildField('Password', 'password', 'passphrase');
  const submitBtn = document.createElement('button');
  submitBtn.type = 'button';
  submitBtn.className = 'bs-btn bs-btn-primary';

  function setError(msg: string | null): void {
    if (msg === null) {
      errorLine.hidden = true;
      errorLine.textContent = '';
    } else {
      errorLine.textContent = msg;
      errorLine.hidden = false;
    }
  }

  async function handleSubmit(): Promise<void> {
    setError(null);
    submitBtn.disabled = true;
    try {
      if (mode === 'claim') {
        const identity = getIdentity();
        const res = await api.claim({
          token: identity.token,
          email: emailField.input.value.trim(),
          password: passwordField.input.value,
          name: nameField.input.value.trim(),
        });
        saveSession(res);
        onSessionChange();
        container.textContent = '';
        renderLoggedIn(container, res.name, res.email, () => {
          clearSession();
          onSessionChange();
          buildAccountView(container, api, onSessionChange);
        });
      } else {
        const res = await api.login({
          email: emailField.input.value.trim(),
          password: passwordField.input.value,
        });
        saveSession(res);
        onSessionChange();
        container.textContent = '';
        renderLoggedIn(container, res.name, res.email, () => {
          clearSession();
          onSessionChange();
          buildAccountView(container, api, onSessionChange);
        });
      }
    } catch (err: unknown) {
      const msg =
        err instanceof StatsApiError ? err.message : 'Request failed. Please try again.';
      setError(msg);
      submitBtn.disabled = false;
    }
  }

  submitBtn.addEventListener('click', () => void handleSubmit());

  // Allow Enter in any field to submit.
  [nameField.input, emailField.input, passwordField.input].forEach((input) => {
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') void handleSubmit();
    });
  });

  function renderMode(): void {
    form.textContent = '';
    errorLine.hidden = true;
    if (mode === 'claim') {
      modeTitle.textContent = 'Claim Account';
      modeDesc.textContent = 'Lock your name and stats to an email so you can log in on any device.';
      form.appendChild(nameField.wrap);
      form.appendChild(emailField.wrap);
      form.appendChild(passwordField.wrap);
      submitBtn.textContent = 'Claim';
      switchBtn.textContent = 'Already claimed? Log in';
    } else {
      modeTitle.textContent = 'Login';
      modeDesc.textContent = 'Sign in to your claimed account.';
      form.appendChild(emailField.wrap);
      form.appendChild(passwordField.wrap);
      submitBtn.textContent = 'Login';
      switchBtn.textContent = 'New here? Claim account';
    }
    form.appendChild(submitBtn);
    submitBtn.disabled = false;
  }

  switchBtn.addEventListener('click', () => {
    mode = mode === 'claim' ? 'login' : 'claim';
    renderMode();
  });

  renderMode();

  return () => {};
}

function buildField(
  label: string,
  type: string,
  placeholder: string,
): { wrap: HTMLElement; input: HTMLInputElement } {
  const wrap = document.createElement('div');
  wrap.className = 'bs-stats-field';

  const labelEl = document.createElement('label');
  labelEl.className = 'bs-dim';
  labelEl.textContent = label;

  const input = document.createElement('input');
  input.type = type;
  input.placeholder = placeholder;
  input.className = 'bs-input';
  input.autocomplete = type === 'password' ? 'current-password' : type === 'email' ? 'email' : 'off';

  wrap.appendChild(labelEl);
  wrap.appendChild(input);
  return { wrap, input };
}

function renderLoggedIn(
  container: HTMLElement,
  name: string,
  email: string,
  onLogout: () => void,
): void {
  const title = document.createElement('h2');
  title.className = 'bs-stats-title';
  title.textContent = 'Account';
  container.appendChild(title);

  const info = document.createElement('div');
  info.className = 'bs-stats-grid';

  const nameCell = document.createElement('div');
  nameCell.className = 'bs-stats-cell';
  const nameLabel = document.createElement('div');
  nameLabel.className = 'bs-dim';
  nameLabel.textContent = 'Name';
  const nameVal = document.createElement('div');
  nameVal.className = 'bs-stats-val';
  nameVal.textContent = name;
  nameCell.appendChild(nameLabel);
  nameCell.appendChild(nameVal);

  const emailCell = document.createElement('div');
  emailCell.className = 'bs-stats-cell';
  const emailLabel = document.createElement('div');
  emailLabel.className = 'bs-dim';
  emailLabel.textContent = 'Email';
  const emailVal = document.createElement('div');
  emailVal.className = 'bs-stats-val';
  emailVal.textContent = email;
  emailCell.appendChild(emailLabel);
  emailCell.appendChild(emailVal);

  info.appendChild(nameCell);
  info.appendChild(emailCell);
  container.appendChild(info);

  const logoutBtn = document.createElement('button');
  logoutBtn.type = 'button';
  logoutBtn.className = 'bs-btn';
  logoutBtn.textContent = 'Log out';
  logoutBtn.addEventListener('click', onLogout);
  container.appendChild(logoutBtn);
}
