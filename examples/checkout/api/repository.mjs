const orders=new Map();
let nextId=1;
export function saveOrder(input,events){
  const order={id:'order-'+String(nextId++).padStart(3,'0'),...input};
  orders.set(order.id,structuredClone(order));
  events.push({stepId:'save',input,output:order});
  return order;
}
