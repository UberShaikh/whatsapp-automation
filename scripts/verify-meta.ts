import { randomBytes } from 'node:crypto';
import { parseArgs } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { loadConfig } from '../app/config.ts';
import { assertSchema,createPool } from '../app/db.ts';

export function publicOrigin(value:string) {
  const url=new URL(value);
  if (url.protocol!=='https:' || url.username || url.password || url.pathname!=='/' || url.search || url.hash) throw new Error('PUBLIC_BASE_URL must be an HTTPS origin');
  return url.origin;
}
export function deliveryVerified(row:Record<string,unknown>|undefined) {
  return Boolean(row && typeof row.inbound_id==='string' && row.inbound_id.startsWith('wamid.') &&
    typeof row.outbound_id==='string' && row.outbound_id.startsWith('wamid.') && row.delivered===true);
}
async function main() {
  const {values}=parseArgs({options:{recipient:{type:'string'},nonce:{type:'string'},wait:{type:'boolean',default:false}}});
  const config=loadConfig();
  if (config.mode!=='meta') throw new Error('Configure WHATSAPP_MODE=meta first');
  const recipient=values.recipient??(config.testRecipients.length===1?config.testRecipients[0]:undefined);
  if (!recipient || !config.testRecipients.includes(recipient)) throw new Error('Select one exact configured test recipient with --recipient');
  const nonce=values.nonce??randomBytes(8).toString('hex');
  if (!/^[a-f0-9]{16}$/.test(nonce)) throw new Error('Nonce must be 16 lowercase hexadecimal characters');
  const origin=publicOrigin(process.env.PUBLIC_BASE_URL??'');
  const ready=await fetch(`${origin}/health/ready`,{signal:AbortSignal.timeout(15000),redirect:'error'});
  const state=await ready.json() as Record<string,unknown>;
  if (!ready.ok || state.status!=='ready' || state.transport_mode!=='meta' || state.automation_paused!==false) throw new Error('Public Meta runtime must be ready and unpaused');
  const challenge=randomBytes(12).toString('hex');
  const callback=new URL('/webhooks/whatsapp',origin);
  callback.search=new URLSearchParams({'hub.mode':'subscribe','hub.verify_token':config.verifyToken,'hub.challenge':challenge}).toString();
  const probe=await fetch(callback,{signal:AbortSignal.timeout(15000),redirect:'error'});
  if (!probe.ok || await probe.text()!==challenge) throw new Error('Public webhook challenge failed');
  console.log(`Public callback is reachable. From the approved recipient, send exactly: VERIFY ${nonce}`);
  console.log('This command only reads evidence. It does not send WhatsApp messages. The running worker replies to your genuine incoming message.');
  const pool=createPool(config.databaseUrl);
  try {
    await assertSchema(pool);
    const deadline=Date.now()+(values.wait?120000:0);
    do {
      const {rows}=await pool.query(`SELECT e.provider_message_id AS inbound_id,o.provider_message_id AS outbound_id,o.state,
        EXISTS(SELECT 1 FROM grocery_dev.wa_status_events s WHERE s.business_account_id=i.business_account_id
          AND s.phone_number_id=i.phone_number_id AND s.transport_mode='meta' AND s.provider_message_id=o.provider_message_id
          AND s.status IN ('delivered','read')) AS delivered
        FROM grocery_dev.wa_inbox e JOIN grocery_dev.wa_identities i ON i.id=e.identity_id
        LEFT JOIN grocery_dev.wa_outbox o ON o.inbox_id=e.id WHERE i.business_account_id=$1 AND i.phone_number_id=$2
          AND i.transport_mode='meta' AND i.address_value=$3 AND lower(trim(e.body))=$4
          AND e.received_at>now()-interval '15 minutes' AND e.occurred_at>now()-interval '15 minutes'
        ORDER BY e.id DESC LIMIT 1`,[config.businessAccountId,config.phoneNumberId,recipient,`verify ${nonce}`]);
      if (deliveryVerified(rows[0])) {console.log('VERIFIED: genuine Meta inbound, correlated outbound and signed delivered/read callback recorded.');return;}
      if (Date.now()>=deadline) {
        console.log(rows[0]?`NOT VERIFIED: reply state ${rows[0].state??'not yet queued'}; awaiting a delivered/read callback.`:'NOT VERIFIED: awaiting the genuine incoming VERIFY message.');
        console.log(`Repeat with --nonce ${nonce} --wait after sending it.`);process.exitCode=1;return;
      }
      await delay(2000);
    } while (true);
  } finally {await pool.end();}
}
if (import.meta.main) main().catch(()=>{console.error('Meta verification could not complete. Check Meta credentials, exact allowlisted recipient, PUBLIC_BASE_URL, public callback and running server/worker.');process.exitCode=1;});
