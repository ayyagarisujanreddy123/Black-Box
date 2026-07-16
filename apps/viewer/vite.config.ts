import { fileURLToPath } from "node:url";

import { defineConfig } from "vite";

const root = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  root,
  base: "/",
  build: {
    outDir: fileURLToPath(new URL("./dist/public", import.meta.url)),
    emptyOutDir: true,
    sourcemap: true,
  },
});
