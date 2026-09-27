import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Initializes and migrates the SQLite database.
 * Supports file paths as well as ':memory:' for isolated testing.
 */
export function initDatabase(dbPath: string): DatabaseSync {
  if (dbPath !== ':memory:') {
    const dir = path.dirname(path.resolve(dbPath));
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }

  const db = new DatabaseSync(dbPath);

  // Enable WAL mode for better concurrency and durability if file-backed
  if (dbPath !== ':memory:') {
    db.exec('PRAGMA journal_mode = WAL;');
  }

  // Create payment decisions table
  db.exec(`
    CREATE TABLE IF NOT EXISTS payment_decisions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp TEXT NOT NULL,
      seller TEXT NOT NULL,
      endpoint TEXT NOT NULL,
      decision TEXT NOT NULL CHECK(decision IN ('paid', 'refused')),
      amount_base_units TEXT NOT NULL,
      network TEXT,
      asset TEXT,
      reason TEXT NOT NULL,
      tx_hash TEXT,
      payment_requirements TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_decisions_decision ON payment_decisions(decision);
    CREATE INDEX IF NOT EXISTS idx_decisions_timestamp ON payment_decisions(timestamp);
  `);

  return db;
}
