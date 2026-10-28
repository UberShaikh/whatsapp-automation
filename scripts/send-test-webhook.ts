import { createHmac,randomUUID } from 'node:crypto';
import { parseArgs } from 'node:util';
import { loadConfig } from '../app/config.ts';
import { createPool } from '../app/db.ts';
import { setTimeout } from 'node:timers/promises';

async function main() {
  const {values}=parseArgs({options:{text:{type:'string',default:'hi'},'message-id':{type:'string'},wait:{type:'boolean'}}});
  const config=loadConfig();
  if (config.mode!=='fake') throw new Error('This command is for local fake mode only');
  const messageId=values['message-id']??`fake-inbound.${randomUUID()}`;
  const body=JSON.stringify({object:'whatsapp_business_account',entry:[{id:config.businessAccountId,changes:[{
    field:'messages',value:{metadata:{phone_number_id:config.phoneNumberId},messages:[{
      id:messageId,from:'919000000001',
      type:'text',timestamp:String(Math.floor(Date.now()/1000)),text:{body:values.text},
    }]},
  }]}]});
  const response=await fetch(`http://127.0.0.1:${config.port}/webhooks/whatsapp`,{method:'POST',
    headers:{'Content-Type':'application/json','X-Hub-Signature-256':`sha256=${createHmac('sha256',config.appSecret).update(body).digest('hex')}`},
    body,signal:AbortSignal.timeout(15000)});
  console.log(JSON.stringify({http_status:response.status,request_id:response.headers.get('x-request-id')}));
  if (!response.ok) process.exitCode=1;
  if (response.ok && values.wait) {
    const pool=createPool(config.databaseUrl);
    try {
      const deadline=Date.now()+40000;
      while (Date.now()<deadline) {
        const {rows}=await pool.query(`SELECT o.body FROM grocery_dev.wa_outbox o
          JOIN grocery_dev.wa_inbox e ON e.id=o.inbox_id JOIN grocery_dev.wa_identities i ON i.id=o.identity_id
          WHERE i.business_account_id=$1 AND i.phone_number_id=$2 AND i.transport_mode='fake'
            AND i.address_value='919000000001' AND e.provider_message_id=$3 AND o.state<>'suppressed'`,
          [config.businessAccountId,config.phoneNumberId,messageId]);
        if (rows.length) {console.log(`Local fake reply:\n${rows[0].body}`);return;}
        await setTimeout(500);
      }
      console.error('Message stored, but no local reply is ready yet. Check that the worker is running and not paused.');process.exitCode=1;
    } finally {await pool.end();}
  }
}
if (import.meta.main) main().catch(()=>{console.error('Local fake webhook failed. Check configuration and that the server is running.');process.exitCode=1;});
