import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "node:path";

export default defineConfig({
  base: "./",
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src"),
      "@shared": path.resolve(__dirname, "../src/shared"),
    },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    cssCodeSplit: false,
    chunkSizeWarningLimit: 2000,
    sourcemap: false,
    modulePreload: false,
    rollupOptions: {
      input: path.resolve(__dirname, "index.html"),
      output: {
        entryFileNames: "assets/index.js",
        chunkFileNames: "assets/index.js",
        assetFileNames: (a) => (a.names?.some((n) => n.endsWith(".css")) ? "assets/index.css" : "assets/[name][extname]"),
        inlineDynamicImports: true,
      },
    },
  },
});
