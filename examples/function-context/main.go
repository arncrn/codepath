package main

type Server struct{}

func (s *Server) Handle() {
	callback := func() {
		println("inside callback") // Select this line: Server.Handle › anonymous
	}
	callback() // Select this line: Server.Handle
}

func (s Server) health() {
	println("private method") // Select this line: Server.health
}

func Identity[T any](value T) T {
	return value // Select this line: Identity
}

func main() {
	server := Server{}
	server.Handle()
	server.health()
	println(Identity(42))
}
