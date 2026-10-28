import { createApp } from './app.ts';
import { ConfigError,loadConfig } from './config.ts';
import { assertSchema,createPool } from './db.ts';
import { ingestEvents } from './transport-store.ts';

async function main() {
  const config=loadConfig();
  const pool=createPool(config.databaseUrl);
  try {
    await assertSchema(pool);
    const app=createApp(config,{ingest:events=>ingestEvents(pool,events),ready:()=>assertSchema(pool)});
    const server=app.listen(config.port,config.host);
    server.requestTimeout=15000; server.headersTimeout=15000; server.maxConnections=100;
    server.on('listening',()=>console.log(JSON.stringify({event:'server_listening',host:config.host,port:config.port,mode:config.mode})));
    server.on('error',()=>{ console.error(JSON.stringify({event:'server_error'})); void pool.end(); process.exitCode=1; });
    let closing=false;
    const close=()=>{
      if (closing) return; closing=true;
      const timer=setTimeout(()=>server.closeAllConnections(),15000); timer.unref();
      server.close(()=>{clearTimeout(timer); void pool.end();});
    };
    process.once('SIGTERM',close); process.once('SIGINT',close);
  } catch (error) { await pool.end(); throw error; }
}
if (import.meta.main) main().catch((error:unknown)=>{
  console.error(error instanceof ConfigError?error.message:'Server could not start. Check database access and explicit migrations.');
  process.exitCode=1;
});
