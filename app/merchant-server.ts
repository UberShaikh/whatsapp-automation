import { loadConfig } from '../scripts/seed-groceries.ts';
import { createPool } from './db.ts';
import { createMerchantApp,verifySupabaseUser } from './merchant-app.ts';

async function main() {
  const pool=createPool(loadConfig());
  try {
    const url=new URL(process.env.SUPABASE_URL??'');
    const key=process.env.SUPABASE_PUBLISHABLE_KEY?.trim();
    if (url.protocol!=='https:' || url.username || url.password || url.search || url.hash || url.pathname!=='/' || !key || key.startsWith('sb_secret_')) throw new Error('Configure Supabase URL and publishable key');
    const version=await pool.query("SELECT 1 FROM grocery_dev.schema_migrations WHERE version='005'");
    if (!version.rowCount) throw new Error('Run the manual migration');
    const port=Number(process.env.MERCHANT_API_PORT??3001);
    if (!Number.isInteger(port) || port<1 || port>65535) throw new Error('Invalid merchant API port');
    const server=createMerchantApp(pool,verifySupabaseUser(url.origin,key)).listen(port,'127.0.0.1',()=>console.log(`Merchant API ready at http://127.0.0.1:${port}`));
    const stop=()=>server.close(()=>{void pool.end();});
    process.once('SIGINT',stop);process.once('SIGTERM',stop);
  } catch(error) {await pool.end();throw error;}
}
if (import.meta.main) main().catch(()=>{console.error('Merchant API could not start. Check DATABASE_URL, Supabase public settings and migration 005.');process.exitCode=1;});
