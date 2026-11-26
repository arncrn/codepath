## Big picture

This walkthrough follows a small Go program and shows which function owns each selected piece of code. A method creates a callback, invokes it, and then the program calls a private method and a generic function.

The shortcut mental model is: **creating a callback is not the same as calling it**, and **a method still belongs to its receiver type whether its name is exported or private**.

## Mental model

- **`Server`** is a struct with no fields in this example.
- **`Server.Handle`** is an exported method with a pointer receiver. It creates a local function value named `callback`, then invokes it synchronously.
- **`Server.Handle › anonymous`** identifies code inside that callback. The breadcrumb is lexical ownership, not a runtime stack trace.
- **`Server.health`** is an unexported method with a value receiver. Lowercase visibility does not stop Codepath from identifying its name.
- **`Identity[T]`** is generic: it returns its argument unchanged, preserving the argument's type. Its selected return line belongs to `Identity`.

## Worked example

The `main` function performs this sequence:

```go
server := Server{}
server.Handle()
server.health()
println(Identity(42))
```

Reading this example predicts the following output; these values are an illustration, not a recorded Codepath execution:

```text
inside callback
private method
42
```

The first message appears only after `callback()` is reached. Merely assigning the callback does not print it.

## What to look for in the cards

1. **Inside the callback** — the label is `Server.Handle › anonymous`.
2. **Invoke the callback** — the label returns to `Server.Handle`, because this call site is in the outer method.
3. **Call the private method** — the label is `Server.health`.
4. **Return the generic value** — the label is `Identity`.

Use **Explore the code** to jump directly to any of these cards, then return to **Overview** when you want the mental model again.

## Keep in mind

There are no goroutines here: the callback runs synchronously. Real callbacks may be registered now and invoked later, so inspect the actual call site before inferring execution order. The selected cards are reading checkpoints, not a complete call graph or proof of observed execution.
