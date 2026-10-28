import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import type { Config } from './config.ts';

export class WebhookError extends Error {
  status: number;
  constructor(status: number) { super('Invalid webhook'); this.status=status; }
}
function check(value: unknown, status=400): asserts value { if (!value) throw new WebhookError(status); }
function object(value: unknown): value is Record<string, unknown> { return typeof value==='object' && value!==null && !Array.isArray(value); }
function text(value: unknown, max=512): value is string { return typeof value==='string' && value.length>0 && value.length<=max; }
function timestamp(value: unknown) {
  check(typeof value==='string' && /^\d{1,12}$/.test(value));
  const date=new Date(Number(value)*1000);
  check(Number.isFinite(date.getTime()) && date.getTime()<=Date.now()+300000);
  return date;
}
export function secureEqual(a: string,b: string) {
  const left=Buffer.from(a); const right=Buffer.from(b);
  return left.length===right.length && timingSafeEqual(left,right);
}
export function validSignature(body: Buffer, header: string|undefined, secret: string) {
  if (!header || !/^sha256=[a-fA-F0-9]{64}$/.test(header)) return false;
  const expected=createHmac('sha256',secret).update(body).digest();
  return timingSafeEqual(expected,Buffer.from(header.slice(7),'hex'));
}

type Scope={ businessAccountId: string; phoneNumberId: string; transportMode:'fake'|'meta' };
export type MessageEvent=Scope & {
  kind:'message'; id:string; senderKey:string; addressType:'phone'|'bsuid'; addressValue:string;
  phoneNumber:string|null; messageType:string; body:string; occurredAt:Date;
};
export type StatusEvent=Scope & {
  kind:'status'; id:string; status:'sent'|'delivered'|'read'|'failed'; occurredAt:Date;
  callbackKey:string|null; errorCode:string|null; eventKey:string;
};
export type Event=MessageEvent|StatusEvent;

export function normalizeWebhook(payload: unknown, config: Config): Event[] {
  check(object(payload) && payload.object==='whatsapp_business_account' && Array.isArray(payload.entry) && payload.entry.length<=100);
  const events: Event[]=[];
  for (const entry of payload.entry) {
    check(object(entry));
    check(entry.id===config.businessAccountId,403);
    check(Array.isArray(entry.changes) && entry.changes.length<=100);
    for (const change of entry.changes) {
      check(object(change));
      if (change.field!=='messages') continue;
      check(object(change.value));
      const value=change.value;
      check(object(value.metadata) && value.metadata.phone_number_id===config.phoneNumberId,403);
      const scope={businessAccountId:config.businessAccountId,phoneNumberId:config.phoneNumberId,transportMode:config.mode};
      if (value.messages!==undefined) {
        check(Array.isArray(value.messages) && value.messages.length<=100);
        for (const message of value.messages) {
          check(object(message));
          // System/reaction notifications are not customer shopping requests.
          if (message.type==='system' || message.type==='reaction') continue;
          check(text(message.id) && text(message.type,64));
          const bsuid=message.from_user_id;
          const from=message.from;
          const address=bsuid ?? from;
          check(text(address,160));
          const addressType=/^[A-Z]{2}\.[A-Za-z0-9.]{1,128}$/.test(address)?'bsuid':'phone';
          check(addressType==='bsuid' || /^\d{5,20}$/.test(address));
          if (bsuid!==undefined) check(addressType==='bsuid');
          const phoneNumber=typeof from==='string' && /^\d{5,20}$/.test(from)?from:null;
          let body='';
          if (message.type==='text') { check(object(message.text) && text(message.text.body,4096)); body=message.text.body; }
          const occurredAt=timestamp(message.timestamp);
          if (config.mode==='meta' && !config.testRecipients.includes(address)) continue;
          events.push({...scope,kind:'message',id:message.id,senderKey:`${addressType}:${address}`,addressType,addressValue:address,phoneNumber,messageType:message.type,body,occurredAt});
        }
      }
      if (value.statuses!==undefined) {
        check(Array.isArray(value.statuses) && value.statuses.length<=100);
        for (const status of value.statuses) {
          check(object(status));
          if (!['sent','delivered','read','failed'].includes(String(status.status))) continue;
          check(text(status.id));
          const occurredAt=timestamp(status.timestamp);
          const callback=status.biz_opaque_callback_data;
          const callbackKey=typeof callback==='string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(callback)?callback:null;
          const errors=Array.isArray(status.errors)?status.errors:[];
          const error=errors[0];
          const errorCode=object(error) && typeof error.code==='number' && Number.isSafeInteger(error.code)?String(error.code):null;
          const eventKey=createHash('sha256').update(JSON.stringify([scope,status.id,status.status,occurredAt.toISOString(),errorCode])).digest('hex');
          events.push({...scope,kind:'status',id:status.id,status:status.status as StatusEvent['status'],occurredAt,callbackKey,errorCode,eventKey});
        }
      }
      check(events.length<=100);
    }
  }
  return events;
}
