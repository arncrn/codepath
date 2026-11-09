import http from "node:http";
import { startProjectService } from "../../dist/service.mjs";

const close = http.Server.prototype.close;
http.Server.prototype.close = function (callback) {
  return close.call(this, () => callback(Error("Drain failure fixture.")));
};
const service = await startProjectService(process.env.PROJECT_ROOT, {
  assetsRoot: process.env.ASSETS_ROOT,
});
try {
  await service.close();
} catch (error) {
  process.send({ error: error.message });
}
process.on("message", () => {});
