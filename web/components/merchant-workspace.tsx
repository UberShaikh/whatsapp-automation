'use client';
import { useCallback,useState } from 'react';
import { useRouter } from 'next/navigation';
import { useTheme } from 'next-themes';
import { AlertCircle,Plus,RefreshCw } from 'lucide-react';
import { toast } from 'sonner';
import { MerchantShell } from './merchant-shell';
import { InventoryTable } from './inventory-table';
import { HistoryTable } from './history-table';
import { StockDialog } from './stock-dialog';
import { Button } from './ui/button';
import { Alert,AlertTitle,AlertDescription } from './ui/alert';
import { Empty,EmptyHeader,EmptyTitle,EmptyDescription } from './ui/empty';
import { Select,SelectTrigger,SelectValue,SelectContent,SelectGroup,SelectItem } from './ui/select';
import { nextStock,type AdjustmentValues,type Product,type Movement } from '@/lib/inventory';
import type { WorkspaceData } from '@/lib/workspace';
import { cn } from '@/lib/utils';

export function MerchantWorkspace({initialView,initialProducts,initialHistory,name,email,preview=false,error:initialError,accessPending:initialPending=false}:WorkspaceData) {
  const [view,setView]=useState(initialView);const [products,setProducts]=useState(initialProducts);const [history,setHistory]=useState(initialHistory);
  const [error,setError]=useState(initialError??'');const [busy,setBusy]=useState(false);const [dialog,setDialog]=useState<{product?:Product}|null>(null);
  const [accessPending,setAccessPending]=useState(initialPending);
  const router=useRouter();const {theme,setTheme}=useTheme();
  const openAdjustment=useCallback((p:Product)=>setDialog({product:p}),[]);
  async function refresh() {
    if (preview) {toast.info('Preview quantities reset when you reload this page.');return;}
    setBusy(true);setError('');
    try {
      const inventory=await fetch('/api/inventory',{cache:'no-store'});const data=await inventory.json();
      if (inventory.status===401) {router.push('/login');return;}
      if (!inventory.ok) {if (inventory.status===403) setAccessPending(true);throw new Error(data.error??'Inventory could not be refreshed.');}
      setAccessPending(false);
      setProducts(data.products);
      if (view==='history') {
        const response=await fetch('/api/history',{cache:'no-store'});const result=await response.json();
        if (!response.ok) throw new Error(result.error??'History could not be refreshed.');
        setHistory(result.movements);
      }
    } catch(e) {setError(e instanceof Error?e.message:'Inventory could not be refreshed. Try again.');} finally {setBusy(false);}
  }
  async function save(values:AdjustmentValues,p:Product,requestId:string) {
    const next=nextStock(p,values);
    if (preview) {
      setProducts(items=>items.map(item=>item.id===p.id?{...item,on_hand:next,available:next-item.reserved}:item));
      setHistory(items=>[{id:requestId,created_at:new Date().toISOString(),kind:'adjustment',quantity:next-p.on_hand,sku:p.sku,name:p.name,brand:p.brand,action:values.action,reason:values.reason,before_qty:p.on_hand,after_qty:next,reserved_qty:p.reserved,user_id:'preview',order_reference:null},...items]);
      toast.success('Preview stock updated. Database unchanged.');return;
    }
    let response:Response;
    try {response=await fetch('/api/adjustments',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({...values,requestId,expectedOnHand:p.on_hand,expectedReserved:p.reserved})});}
    catch {throw new Error('Save could not be confirmed. Refresh stock before retrying.');}
    const result=await response.json();
    if (!response.ok) {if (response.status===409) await refresh();throw new Error(result.error??'Stock could not be saved.');}
    setProducts(items=>items.map(item=>item.id===p.id?{...item,on_hand:result.onHand,reserved:result.reserved,available:result.onHand-result.reserved}:item));
    toast.success(result.repeated?'This stock adjustment was already saved.':'Stock saved.');
  }
  const metrics=[['Products',products.length],['Available packs',products.reduce((sum,p)=>sum+p.available,0)],['Reserved packs',products.reduce((sum,p)=>sum+p.reserved,0)],['Out of stock',products.filter(p=>p.available===0).length]];
  return <MerchantShell view={view} name={name} preview={preview} onViewChange={setView}>
    <div className="flex flex-wrap items-start justify-between gap-4"><div className="flex flex-col gap-2"><h1 className="text-[28px] leading-9 font-semibold tracking-tight">{view==='inventory'?'Inventory':view==='history'?'Stock history':'Account'}</h1><p className="text-sm text-muted-foreground">{view==='inventory'?'Track sellable packs and update stock.':view==='history'?'Latest 100 stock movements. Times shown in India Standard Time.':'Your merchant profile and store access.'}</p></div><div className="flex gap-2">{!preview?<Button variant="outline" size="lg" aria-label="Refresh stock" disabled={busy} onClick={refresh}><RefreshCw className={busy?'animate-spin motion-reduce:animate-none':''} />Refresh</Button>:null}{view==='inventory'?<Button size="lg" disabled={accessPending || !products.length || busy} onClick={()=>setDialog({})}><Plus data-icon="inline-start" />Adjust stock</Button>:null}</div></div>
    {error?<Alert variant="destructive" className="mt-6"><AlertCircle /><AlertTitle>{accessPending?'Merchant approval needed':'Stock could not be loaded'}</AlertTitle><AlertDescription>{error}</AlertDescription></Alert>:null}
    {view==='inventory'?<><dl className="mt-5 grid grid-cols-2 gap-y-5 border-t py-6 md:grid-cols-4">{metrics.map(([label,value],i)=><div key={label} className={cn('pr-5',i%2===1 && 'border-l pl-6',i===2 && 'md:border-l md:pl-6')}><dt className="text-[13px] text-muted-foreground">{label}</dt><dd className={cn('mt-1 text-[28px] leading-8 font-semibold tabular-nums',label==='Out of stock' && Number(value)>0 && 'text-destructive')}>{error && !products.length?'—':value}</dd></div>)}</dl><div className="mt-3"><InventoryTable products={products} onAdjust={openAdjustment} /></div><p className="mt-2 text-xs text-muted-foreground">Quantities are sellable packs. Low stock: 1–5 available packs. Demo inventory.</p></>:null}
    {view==='history'?<div className="mt-6"><HistoryTable movements={history} /></div>:null}
    {view==='account'?<div className="mt-8 flex max-w-xl flex-col gap-7"><dl className="flex flex-col gap-5 text-sm"><div className="flex justify-between gap-4 border-b pb-4"><dt className="text-muted-foreground">Full name</dt><dd>{name}</dd></div><div className="flex justify-between gap-4 border-b pb-4"><dt className="text-muted-foreground">Email</dt><dd className="break-all">{email||'Local preview'}</dd></div><div className="flex justify-between gap-4 border-b pb-4"><dt className="text-muted-foreground">Store access</dt><dd>{preview?'Preview only':accessPending?'Awaiting approval':error?'Not verified':'DEMO-STORE'}</dd></div></dl><div className="flex items-center justify-between gap-4"><label htmlFor="theme">Appearance</label><Select value={theme??'light'} onValueChange={setTheme}><SelectTrigger id="theme" className="w-36"><SelectValue /></SelectTrigger><SelectContent><SelectGroup><SelectItem value="light">Light</SelectItem><SelectItem value="dark">Dark</SelectItem></SelectGroup></SelectContent></Select></div><Button asChild variant="outline" className="w-fit"><a href="/forgot-password">Reset password</a></Button></div>:null}
    {!products.length && !error && view==='inventory'?<Empty><EmptyHeader><EmptyTitle>No stocked products</EmptyTitle><EmptyDescription>Ask the store owner to import the product catalog manually before adjusting stock.</EmptyDescription></EmptyHeader></Empty>:null}
    {dialog?<StockDialog key={dialog.product?.id??'new'} products={products} selected={dialog.product} onClose={()=>setDialog(null)} onSave={save} />:null}
  </MerchantShell>;
}
