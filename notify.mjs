// notify.mjs — Push short messages to Drew's Telegram.
//
// Reuses the existing MARVIN bot, so there is no new service and no new account.
// Messages land in the same chat as MARVIN, hence the fixed prefixes below: they are
// what makes game traffic scannable against everything else in that chat.
//
// Config (Render environment):
//   TELEGRAM_BOT_TOKEN   required, or this module is inert
//   TELEGRAM_CHAT_ID     required, or this module is inert
//   NOTIFY_VISITS        'off' to silence visit pings entirely (default on)
//   VISIT_QUIET_MINUTES  minimum gap between visit pings (default 10)
//
// Inert-by-default matters: with the variables unset nothing is sent and nothing throws,
// so a local run or a fork never messages anybody.

const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const VISITS_ON = (process.env.NOTIFY_VISITS || 'on').toLowerCase() !== 'off';
const VISIT_QUIET_MS = Number(process.env.VISIT_QUIET_MINUTES || 10) * 60_000;

export const enabled = Boolean(TOKEN && CHAT_ID);

// Telegram allows bursts but Drew's attention does not. One message per second, in order.
const queue = [];
let draining = false;
const MAX_QUEUE = 50;

async function drain() {
  if (draining) return;
  draining = true;
  while (queue.length) {
    const text = queue.shift();
    try {
      const res = await fetch(`https://api.telegram.org/bot${TOKEN}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: CHAT_ID,
          text,
          disable_web_page_preview: true,
        }),
      });
      if (!res.ok) console.error('telegram send failed:', res.status, (await res.text()).slice(0, 200));
    } catch (err) {
      console.error('telegram send error:', err.message);
    }
    await new Promise(r => setTimeout(r, 1000));
  }
  draining = false;
}

/** Queue a message. Never throws, never blocks the caller. */
export function send(text) {
  try {
    if (!enabled) return;
    if (queue.length >= MAX_QUEUE) return;   // something is looping; drop rather than flood
    queue.push(String(text).slice(0, 3500)); // Telegram hard limit is 4096
    drain();
  } catch (err) {
    console.error('notify.send failed:', err.message);
  }
}

// --- Visit pings ------------------------------------------------------------
// One ping, then a quiet window. Suppressed visits are counted and reported in the
// next ping rather than dropped, because the client force-reconnects on tab resume
// and on bfcache restore, so one player can open several sockets in a minute.

let lastVisitPing = 0;
let suppressed = 0;

export function visit({ country, ua }) {
  if (!enabled || !VISITS_ON) return;
  const now = Date.now();
  if (now - lastVisitPing < VISIT_QUIET_MS) {
    suppressed += 1;
    return;
  }
  const extra = suppressed ? ` (+${suppressed} more in the last ${Math.round(VISIT_QUIET_MS / 60000)} min)` : '';
  lastVisitPing = now;
  suppressed = 0;
  const where = country ? ` from ${country}` : '';
  send(`Don: visit${where}${extra}\n${ua || 'unknown device'}`);
}

// --- The one Drew actually cares about --------------------------------------

export function gameStarted({ humans, ais, quickPlay }) {
  if (!enabled) return;
  if (humans < 2) return;   // solo-vs-bots is the norm; pinging it would drown the signal
  send(
    `Don: GAME WITH ${humans} HUMANS 🎉\n` +
    `${humans} human${humans > 1 ? 's' : ''}, ${ais} bot${ais === 1 ? '' : 's'}` +
    `${quickPlay ? ', via Quick Play' : ', private room'}`
  );
}

export function feedback({ message, name, email, context }) {
  const who = [name, email].filter(Boolean).join(' / ') || 'anonymous';
  send(
    `Don: FEEDBACK from ${who}\n\n${message}\n\n` +
    `--\n${context || 'no context'}` +
    (email ? '' : '\n(no email given, cannot reply)')
  );
}

if (!enabled) {
  console.log('notify: TELEGRAM_BOT_TOKEN/TELEGRAM_CHAT_ID not set, notifications disabled');
}
