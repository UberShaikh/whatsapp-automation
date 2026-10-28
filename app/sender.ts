import type { Config } from './config.ts';

export type Outgoing={ id:string; callbackKey:string; addressType:'phone'|'bsuid'; addressValue:string; body:string };
export type Sender=(message: Outgoing)=>Promise<string>;
export class SendFailure extends Error {
  outcome:'retry'|'failed'|'uncertain';
  code:string;
  constructor(outcome:SendFailure['outcome'],code:string) { super('Send failed'); this.outcome=outcome; this.code=code; }
}

export function createSender(config: Config,request: typeof fetch=fetch): Sender {
  if (config.mode==='fake') return async message=>`fake.${message.callbackKey}`;
  return async message=>{
    if (!config.testRecipients.includes(message.addressValue)) throw new SendFailure('failed','recipient_not_allowed');
    const destination=message.addressType==='bsuid'?{recipient:message.addressValue}:{to:message.addressValue};
    let response: Response;
    try {
      response=await request(`https://graph.facebook.com/${config.apiVersion}/${config.phoneNumberId}/messages`,{
        method:'POST',headers:{Authorization:`Bearer ${config.accessToken}`,'Content-Type':'application/json'},
        signal:AbortSignal.timeout(15000),
        body:JSON.stringify({messaging_product:'whatsapp',recipient_type:'individual',...destination,
          type:'text',text:{body:message.body,preview_url:false},biz_opaque_callback_data:message.callbackKey}),
      });
    } catch { throw new SendFailure('uncertain','network_or_timeout'); }
    // Only a definite rejection is retried automatically. A 5xx can hide an accepted send.
    if (response.status===429) throw new SendFailure('retry','http_429');
    if (response.status>=500) throw new SendFailure('uncertain',`http_${response.status}`);
    if (!response.ok) throw new SendFailure('failed',`http_${response.status}`);
    let payload;
    try { payload=await response.json(); } catch { throw new SendFailure('uncertain','invalid_send_response'); }
    const id=payload?.messages?.[0]?.id;
    if (typeof id!=='string' || !id || id.length>512) throw new SendFailure('uncertain','missing_provider_id');
    return id;
  };
}
