import type { Pool, PoolClient } from 'pg';
import { transaction } from './db.ts';
import type { Config } from './config.ts';
import type { Event, StatusEvent } from './whatsapp.ts';
import { shoppingReply } from './shopping.ts';
import { checkoutReply } from './checkout.ts';

async function applyStatus(db: PoolClient,event: StatusEvent) {
  await db.query(`INSERT INTO grocery_dev.wa_status_events
    (event_key,business_account_id,phone_number_id,provider_message_id,status,occurred_at,callback_key,error_code,transport_mode)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT DO NOTHING`,
    [event.eventKey,event.businessAccountId,event.phoneNumberId,event.id,event.status,event.occurredAt,event.callbackKey,event.errorCode,event.transportMode]);
  // Reapply even duplicate callbacks: a status can arrive before the send response is saved.
  await db.query(`UPDATE grocery_dev.wa_outbox o SET state=$1,provider_message_id=$2,
    last_error_code=$3,lease_token=NULL,lease_until=NULL,updated_at=now()
    FROM grocery_dev.wa_identities i WHERE o.identity_id=i.id AND i.business_account_id=$4 AND i.phone_number_id=$5 AND i.transport_mode=$7
      AND (o.provider_message_id=$2 OR (o.callback_key=$6::uuid AND (o.provider_message_id IS NULL OR o.provider_message_id=$2)))
      AND o.state<>'suppressed'
      AND (CASE o.state WHEN 'read' THEN 4 WHEN 'delivered' THEN 3 WHEN 'failed' THEN 2
        WHEN 'accepted' THEN 1 WHEN 'sent' THEN 1 ELSE 0 END)
      <= (CASE $1 WHEN 'read' THEN 4 WHEN 'delivered' THEN 3 WHEN 'failed' THEN 2 ELSE 1 END)`,
    [event.status,event.id,event.errorCode,event.businessAccountId,event.phoneNumberId,event.callbackKey,event.transportMode]);
}

export async function ingestEvents(pool: Pool,events: Event[]) {
  return transaction(pool,async db=>{
    let inserted=0;
    for (const event of events) {
      if (event.kind==='status') { await applyStatus(db,event); continue; }
      const identity=await db.query(`INSERT INTO grocery_dev.wa_identities
        (business_account_id,phone_number_id,sender_key,address_type,address_value,phone_number,last_customer_message_at,transport_mode)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
        ON CONFLICT (business_account_id,phone_number_id,transport_mode,sender_key) DO UPDATE SET
          last_customer_message_at=GREATEST(wa_identities.last_customer_message_at,EXCLUDED.last_customer_message_at),
          phone_number=COALESCE(EXCLUDED.phone_number,wa_identities.phone_number) RETURNING id`,
        [event.businessAccountId,event.phoneNumberId,event.senderKey,event.addressType,event.addressValue,event.phoneNumber,event.occurredAt,event.transportMode]);
      const message=await db.query(`INSERT INTO grocery_dev.wa_inbox
        (identity_id,business_account_id,phone_number_id,provider_message_id,message_type,body,occurred_at,transport_mode)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT DO NOTHING RETURNING id`,
        [identity.rows[0].id,event.businessAccountId,event.phoneNumberId,event.id,event.messageType,event.body,event.occurredAt,event.transportMode]);
      inserted+=message.rowCount??0;
    }
    return inserted;
  });
}

function replyFor(body: string,type: string,config: Config,mode: string) {
  const command=body.trim().toLowerCase();
  if (command==='stop') return 'Order updates are stopped. You can still request HELP. Reply RESUME to allow future order updates.';
  if (command==='resume') return 'Future order updates are allowed. You can build a demo cart and review CHECKOUT for demo pickup. Reply HELP for support.';
  if (command==='agent') return `For human assistance: ${config.supportContact} Automated shopping replies are paused for this conversation.`;
  if (command==='help') return `${config.storeName}: send up to 10 items, for example 2 milk 1 l, 1 kg rice. Use CART, CHANGE <line> <packs>, REMOVE <line>, CANCEL, or CHOICES. Follow the code shown to CHOOSE, REPLACE or SKIP an unclear item. CHECKOUT reviews demo pickup; CONFIRM <code> reserves stock. STATUS [order reference] checks progress; CANCEL ORDER <reference> cancels before picking. ${mode==='HUMAN_HANDOFF'?'Automated shopping is paused; your saved cart is retained. ':''}Human assistance: ${config.supportContact}`;
  if (/^verify [a-f0-9]{16}$/.test(command)) return `Verification received: ${command.slice(7)}. This is a demo delivery check, not an order.`;
  if (mode==='HUMAN_HANDOFF') return null;
  if (type!=='text') return 'Please send a text shopping list. Media ordering is not available yet. Reply HELP or AGENT for assistance.';
  if (/^(hi|hello|hey|namaste)[!. ]*$/.test(command)) return `Welcome to ${config.storeName}. Send a shopping list such as 2 milk 1 l, 1 kg rice, or reply CART. CHECKOUT reviews demo pickup and pay-at-pickup. Reply HELP for instructions or STOP to stop future order updates.`;
  return undefined;
}

export async function processNextMessage(pool: Pool,config: Config) {
  if (config.paused) return false;
  return transaction(pool,async db=>{
    const { rows }=await db.query(`SELECT e.*,i.mode,i.revision FROM grocery_dev.wa_inbox e
      JOIN grocery_dev.wa_identities i ON i.id=e.identity_id
      WHERE e.processed_at IS NULL AND i.business_account_id=$1 AND i.phone_number_id=$2 AND i.transport_mode=$3
      AND NOT EXISTS (SELECT 1 FROM grocery_dev.wa_inbox older WHERE older.identity_id=e.identity_id
        AND older.processed_at IS NULL AND older.id<e.id)
      ORDER BY e.id LIMIT 1 FOR UPDATE OF e,i SKIP LOCKED`,[config.businessAccountId,config.phoneNumberId,config.mode]);
    if (!rows.length) return false;
    const event=rows[0];
    const command=(event.body as string).trim().toLowerCase();
    if (command==='stop' || command==='resume') {
      const newer=await db.query(`SELECT 1 FROM grocery_dev.wa_inbox WHERE identity_id=$1 AND processed_at IS NOT NULL
        AND message_type='text' AND lower(trim(body)) IN ('stop','resume')
        AND (occurred_at>$2 OR (occurred_at=$2 AND id>$3)) LIMIT 1`,[event.identity_id,event.occurred_at,event.id]);
      if (newer.rows.length) {
        await db.query('UPDATE grocery_dev.wa_inbox SET processed_at=now() WHERE id=$1',[event.id]);
        return true;
      }
    }
    let mode=command==='agent'?'HUMAN_HANDOFF':event.mode;
    const checkout=event.message_type==='text'?await checkoutReply(db,event.identity_id,event.body,event.occurred_at,config,event.mode):undefined;
    let body=checkout??replyFor(event.body,event.message_type,config,event.mode);
    if (body===undefined) {
      const reply=await shoppingReply(db,event.identity_id,event.body,event.occurred_at);
      body=reply.body;
      if (reply.handoff) {mode='HUMAN_HANDOFF';body+=` Human assistance: ${config.supportContact}`;}
      if (body.length>4096) body='Your demo cart is saved. Reply CART for its contents or CHOICES for the current choice.';
    }
    if (body===null) {
      await db.query('UPDATE grocery_dev.wa_inbox SET processed_at=now() WHERE id=$1',[event.id]);
      return true;
    }
    const identity=await db.query(`UPDATE grocery_dev.wa_identities SET revision=revision+1,mode=$2,
      opted_out=CASE WHEN $3='stop' THEN true WHEN $3='resume' THEN false ELSE opted_out END
      WHERE id=$1 RETURNING revision`,[event.identity_id,mode,command]);
    await db.query("UPDATE grocery_dev.wa_outbox SET state='suppressed',last_error_code='superseded_reply',updated_at=now() WHERE identity_id=$1 AND state='pending'",[event.identity_id]);
    if (body) await db.query(`INSERT INTO grocery_dev.wa_outbox(identity_id,inbox_id,revision,body)
      VALUES ($1,$2,$3,$4) ON CONFLICT (inbox_id) DO NOTHING`,[event.identity_id,event.id,identity.rows[0].revision,body]);
    await db.query('UPDATE grocery_dev.wa_inbox SET processed_at=now() WHERE id=$1',[event.id]);
    return true;
  });
}
