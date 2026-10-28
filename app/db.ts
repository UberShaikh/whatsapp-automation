import { Pool } from 'pg';
import type { PoolClient } from 'pg';

export function createPool(databaseUrl: string) {
  const pool=new Pool({ connectionString: databaseUrl, max: 5, connectionTimeoutMillis: 10000,
    idleTimeoutMillis: 30000, statement_timeout: 15000, lock_timeout: 5000 });
  pool.on('error',()=> console.error(JSON.stringify({ event:'database_connection_error' })));
  return pool;
}

export async function transaction<T>(pool: Pool, work: (db: PoolClient)=>Promise<T>): Promise<T> {
  const db=await pool.connect();
  let broken=false;
  try {
    await db.query('BEGIN');
    const result=await work(db);
    await db.query('COMMIT');
    return result;
  } catch (error) {
    await db.query('ROLLBACK').catch(()=>{broken=true;});
    throw error;
  } finally { db.release(broken); }
}

export async function assertSchema(pool: Pool) {
  const { rows }=await pool.query("SELECT version FROM grocery_dev.schema_migrations WHERE version IN ('001','002')");
  if (rows.length !== 2) throw new Error('Run npm run db:migrate explicitly before starting the runtime');
}
