import { setTimeout } from 'node:timers/promises';
import { ConfigError,loadConfig } from './config.ts';
import { assertSchema,createPool } from './db.ts';
import { processNextMessage } from './transport-store.ts';
import { sendNextReply } from './outbox.ts';
import { createSender } from './sender.ts';

async function main() {
  const config=loadConfig(); const pool=createPool(config.databaseUrl);
  const controller=new AbortController();
  const stop=()=>controller.abort();
  process.once('SIGINT',stop); process.once('SIGTERM',stop);
  try {
    await assertSchema(pool);
    const sender=createSender(config);
    console.log(JSON.stringify({event:'worker_started',mode:config.mode,paused:config.paused}));
    while (!controller.signal.aborted) {
      try {
        const processed=await processNextMessage(pool,config);
        const sent=controller.signal.aborted?false:await sendNextReply(pool,config,sender);
        if (processed || sent) continue;
      } catch { console.error(JSON.stringify({event:'worker_iteration_failed'})); }
      await setTimeout(1000,undefined,{signal:controller.signal}).catch(()=>{});
    }
  } finally { await pool.end(); }
}
if (import.meta.main) main().catch((error:unknown)=>{
  console.error(error instanceof ConfigError?error.message:'Worker could not start. Check database access and explicit migrations.');
  process.exitCode=1;
});
