import { parseArgs } from 'node:util';
import { loadConfig } from '../app/config.ts';
import { assertSchema,createPool,transaction } from '../app/db.ts';

async function main() {
  const {values}=parseArgs({options:{retry:{type:'string'}}});
  const config=loadConfig(); const pool=createPool(config.databaseUrl);
  const scope=[config.businessAccountId,config.phoneNumberId,config.mode];
  try {
    await assertSchema(pool);
    if (values.retry) {
      if (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(values.retry)) throw new Error('Invalid job ID');
      await transaction(pool,async db=>{
        const result=await db.query(`UPDATE grocery_dev.wa_outbox o SET state='pending',attempts=0,
          available_at=now(),provider_message_id=NULL,callback_key=NULL,manual_retries=manual_retries+1,
          last_retried_by=current_user,updated_at=now() FROM grocery_dev.wa_identities i
          WHERE o.identity_id=i.id AND i.business_account_id=$1 AND i.phone_number_id=$2
            AND i.transport_mode=$3 AND o.id=$4 AND o.state='failed' RETURNING o.id`,[...scope,values.retry]);
        if (!result.rowCount) throw new Error('Only definitively failed jobs in this scope can be retried');
      });
      console.log('Failed job queued for manual retry. The worker will recheck recipient, revision and service window.');
    }
    const summary=await pool.query(`SELECT o.state,count(*)::int AS count FROM grocery_dev.wa_outbox o
      JOIN grocery_dev.wa_identities i ON i.id=o.identity_id WHERE i.business_account_id=$1 AND i.phone_number_id=$2
      AND i.transport_mode=$3 GROUP BY o.state ORDER BY o.state`,scope);
    const failures=await pool.query(`SELECT o.id,o.state,o.attempts,o.manual_retries,o.last_error_code,o.updated_at,
      (o.state='sending' AND o.lease_until<now()) AS expired_send_lease FROM grocery_dev.wa_outbox o
      JOIN grocery_dev.wa_identities i ON i.id=o.identity_id WHERE i.business_account_id=$1 AND i.phone_number_id=$2
      AND i.transport_mode=$3 AND (o.state IN ('failed','uncertain') OR (o.state='sending' AND o.lease_until<now()))
      ORDER BY o.updated_at DESC LIMIT 50`,scope);
    const inbox=await pool.query(`SELECT count(*)::int AS pending,min(e.received_at) AS oldest_pending_at
      FROM grocery_dev.wa_inbox e JOIN grocery_dev.wa_identities i ON i.id=e.identity_id
      WHERE i.business_account_id=$1 AND i.phone_number_id=$2 AND i.transport_mode=$3 AND e.processed_at IS NULL`,scope);
    console.log(JSON.stringify({mode:config.mode,inbox:inbox.rows[0],counts:summary.rows,needs_review:failures.rows},null,2));
  } finally { await pool.end(); }
}
if (import.meta.main) main().catch(()=>{
  console.error('Status/retry failed. Check configuration and job scope; uncertain sends cannot be automatically replayed.');
  process.exitCode=1;
});
