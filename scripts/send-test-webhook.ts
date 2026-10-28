import { createHmac,randomUUID } from 'node:crypto';
import { parseArgs } from 'node:util';
import { loadConfig } from '../app/config.ts';

async function main() {
  const {values}=parseArgs({options:{text:{type:'string',default:'hi'},'message-id':{type:'string'}}});
  const config=loadConfig();
  if (config.mode!=='fake') throw new Error('This command is for local fake mode only');
  const body=JSON.stringify({object:'whatsapp_business_account',entry:[{id:config.businessAccountId,changes:[{
    field:'messages',value:{metadata:{phone_number_id:config.phoneNumberId},messages:[{
      id:values['message-id']??`fake-inbound.${randomUUID()}`,from:'919000000001',
      type:'text',timestamp:String(Math.floor(Date.now()/1000)),text:{body:values.text},
    }]},
  }]}]});
  const response=await fetch(`http://127.0.0.1:${config.port}/webhooks/whatsapp`,{method:'POST',
    headers:{'Content-Type':'application/json','X-Hub-Signature-256':`sha256=${createHmac('sha256',config.appSecret).update(body).digest('hex')}`},
    body,signal:AbortSignal.timeout(15000)});
  console.log(JSON.stringify({http_status:response.status,request_id:response.headers.get('x-request-id')}));
  if (!response.ok) process.exitCode=1;
}
if (import.meta.main) main().catch(()=>{console.error('Local fake webhook failed. Check configuration and that the server is running.');process.exitCode=1;});
