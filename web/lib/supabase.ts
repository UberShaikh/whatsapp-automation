import 'server-only';
import { createServerClient } from '@supabase/ssr';
import { cookies } from 'next/headers';

export const authConfigured=()=>Boolean(process.env.SUPABASE_URL && process.env.SUPABASE_PUBLISHABLE_KEY);
export async function supabase() {
  if (!authConfigured()) throw new Error('Sign-in is not configured.');
  const jar=await cookies();
  return createServerClient(process.env.SUPABASE_URL!,process.env.SUPABASE_PUBLISHABLE_KEY!,{cookieOptions:{httpOnly:true,sameSite:'lax',secure:process.env.NODE_ENV==='production'},cookies:{
    getAll:()=>jar.getAll(),
    setAll:values=>{try {for (const {name,value,options} of values) jar.set(name,value,options);} catch {/* Server Component refreshes are persisted by proxy. */}},
  }});
}
