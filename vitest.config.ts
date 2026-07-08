import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [react()],
  test: {
    environment: "jsdom",
    globals: true,
    // `sidecar/` is a separate Node subproject with its own test runner —
    // don't let this frontend config pick up (and fail on) its test files.
    include: ["src/**/*.{test,spec}.{ts,tsx}"],
  },
});
