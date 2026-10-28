import { parseArgs } from 'node:util';
import { createClient } from './seed-groceries.ts';
import { uuid } from '../app/merchant-inventory.ts';

async function main() {
  const {values}=parseArgs({options:{user:{type:'string'},revoke:{type:'boolean',default:false}}});
  if (!uuid(values.user)) throw new Error('Supply --user with the confirmed Supabase user UUID');
  const db=createClient();await db.connect();
  try {
    if (values.revoke) {
      const revoked=await db.query(`UPDATE grocery_dev.merchant_access SET is_active=false,granted_by=current_user,granted_at=now()
        WHERE user_id=$1 AND location_code='DEMO-STORE' RETURNING user_id`,[values.user]);
      if (!revoked.rowCount) throw new Error('No existing access grant');
    } else {
      const user=await db.query('SELECT id FROM auth.users WHERE id=$1 AND email_confirmed_at IS NOT NULL AND NOT is_anonymous',[values.user]);
      if (!user.rowCount) throw new Error('No confirmed user in this database Auth project');
      await db.query(`INSERT INTO grocery_dev.merchant_access(user_id,location_code) VALUES ($1,'DEMO-STORE')
        ON CONFLICT (user_id,location_code) DO UPDATE SET is_active=true,granted_by=current_user,granted_at=now()`,[values.user]);
    }
    console.log(values.revoke?'Merchant access revoked. Audit history retained.':'Merchant access granted for DEMO-STORE.');
  } finally {await db.end();}
}
if (import.meta.main) main().catch(()=>{console.error('Merchant access could not be changed. Check the user UUID, confirmed email, matching Supabase project and migration 005.');process.exitCode=1;});
