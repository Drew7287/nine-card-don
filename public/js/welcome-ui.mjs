// welcome-ui.mjs — First-visit welcome, with a "don't show this again" toggle.
//
// The toggle is the ONLY thing that hides it. Closing without ticking means it shows
// again next visit, which is what "don't show this again" implies by its existence.
// An earlier version also snoozed it for 7 days on a plain dismissal; that was clever
// beyond the brief and made the box look broken.

const $ = (id) => document.getElementById(id);

const KEY_NEVER = 'don-welcome-never';
const KEY_LEGACY_SNOOZE = 'don-welcome-snooze';   // written by the old version

// localStorage throws in private mode on some browsers, and a welcome box must never
// be the reason the lobby fails to load.
function read(key) {
  try { return localStorage.getItem(key); } catch { return null; }
}
function write(key, value) {
  try { localStorage.setItem(key, value); } catch { /* nothing to do */ }
}
function remove(key) {
  try { localStorage.removeItem(key); } catch { /* nothing to do */ }
}

function close() {
  if ($('welcome-hide')?.checked) write(KEY_NEVER, '1');
  $('welcome-modal')?.classList.remove('open');
}

export function initWelcome() {
  const modal = $('welcome-modal');
  if (!modal) return;

  // Anyone carrying a snooze from the old build would keep seeing nothing for up to a
  // week. Clear it so they get the behaviour they actually asked for.
  remove(KEY_LEGACY_SNOOZE);

  $('welcome-close')?.addEventListener('click', close);
  modal.addEventListener('click', (e) => { if (e.target === modal) close(); });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && modal.classList.contains('open')) close();
  });

  if (read(KEY_NEVER) !== '1') modal.classList.add('open');
}
