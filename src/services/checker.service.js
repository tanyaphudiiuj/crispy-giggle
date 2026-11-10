const baileys = require('./baileys.service');
const db = require('./db.service');
const config = require('../utils/config');
const recent = new Map();

function normalize(value) {
  const phone = String(value || '').replace(/[\s()-]/g, '');
  return /^\+?\d{7,15}$/.test(phone) ? phone.replace(/^\+/, '') : null;
}
function rateLimit(userId) {
  const now = Date.now();
  const list = (recent.get(String(userId)) || []).filter((t) => now - t < 60000);
  if (list.length >= config.checkRateLimit) return false;
  list.push(now); recent.set(String(userId), list); return true;
}
async function checkAllowed(userId, chatId, phones) {
  if (!rateLimit(userId)) throw new Error('Rate limit reached. Try again in a minute.');
  const sessions = db.listSessions(userId);
  if (!sessions.length) throw new Error('Connect your own WhatsApp account first with /connect.');
  const sock = await baileys.restore(userId, chatId, sessions[0].phone, sessions[0].mega_file_id);
  const registered = [], unregistered = [], skipped = [];
  for (const raw of phones) {
    const phone = normalize(raw);
    if (!phone) { skipped.push(raw); continue; }
    if (!db.isAllowed(userId, phone)) { skipped.push(phone); continue; }
    const result = await sock.onWhatsApp(phone);
    if (result?.[0]?.exists) registered.push(phone);
    else unregistered.push(phone);
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  db.incrementChecks(registered.length + unregistered.length);
  return { registered, unregistered, skipped };
}
module.exports = { normalize, checkAllowed };
