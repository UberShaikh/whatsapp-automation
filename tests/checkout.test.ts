import assert from 'node:assert/strict';
import { test } from 'node:test';
import { publicOrigin,deliveryVerified } from '../scripts/verify-meta.ts';

test('Meta verification accepts only a public HTTPS origin without credentials or query data',()=>{
  assert.equal(publicOrigin('https://example.com'),'https://example.com');
  for (const url of ['http://example.com','https://user:secret@example.com','https://example.com/path','https://example.com?token=secret','https://example.com/#fragment']) assert.throws(()=>publicOrigin(url));
});
test('API acceptance, sent status and fake messages cannot pass real delivery verification',()=>{
  assert.equal(deliveryVerified(undefined),false);
  assert.equal(deliveryVerified({inbound_id:'wamid.in',outbound_id:'wamid.out',state:'accepted',delivered:false}),false);
  assert.equal(deliveryVerified({inbound_id:'fake.in',outbound_id:'wamid.out',delivered:true}),false);
  assert.equal(deliveryVerified({inbound_id:'wamid.in',outbound_id:'fake.out',delivered:true}),false);
  assert.equal(deliveryVerified({inbound_id:'wamid.in',outbound_id:'wamid.out',delivered:true}),true);
});
