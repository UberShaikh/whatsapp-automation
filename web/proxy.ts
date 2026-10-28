import { createServerClient } from '@supabase/ssr';
import { NextResponse,type NextRequest } from 'next/server';

export async function proxy(request:NextRequest) {
  let response=NextResponse.next({request});
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_PUBLISHABLE_KEY) return response;
  const client=createServerClient(process.env.SUPABASE_URL,process.env.SUPABASE_PUBLISHABLE_KEY,{cookieOptions:{httpOnly:true,sameSite:'lax',secure:process.env.NODE_ENV==='production'},cookies:{
    getAll:()=>request.cookies.getAll(),
    setAll:values=>{
      for (const {name,value} of values) request.cookies.set(name,value);
      response=NextResponse.next({request});
      for (const {name,value,options} of values) response.cookies.set(name,value,options);
    },
  }});
  await client.auth.getUser();
  response.headers.set('Cache-Control','private, no-store');
  return response;
}
export const config={matcher:['/((?!_next/static|_next/image|favicon.ico|preview).*)']};
