// feedback-ui.mjs — Feedback button/modal and the announcement banner.

const $ = (id) => document.getElementById(id);

function currentContext() {
  // Enough for a report to be actionable without asking the player to describe setup.
  const screen = ['lobby', 'room', 'game'].find(
    s => $(`${s}-screen`)?.classList.contains('active')
  ) || 'unknown';
  const code = $('room-code-display')?.textContent?.trim();
  return [
    `screen: ${screen}`,
    code ? `room: ${code}` : null,
    `viewport: ${window.innerWidth}x${window.innerHeight}`,
    `ua: ${navigator.userAgent}`,
  ].filter(Boolean).join(' | ');
}

function setOpen(open) {
  $('feedback-modal')?.classList.toggle('open', open);
  if (open) $('feedback-message')?.focus();
}

async function sendFeedback() {
  const btn = $('feedback-send');
  const status = $('feedback-status');
  const message = $('feedback-message').value.trim();

  if (message.length < 3) {
    status.textContent = 'Type a message first.';
    status.className = 'feedback-status error';
    return;
  }

  btn.disabled = true;
  status.textContent = 'Sending…';
  status.className = 'feedback-status';

  try {
    const res = await fetch('/feedback', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message,
        name: $('feedback-name').value.trim(),
        email: $('feedback-email').value.trim(),
        context: currentContext(),
      }),
    });
    const data = await res.json().catch(() => ({}));

    if (res.ok) {
      status.textContent = 'Sent. Thank you.';
      status.className = 'feedback-status ok';
      $('feedback-message').value = '';
      setTimeout(() => { setOpen(false); status.textContent = ''; }, 1200);
    } else {
      status.textContent = data.error || 'Could not send, try again later.';
      status.className = 'feedback-status error';
    }
  } catch {
    status.textContent = 'No connection. Try again later.';
    status.className = 'feedback-status error';
  } finally {
    btn.disabled = false;
  }
}

async function loadAnnouncement() {
  try {
    const res = await fetch('/announcement');
    const { text } = await res.json();
    if (!text) return;
    if (localStorage.getItem('don-announcement-dismissed') === text) return;

    // textContent, never innerHTML: this string is set by an operator but it renders
    // for every player, so it stays inert regardless.
    $('announcement-text').textContent = text;
    $('announcement-banner').classList.add('visible');
    // On narrow screens the feedback button lives at the top too; without this the
    // banner sits over it and swallows the tap.
    document.body.classList.add('has-announcement');
    $('announcement-close').addEventListener('click', () => {
      $('announcement-banner').classList.remove('visible');
      document.body.classList.remove('has-announcement');
      try { localStorage.setItem('don-announcement-dismissed', text); } catch {}
    });
  } catch {
    // A missing announcement must never stop the game loading.
  }
}

export function initFeedback() {
  $('feedback-btn')?.addEventListener('click', () => setOpen(true));
  $('feedback-cancel')?.addEventListener('click', () => setOpen(false));
  $('feedback-send')?.addEventListener('click', sendFeedback);
  $('feedback-modal')?.addEventListener('click', (e) => {
    if (e.target.id === 'feedback-modal') setOpen(false);
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') setOpen(false);
  });
  loadAnnouncement();
}
