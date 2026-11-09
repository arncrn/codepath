package main
import ("log"; "net/http"; "os")
func main(){
  address:=os.Getenv("CODEPATH_DEMO_ADDR")
  if address=="" { address="127.0.0.1:4178" }
  http.HandleFunc("/api/orders",handleOrder)
  log.Fatal(http.ListenAndServe(address,nil))
}
