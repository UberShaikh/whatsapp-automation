import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import type { Config } from './config.ts';
import { transaction } from './db.ts';
import { SendFailure } from './sender.ts';
import type { Sender } from './sender.ts';

export async function sendNextReply(pool: Pool,config: Config,sender: Sender) {
  if (config.paused) return false;
  const scope=[config.businessAccountId,config.phoneNumberId,config.mode];
  const job=await transaction(pool,async db=>{
    // A crashed/expired send may already have reached Meta; never reclaim it for another send.
    await db.query(`UPDATE grocery_dev.wa_outbox o SET state='uncertain',last_error_code='send_lease_expired',
      lease_token=NULL,lease_until=NULL,updated_at=now() FROM grocery_dev.wa_identities i
      WHERE o.identity_id=i.id AND i.business_account_id=$1 AND i.phone_number_id=$2 AND i.transport_mode=$3
        AND o.state='sending' AND o.lease_until<now()`,scope);
    const { rows }=await db.query(`SELECT o.*,i.address_type,i.address_value,i.last_customer_message_at,
      i.revision AS current_revision FROM grocery_dev.wa_outbox o JOIN grocery_dev.wa_identities i ON i.id=o.identity_id
      WHERE o.state='pending' AND o.available_at<=now() AND i.business_account_id=$1 AND i.phone_number_id=$2
        AND i.transport_mode=$3 AND NOT EXISTS (SELECT 1 FROM grocery_dev.wa_outbox busy
          WHERE busy.identity_id=o.identity_id AND busy.state='sending')
      ORDER BY o.sequence LIMIT 1 FOR UPDATE OF o,i SKIP LOCKED`,scope);
    if (!rows.length) return null;
    const row=rows[0];
    const reason=row.revision!==row.current_revision?'superseded_reply'
      : new Date(row.last_customer_message_at).getTime()<=Date.now()-86400000?'service_window_closed'
      : config.mode==='meta' && !config.testRecipients.includes(row.address_value)?'recipient_not_allowed':null;
    if (reason) {
      await db.query("UPDATE grocery_dev.wa_outbox SET state='suppressed',last_error_code=$2,updated_at=now() WHERE id=$1",[row.id,reason]);
      return {suppressed:true as const};
    }
    const token=randomUUID();
    await db.query(`UPDATE grocery_dev.wa_outbox SET state='sending',attempts=attempts+1,
      lease_token=$2,callback_key=$2,lease_until=now()+interval '60 seconds',updated_at=now() WHERE id=$1`,[row.id,token]);
    return {suppressed:false as const,id:row.id as string,token,attempts:row.attempts+1 as number,
      addressType:row.address_type as 'phone'|'bsuid',addressValue:row.address_value as string,body:row.body as string};
  });
  if (!job) return false;
  if (job.suppressed) return true;
  try {
    const providerId=await sender({id:job.id,callbackKey:job.token,addressType:job.addressType,addressValue:job.addressValue,body:job.body});
    // A callback may have already advanced this job to delivered/read.
    await pool.query(`UPDATE grocery_dev.wa_outbox SET state='accepted',provider_message_id=$3,
      lease_token=NULL,lease_until=NULL,last_error_code=NULL,updated_at=now()
      WHERE id=$1 AND lease_token=$2 AND state='sending'`,[job.id,job.token,providerId]);
  } catch (error) {
    const failure=error instanceof SendFailure?error:new SendFailure('uncertain','unknown_send_failure');
    const state=failure.outcome==='retry' && job.attempts<5?'pending':failure.outcome==='uncertain'?'uncertain':'failed';
    const delay=[5,30,120,600][Math.min(job.attempts-1,3)];
    await pool.query(`UPDATE grocery_dev.wa_outbox SET state=$3,last_error_code=$4,
      available_at=now()+($5::int * interval '1 second'),lease_token=NULL,lease_until=NULL,updated_at=now()
      WHERE id=$1 AND lease_token=$2 AND state='sending'`,[job.id,job.token,state,failure.code,delay]);
    console.error(JSON.stringify({event:'outbound_send_result',jobId:job.id,state,code:failure.code}));
  }
  return true;
}
