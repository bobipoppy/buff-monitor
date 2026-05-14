const Database = require('better-sqlite3');
const path = require('path');
const { app } = require('electron');

let db = null;

function getDbPath() {
  const userDataPath = app.isPackaged ? app.getPath('userData') : path.join(__dirname, '..');
  return path.join(userDataPath, 'buff-monitor.db');
}

function initDatabase() {
  const dbPath = getDbPath();
  db = new Database(dbPath);

  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  db.exec(`
    CREATE TABLE IF NOT EXISTS items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      goods_id INTEGER UNIQUE NOT NULL,
      name TEXT NOT NULL,
      game TEXT NOT NULL DEFAULT 'csgo',
      category TEXT,
      image_url TEXT,
      steam_price REAL,
      buff_min_price REAL NOT NULL DEFAULT 0,
      sell_count INTEGER NOT NULL DEFAULT 0,
      watch_priority TEXT NOT NULL DEFAULT 'normal',
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS price_records (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      item_id INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
      price REAL NOT NULL,
      avg_price REAL,
      volume INTEGER NOT NULL DEFAULT 0,
      sell_count INTEGER NOT NULL DEFAULT 0,
      recorded_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS portfolio (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      item_id INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
      buy_price REAL NOT NULL,
      quantity INTEGER NOT NULL DEFAULT 1,
      buy_date TEXT NOT NULL,
      target_price REAL,
      stop_loss_price REAL,
      sold_price REAL,
      sold_date TEXT,
      status TEXT NOT NULL DEFAULT 'holding',
      notes TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS alert_rules (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      item_id INTEGER REFERENCES items(id) ON DELETE CASCADE,
      portfolio_id INTEGER REFERENCES portfolio(id) ON DELETE CASCADE,
      type TEXT NOT NULL,
      condition TEXT NOT NULL,
      threshold REAL NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      last_triggered_at TEXT,
      cooldown_minutes INTEGER NOT NULL DEFAULT 240,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS alert_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      rule_id INTEGER REFERENCES alert_rules(id) ON DELETE SET NULL,
      item_id INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
      message TEXT NOT NULL,
      current_price REAL NOT NULL,
      triggered_at TEXT DEFAULT (datetime('now')),
      notified INTEGER NOT NULL DEFAULT 0
    );

    CREATE INDEX IF NOT EXISTS idx_price_records_item_time ON price_records(item_id, recorded_at DESC);
    CREATE INDEX IF NOT EXISTS idx_portfolio_status ON portfolio(status);
    CREATE INDEX IF NOT EXISTS idx_items_goods_id ON items(goods_id);
    CREATE INDEX IF NOT EXISTS idx_alert_logs_triggered ON alert_logs(triggered_at DESC);
  `);

  console.log('SQLite database initialized at:', dbPath);
  return db;
}

function getDb() {
  if (!db) throw new Error('Database not initialized');
  return db;
}

function closeDatabase() {
  if (db) {
    db.close();
    db = null;
  }
}

module.exports = { initDatabase, getDb, closeDatabase };
