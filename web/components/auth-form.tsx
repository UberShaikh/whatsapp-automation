'use client';
import { useState } from 'react';
import Link from 'next/link';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { LoaderCircle } from 'lucide-react';
import { authAction } from '@/app/auth/actions';
import { authSchema,type AuthMode } from '@/lib/auth-schema';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { Field,FieldGroup,FieldLabel,FieldError,FieldDescription } from './ui/field';
import { Alert,AlertDescription } from './ui/alert';
type Values={name:string|undefined;email:string|undefined;password:string|undefined;confirmPassword?:string};
const labels={login:'Sign in',signup:'Create account',forgot:'Send reset link',reset:'Save new password'};
export function AuthForm({mode,configured}:{mode:AuthMode;configured:boolean}) {
  const [result,setResult]=useState<{error?:string;message?:string}>({});
  const form=useForm<Values>({resolver:zodResolver(authSchema(mode)),mode:'onBlur',defaultValues:{name:'',email:'',password:'',confirmPassword:''}});
  async function save(values:Values) {
    setResult({});
    try {setResult(await authAction(mode,values));} catch {setResult({error:'The account service could not be reached. Try again.'});}
  }
  return <form onSubmit={form.handleSubmit(save)} className="flex flex-col gap-5" noValidate><FieldGroup className="gap-4">
      {mode==='signup'?<Field data-invalid={!!form.formState.errors.name}><FieldLabel htmlFor="name">Full name</FieldLabel><Input id="name" autoComplete="name" {...form.register('name')} aria-invalid={!!form.formState.errors.name} /><FieldError errors={[form.formState.errors.name]} /></Field>:null}
      {mode!=='reset'?<Field data-invalid={!!form.formState.errors.email}><FieldLabel htmlFor="email">Email</FieldLabel><Input id="email" type="email" autoComplete="email" {...form.register('email')} aria-invalid={!!form.formState.errors.email} /><FieldError errors={[form.formState.errors.email]} /></Field>:null}
      {mode!=='forgot'?<Field data-invalid={!!form.formState.errors.password}><div className="flex items-center justify-between"><FieldLabel htmlFor="password">Password</FieldLabel>{mode==='login'?<Link className="text-xs text-primary underline-offset-4 hover:underline" href="/forgot-password">Forgot password?</Link>:null}</div><Input id="password" type="password" autoComplete={mode==='login'?'current-password':'new-password'} {...form.register('password')} aria-invalid={!!form.formState.errors.password} />{mode!=='login'?<FieldDescription>Use at least 12 characters.</FieldDescription>:null}<FieldError errors={[form.formState.errors.password]} /></Field>:null}
      {['signup','reset'].includes(mode)?<Field data-invalid={!!form.formState.errors.confirmPassword}><FieldLabel htmlFor="confirmPassword">Confirm password</FieldLabel><Input id="confirmPassword" type="password" autoComplete="new-password" {...form.register('confirmPassword')} aria-invalid={!!form.formState.errors.confirmPassword} /><FieldError errors={[form.formState.errors.confirmPassword]} /></Field>:null}
    </FieldGroup>
    {result.error?<Alert variant="destructive" role="alert"><AlertDescription>{result.error}</AlertDescription></Alert>:null}
    {result.message?<Alert role="status"><AlertDescription>{result.message}</AlertDescription></Alert>:null}
    <Button size="lg" type="submit" disabled={!configured || form.formState.isSubmitting || !!result.message}>{form.formState.isSubmitting?<LoaderCircle data-icon="inline-start" className="animate-spin motion-reduce:animate-none" />:null}{labels[mode]}</Button>
    {mode==='login'?<p className="text-sm text-muted-foreground">Need a merchant account? <Link className="font-medium text-primary underline-offset-4 hover:underline" href="/signup">Create account</Link></p>:<Link className="text-sm text-primary underline-offset-4 hover:underline" href="/login">Back to sign in</Link>}
  </form>;
}
