import express from 'express';
import type { ErrorRequestHandler } from 'express';
import type { Pool } from 'pg';
import { transaction } from './db.ts';
import { adjustStock,inventory,MerchantError,parseAdjustment,requireMerchant,stockHistory,uuid } from './merchant-inventory.ts';

export function verifySupabaseUser(url:string,key:string,request:typeof fetch=fetch) {
  return async (token:string)=>{
    let response:Response;
    try {response=await request(`${url}/auth/v1/user`,{headers:{apikey:key,Authorization:`Bearer ${token}`},signal:AbortSignal.timeout(10000),redirect:'error'});}
    catch {throw new MerchantError(503,'Sign-in verification is unavailable. Try again shortly.');}
    if (response.status===401 || response.status===403) throw new MerchantError(401,'Your session expired. Sign in again.');
    if (!response.ok) throw new MerchantError(503,'Sign-in verification is unavailable. Try again shortly.');
    let user;
    try {user=await response.json();} catch {throw new MerchantError(503,'Sign-in verification is unavailable. Try again shortly.');}
    if (!uuid(user?.id) || !user.email_confirmed_at || user.is_anonymous) throw new MerchantError(401,'Confirm your email and sign in again.');
    return user.id as string;
  };
}
export function createMerchantApp(pool:Pool,verify:(token:string)=>Promise<string>) {
  const app=express();app.disable('x-powered-by');
  app.use((_req,res,next)=>{res.set({'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});next();});
  app.get('/health/ready',async (_req,res)=>{
    try {const result=await pool.query("SELECT 1 FROM grocery_dev.schema_migrations WHERE version='005'");res.status(result.rowCount?200:503).json({status:result.rowCount?'ready':'migration_required'});}
    catch {res.status(503).json({status:'not_ready'});}
  });
  app.use('/merchant',async(req,res,next)=>{
    const match=req.get('Authorization')?.match(/^Bearer ([^\s]{1,8192})$/);
    if (!match) throw new MerchantError(401,'Sign in to manage inventory.');
    const id=await verify(match[1]);
    if (!uuid(id)) throw new MerchantError(401,'Sign in again.');
    res.locals.userId=id;next();
  });
  app.get('/merchant/inventory',async(_req,res)=>{
    const result=await transaction(pool,async db=>{const location=await requireMerchant(db,res.locals.userId);return {location,products:await inventory(db,location)};});
    res.json(result);
  });
  app.get('/merchant/history',async(_req,res)=>{
    res.json(await transaction(pool,async db=>{const location=await requireMerchant(db,res.locals.userId);return {movements:await stockHistory(db,location)};}));
  });
  app.post('/merchant/adjustments',express.json({limit:'8kb',strict:true}),async(req,res)=>{
    if (!req.is('application/json')) throw new MerchantError(415,'Send a JSON stock adjustment.');
    const input=parseAdjustment(req.body);
    res.json(await transaction(pool,db=>adjustStock(db,res.locals.userId,input)));
  });
  const errors:ErrorRequestHandler=(error,_req,res,_next)=>{
    const status=error instanceof MerchantError?error.status:[400,413,415].includes(error?.status)?error.status:500;
    res.status(status).json({error:error instanceof MerchantError?error.message:status===500?'Stock could not be saved. Refresh before trying again.':'The request could not be read.'});
  };
  app.use(errors);return app;
}
