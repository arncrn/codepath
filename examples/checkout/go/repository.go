package main
import ("fmt"; "sync")
type Order struct {
  ID string `json:"id,omitempty"`
  Email string `json:"email"`
  Quantity int `json:"quantity"`
  Discount int `json:"discount"`
  Total int `json:"total"`
}
var orders=map[string]Order{}
var nextID=1
var mutex sync.Mutex
func saveOrder(input Order,events *[]Event)Order{
  mutex.Lock(); defer mutex.Unlock()
  order:=input
  order.ID=fmt.Sprintf("order-%03d",nextID); nextID++
  orders[order.ID]=order
  *events=append(*events,Event{"save",input,order})
  return order
}
