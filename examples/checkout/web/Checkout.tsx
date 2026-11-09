import React, {useState} from 'react';
import {createRoot} from 'react-dom/client';
import {sendOrder} from './api';
import {Receipt} from './Receipt';
export function Checkout(){
  const [email,setEmail]=useState(' Ada@Example.com ');
  const [quantity,setQuantity]=useState('2');
  const [coupon,setCoupon]=useState('SAVE10');
  const [receipt,setReceipt]=useState<any>(null);
  const [error,setError]=useState(''),[busy,setBusy]=useState(false);
  async function handleSubmit(event:React.FormEvent){
    event.preventDefault();setBusy(true);setError('');
    const input={email,quantity,coupon};
    const payload={...input,quantity:Number(quantity)};
    const events=[{stepId:'submit',input,output:payload}];
    try{setReceipt(await sendOrder(payload,events));}
    catch(e){setError(e instanceof Error?e.message:String(e));}
    finally{setBusy(false);}
  }
  return <main>
    <small>REACT CHECKOUT · REAL EXECUTION</small>
    <h1>Notebook shop</h1>
    <p>Submit an order to capture selected values through the code.</p>
    <form onSubmit={handleSubmit}>
      <label>Email<input value={email} onChange={e=>setEmail(e.target.value)}/></label>
      <label>Notebooks · $12 each<input type="number" min="1" max="10" value={quantity} onChange={e=>setQuantity(e.target.value)}/></label>
      <label>Coupon<input value={coupon} onChange={e=>setCoupon(e.target.value)}/></label>
      <small>SAVE10 takes 10% off two or more notebooks.</small>
      <button disabled={busy}>{busy?'Submitting…':'Submit order →'}</button>
    </form>
    {error&&<p role="alert">{error}</p>}
    {receipt&&<Receipt key={receipt.order.id} receipt={receipt}/>}
  </main>;
}
createRoot(document.getElementById('root')!).render(<Checkout/>);
