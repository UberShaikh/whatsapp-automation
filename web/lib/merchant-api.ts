import 'server-only';
import { supabase } from './supabase';

export async function merchantApi(path:string,init?:RequestInit) {
  const client=await supabase();
  const {data:{user}}=await client.auth.getUser();
  if (!user) return Response.json({error:'Sign in again.'},{status:401});
  const {data:{session}}=await client.auth.getSession();
  if (!session) return Response.json({error:'Sign in again.'},{status:401});
  const base=process.env.MERCHANT_API_URL??'http://127.0.0.1:3001';
  return fetch(`${base}/merchant/${path}`,{...init,headers:{'Content-Type':'application/json',Authorization:`Bearer ${session.access_token}`},cache:'no-store',signal:AbortSignal.timeout(20000),redirect:'error'});
}
