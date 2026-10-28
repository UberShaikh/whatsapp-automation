import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:net';
import type { AddressInfo } from 'node:net';
import { setTimeout } from 'node:timers/promises';
import { test } from 'node:test';
import { loadConfig as databaseUrl } from '../scripts/seed-groceries.ts';
import { createPool,transaction } from '../app/db.ts';
import { transitionOrder } from '../app/checkout.ts';
import { config } from './whatsapp-fixtures.ts';

test('server, worker, fake-message CLI and operator CLI run without seeding or external sends',{
  skip:process.env.WHATSAPP_INTEGRATION_TEST!=='1',timeout:240000,
},async()=>{
  const socket=createServer().listen(0,'127.0.0.1');await once(socket,'listening');
  const port=(socket.address() as AddressInfo).port;
  await new Promise<void>(resolve=>socket.close(()=>resolve()));
  const account=`test-runtime-${randomUUID()}`;
  const url=databaseUrl();const pool=createPool(url);const children:ChildProcess[]=[];
  const env={...process.env,APP_ENV:'test',DATABASE_URL:url,WHATSAPP_MODE:'fake',
    WHATSAPP_APP_SECRET:config.appSecret,WHATSAPP_VERIFY_TOKEN:config.verifyToken,
    WHATSAPP_BUSINESS_ACCOUNT_ID:account,WHATSAPP_PHONE_NUMBER_ID:config.phoneNumberId,
    STORE_NAME:config.storeName,SUPPORT_CONTACT:config.supportContact,AUTOMATION_PAUSED:'false',HOST:'127.0.0.1',PORT:String(port)};
  function start(file:string,args:string[]=[]) {
    const child=spawn(process.execPath,[file,...args],{env,stdio:['ignore','pipe','pipe'],windowsHide:true});
    children.push(child);return child;
  }
  async function command(file:string,args:string[]=[]) {
    const child=start(file,args);let output='';
    child.stdout!.on('data',data=>{output+=String(data);});child.stderr!.resume();
    const [code]=await once(child,'exit');return {code,output};
  }
  async function until(check:()=>Promise<boolean>) {
    const deadline=Date.now()+40000;
    while (Date.now()<deadline) { if (await check()) return;await setTimeout(500); }
    throw new Error('Runtime smoke check timed out');
  }
  const baseline=async()=> (await pool.query(`SELECT
    (SELECT count(*)::int FROM grocery_dev.product_variants) AS variants,
    (SELECT sum(on_hand_qty)::int FROM grocery_dev.stock_balances) AS stock,
    (SELECT sum(reserved_qty)::int FROM grocery_dev.stock_balances) AS reserved,
    (SELECT count(*)::int FROM grocery_dev.seed_imports) AS imports`)).rows[0];
  const before=await baseline();
  try {
    const server=start('app/server.ts');server.stdout!.resume();server.stderr!.resume();
    await until(async()=>{
      if (server.exitCode!==null) throw new Error('Server exited before becoming ready');
      try { return (await fetch(`http://127.0.0.1:${port}/health/ready`,{signal:AbortSignal.timeout(2000)})).ok; }
      catch { return false; }
    });
    const worker=start('app/worker.ts');worker.stdout!.resume();worker.stderr!.resume();
    assert.equal((await command('scripts/send-test-webhook.ts',['--text','hi','--message-id','runtime-smoke-message'])).code,0);
    await until(async()=> (await pool.query(`SELECT 1 FROM grocery_dev.wa_outbox o JOIN grocery_dev.wa_identities i ON i.id=o.identity_id
      WHERE i.business_account_id=$1 AND o.state='accepted'`,[account])).rows.length===1);
    const status=await command('scripts/whatsapp-status.ts');assert.equal(status.code,0);
    assert.deepEqual(JSON.parse(status.output).counts,[{state:'accepted',count:1}]);
    assert.doesNotMatch(status.output,/919000000001|test-secret|Welcome to/);
    const jobs=await pool.query(`SELECT o.id FROM grocery_dev.wa_outbox o JOIN grocery_dev.wa_identities i ON i.id=o.identity_id WHERE i.business_account_id=$1`,[account]);
    assert.equal((await command('scripts/whatsapp-status.ts',['--retry',jobs.rows[0].id])).code,1);
    assert.equal((await command('scripts/send-test-webhook.ts',['--text','hi','--message-id','runtime-smoke-message'])).code,0);
    assert.equal((await pool.query(`SELECT count(*)::int AS n FROM grocery_dev.wa_outbox o JOIN grocery_dev.wa_identities i ON i.id=o.identity_id WHERE i.business_account_id=$1`,[account])).rows[0].n,1);
    const shopping=await command('scripts/send-test-webhook.ts',['--text','2 milk 1 l, 1 kg rice','--message-id','runtime-shopping','--wait']);
    assert.equal(shopping.code,0);assert.match(shopping.output,/INR 397.00/);assert.match(shopping.output,/stock is not reserved/);
    const cart=await command('scripts/send-test-webhook.ts',['--text','cart','--message-id','runtime-cart','--wait']);
    assert.equal(cart.code,0);assert.match(cart.output,/Amul/);assert.match(cart.output,/India Gate/);
    const review=await command('scripts/send-test-webhook.ts',['--text','CHECKOUT','--wait']);
    assert.equal(review.code,0);assert.match(review.output,/INR 397.00/);
    const code=review.output.match(/CONFIRM ([a-f0-9]{16})/);assert.ok(code);
    assert.deepEqual(await baseline(),before);
    const confirmed=await command('scripts/send-test-webhook.ts',['--text',`CONFIRM ${code[1]}`,'--wait']);
    assert.equal(confirmed.code,0);assert.match(confirmed.output,/Stock held/);
    const reference=confirmed.output.match(/D-[A-F0-9]{12}/);assert.ok(reference);
    assert.equal((await baseline()).reserved,before.reserved+3);
    const duplicate=await command('scripts/send-test-webhook.ts',['--text',`CONFIRM ${code[1]}`,'--wait']);
    assert.equal(duplicate.code,0);assert.match(duplicate.output,new RegExp(reference[0]));
    assert.equal((await baseline()).reserved,before.reserved+3);
    const accept=await command('scripts/orders.ts',['--order',reference[0],'--action','accept']);
    assert.equal(accept.code,0);assert.match(accept.output,/ACCEPTED/);
    const progress=await command('scripts/send-test-webhook.ts',['--text',`STATUS ${reference[0]}`,'--wait']);
    assert.equal(progress.code,0);assert.match(progress.output,/ACCEPTED/);
    const cancel=await command('scripts/send-test-webhook.ts',['--text',`CANCEL ORDER ${reference[0]}`,'--wait']);
    assert.equal(cancel.code,0);assert.match(cancel.output,/CANCELLED/);
    assert.equal((await command('scripts/verify-meta.ts')).code,1);
    assert.deepEqual(await baseline(),before);
  } finally {
    await Promise.all(children.map(async child=>{
      if (child.exitCode!==null || child.signalCode!==null) return;
      const ended=once(child,'exit');child.kill();await ended;
    }));
    try {
      await transaction(pool,async db=>{
        const {rows}=await db.query(`SELECT o.* FROM grocery_dev.wa_orders o JOIN grocery_dev.wa_identities i ON i.id=o.identity_id WHERE i.business_account_id=$1`,[account]);
        for (const order of rows) {
          await db.query('SELECT id FROM grocery_dev.wa_identities WHERE id=$1 FOR UPDATE',[order.identity_id]);
          await transitionOrder(db,order,'cancel','operator');
          await db.query('DELETE FROM grocery_dev.wa_order_events WHERE order_id=$1',[order.id]);
          await db.query('DELETE FROM grocery_dev.wa_inventory_reservations WHERE order_id=$1',[order.id]);
          await db.query('DELETE FROM grocery_dev.wa_orders WHERE id=$1',[order.id]);
        }
      });
      await pool.query('DELETE FROM grocery_dev.wa_status_events WHERE business_account_id=$1',[account]);
      await pool.query('DELETE FROM grocery_dev.wa_identities WHERE business_account_id=$1',[account]);
    } finally { await pool.end(); }
  }
});
