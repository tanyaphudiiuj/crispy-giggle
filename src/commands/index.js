const fs = require('fs-extra');
const path = require('path');
const XLSX = require('xlsx');
const db = require('../services/db.service');
const pairing = require('../services/baileys.service');
const checker = require('../services/checker.service');
const config = require('../utils/config');

const pendingExports = new Map();
const phoneRe = /^\+?\d{7,15}$/;
const html = (s) => String(s).replace(/[&<>"]/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const isAdmin = (id) => config.adminIds.has(String(id));

function registerCommands(bot, { logger }) {
  bot.use(async (ctx, next) => {
    if (ctx.from && ctx.chat) db.touchUser(ctx.from.id, ctx.chat.id);
    return next();
  });

  bot.start(async (ctx) => {
    const caption = `<b>XD WS CHECKER BOT</b>\\nPrivate WhatsApp account linking and authorized number checks.\\n\\n/connect 559455836487 — Link your WhatsApp\\n/sessions — Your linked accounts\\n/allowcheck 559455836487 — Authorize a number you own\\n/check — Check authorized numbers\\n/help — Help`;
    const keyboard = { inline_keyboard: [
      [{ text: '🔗 Connect WhatsApp', callback_data: 'connect_help' }],
      [{ text: '✅ Check Numbers', callback_data: 'check_help' }, { text: 'ℹ️ Help', callback_data: 'help' }]
    ] };
    try { await ctx.replyWithPhoto(config.welcomeImageUrl, { caption, parse_mode: 'HTML', reply_markup: keyboard }); }
    catch { await ctx.reply(caption, { parse_mode: 'HTML', reply_markup: keyboard }); }
  });

  bot.help(async (ctx) => ctx.reply('Use /connect <number> to link your own WhatsApp. Use /allowcheck <number> to add a number you own or have permission to check, then /check. Use /sessions to see linked accounts.'));
  bot.command('connect', async (ctx) => {
    const phone = (ctx.message.text.split(/\s+/)[1] || '').replace(/^\+/, '');
    if (!phoneRe.test(phone)) return ctx.reply('Invalid number. Use international format, e.g. /connect 559455836487');
    const userId = String(ctx.from.id), chatId = String(ctx.chat.id);
    await ctx.reply('⏳ Generating pairing code...');
    try {
      await pairing.startPairing({
        userId, chatId, phone,
        onCode: (code) => ctx.reply(`🔑 Your pairing code: <code>${html(code)}</code>\nOpen WhatsApp → Linked Devices → Link with phone number.`, { parse_mode: 'HTML' }),
        onConnected: () => ctx.reply(`✅ WhatsApp ${html(phone)} connected. Its encrypted private backup was saved to MEGA.`, { parse_mode: 'HTML' }),
        onFailure: (message) => ctx.reply(`⚠️ ${html(message)}`, { parse_mode: 'HTML' })
      });
    } catch (err) { logger.error({ err }, 'Pairing start failed'); await ctx.reply(`⚠️ ${html(err.message)}`, { parse_mode: 'HTML' }); }
  });

  bot.command('sessions', async (ctx) => {
    const rows = db.listSessions(ctx.from.id);
    if (!rows.length) return ctx.reply('No linked WhatsApp accounts yet.');
    await ctx.reply('Your linked accounts:\n' + rows.map((r) => `• ${r.phone} — ${r.status}`).join('\n'));
  });

  bot.command('disconnect', async (ctx) => {
    const phone = (ctx.message.text.split(/\s+/)[1] || '').replace(/^\+/, '');
    if (!phoneRe.test(phone)) return ctx.reply('Usage: /disconnect <number>');
    const row = db.getSession(ctx.from.id, phone);
    if (!row) return ctx.reply('That number is not linked to your account.');
    await pairing.disconnect(ctx.from.id, phone);
    db.deleteSession(ctx.from.id, phone);
    const mega = require('../services/mega.service');
    await mega.deletePrivateBackup(row.mega_file_id).catch(() => {});
    await ctx.reply(`🗑 Disconnected ${phone} and removed its private backup.`);
  });

  bot.command('allowcheck', async (ctx) => {
    const phone = (ctx.message.text.split(/\s+/)[1] || '').replace(/^\+/, '');
    if (!phoneRe.test(phone)) return ctx.reply('Usage: /allowcheck <number> (only numbers you own or have permission to check)');
    db.allowCheck(ctx.from.id, phone);
    await ctx.reply(`✅ ${phone} added to your authorized check list.`);
  });

  bot.command('check', async (ctx) => {
    const arg = ctx.message.text.replace(/^\/check(?:@\w+)?\s*/, '').trim();
    const lines = arg ? arg.split(/\r?\n/) : [];
    if (!lines.length) return ctx.reply('Add numbers with /allowcheck first, then send /check followed by one or more authorized numbers.');
    await runCheck(ctx, lines);
  });

  bot.on('document', async (ctx) => {
    const doc = ctx.message.document;
    if (!doc.file_name?.toLowerCase().endsWith('.txt')) return;
    const link = await ctx.telegram.getFileLink(doc.file_id);
    const axios = require('axios');
    const response = await axios.get(link.href, { responseType: 'text', timeout: 30000, maxContentLength: 2 * 1024 * 1024 });
    await runCheck(ctx, String(response.data).split(/\r?\n/));
  });

  async function runCheck(ctx, lines) {
    const cleaned = lines.map((x) => x.trim()).filter(Boolean);
    if (!cleaned.length) return ctx.reply('No numbers found.');
    await ctx.reply('⏳ Checking numbers on your linked WhatsApp account...');
    try {
      const result = await checker.checkAllowed(ctx.from.id, ctx.chat.id, cleaned);
      pendingExports.set(`${ctx.from.id}:${ctx.chat.id}`, result);
      await ctx.reply(
        `📊 Results: ${result.registered.length} registered, ${result.unregistered.length} unregistered, ${result.skipped.length} skipped.\nChoose export format:`,
        { reply_markup: { inline_keyboard: [[
          { text: '📄 .txt', callback_data: 'export_txt' },
          { text: '📊 .xlsx', callback_data: 'export_xlsx' }
        ]] } }
      );
    } catch (err) { await ctx.reply(`⚠️ ${html(err.message)}`, { parse_mode: 'HTML' }); }
  }

  bot.action(/^export_(txt|xlsx)$/, async (ctx) => {
    const result = pendingExports.get(`${ctx.from.id}:${ctx.chat.id}`);
    if (!result) return ctx.answerCbQuery('No recent results found.');
    const format = ctx.match[1];
    const tmp = path.join(config.sessionTmpDir, `export-${ctx.from.id}-${Date.now()}.${format}`);
    await fs.ensureDir(path.dirname(tmp));
    try {
      if (format === 'txt') {
        const content = `✅ REGISTERED\n${result.registered.join('\n')}\n\n❌ UNREGISTERED\n${result.unregistered.join('\n')}\n\n⚠️ SKIPPED (not authorized or invalid)\n${result.skipped.join('\n')}\n`;
        await fs.writeFile(tmp, content);
      } else {
        const wb = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['Phone'], ...result.registered.map((x) => [x])]), 'Registered');
        XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['Phone'], ...result.unregistered.map((x) => [x])]), 'Unregistered');
        XLSX.writeFile(wb, tmp);
      }
      await ctx.replyWithDocument({ source: tmp, filename: `whatsapp-check-${Date.now()}.${format}` });
      await ctx.answerCbQuery('Export sent');
    } finally { await fs.remove(tmp).catch(() => {}); }
  });

  bot.action('connect_help', (ctx) => ctx.answerCbQuery('Use /connect <international number>', { show_alert: true }));
  bot.action('check_help', (ctx) => ctx.answerCbQuery('Authorize your own number with /allowcheck first, then /check', { show_alert: true }));
  bot.action('help', async (ctx) => { await ctx.answerCbQuery(); await ctx.reply('Commands: /connect, /sessions, /disconnect, /allowcheck, /check, /help'); });

  bot.command('admin', async (ctx) => {
    if (!isAdmin(ctx.from.id)) return ctx.reply('Not authorized.');
    await ctx.reply('Admin panel', { reply_markup: { inline_keyboard: [
      [{ text: '👥 Users', callback_data: 'admin_users' }, { text: '📊 Stats', callback_data: 'admin_stats' }],
      [{ text: '📢 Broadcast', callback_data: 'admin_broadcast' }]
    ] } });
  });
  bot.action('admin_users', async (ctx) => {
    if (!isAdmin(ctx.from.id)) return ctx.answerCbQuery('Not authorized', { show_alert: true });
    const users = db.listUsers();
    await ctx.answerCbQuery();
    await ctx.reply(users.slice(0, 50).map((u) => `${u.user_id} — ${u.sessions} session(s)`).join('\n') || 'No users yet.');
  });
  bot.action('admin_stats', async (ctx) => {
    if (!isAdmin(ctx.from.id)) return ctx.answerCbQuery('Not authorized', { show_alert: true });
    const s = db.stats(); await ctx.answerCbQuery();
    await ctx.reply(`Users: ${s.users}\nSessions: ${s.sessions}\nChecks: ${s.checks}`);
  });
  bot.action('admin_broadcast', async (ctx) => {
    if (!isAdmin(ctx.from.id)) return ctx.answerCbQuery('Not authorized', { show_alert: true });
    await ctx.answerCbQuery();
    await ctx.reply('Send /broadcast <message> to broadcast to all registered users.');
  });
  bot.command('broadcast', async (ctx) => {
    if (!isAdmin(ctx.from.id)) return ctx.reply('Not authorized.');
    const message = ctx.message.text.replace(/^\/broadcast\s*/, '');
    if (!message) return ctx.reply('Usage: /broadcast <message>');
    let sent = 0;
    for (const user of db.listUsers()) {
      try { await ctx.telegram.sendMessage(user.chat_id, message); sent++; } catch (err) { logger.warn({ err, user: user.user_id }, 'Broadcast failed'); }
      await new Promise((r) => setTimeout(r, 40));
    }
    await ctx.reply(`Broadcast completed. Sent to ${sent} user(s).`);
  });
}

module.exports = { registerCommands };
