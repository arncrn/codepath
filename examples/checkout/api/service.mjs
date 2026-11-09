import {saveOrder} from './repository.mjs';
export function createOrder(input,events=[]){
  const email=String(input.email??'').trim().toLowerCase(),quantity=Number(input.quantity);
  if(!email.includes('@')||!Number.isInteger(quantity)||quantity<1||quantity>10){
    const error='A valid email and 1–10 notebooks are required';
    events.push({stepId:'normalize',input,output:{error}});throw Error(error);
  }
  const subtotal=quantity*1200;
  const discount=input.coupon==='SAVE10'&&quantity>=2?Math.round(subtotal*0.1):0;
  const normalized={email,quantity,discount,total:subtotal-discount};
  events.push({stepId:'normalize',input,output:normalized});
  return saveOrder(normalized,events);
}
