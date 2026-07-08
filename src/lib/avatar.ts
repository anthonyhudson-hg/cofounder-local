import { fetch as tauriFetch } from "@tauri-apps/plugin-http";

const AVATAR_SIZE = 160;

export function readImageAsResizedDataUrl(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error("Failed to read file"));
    reader.onload = () => {
      const img = new Image();
      img.onerror = () => reject(new Error("Failed to decode image"));
      img.onload = () => {
        const canvas = document.createElement("canvas");
        canvas.width = AVATAR_SIZE;
        canvas.height = AVATAR_SIZE;
        const ctx = canvas.getContext("2d");
        if (!ctx) {
          reject(new Error("Canvas not supported"));
          return;
        }

        const side = Math.min(img.width, img.height);
        const sx = (img.width - side) / 2;
        const sy = (img.height - side) / 2;
        ctx.drawImage(img, sx, sy, side, side, 0, 0, AVATAR_SIZE, AVATAR_SIZE);

        resolve(canvas.toDataURL("image/jpeg", 0.85));
      };
      img.src = reader.result as string;
    };
    reader.readAsDataURL(file);
  });
}

const FETCH_TIMEOUT_MS = 10_000;

export async function urlToResizedDataUrl(url: string): Promise<string> {
  // Candidate photos come from randomuser.me, which sends no CORS headers on
  // its image paths — the browser's own fetch() is rejected outright ("Failed
  // to fetch") even though the same domain's JSON API allows it. Routing
  // through the Tauri HTTP plugin makes the request from Rust, side-stepping
  // the renderer's CORS enforcement entirely.
  //
  // No timeout previously — a hung request blocked avatar generation
  // indefinitely with no recovery path (report §5.9).
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  let res: Awaited<ReturnType<typeof tauriFetch>>;
  try {
    res = await tauriFetch(url, { signal: controller.signal });
  } catch (err) {
    // Reuses the caught error object (message amended) rather than constructing a new
    // one, so the original error/stack is preserved without needing the ES2022
    // `Error(message, {cause})` overload this project's ES2020 target lacks.
    if (controller.signal.aborted && err instanceof Error) {
      err.message = `Avatar image request timed out: ${err.message}`;
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) throw new Error(`Failed to fetch image: ${res.status}`);
  const blob = await res.blob();
  return readImageAsResizedDataUrl(blob);
}
