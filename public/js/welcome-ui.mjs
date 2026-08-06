// welcome-ui.mjs — First-visit welcome, with a "don't show this again" toggle.

const $ = (id) => document.getElementById(id);

const KEY_NEVER = 'don-welcome-never';    // set when the toggle is ticked
const KEY_SNOOZE = 'don-welcome-snooze';  // timestamp; set when dismissed untick
const SNOOZE_MS = 7 * 24 * 60 * 60_000;

// localStorage throws in private mode on some browsers, and a welcome box must never
// be the reason the lobby fails to load.
function read(key) {
  try { return localStorage.getItem(key); } catch { return null; }
}
function write(key, value) {
  try { localStorage.setItem(key, value); } catch { /* nothing to do */ }
}

function shouldShow() {
  if (read(KEY_NEVER) === '1') return false;
  const snoozed = Number(read(KEY_SNOOZE) || 0);
  // Dismissing without ticking hides it for a week rather than nagging on every visit.
  return !(snoozed && Date.now() - snoozed < SNOOZE_MS);
}

function close() {
  if ($('welcome-hide')?.checked) write(KEY_NEVER, '1');
  else write(KEY_SNOOZE, String(Date.now()));
  $('welcome-modal')?.classList.remove('open');
}

export function initWelcome() {
  const modal = $('welcome-modal');
  if (!modal) return;

  $('welcome-close')?.addEventListener('click', close);
  modal.addEventListener('click', (e) => { if (e.target === modal) close(); });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && modal.classList.contains('open')) close();
  });
  // The rules link navigates away; treat that as a dismissal so it does not reappear
  // the moment they come back.
  modal.querySelector('a[href="/rules.html"]')?.addEventListener('click', () => {
    write(KEY_SNOOZE, String(Date.now()));
  });

  if (shouldShow()) modal.classList.add('open');
}
