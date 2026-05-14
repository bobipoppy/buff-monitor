import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { getPool, closePool } from './db';
import { logger } from '../utils/logger';

async function migrate() {
  const schemaPath = path.join(__dirname, 'schema.sql');
  const sql = fs.readFileSync(schemaPath, 'utf-8');

  const pool = getPool();
  try {
    await pool.query(sql);
    logger.info('Database migration completed successfully');
  } catch (err) {
    logger.error({ err }, 'Migration failed');
    process.exit(1);
  } finally {
    await closePool();
  }
}

migrate();
