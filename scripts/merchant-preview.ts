import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const child=spawn(process.execPath,['node_modules/next/dist/bin/next','dev','--hostname','127.0.0.1','--port','3100'],{
  cwd:fileURLToPath(new URL('../web/',import.meta.url)),stdio:'inherit',windowsHide:true,
  env:{...process.env,MERCHANT_PREVIEW:'true'},
});
child.on('exit',code=>{process.exitCode=code??1;});
process.once('SIGINT',()=>child.kill());process.once('SIGTERM',()=>child.kill());
