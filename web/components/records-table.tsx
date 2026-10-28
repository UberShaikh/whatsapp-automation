'use client';
import { useState } from 'react';
import { flexRender,getCoreRowModel,getFilteredRowModel,getPaginationRowModel,getSortedRowModel,useReactTable,type ColumnDef,type SortingState,type VisibilityState } from '@tanstack/react-table';
import { ArrowDown,ArrowUp,ArrowUpDown,ChevronLeft,ChevronRight,Columns3,Search } from 'lucide-react';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { Table,TableBody,TableCell,TableHead,TableHeader,TableRow } from './ui/table';
import { DropdownMenu,DropdownMenuTrigger,DropdownMenuContent,DropdownMenuGroup,DropdownMenuCheckboxItem } from './ui/dropdown-menu';
import { Select,SelectTrigger,SelectValue,SelectContent,SelectGroup,SelectItem } from './ui/select';
import { Empty,EmptyHeader,EmptyTitle,EmptyDescription } from './ui/empty';

export function RecordsTable<T>({data,columns,searchPlaceholder,toolbar,noun='records',emptyDescription='Change the filters or search to see matching records.'}:{data:T[];columns:ColumnDef<T>[];searchPlaceholder:string;toolbar?:React.ReactNode;noun?:string;emptyDescription?:string}) {
  const [sorting,setSorting]=useState<SortingState>([]);
  const [visibility,setVisibility]=useState<VisibilityState>({});
  const [search,setSearch]=useState('');
  const table=useReactTable({data,columns,state:{sorting,columnVisibility:visibility,globalFilter:search},
    onSortingChange:setSorting,onColumnVisibilityChange:setVisibility,onGlobalFilterChange:setSearch,
    getCoreRowModel:getCoreRowModel(),getFilteredRowModel:getFilteredRowModel(),getSortedRowModel:getSortedRowModel(),getPaginationRowModel:getPaginationRowModel(),initialState:{pagination:{pageSize:10}}});
  return <div className="flex min-w-0 flex-col">
    <div className="flex flex-wrap items-center gap-3 py-4"><div className="relative min-w-52 flex-1 md:max-w-xl"><Search className="pointer-events-none absolute top-2.5 left-3 size-4 text-muted-foreground" aria-hidden /><Input aria-label={searchPlaceholder} placeholder={searchPlaceholder} value={search} onChange={e=>setSearch(e.target.value)} className="h-9 pl-9" /></div>{toolbar}
      <DropdownMenu><DropdownMenuTrigger asChild><Button variant="outline" size="lg" className="ml-auto"><Columns3 data-icon="inline-start" />Columns</Button></DropdownMenuTrigger><DropdownMenuContent align="end"><DropdownMenuGroup>{table.getAllColumns().filter(c=>c.getCanHide()).map(column=><DropdownMenuCheckboxItem key={column.id} checked={column.getIsVisible()} onCheckedChange={value=>column.toggleVisibility(!!value)}>{typeof column.columnDef.header==='string'?column.columnDef.header:column.id}</DropdownMenuCheckboxItem>)}</DropdownMenuGroup></DropdownMenuContent></DropdownMenu>
    </div>
    <div className="min-w-0 border-y"><Table className="min-w-[1060px] text-[13px]"><TableHeader className="bg-muted/70">{table.getHeaderGroups().map(group=><TableRow key={group.id}>{group.headers.map(header=><TableHead key={header.id} className="px-3 text-xs text-muted-foreground" aria-sort={header.column.getIsSorted()==='asc'?'ascending':header.column.getIsSorted()==='desc'?'descending':undefined}>
      {header.isPlaceholder?null:header.column.getCanSort()?<button className="flex h-10 items-center gap-1.5" onClick={header.column.getToggleSortingHandler()}>{flexRender(header.column.columnDef.header,header.getContext())}{header.column.getIsSorted()==='asc'?<ArrowUp className="size-3" />:header.column.getIsSorted()==='desc'?<ArrowDown className="size-3" />:<ArrowUpDown className="size-3 opacity-40" />}</button>:flexRender(header.column.columnDef.header,header.getContext())}
    </TableHead>)}</TableRow>)}</TableHeader>
      <TableBody>{table.getRowModel().rows.length?table.getRowModel().rows.map(row=><TableRow key={row.id} className="h-12">{row.getVisibleCells().map(cell=><TableCell key={cell.id} className="px-3 py-2 tabular-nums">{flexRender(cell.column.columnDef.cell,cell.getContext())}</TableCell>)}</TableRow>):<TableRow><TableCell colSpan={table.getVisibleLeafColumns().length}><Empty><EmptyHeader><EmptyTitle>No matching records</EmptyTitle><EmptyDescription>{emptyDescription}</EmptyDescription></EmptyHeader></Empty></TableCell></TableRow>}</TableBody>
    </Table></div>
    <div className="flex flex-wrap items-center justify-between gap-4 py-5 text-xs text-muted-foreground"><p aria-live="polite">{table.getFilteredRowModel().rows.length} {table.getFilteredRowModel().rows.length===1?noun.replace(/s$/,''):noun}</p><div className="flex items-center gap-4"><Select value={String(table.getState().pagination.pageSize)} onValueChange={value=>table.setPageSize(Number(value))}><SelectTrigger aria-label="Rows per page" className="w-32"><SelectValue /></SelectTrigger><SelectContent><SelectGroup>{[10,20,50].map(n=><SelectItem key={n} value={String(n)}>{n} per page</SelectItem>)}</SelectGroup></SelectContent></Select><span>Page {table.getState().pagination.pageIndex+1} of {Math.max(1,table.getPageCount())}</span><div className="flex gap-2"><Button variant="outline" size="icon" aria-label="Previous page" disabled={!table.getCanPreviousPage()} onClick={()=>table.previousPage()}><ChevronLeft /></Button><Button variant="outline" size="icon" aria-label="Next page" disabled={!table.getCanNextPage()} onClick={()=>table.nextPage()}><ChevronRight /></Button></div></div></div>
  </div>;
}
