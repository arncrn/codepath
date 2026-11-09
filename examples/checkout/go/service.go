package main
import ("errors"; "strings")
func createOrder(input Input,events *[]Event)(Order,error){
  email:=strings.ToLower(strings.TrimSpace(input.Email))
  if !strings.Contains(email,"@")||input.Quantity<1||input.Quantity>10 {
    message:="A valid email and 1–10 notebooks are required"
    *events=append(*events,Event{"normalize",input,map[string]string{"error":message}})
    return Order{},errors.New(message)
  }
  subtotal:=input.Quantity*1200
  discount:=0
  if input.Coupon=="SAVE10"&&input.Quantity>=2 { discount=subtotal/10 }
  normalized:=Order{Email:email,Quantity:input.Quantity,Discount:discount,Total:subtotal-discount}
  *events=append(*events,Event{"normalize",input,normalized})
  return saveOrder(normalized,events),nil
}
