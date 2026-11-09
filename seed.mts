import fs from "node:fs";
import path from "node:path";
import type { openWorkspace } from "./workspace.mjs";
export function seed(workspace: ReturnType<typeof openWorkspace>) {
  const ref = (file: string, symbol: string) => ({ file, symbol });
  const lines = fs
    .readFileSync(path.join(workspace.root, "web/api.ts"), "utf8")
    .split("\n");
  const response = {
    file: "web/api.ts",
    startLine: lines.findIndex((l) => l.includes("@path response:start")) + 2,
    endLine: lines.findIndex((l) => l.includes("@path response:end")),
  };
  const input = { email: " Ada@Example.com ", quantity: "2", coupon: "SAVE10" },
    payload = { ...input, quantity: 2 };
  const normalized = {
      email: "ada@example.com",
      quantity: 2,
      discount: 240,
      total: 2160,
    },
    order = { id: "order-001", ...normalized };
  for (const backend of ["node", "go"]) {
    const go = backend === "go",
      dir = go ? "go" : "api",
      extension = go ? "go" : "mjs";
    const steps = [
      {
        id: "submit",
        title: "Handle Submit",
        source: ref("web/Checkout.tsx", "handleSubmit"),
        explanation:
          "Checkout binds the form onSubmit to this handler. Convert the quantity string to a number.",
        sample: { input, output: payload },
      },
      {
        id: "request",
        title: "Send the request",
        source: ref("web/api.ts", "sendOrder"),
        explanation:
          "POST /demo-api/orders is forwarded by the prototype adapter to this sample’s /api/orders route.",
        sample: {
          input: payload,
          output: {
            method: "POST",
            url: "/api/orders",
            body: JSON.stringify(payload),
          },
        },
      },
      {
        id: "route",
        title: "Enter the backend",
        source: ref(
          dir + "/" + (go ? "handler" : "router") + "." + extension,
          "handleOrder"
        ),
        explanation: go
          ? "main.go binds /api/orders to handleOrder. Decode JSON into Input."
          : "The adapter calls handleOrder, which matches POST /api/orders.",
        sample: {
          input: { method: "POST", path: "/api/orders", body: payload },
          output: payload,
        },
      },
      {
        id: "normalize",
        title: "Validate and price",
        source: ref(dir + "/service." + extension, "createOrder"),
        explanation:
          "Trim and lowercase the email. Apply SAVE10 only when quantity is at least two. Money uses integer cents.",
        sample: { input: payload, output: normalized },
      },
      {
        id: "save",
        title: "Save the order",
        source: ref(dir + "/repository." + extension, "saveOrder"),
        explanation:
          "Assign an ID and persist in an in-memory repository. Restarting the demo clears orders.",
        sample: { input: normalized, output: order },
      },
      {
        id: "response",
        title: "Read the response",
        source: response,
        explanation:
          "The awaited response resumes sendOrder. Read and unwrap the order.",
        sample: { input: { status: 201, body: order }, output: order },
      },
      {
        id: "display",
        title: "Render the receipt",
        source: ref("web/Receipt.tsx", "Receipt"),
        explanation:
          "handleSubmit sets receipt state. Checkout mounts Receipt. The effect captures a selected value after React commits.",
        sample: {
          input: order,
          output: { message: "Order order-001 confirmed. Total: $21.60." },
        },
      },
    ].map((s) => ({ ...s, evidence: "source" as const }));
    workspace.invoke("save_walkthrough", {
      id: "checkout-" + backend,
      title: "Submit an order · " + (go ? "Go" : "Node"),
      description:
        "Two notebooks, SAVE10, and a receipt. Follow the click through the request, service, repository and React render.",
      steps,
    });
    workspace.invoke("add_note", {
      walkthroughId: "checkout-" + backend,
      stepId: "normalize",
      author: "Example author",
      body: "Try quantity 1, then 2. A single notebook does not receive the SAVE10 discount. Compare the captured total and discount fields.",
    });
  }
  workspace.invoke("save_walkthrough", {
    id: "empty-cart-test",
    title: "Reject an empty cart · test",
    description:
      "A test is one possible starting point. This one checks validation before persistence.",
    steps: [
      {
        id: "test",
        title: "Exercise the empty cart",
        source: ref(
          "api/service.test.mjs",
          "test: Empty cart is rejected before persistence"
        ),
        evidence: "source",
        explanation:
          "assert.throws checks the validation error. The second assertion checks that no save event was emitted.",
      },
      {
        id: "normalize",
        title: "Reject before saving",
        source: ref("api/service.mjs", "createOrder"),
        evidence: "source",
        explanation: "The quantity guard throws before saveOrder is called.",
        sample: {
          input: { email: "ada@example.com", quantity: 0, coupon: "SAVE10" },
          output: { error: "A valid email and 1–10 notebooks are required" },
        },
      },
    ],
  });
}
