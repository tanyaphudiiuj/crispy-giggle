const path = require('path');

const admins = (process.env.ADMIN_IDS || '')
  .split(',')
  .map((x) => x.trim())
  .filter(Boolean);

const key = process.env.SESSION_ENCRYPTION_KEY || '';
if (key && !/^[a-f0-9]{64}$/i.test(key)) {
  throw new Error('SESSION_ENCRYPTION_KEY must be exactly 64 hexadecimal characters');
}

module.exports = {
  botToken: process.env.BOT_TOKEN,
  adminIds: new Set(admins),
  megaEmail: process.env.MEGA_EMAIL,
  megaPassword: process.env.MEGA_PASSWORD,
  encryptionKey: key ? Buffer.from(key, 'hex') : null,
  dbPath: path.resolve(process.env.DB_PATH || './data/bot.sqlite'),
  sessionTmpDir: path.resolve(process.env.SESSION_TMP_DIR || './tmp/sessions'),
  welcomeImageUrl: process.env.WELCOME_IMAGE_URL || 'https://files.catbox.moe/dgxrag.jpg',
  checkRateLimit: Number(process.env.CHECK_RATE_LIMIT || 5)
};
