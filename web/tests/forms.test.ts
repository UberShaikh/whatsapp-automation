import assert from 'node:assert/strict';
import { test } from 'node:test';
import { authSchema } from '../lib/auth-schema.ts';
import { adjustmentSchema,nextStock,price,stockStatus,type Product } from '../lib/inventory.ts';

test('signup and recovery require valid email, long passwords and matching confirmation',()=>{
  const valid={name:'Test merchant',email:'merchant@example.test',password:'test-password-123',confirmPassword:'test-password-123'};
  assert.equal(authSchema('signup').safeParse(valid).success,true);
  assert.equal(authSchema('signup').safeParse({...valid,password:'short'}).success,false);
  assert.equal(authSchema('signup').safeParse({...valid,confirmPassword:'different'}).success,false);
  assert.equal(authSchema('signup').safeParse({...valid,email:'invalid'}).success,false);
  assert.equal(authSchema('forgot').safeParse({email:valid.email}).success,true);
  assert.equal(authSchema('reset').safeParse({password:valid.password,confirmPassword:valid.password}).success,true);
  assert.equal(authSchema('login').safeParse({email:valid.email,password:'older-password'}).success,true);
});
test('stock form uses whole packs and protects holds in every adjustment mode',()=>{
  const p={id:'11111111-1111-4111-a111-111111111111',on_hand:10,reserved:3,available:7,is_active:true} as Product;
  const values={variantId:p.id,action:'receive' as const,quantity:2,reason:'Supplier receipt'};
  assert.equal(adjustmentSchema.safeParse(values).success,true);
  assert.equal(adjustmentSchema.safeParse({...values,quantity:1.5}).success,false);
  assert.equal(adjustmentSchema.safeParse({...values,quantity:-1}).success,false);
  assert.equal(adjustmentSchema.safeParse({...values,reason:''}).success,false);
  assert.equal(nextStock(p,values),12);
  assert.equal(nextStock(p,{...values,action:'remove',quantity:7}),3);
  assert.throws(()=>nextStock(p,{...values,action:'remove',quantity:8}),/reserved/);
  assert.throws(()=>nextStock(p,{...values,action:'recount',quantity:2}),/reserved/);
  assert.throws(()=>nextStock(p,{...values,action:'recount',quantity:10}),/unchanged/);
  assert.equal(stockStatus({...p,available:0}),'Out of stock');
  assert.equal(stockStatus({...p,available:1}),'Low stock');
  assert.equal(price('NaN'),'Unpriced');
});
