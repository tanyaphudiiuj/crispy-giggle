require('dotenv').config();
const { Telegraf } = require('telegraf');
const pino = require('pino');
const config = require('./utils/config');
const db = require('./services/db.service');
const sessionService = require('./services/session.service');
const { registerCommands } = require('./commands');
const logger = pino({ level: process.env.LOG_LEVEL || 'info' });

async function main() {
  if (!config.botToken) throw new Error('BOT_TOKEN is required');
  db.init();
  const bot = new Telegraf(config.botToken);

  bot.catch((err, ctx) => {
    logger.error({ err, updateId: ctx?.update?.update_id }, 'Telegram handler failed');
    ctx?.reply?.('⚠️ Something went wrong. Please try again.').catch(() => {});
  });

  registerCommands(bot, { logger });
  await bot.launch();
  logger.info('XD WS CHECKER BOT started');

  const shutdown = async (signal) => {
    logger.info({ signal }, 'Shutting down');
    bot.stop(signal);
    await sessionService.shutdown();
    db.close();
    process.exit(0);
  };
  process.once('SIGINT', () => shutdown('SIGINT'));
  process.once('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((err) => {
  console.error('Fatal startup error:', err);
  process.exit(1);
});
