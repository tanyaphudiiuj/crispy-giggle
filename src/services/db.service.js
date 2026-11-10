const Database = require('better-sqlite3');
const fs = require('fs-extra');
const path = require('path');
const config = require('../utils/config');

let db;
function init() {
  fs.ensureDirSync(path.dirname(config.dbPath));
  db = new Database(config.dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      user_id TEXT PRIMARY KEY,
      chat_id TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sessions (
      user_id TEXT NOT NULL,
      chat_id TEXT NOT NULL,
      phone TEXT NOT NULL,
      mega_file_id TEXT NOT NULL,
      connected_at TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'connected',
      PRIMARY KEY(user_id, phone),
      FOREIGN KEY(user_id) REFERENCES users(user_id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS allowed_checks (
      user_id TEXT NOT NULL,
      phone TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY(user_id, phone)
    );
    CREATE TABLE IF NOT EXISTS stats (
      key TEXT PRIMARY KEY,
      value INTEGER NOT NULL DEFAULT 0
    );
    INSERT OR IGNORE INTO stats(key, value) VALUES ('checks', 0);
  `);
}
function get() { if (!db) throw new Error('Database not initialized'); return db; }
function touchUser(userId, chatId) {
  get().prepare(`INSERT INTO users(user_id,chat_id,created_at) VALUES(?,?,?)
    ON CONFLICT(user_id) DO UPDATE SET chat_id=excluded.chat_id`)
    .run(String(userId), String(chatId), new Date().toISOString());
}
function listSessions(userId) {
  return get().prepare('SELECT * FROM sessions WHERE user_id=? AND status=?').all(String(userId), 'connected');
}
function getSession(userId, phone) {
  return get().prepare('SELECT * FROM sessions WHERE user_id=? AND phone=?').get(String(userId), phone);
}
function upsertSession(row) {
  get().prepare(`INSERT INTO sessions(user_id,chat_id,phone,mega_file_id,connected_at,status)
    VALUES(@user_id,@chat_id,@phone,@mega_file_id,@connected_at,'connected')
    ON CONFLICT(user_id,phone) DO UPDATE SET
      chat_id=excluded.chat_id, mega_file_id=excluded.mega_file_id,
      connected_at=excluded.connected_at,status='connected'`).run(row);
}
function deleteSession(userId, phone) {
  return get().prepare('DELETE FROM sessions WHERE user_id=? AND phone=?').run(String(userId), phone).changes > 0;
}
function listUsers() {
  return get().prepare(`SELECT u.user_id,u.chat_id,u.created_at,COUNT(s.phone) AS sessions
    FROM users u LEFT JOIN sessions s ON s.user_id=u.user_id AND s.status='connected'
    GROUP BY u.user_id ORDER BY u.created_at DESC`).all();
}
function stats() {
  const users = get().prepare('SELECT COUNT(*) n FROM users').get().n;
  const sessions = get().prepare("SELECT COUNT(*) n FROM sessions WHERE status='connected'").get().n;
  const checks = get().prepare("SELECT value FROM stats WHERE key='checks'").get().value;
  return { users, sessions, checks };
}
function incrementChecks(n) { get().prepare("UPDATE stats SET value=value+? WHERE key='checks'").run(n); }
function allowCheck(userId, phone) {
  get().prepare('INSERT OR IGNORE INTO allowed_checks(user_id,phone,created_at) VALUES(?,?,?)')
    .run(String(userId), phone, new Date().toISOString());
}
function isAllowed(userId, phone) {
  return !!get().prepare('SELECT 1 FROM allowed_checks WHERE user_id=? AND phone=?').get(String(userId), phone);
}
function close() { if (db) db.close(); db = null; }

module.exports = { init, get, touchUser, listSessions, getSession, upsertSession, deleteSession, listUsers, stats, incrementChecks, allowCheck, isAllowed, close };
