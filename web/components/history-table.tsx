'use client';
import type { ColumnDef } from '@tanstack/react-table';
import type { Movement } from '@/lib/inventory';
import { RecordsTable } from './records-table';
const columns:ColumnDef<Movement>[]=[
  {accessorKey:'created_at',header:'Date',cell:({row})=>new Intl.DateTimeFormat('en-IN',{dateStyle:'medium',timeStyle:'short',timeZone:'Asia/Kolkata'}).format(new Date(row.original.created_at))},
  {id:'product',accessorFn:m=>`${m.brand} ${m.name}`,header:'Product',enableHiding:false,cell:({row})=><span className="block max-w-60 truncate">{row.original.brand} {row.original.name}</span>},
  {accessorKey:'sku',header:'SKU',cell:({row})=><span className="block max-w-44 truncate text-xs text-muted-foreground">{row.original.sku}</span>},
  {id:'type',accessorFn:m=>m.action==='receive'?'Stock received':m.action==='remove'?'Stock removed':m.action==='recount'?'Stock recount':m.kind==='opening_stock'?'Opening stock':m.kind==='sale'?'Order collection':m.kind,header:'Type'},
  {accessorKey:'quantity',header:'Pack change',cell:({row})=>`${row.original.quantity>0?'+':''}${row.original.quantity}`},
  {accessorKey:'after_qty',header:'On hand after',cell:({row})=>row.original.after_qty??'—'},
  {id:'reason',accessorFn:m=>m.reason??m.order_reference??(m.kind==='opening_stock'?'Opening balance':'Stock movement'),header:'Reason',cell:({getValue})=><span className="block max-w-64 truncate" title={String(getValue())}>{String(getValue())}</span>},
  {accessorKey:'user_id',header:'Changed by',cell:({row})=>row.original.user_id?`Merchant ${row.original.user_id.slice(0,8)}`:row.original.kind==='opening_stock'?'Store setup':'Order workflow'},
];
export function HistoryTable({movements}:{movements:Movement[]}) {return <RecordsTable data={movements} columns={columns} noun="movements" searchPlaceholder="Search product, reason or SKU" emptyDescription="Stock receipts, removals, recounts and order collections appear here after they are saved." />;}
