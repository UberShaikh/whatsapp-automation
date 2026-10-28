import Link from 'next/link';
import { Brand } from './brand';
import { AuthForm } from './auth-form';
import type { AuthMode } from '@/lib/auth-schema';
import { authConfigured } from '@/lib/supabase';
import { Alert,AlertDescription } from '@/components/ui/alert';
const content={login:['Sign in','Use your merchant account to manage store inventory.'],signup:['Create account','Create your account. The store owner will approve inventory access.'],forgot:['Forgot password','Enter your account email to receive a reset link.'],reset:['Reset password','Choose a new password for your merchant account.']};
export function AuthScreen({mode,expired=false}:{mode:AuthMode;expired?:boolean}) {
  const [title,description]=content[mode];const configured=authConfigured();
  return <div className="min-h-dvh"><header className="flex h-20 items-center justify-between border-b px-6 md:px-10"><Link href="/login" aria-label="Stockroom sign in"><Brand /></Link><Link href={mode==='signup'?'/login':'/signup'} className="text-sm font-medium text-primary underline-offset-4 hover:underline">{mode==='signup'?'Sign in':'Create account'}</Link></header>
    <main className="mx-auto grid max-w-5xl gap-12 px-6 py-8 md:grid-cols-[1fr_0.8fr] md:gap-20 md:py-12">
      <section className="flex max-w-sm flex-col gap-6"><div className="flex flex-col gap-2"><h1 className="text-[28px] font-semibold tracking-tight">{title}</h1><p className="text-sm leading-6 text-muted-foreground">{description}</p></div>
        {expired?<Alert variant="destructive"><AlertDescription>This email link expired or could not be verified. Sign in or request a new reset link.</AlertDescription></Alert>:null}
        {!configured?<Alert><AlertDescription>Account setup is not complete. Ask the store owner to configure sign-in.</AlertDescription></Alert>:null}
        <AuthForm mode={mode} configured={configured} />
      </section>
      <aside className="flex flex-col gap-6 border-t pt-8 md:border-t-0 md:border-l md:pt-2 md:pl-12"><h2 className="text-xl font-semibold">Demo store</h2><p className="max-w-xs text-sm leading-6 text-muted-foreground">Manage on-hand stock, protect reserved packs and keep a record of every adjustment.</p>
        <dl className="flex flex-col gap-5 text-sm"><div className="flex justify-between border-b pb-4"><dt className="text-muted-foreground">Store</dt><dd>DEMO-STORE</dd></div><div className="flex justify-between border-b pb-4"><dt className="text-muted-foreground">Stock unit</dt><dd>Sellable packs</dd></div><div className="flex justify-between border-b pb-4"><dt className="text-muted-foreground">Access</dt><dd>Approved merchants</dd></div></dl>
        <p className="max-w-xs text-xs leading-5 text-muted-foreground">This workspace currently uses demo grocery inventory. Signing up does not grant access to an existing store.</p>
      </aside>
    </main></div>;
}
