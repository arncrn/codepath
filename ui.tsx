import { createRoot } from "react-dom/client";
import { App } from "./ui/App";
import { FlowWindowApp } from "./ui/flow-window-app";
import { config } from "./ui/transport";

const flowWindow =
  config.view === "flow" ||
  new URLSearchParams(location.search).get("view") === "flow";
createRoot(document.getElementById("root")!).render(
  flowWindow ? <FlowWindowApp /> : <App />
);
