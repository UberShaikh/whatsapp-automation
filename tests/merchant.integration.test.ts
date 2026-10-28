import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { createPool } from '../app/db.ts';
import { loadConfig } from '../scripts/seed-groceries.ts';
import { adjustStock,inventory,MerchantError,parseAdjustment,stockHistory } from '../app/merchant-inventory.ts';

test('merchant adjustments are audited, idempotent, access-controlled and cannot consume order holds',{
  skip:process.env.MERCHANT_INTEGRATION_TEST!=='1',
},async()=>{
  const pool=createPool(loadConfig());const db=await pool.connect();
  const snapshot=async()=> (await db.query('SELECT variant_id,location_code,on_hand_qty,reserved_qty FROM grocery_dev.stock_balances ORDER BY variant_id,location_code')).rows;
  const before=await snapshot();
  try {
    await db.query('BEGIN');const user=randomUUID();
    await db.query("INSERT INTO grocery_dev.merchant_access(user_id,location_code) VALUES ($1,'DEMO-STORE')",[user]);
    const products=await inventory(db,'DEMO-STORE');assert.equal(products.length,33);
    assert.ok(products.every(p=>!('source_metadata' in p) && !('source_url' in p)));
    const p=products.find(p=>p.sku==='MILK-AMUL-TAAZA-UHT-1L')!;assert.ok(p);
    const input=parseAdjustment({requestId:randomUUID(),variantId:p.id,action:'receive',quantity:3,reason:'Integration test receipt',expectedOnHand:p.on_hand,expectedReserved:p.reserved});
    await assert.rejects(adjustStock(db,randomUUID(),input),(e:unknown)=>e instanceof MerchantError && e.status===403);
    const received=await adjustStock(db,user,input);assert.equal(received.onHand,p.on_hand+3);assert.equal(received.reserved,p.reserved);
    assert.equal((await adjustStock(db,user,input)).repeated,true);
    await assert.rejects(adjustStock(db,user,{...input,quantity:4}),(e:unknown)=>e instanceof MerchantError && e.status===409);
    assert.equal((await db.query('SELECT count(*)::int AS n FROM grocery_dev.merchant_stock_adjustments WHERE user_id=$1',[user])).rows[0].n,1);
    await db.query("UPDATE grocery_dev.stock_balances SET reserved_qty=3 WHERE variant_id=$1 AND location_code='DEMO-STORE'",[p.id]);
    await assert.rejects(adjustStock(db,user,{...input,requestId:randomUUID(),expectedOnHand:received.onHand}),(e:unknown)=>e instanceof MerchantError && e.message.includes('Stock changed'));
    await assert.rejects(adjustStock(db,user,{...input,requestId:randomUUID(),action:'recount',quantity:2,expectedOnHand:received.onHand,expectedReserved:3}),(e:unknown)=>e instanceof MerchantError && e.message.includes('reserved'));
    const counted=await adjustStock(db,user,{...input,requestId:randomUUID(),action:'recount',quantity:3,expectedOnHand:received.onHand,expectedReserved:3});
    assert.equal(counted.onHand,3);assert.equal(counted.reserved,3);
    const entries=(await stockHistory(db,'DEMO-STORE')).filter(m=>m.user_id===user);
    assert.equal(entries.length,2);assert.ok(entries.every(m=>m.reason==='Integration test receipt'));
    assert.equal(entries.reduce((sum,m)=>sum+m.quantity,0),3-p.on_hand);
    await db.query('UPDATE grocery_dev.merchant_access SET is_active=false WHERE user_id=$1',[user]);
    await assert.rejects(adjustStock(db,user,input),(e:unknown)=>e instanceof MerchantError && e.status===403);
  } finally {await db.query('ROLLBACK');assert.deepEqual(await snapshot(),before);db.release();await pool.end();}
});
