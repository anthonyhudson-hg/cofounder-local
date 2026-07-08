import { invoke } from "@tauri-apps/api/core";
import { registerRequestHandler, unregisterRequestHandler, SidecarEvent } from "./sidecarBus";

export function invokeAndWait<T extends SidecarEvent>(
  command: string,
  args: Record<string, unknown>,
  id: string,
): Promise<T> {
  return new Promise((resolve, reject) => {
    registerRequestHandler(id, (event) => {
      unregisterRequestHandler(id);
      resolve(event as T);
    });
    invoke(command, args).catch((err) => {
      unregisterRequestHandler(id);
      reject(err);
    });
  });
}
