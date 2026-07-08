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

export async function urlToResizedDataUrl(url: string): Promise<string> {
  // Candidate photos come from randomuser.me, which sends no CORS headers on
  // its image paths — the browser's own fetch() is rejected outright ("Failed
  // to fetch") even though the same domain's JSON API allows it. Routing
  // through the Tauri HTTP plugin makes the request from Rust, side-stepping
  // the renderer's CORS enforcement entirely.
  const res = await tauriFetch(url);
  if (!res.ok) throw new Error(`Failed to fetch image: ${res.status}`);
  const blob = await res.blob();
  return readImageAsResizedDataUrl(blob);
}
