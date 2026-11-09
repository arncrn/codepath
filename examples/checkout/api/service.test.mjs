import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createOrder} from './service.mjs';
test('Empty cart is rejected before persistence',()=>{
  const events=[];
  assert.throws(()=>createOrder({email:'ada@example.com',quantity:0,coupon:'SAVE10'},events),/1–10 notebooks/);
  assert.equal(events.some(e=>e.stepId==='save'),false);
});
test('SAVE10 requires two or more notebooks',()=>{
  const one=createOrder({email:' Ada@Example.com ',quantity:1,coupon:'SAVE10'});
  const two=createOrder({email:' Ada@Example.com ',quantity:2,coupon:'SAVE10'});
  assert.equal(one.total,1200);
  assert.equal(two.total,2160);
  assert.equal(two.email,'ada@example.com');
});
