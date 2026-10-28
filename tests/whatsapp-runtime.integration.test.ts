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
import { createPool } from '../app/db.ts';
import { config } from './whatsapp-fixtures.ts';

test('server, worker, fake-message CLI and operator CLI run without seeding or external sends',{
  skip:process.env.WHATSAPP_INTEGRATION_TEST!=='1',timeout:120000,
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
    assert.deepEqual(await baseline(),before);
  } finally {
    await Promise.all(children.map(async child=>{
      if (child.exitCode!==null || child.signalCode!==null) return;
      const ended=once(child,'exit');child.kill();await ended;
    }));
    try {
      await pool.query('DELETE FROM grocery_dev.wa_status_events WHERE business_account_id=$1',[account]);
      await pool.query('DELETE FROM grocery_dev.wa_identities WHERE business_account_id=$1',[account]);
    } finally { await pool.end(); }
  }
});
