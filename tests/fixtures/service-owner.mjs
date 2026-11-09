import http from "node:http";
import net from "node:net";
import { startProjectService } from "../../dist/service.mjs";

let service, release;
const original = net.Server.prototype.listen;
if (process.env.HOLD_LISTENER) {
  net.Server.prototype.listen = function (...args) {
    const httpListener = this instanceof http.Server;
    const selected =
      process.env.HOLD_LISTENER === "http" ? httpListener : !httpListener;
    if (selected) {
      const callback = args.pop();
      args.push(function (...values) {
        release = () => callback.apply(this, values);
        process.send({ event: "held" });
      });
    }
    return original.apply(this, args);
  };
}
process.on("message", async ({ id, command, args }) => {
  try {
    let result;
    if (command === "start") {
      const pending = startProjectService(process.env.PROJECT_ROOT, {
        assetsRoot: process.env.ASSETS_ROOT,
        reuse: true,
      });
      process.send({ event: "invoked" });
      service = await pending;
      result = { owned: service.owned, url: service.url };
    } else if (command === "release") release();
    else if (command === "call") result = await service.call(...args);
    else if (command === "close") await service?.close();
    else throw Error("Unknown fixture command.");
    process.send({ id, result });
  } catch (error) {
    process.send({ id, error: error.stack });
  }
});
process.send({ event: "ready" });
