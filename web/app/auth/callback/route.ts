import { NextResponse,type NextRequest } from 'next/server';
import { supabase,authConfigured } from '@/lib/supabase';

export async function GET(request:NextRequest) {
  const code=request.nextUrl.searchParams.get('code');
  const next=request.nextUrl.searchParams.get('next')==='/reset-password'?'/reset-password':'/inventory';
  const base=process.env.MERCHANT_WEB_URL??'http://127.0.0.1:3100';
  if (code && authConfigured()) {
    const client=await supabase();const {error}=await client.auth.exchangeCodeForSession(code);
    if (!error) return NextResponse.redirect(new URL(next,base));
  }
  return NextResponse.redirect(new URL('/login?link=expired',base));
}
