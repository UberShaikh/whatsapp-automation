import { z } from 'zod';
export type AuthMode='login'|'signup'|'forgot'|'reset';
export const authSchema=(mode:AuthMode)=>z.object({
  name:mode==='signup'?z.string().trim().min(2,'Enter your full name.').max(100):z.string().optional(),
  email:mode==='reset'?z.string().optional():z.email('Enter a valid email address.').max(254),
  password:mode==='forgot'?z.string().optional():z.string().min(mode==='login'?1:12,mode==='login'?'Enter your password.':'Use at least 12 characters.').max(128),
  confirmPassword:z.string().optional(),
}).refine(v=>!['signup','reset'].includes(mode) || v.password===v.confirmPassword,{path:['confirmPassword'],message:'Passwords must match.'});
