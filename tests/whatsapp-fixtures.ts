import { createHmac } from 'node:crypto';
import type { Config } from '../app/config.ts';

export const config: Config={databaseUrl:'',mode:'fake',appSecret:'test-secret-not-a-real-credential',
  verifyToken:'test-verify-token',businessAccountId:'test-account',phoneNumberId:'test-number',
  accessToken:'test-token',apiVersion:'v99.0',testRecipients:['919000000001','IN.USER1'],
  storeName:'Test Grocery',supportContact:'Call the test store operator',paused:false,host:'127.0.0.1',port:3000};
export function payload(c=config,options:{id?:string;body?:string;from?:string;bsuid?:string;timestamp?:number}={}) {
  return {object:'whatsapp_business_account',entry:[{id:c.businessAccountId,changes:[{field:'messages',value:{
    metadata:{phone_number_id:c.phoneNumberId},messages:[{id:options.id??'wamid.test-1',
      from:options.bsuid?undefined:options.from??'919000000001',from_user_id:options.bsuid,
      timestamp:String(options.timestamp??Math.floor(Date.now()/1000)),type:'text',text:{body:options.body??'hi'}}],
  }}]}]};
}
export function signature(body:string|Buffer) { return `sha256=${createHmac('sha256',config.appSecret).update(body).digest('hex')}`; }
