const fs = require('fs-extra');
const path = require('path');
const pino = require('pino');
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, Browsers } = require('@whiskeysockets/baileys');
const config = require('../utils/config');
const mega = require('./mega.service');
const db = require('./db.service');

const active = new Map(); // `${userId}:${phone}` -> { sock, dir, timer }
const logger = pino({ level: 'silent' });

function key(userId, phone) { return `${userId}:${phone}`; }
async function snapshotAuth(dir) {
  const files = {};
  async function walk(folder, prefix = '') {
    for (const entry of await fs.readdir(folder, { withFileTypes: true })) {
      const full = path.join(folder, entry.name);
      const rel = path.posix.join(prefix, entry.name);
      if (entry.isDirectory()) await walk(full, rel);
      else files[rel] = (await fs.readFile(full)).toString('base64');
    }
  }
  await walk(dir);
  return Buffer.from(JSON.stringify({ version: 1, files }));
}
async function restoreAuth(dir, buffer) {
  const parsed = JSON.parse(buffer.toString('utf8'));
  if (parsed.version !== 1 || !parsed.files) throw new Error('Invalid session backup');
  await fs.emptyDir(dir);
  for (const [rel, b64] of Object.entries(parsed.files)) {
    const target = path.resolve(dir, rel);
    if (!target.startsWith(path.resolve(dir) + path.sep)) throw new Error('Invalid backup path');
    await fs.ensureDir(path.dirname(target));
    await fs.writeFile(target, Buffer.from(b64, 'base64'));
  }
}
async function persist(userId, chatId, phone, dir) {
  const snapshot = await snapshotAuth(dir);
  const uploaded = await mega.uploadSession(chatId, phone, snapshot);
  const previous = db.getSession(userId, phone);
  db.upsertSession({
    user_id: String(userId), chat_id: String(chatId), phone,
    mega_file_id: uploaded.fileId, connected_at: new Date().toISOString()
  });
  if (previous?.mega_file_id && previous.mega_file_id !== uploaded.fileId) {
    await mega.deletePrivateBackup(previous.mega_file_id).catch(() => {});
  }
}
async function startPairing({ userId, chatId, phone, onCode, onConnected, onFailure }) {
  const id = key(userId, phone);
  if (active.has(id)) throw new Error('A connection attempt for this number is already active');
  await fs.ensureDir(config.sessionTmpDir);
  const dir = path.join(config.sessionTmpDir, `${String(userId)}-${phone}-${Date.now()}`);
  await fs.ensureDir(dir);
  let sock;
  let finished = false;
  const timer = setTimeout(async () => {
    if (!finished) {
      finished = true;
      await cleanup(id);
      await onFailure?.('Pairing timed out after five minutes.');
    }
  }, 5 * 60 * 1000);

  try {
    const { state, saveCreds } = await useMultiFileAuthState(dir);
    sock = makeWASocket({
      auth: state,
      usePairingCode: true,
      logger,
      printQRInTerminal: false,
      browser: Browsers.macOS('Desktop'),
      syncFullHistory: false,
      markOnlineOnConnect: false
    });
    active.set(id, { sock, dir, timer });

    let backupTimer = null;
    let backupQueue = Promise.resolve();
    sock.ev.on('creds.update', async () => {
      await saveCreds();
      if (finished && sock.user) {
        clearTimeout(backupTimer);
        backupTimer = setTimeout(() => {
          backupQueue = backupQueue.then(() => persist(userId, chatId, phone, dir))
            .catch((err) => onFailure?.(`Connected, but refreshing the private MEGA backup failed: ${err.message}`));
        }, 2500);
      }
    });

    let codeSent = false;
    const requestCode = async () => {
      if (codeSent || finished || sock.authState?.creds?.registered) return;
      codeSent = true;
      try {
        const code = await sock.requestPairingCode(phone);
        await onCode?.(code);
      } catch (err) {
        codeSent = false;
        throw err;
      }
    };
    sock.ev.on('connection.update', async (update) => {
      if (update.qr && !codeSent) {
        try { await requestCode(); }
        catch (err) { finished = true; clearTimeout(timer); await cleanup(id); await onFailure?.(err.message); }
      }
      if (update.connection === 'open' && !finished) {
        finished = true;
        clearTimeout(timer);
        try {
          await saveCreds();
          await persist(userId, chatId, phone, dir);
          await onConnected?.();
        } catch (err) {
          await onFailure?.(`WhatsApp connected, but MEGA backup failed: ${err.message}`);
        }
      }
      if (update.connection === 'close' && !finished) {
        const status = update.lastDisconnect?.error?.output?.statusCode;
        finished = true;
        clearTimeout(timer);
        await cleanup(id);
        if (status !== DisconnectReason.loggedOut) await onFailure?.('WhatsApp connection closed before pairing completed.');
        else await onFailure?.('WhatsApp logged out before pairing completed.');
      }
    });
    // Some Baileys versions emit a connection update without QR before pairing code can be requested.
    setTimeout(() => {
      if (!codeSent && !finished) requestCode().catch(async (err) => {
        finished = true; clearTimeout(timer); await cleanup(id); await onFailure?.(err.message);
      });
    }, 1200);
  } catch (err) {
    clearTimeout(timer);
    await cleanup(id);
    throw err;
  }
}
async function cleanup(id) {
  const item = active.get(id);
  if (item) {
    clearTimeout(item.timer);
    try { item.sock.end(undefined); } catch {}
    await fs.remove(item.dir).catch(() => {});
    active.delete(id);
  }
}
async function restore(userId, chatId, phone, fileId) {
  const id = key(userId, phone);
  if (active.has(id)) return active.get(id).sock;
  const dir = path.join(config.sessionTmpDir, `${String(userId)}-${phone}-restore-${Date.now()}`);
  await fs.ensureDir(dir);
  const buffer = await mega.downloadSession(fileId);
  await restoreAuth(dir, buffer);
  const { state, saveCreds } = await useMultiFileAuthState(dir);
  const sock = makeWASocket({ auth: state, logger, browser: Browsers.macOS('Desktop'), syncFullHistory: false });
  active.set(id, { sock, dir, timer: null });
  sock.ev.on('creds.update', async () => { await saveCreds(); });
  sock.ev.on('connection.update', async ({ connection }) => {
    if (connection === 'close') await cleanup(id);
  });
  return sock;
}
async function disconnect(userId, phone) { await cleanup(key(userId, phone)); }
async function shutdown() {
  for (const id of [...active.keys()]) await cleanup(id);
}
module.exports = { startPairing, restore, disconnect, shutdown };
