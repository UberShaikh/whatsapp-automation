import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import type { Pool } from 'pg';
import { test } from 'node:test';
import { createMerchantApp,verifySupabaseUser } from '../app/merchant-app.ts';
import { MerchantError,parseAdjustment } from '../app/merchant-inventory.ts';

test('stock adjustment input rejects fractions, negative counts, invalid IDs and missing reasons',()=>{
  const valid={requestId:randomUUID(),variantId:randomUUID(),action:'receive',quantity:2,reason:'Supplier delivery',expectedOnHand:24,expectedReserved:0};
  assert.equal(parseAdjustment(valid).quantity,2);
  for (const patch of [{quantity:0},{quantity:-1},{quantity:1.5},{quantity:'2'},{quantity:1000001},{expectedReserved:-1},{variantId:'not-an-id'},{reason:' '},{action:'sale'}]) assert.throws(()=>parseAdjustment({...valid,...patch}),MerchantError);
  assert.equal(parseAdjustment({...valid,action:'recount',quantity:0}).quantity,0);
});
test('merchant identity comes only from Supabase verification and confirmed nonanonymous users',async()=>{
  const id=randomUUID();let calls=0;
  const verify=verifySupabaseUser('https://project.supabase.co','publishable-test-key',async(url,init)=>{
    calls++;assert.equal(url,'https://project.supabase.co/auth/v1/user');assert.equal((init?.headers as Record<string,string>).Authorization,'Bearer test-token');
    assert.equal(init?.redirect,'error');return Response.json({id,email_confirmed_at:new Date().toISOString(),is_anonymous:false});
  });
  assert.equal(await verify('test-token'),id);assert.equal(calls,1);
  for (const body of [{id},{id,email_confirmed_at:'today',is_anonymous:true},{id:'forged',email_confirmed_at:'today'}]) {
    await assert.rejects(verifySupabaseUser('https://project.supabase.co','key',async()=>Response.json(body))('token'),(e:unknown)=>e instanceof MerchantError && e.status===401);
  }
  await assert.rejects(verifySupabaseUser('https://project.supabase.co','key',async()=>new Response('',{status:401}))('token'),(e:unknown)=>e instanceof MerchantError && e.status===401);
  await assert.rejects(verifySupabaseUser('https://project.supabase.co','key',async()=>{throw new Error('private network details');})('token'),(e:unknown)=>e instanceof MerchantError && e.status===503 && !e.message.includes('private'));
});
test('merchant HTTP endpoints reject missing or unverified sessions before touching the database',async()=>{
  let databaseCalls=0;
  const pool={connect:async()=>{databaseCalls++;throw new Error('Must not query');}} as unknown as Pool;
  const app=createMerchantApp(pool,async()=>{throw new MerchantError(401,'Sign in again.');});
  const server=app.listen(0,'127.0.0.1');await once(server,'listening');
  try {
    const url=`http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    for (const path of ['inventory','history','adjustments']) {
      const response=await fetch(`${url}/merchant/${path}`,{method:path==='adjustments'?'POST':'GET'});
      assert.equal(response.status,401);assert.equal(response.headers.get('cache-control'),'no-store');
    }
    assert.equal((await fetch(`${url}/merchant/inventory`,{headers:{Authorization:'Bearer forged-token'}})).status,401);
    assert.equal(databaseCalls,0);
  } finally {server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));}
});
