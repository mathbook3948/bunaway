import { defineConfig } from "vite";

export default defineConfig({
  clearScreen: false,
  base: "./",
  build: {
    outDir: "web-dist",
    emptyOutDir: true,
    target: "es2022",
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
    {
      name: "bunaway-development-page",
      apply: "serve",
      transformIndexHtml(html, context) {
        const port = context.server?.config.server.port ?? 5173;
        // Only the served development page permits CSS updates and the HMR socket.
        return html.replace(
          /<meta http-equiv="Content-Security-Policy"[^>]*>/,
          `<meta http-equiv="Content-Security-Policy" content="default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self' ws://127.0.0.1:${port}">`,
        );
      },
    },
  ],
});
