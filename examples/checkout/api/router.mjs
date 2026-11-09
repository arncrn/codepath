import {createOrder} from './service.mjs';
export function handleOrder(request){
  if(request.method!=='POST'||request.path!=='/api/orders')return {status:404,body:{error:'Route not found'}};
  const events=[],input=request.body;
  events.push({stepId:'route',input:{method:request.method,path:request.path,body:input},output:input});
  try{return {status:201,body:{order:createOrder(input,events),events}};}
  catch(e){return {status:400,body:{error:e.message,events}};}
}
