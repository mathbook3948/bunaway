import { svelte } from "@sveltejs/vite-plugin-svelte";
import { defineConfig } from "vite";

export default defineConfig(({ command }) => ({
  clearScreen: false,
  base: "./",
  build: {
    outDir: "web-dist",
    emptyOutDir: true,
    target: "es2022",
    // Keep upstream logo images as local files under the production CSP.
    assetsInlineLimit: 0,
  },
  server: {
    host: "127.0.0.1",
    port: 5173,
    strictPort: true,
    watch: {
      ignored: [
        "**/src-bunaway/**",
        "**/.bunaway/**",
        "**/web-dist/**",
        "**/dist/**",
      ],
    },
  },
  plugins: [
    svelte(),
    {
      name: "bunaway-content-security-policy",
      transformIndexHtml(_html, context) {
        const port = context.server?.config.server.port ?? 5173;
        return [
          {
            tag: "meta",
            attrs: {
              "http-equiv": "Content-Security-Policy",
              content:
                command === "serve"
                  ? `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self' ws://127.0.0.1:${port}`
                  : "default-src 'self'; script-src 'self'; style-src 'self'",
            },
            injectTo: "head-prepend",
          },
        ];
      },
    },
  ],
}));
