import type { AppConfig, Walkthrough } from "../types.mjs";
import { getWalkthrough, saveWalkthrough } from "./api";

export function checkBrowserContract(config: AppConfig) {
  const host: "vscode" | undefined = config.host;
  // @ts-expect-error Browser code cannot use Node's process global.
  void process.stdout;
  return host;
}

export function checkNamedOperations() {
  const loaded: Promise<Walkthrough> = getWalkthrough("walkthrough-id");
  // @ts-expect-error A walkthrough identifier must be a string.
  void getWalkthrough(42);
  // @ts-expect-error Saving a walkthrough requires its title.
  void saveWalkthrough({ steps: [] });
  return loaded;
}
