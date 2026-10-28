'use server';
import { redirect } from 'next/navigation';
import { supabase,authConfigured } from '@/lib/supabase';
import { authSchema,type AuthMode } from '@/lib/auth-schema';

const origin=()=>{
  const url=new URL(process.env.MERCHANT_WEB_URL??'http://127.0.0.1:3100');
  if (!['http:','https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname!=='/') throw new Error('Invalid merchant web origin');
  return url.origin;
};
export async function authAction(mode:AuthMode,raw:unknown):Promise<{error?:string;message?:string}> {
  if (!['login','signup','forgot','reset'].includes(mode)) return {error:'Choose a valid account action.'};
  const parsed=authSchema(mode).safeParse(raw);
  if (!parsed.success) return {error:parsed.error.issues[0].message};
  if (!authConfigured()) return {error:'Sign-in is not configured yet. Ask the store owner to finish account setup.'};
  const data=parsed.data;const client=await supabase();
  try {
    if (mode==='login') {
      const {error}=await client.auth.signInWithPassword({email:data.email!,password:data.password!});
      if (error) return {error:'Sign-in failed. Check your email and password, and confirm your email first.'};
    } else if (mode==='signup') {
      const {data:result,error}=await client.auth.signUp({email:data.email!,password:data.password!,options:{data:{full_name:data.name},emailRedirectTo:`${origin()}/auth/callback`}});
      if (error) return {error:error.status===429?'Too many attempts. Wait a few minutes and try again.':'Account could not be created. Check the details or try signing in.'};
      if (!result.session) return {message:'Check your email to confirm your account. After confirmation, the store owner must grant merchant access.'};
    } else if (mode==='forgot') {
      const {error}=await client.auth.resetPasswordForEmail(data.email!,{redirectTo:`${origin()}/auth/callback?next=/reset-password`});
      if (error && error.status===429) return {error:'Too many attempts. Wait a few minutes and try again.'};
      if (error) return {error:'Password reset is unavailable. Try again shortly.'};
      return {message:'If that email has an account, a password reset link has been sent.'};
    } else {
      const {data:user}=await client.auth.getUser();
      if (!user.user) return {error:'This reset link expired. Request another password reset email.'};
      const {error}=await client.auth.updateUser({password:data.password!});
      if (error) return {error:'Password could not be changed. Use a different password or request a new reset link.'};
    }
  } catch {return {error:'Account service is unavailable. Try again shortly.'};}
  redirect('/inventory');
}
export async function signOut() {
  if (authConfigured()) {const client=await supabase();const {error}=await client.auth.signOut();if (error) throw new Error('Sign-out failed. Try again.');}
  redirect('/login');
}
