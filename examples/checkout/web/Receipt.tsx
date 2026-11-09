import React,{useEffect,useState} from 'react';
export function Receipt({receipt}:{receipt:any}){
  const {order}=receipt;
  const message='Order '+order.id+' confirmed. Total: $'+(order.total/100).toFixed(2)+'.';
  const [status,setStatus]=useState('Saving captured values…');
  useEffect(()=>{
    const events=[...receipt.events,{stepId:'display',input:order,output:{message}}];
    fetch('/api/demo/capture',{
      method:'POST',
      headers:{'Content-Type':'application/json','X-Codepath-Token':(window as any).CODEPATH_TOKEN},
      body:JSON.stringify({walkthroughId:receipt.walkthroughId,label:order.quantity+' notebooks · '+order.email,events})
    }).then(async r=>{if(!r.ok)throw new Error((await r.json()).error);setStatus('Run captured. Close the example to inspect it.');})
      .catch(e=>setStatus('Capture failed: '+e.message));
  },[receipt]);
  return <section className="receipt"><strong>{message}</strong><p>Receipt for {order.email}</p><small>{status}</small></section>;
}
