import 'server-only';
import { redirect } from 'next/navigation';
import { supabase,authConfigured } from './supabase';
import { merchantApi } from './merchant-api';
import type { Product,Movement } from './inventory';
export type View='inventory'|'history'|'account';
export type WorkspaceData={initialView:View;initialProducts:Product[];initialHistory:Movement[];email:string;name:string;preview?:boolean;error?:string;accessPending?:boolean};
export async function loadWorkspace(view:View):Promise<WorkspaceData> {
  if (!authConfigured()) redirect('/login');
  const client=await supabase();const {data:{user}}=await client.auth.getUser();
  if (!user) redirect('/login');
  const result:WorkspaceData={initialView:view,initialProducts:[],initialHistory:[],email:user.email??'',name:typeof user.user_metadata?.full_name==='string'?user.user_metadata.full_name.slice(0,100):'Merchant'};
  try {
    const inventory=await merchantApi('inventory');
    if (inventory.status===401) return {...result,error:'Your session expired. Sign out and sign in again.'};
    if (!inventory.ok) return {...result,error:(await inventory.json()).error??'Inventory is unavailable.',accessPending:inventory.status===403};
    result.initialProducts=(await inventory.json()).products;
    if (view==='history') {
      const history=await merchantApi('history');
      if (!history.ok) return {...result,error:'Stock history is unavailable. Try refreshing.'};
      result.initialHistory=(await history.json()).movements;
    }
    return result;
  } catch {return {...result,error:'Inventory is unavailable. Check that the merchant service is running, then refresh.'};}
}
