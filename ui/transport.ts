import type { AppConfig } from "../types.mjs";
import { parseReadingContext, readingContextKey } from "./reading-context";
import type { ReadingContext } from "./reading-context";

declare global {
  interface Window {
    CODEPATH_CONFIG: AppConfig;
    CODEPATH_TOKEN?: string;
  }
  function acquireVsCodeApi(): { postMessage(message: unknown): void };
}
export const config = window.CODEPATH_CONFIG;
const vscodeHost = config.host === "vscode" ? acquireVsCodeApi() : null;
export const inVSCode = !!vscodeHost;
const pendingHostRequests = new Map<
  string,
  {
    resolve: (responseBody: unknown) => void;
    reject: (error: Error) => void;
    responseTimeout: ReturnType<typeof setTimeout>;
  }
>();
const refreshListeners = new Set<() => void>();
const flowListeners = new Set<(message: unknown) => void>();
export function onFlowMessage(listener: (message: unknown) => void) {
  flowListeners.add(listener);
  return () => {
    flowListeners.delete(listener);
  };
}
if (vscodeHost)
  window.addEventListener("message", (event: MessageEvent<unknown>) => {
    const hostMessage = event.data as {
      type?: string;
      id?: string;
      error?: string;
      result?: unknown;
    } | null;
    if (hostMessage?.type?.startsWith("codepath.flow.")) {
      for (const listener of flowListeners) listener(hostMessage);
      return;
    }
    if (hostMessage?.type === "codepath.refresh") {
      for (const listener of refreshListeners) listener();
      return;
    }
    if (
      hostMessage?.type !== "codepath.response" ||
      typeof hostMessage.id !== "string"
    )
      return;
    const pendingRequest = pendingHostRequests.get(hostMessage.id);
    if (!pendingRequest) return;
    clearTimeout(pendingRequest.responseTimeout);
    pendingHostRequests.delete(hostMessage.id);
    if (hostMessage.error) pendingRequest.reject(Error(hostMessage.error));
    else pendingRequest.resolve(hostMessage.result);
  });
export function onRefresh(listener: () => void) {
  refreshListeners.add(listener);
  return () => {
    refreshListeners.delete(listener);
  };
}
export async function request<ResponseBody = unknown>(
  requestRoute: string,
  requestBody?: unknown
): Promise<ResponseBody> {
  if (vscodeHost)
    return new Promise<unknown>((resolve, reject) => {
      const hostRequestId = crypto.randomUUID();
      const responseTimeout = setTimeout(() => {
        pendingHostRequests.delete(hostRequestId);
        reject(
          Error("VS Code did not respond. Reopen Codepath and try again.")
        );
      }, 20000);
      pendingHostRequests.set(hostRequestId, {
        resolve,
        reject,
        responseTimeout,
      });
      vscodeHost.postMessage({
        type: "codepath.request",
        id: hostRequestId,
        route: requestRoute,
        body: requestBody,
      });
    }) as Promise<ResponseBody>;
  const httpResponse = await fetch(requestRoute, {
    method: requestBody ? "POST" : "GET",
    headers: {
      "Content-Type": "application/json",
      "X-Codepath-Token": window.CODEPATH_TOKEN ?? "",
    },
    ...(requestBody ? { body: JSON.stringify(requestBody) } : {}),
  });
  const responseData: unknown = await httpResponse.json();
  if (!httpResponse.ok)
    throw Error(
      (responseData as { error?: string }).error || "Request failed."
    );
  return responseData as ResponseBody;
}
// Browser localStorage survives reload/reopen on the same origin/profile. A
// different service port is a different origin. VS Code uses host workspaceState
// because acquireVsCodeApi state alone does not survive panel disposal.
export async function loadReadingContext(): Promise<ReadingContext | null> {
  try {
    return parseReadingContext(
      vscodeHost
        ? await request("reading-context/get")
        : JSON.parse(
            localStorage.getItem(readingContextKey(config.root)) ?? "null"
          )
    );
  } catch {
    return null;
  }
}
export async function saveReadingContext(value: ReadingContext): Promise<void> {
  try {
    if (vscodeHost) await request("reading-context/set", value);
    else
      localStorage.setItem(
        readingContextKey(config.root),
        JSON.stringify(value)
      );
  } catch {
    /* Storage is optional; reading must still work. */
  }
}
