import { randomUUID } from 'node:crypto';
import express from 'express';
import type { ErrorRequestHandler } from 'express';
import type { Config } from './config.ts';
import { normalizeWebhook,secureEqual,validSignature,WebhookError } from './whatsapp.ts';
import type { Event } from './whatsapp.ts';

type Services={ ingest:(events:Event[])=>Promise<number>; ready:()=>Promise<void>; log?:(record:object)=>void };

export function createApp(config: Config,services: Services) {
  const app=express();
  app.disable('x-powered-by');
  const log=services.log??(record=>console.log(JSON.stringify(record)));
  app.use((req,res,next)=>{
    const requestId=randomUUID(); const start=Date.now();
    res.setHeader('X-Request-Id',requestId);
    res.setHeader('Cache-Control','no-store');
    res.setHeader('X-Content-Type-Options','nosniff');
    res.on('finish',()=>log({event:'http_request',requestId,method:req.method,
      route:typeof req.route?.path==='string'?req.route.path:'unmatched',status:res.statusCode,durationMs:Date.now()-start}));
    next();
  });
  app.get('/health/live',(_req,res)=>res.json({status:'alive'}));
  app.get('/health/ready',async (_req,res)=>{
    try { await services.ready(); res.json({status:'ready',automation_paused:config.paused,transport_mode:config.mode}); }
    catch { res.status(503).json({status:'not_ready'}); }
  });
  app.get('/webhooks/whatsapp',(req,res)=>{
    const token=req.query['hub.verify_token']; const challenge=req.query['hub.challenge'];
    if (req.query['hub.mode']!=='subscribe' || typeof token!=='string' || token.length>1024 ||
      !secureEqual(token,config.verifyToken) || typeof challenge!=='string' || challenge.length>1024) {
      res.sendStatus(403); return;
    }
    res.type('text/plain').send(challenge);
  });
  // This route must precede any JSON parser: signatures cover the exact raw bytes.
  app.post('/webhooks/whatsapp',express.raw({type:'application/json',limit:'256kb',inflate:false}),async (req,res)=>{
    if (!Buffer.isBuffer(req.body)) { res.sendStatus(415); return; }
    if (!validSignature(req.body,req.get('X-Hub-Signature-256'),config.appSecret)) { res.sendStatus(401); return; }
    let payload:unknown;
    try { payload=JSON.parse(req.body.toString('utf8')); }
    catch { res.sendStatus(400); return; }
    const events=normalizeWebhook(payload,config);
    try { if (events.length) await services.ingest(events); }
    catch { res.status(503).json({status:'storage_unavailable'}); return; }
    res.sendStatus(200);
  });
  const errorHandler: ErrorRequestHandler=(error,_req,res,_next)=>{
    const status=error instanceof WebhookError?error.status:[400,413,415].includes(error?.status)?error.status:500;
    res.status(status).json({status:status===500?'internal_error':'invalid_request'});
  };
  app.use(errorHandler);
  return app;
}
