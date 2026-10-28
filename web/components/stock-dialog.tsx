'use client';
import { useRef,useState } from 'react';
import { Controller,useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { LoaderCircle } from 'lucide-react';
import { adjustmentSchema,nextStock,pack,productName,type AdjustmentValues,type Product } from '@/lib/inventory';
import { Dialog,DialogContent,DialogDescription,DialogHeader,DialogTitle,DialogFooter } from './ui/dialog';
import { Field,FieldGroup,FieldLabel,FieldError,FieldDescription } from './ui/field';
import { Input } from './ui/input';
import { Button } from './ui/button';
import { Alert,AlertDescription } from './ui/alert';
import { Select,SelectContent,SelectGroup,SelectItem,SelectTrigger,SelectValue } from './ui/select';

export function StockDialog({products,selected,onClose,onSave}:{products:Product[];selected?:Product;onClose:()=>void;onSave:(values:AdjustmentValues,product:Product,requestId:string)=>Promise<void>}) {
  const [error,setError]=useState('');const request=useRef<{hash:string;id:string}|null>(null);
  const form=useForm<AdjustmentValues>({resolver:zodResolver(adjustmentSchema),mode:'onBlur',defaultValues:{variantId:selected?.id??'',action:'receive',quantity:1,reason:''}});
  const product=products.find(p=>p.id===form.watch('variantId'));const action=form.watch('action');const quantity=form.watch('quantity');
  let next:number|undefined;
  try {if (product && Number.isInteger(quantity) && quantity>=0) next=nextStock(product,{variantId:product.id,action,quantity,reason:''});} catch {/* Validation is shown when saving. */}
  async function save(values:AdjustmentValues) {
    setError('');if (!product) {form.setError('variantId',{message:'Choose a product.'});return;}
    try {
      nextStock(product,values);
      const hash=JSON.stringify([values,product.on_hand,product.reserved]);
      if (request.current?.hash!==hash) request.current={hash,id:crypto.randomUUID()};
      await onSave(values,product,request.current!.id);onClose();
    } catch(e) {setError(e instanceof Error?e.message:'Stock could not be saved. Refresh before trying again.');}
  }
  return <Dialog open onOpenChange={open=>{if (!open && !form.formState.isSubmitting) onClose();}}><DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-md"><DialogHeader><DialogTitle>Adjust stock</DialogTitle><DialogDescription>Update sellable packs. Existing order reservations stay protected.</DialogDescription></DialogHeader>
    <form onSubmit={form.handleSubmit(save)} className="flex flex-col gap-5" noValidate><FieldGroup>
      <Field data-invalid={!!form.formState.errors.variantId}><FieldLabel htmlFor="product">Product</FieldLabel><Controller name="variantId" control={form.control} render={({field})=><Select value={field.value} onValueChange={field.onChange}><SelectTrigger id="product" className="w-full" aria-invalid={!!form.formState.errors.variantId}><SelectValue placeholder="Choose a product" /></SelectTrigger><SelectContent><SelectGroup>{products.map(p=><SelectItem key={p.id} value={p.id}>{productName(p)} · {pack(p)}</SelectItem>)}</SelectGroup></SelectContent></Select>} /><FieldError errors={[form.formState.errors.variantId]} /></Field>
      {product?<dl className="grid grid-cols-3 gap-3 rounded-md bg-muted p-3 text-xs"><div><dt className="text-muted-foreground">On hand</dt><dd className="mt-1 text-base font-semibold tabular-nums">{product.on_hand}</dd></div><div><dt className="text-muted-foreground">Reserved</dt><dd className="mt-1 text-base font-semibold tabular-nums">{product.reserved}</dd></div><div><dt className="text-muted-foreground">Available</dt><dd className="mt-1 text-base font-semibold tabular-nums">{product.available}</dd></div></dl>:null}
      <Field><FieldLabel htmlFor="action">Adjustment</FieldLabel><Controller name="action" control={form.control} render={({field})=><Select value={field.value} onValueChange={field.onChange}><SelectTrigger id="action" className="w-full"><SelectValue /></SelectTrigger><SelectContent><SelectGroup><SelectItem value="receive">Receive stock</SelectItem><SelectItem value="remove">Remove stock</SelectItem><SelectItem value="recount">Set counted stock</SelectItem></SelectGroup></SelectContent></Select>} /></Field>
      <Field data-invalid={!!form.formState.errors.quantity}><FieldLabel htmlFor="quantity">{action==='recount'?'Counted packs':'Number of packs'}</FieldLabel><Input id="quantity" type="number" inputMode="numeric" min={action==='recount'?0:1} max={1000000} step={1} {...form.register('quantity',{valueAsNumber:true})} aria-invalid={!!form.formState.errors.quantity} /><FieldDescription>{next!==undefined?`On hand after save: ${next} packs. Available: ${next-(product?.reserved??0)}.`:'Enter a whole number of sellable packs.'}</FieldDescription><FieldError errors={[form.formState.errors.quantity]} /></Field>
      <Field data-invalid={!!form.formState.errors.reason}><FieldLabel htmlFor="reason">Reason</FieldLabel><Input id="reason" placeholder="For example, supplier delivery or damaged packs" maxLength={200} {...form.register('reason')} aria-invalid={!!form.formState.errors.reason} /><FieldError errors={[form.formState.errors.reason]} /></Field>
    </FieldGroup>{error?<Alert variant="destructive" role="alert"><AlertDescription>{error}</AlertDescription></Alert>:null}
    <DialogFooter><Button variant="outline" type="button" disabled={form.formState.isSubmitting} onClick={onClose}>Cancel</Button><Button type="submit" disabled={form.formState.isSubmitting}>{form.formState.isSubmitting?<LoaderCircle data-icon="inline-start" className="animate-spin motion-reduce:animate-none" />:null}Save stock</Button></DialogFooter>
    </form></DialogContent></Dialog>;
}
