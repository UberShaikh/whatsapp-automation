import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { createClient, initSchema, LOCK_ID } from './seed-groceries.ts';

export async function migrate() {
  const db = createClient();
  try {
    await db.connect();
    await db.query('BEGIN');
    await db.query('SELECT pg_advisory_xact_lock($1)', [LOCK_ID]);
    await initSchema(db);
    const directory = new URL('../migrations/',import.meta.url);
    for (const file of readdirSync(directory).filter(f => /^\d{3}_.+\.sql$/.test(f) && !f.startsWith('001_')).sort()) {
      const version = file.slice(0,3);
      const sql = readFileSync(new URL(file,directory),'utf8').replace(/\r\n/g,'\n');
      const checksum = createHash('sha256').update(sql).digest('hex');
      const { rows } = await db.query('SELECT checksum FROM grocery_dev.schema_migrations WHERE version=$1',[version]);
      if (rows.length) {
        if (rows[0].checksum !== checksum) throw new Error('Migration checksum mismatch');
        continue;
      }
      await db.query(sql);
      await db.query('INSERT INTO grocery_dev.schema_migrations(version,checksum) VALUES ($1,$2)',[version,checksum]);
    }
    await db.query('COMMIT');
    console.log('Database migrations are up to date. No seed data was imported.');
  } catch (error) {
    await db.query('ROLLBACK').catch(() => {});
    throw error;
  } finally { await db.end(); }
}

if (import.meta.main) migrate().catch(() => {
  console.error('Migration failed; transaction rolled back. Check database access and migration checksums.');
  process.exitCode=1;
});
