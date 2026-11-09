export async function sendOrder(payload:unknown,events:any[]){
  const body=JSON.stringify(payload);
  events.push({stepId:'request',input:payload,output:{method:'POST',url:'/api/orders',body}});
  const response=await fetch('/demo-api/orders',{
    method:'POST',
    headers:{'Content-Type':'application/json','X-Codepath-Token':(window as any).CODEPATH_TOKEN},
    body
  });
  // @path response:start
  const result=await response.json();
  if(!response.ok)throw new Error(result.error);
  events.push(...result.events);
  events.push({stepId:'response',input:{status:response.status,body:result.order},output:result.order});
  return {order:result.order,events,walkthroughId:result.walkthroughId};
  // @path response:end
}
