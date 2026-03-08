import path from "node:path";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { tanstackRouter } from "@tanstack/router-plugin/vite";
import { defineConfig } from "vite";

const port = Number(process.env.PORT ?? 5733);

export default defineConfig({
  plugins: [
    tanstackRouter(),
    react({
      babel: {
        plugins: [["babel-plugin-react-compiler", { target: "19" }]],
      },
    }),
    tailwindcss(),
  ],
  optimizeDeps: {
    include: ["@pierre/diffs", "@pierre/diffs/react", "@pierre/diffs/worker/worker.js"],
  },
  define: {
    // In dev mode, tell the web app where the WebSocket server lives
    "import.meta.env.VITE_WS_URL": JSON.stringify(process.env.VITE_WS_URL ?? ""),
  },
  experimental: {
    enableNativePlugin: true,
  },
  resolve: {
    alias: {
      "prettier/standalone": path.resolve("node_modules/prettier/standalone.mjs"),
      "prettier/plugins/babel": path.resolve("node_modules/prettier/plugins/babel.mjs"),
      "prettier/plugins/estree": path.resolve("node_modules/prettier/plugins/estree.mjs"),
      "prettier/plugins/html": path.resolve("node_modules/prettier/plugins/html.mjs"),
      "prettier/plugins/markdown": path.resolve("node_modules/prettier/plugins/markdown.mjs"),
      "prettier/plugins/postcss": path.resolve("node_modules/prettier/plugins/postcss.mjs"),
      "prettier/plugins/typescript": path.resolve("node_modules/prettier/plugins/typescript.mjs"),
      "prettier/plugins/yaml": path.resolve("node_modules/prettier/plugins/yaml.mjs"),
    },
    tsconfigPaths: true,
  },
  server: {
    port,
    strictPort: true,
    hmr: {
      // Explicit config so Vite's HMR WebSocket connects reliably
      // inside Electron's BrowserWindow. Vite 8 uses console.debug for
      // connection logs — enable "Verbose" in DevTools to see them.
      protocol: "ws",
      host: "localhost",
    },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    chunkSizeWarningLimit: 700,
    rolldownOptions: {
      output: {
        codeSplitting: true,
        manualChunks(id) {
          if (!id.includes("node_modules")) {
            return undefined;
          }
          if (id.includes("@xterm/")) {
            return "vendor-xterm";
          }
          if (id.includes("@tanstack/")) {
            return "vendor-tanstack";
          }
          if (id.includes("@lexical/") || id.includes("lexical")) {
            return "vendor-lexical";
          }
          if (id.includes("prettier/")) {
            return "vendor-prettier";
          }
          if (id.includes("@pierre/diffs")) {
            return "vendor-diff";
          }
          if (id.includes("react")) {
            return "vendor-react";
          }
          return "vendor-misc";
        },
      },
    },
  },
});
