'use client';
import { useMemo,useState } from 'react';
import type { ColumnDef } from '@tanstack/react-table';
import { MoreHorizontal } from 'lucide-react';
import { RecordsTable } from './records-table';
import { Button } from './ui/button';
import { Badge } from './ui/badge';
import { Tabs,TabsList,TabsTrigger } from './ui/tabs';
import { Select,SelectTrigger,SelectValue,SelectContent,SelectGroup,SelectItem } from './ui/select';
import { pack,price,productName,stockStatus,type Product } from '@/lib/inventory';

export function InventoryTable({products,onAdjust}:{products:Product[];onAdjust:(p:Product)=>void}) {
  const [stock,setStock]=useState('all');const [category,setCategory]=useState('all');
  const columns=useMemo<ColumnDef<Product>[]>(()=>[
    {id:'product',accessorFn:productName,header:'Product',enableHiding:false,cell:({row})=><span className="block max-w-72 truncate font-medium" title={`${productName(row.original)} [${pack(row.original)}]`}>{productName(row.original)} <span className="font-normal text-muted-foreground">[{pack(row.original)}]</span></span>},
    {accessorKey:'sku',header:'SKU',cell:({row})=><span className="block max-w-48 truncate text-xs text-muted-foreground" title={row.original.sku}>{row.original.sku}</span>},
    {accessorKey:'category',header:'Category'},
    {accessorKey:'price',header:'Price',cell:({row})=>price(row.original.price),sortingFn:(a,b)=>Number(a.original.price??0)-Number(b.original.price??0)},
    {accessorKey:'on_hand',header:'On hand'},
    {accessorKey:'reserved',header:'Reserved'},
    {accessorKey:'available',header:'Available'},
    {id:'status',accessorFn:stockStatus,header:'Status',cell:({row})=>{
      const state=stockStatus(row.original);return <Badge variant={state==='Out of stock'?'out':state==='Low stock'?'warning':state==='Inactive'?'secondary':'success'}>{state}</Badge>;
    }},
    {id:'actions',enableHiding:false,enableSorting:false,cell:({row})=><Button size="icon-sm" variant="ghost" aria-label={`Adjust stock for ${productName(row.original)}`} onClick={()=>onAdjust(row.original)}><MoreHorizontal /></Button>},
  ],[onAdjust]);
  const filtered=products.filter(p=>(category==='all' || p.category===category) && (stock==='all' || (stock==='low'?p.available>0 && p.available<=5:p.available===0)));
  return <><Tabs value={stock} onValueChange={setStock}><TabsList variant="line" className="h-11"><TabsTrigger value="all">All products</TabsTrigger><TabsTrigger value="low">Low stock</TabsTrigger><TabsTrigger value="out">Out of stock</TabsTrigger></TabsList></Tabs>
    <RecordsTable data={filtered} columns={columns} noun="products" searchPlaceholder="Search product, brand or SKU" toolbar={<Select value={category} onValueChange={setCategory}><SelectTrigger aria-label="Category" className="h-9 w-40"><SelectValue /></SelectTrigger><SelectContent><SelectGroup><SelectItem value="all">All categories</SelectItem>{[...new Set(products.map(p=>p.category))].sort().map(c=><SelectItem key={c} value={c}>{c}</SelectItem>)}</SelectGroup></SelectContent></Select>} />
  </>;
}
