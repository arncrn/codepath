package main
import ("encoding/json"; "net/http")
type Input struct {
  Email string `json:"email"`
  Quantity int `json:"quantity"`
  Coupon string `json:"coupon"`
}
type Event struct {
  StepID string `json:"stepId"`
  Input any `json:"input"`
  Output any `json:"output"`
}
func handleOrder(w http.ResponseWriter,r *http.Request){
  w.Header().Set("Content-Type","application/json")
  if r.Method!="POST" { w.WriteHeader(405); return }
  var input Input
  if err:=json.NewDecoder(http.MaxBytesReader(w,r.Body,65536)).Decode(&input); err!=nil {
    http.Error(w,"{\"error\":\"Invalid request\"}",400); return
  }
  events:=[]Event{{"route",map[string]any{"method":r.Method,"path":r.URL.Path,"body":input},input}}
  order,err:=createOrder(input,&events)
  if err!=nil {
    w.WriteHeader(400)
    json.NewEncoder(w).Encode(map[string]any{"error":err.Error(),"events":events}); return
  }
  w.WriteHeader(201)
  json.NewEncoder(w).Encode(map[string]any{"order":order,"events":events})
}
