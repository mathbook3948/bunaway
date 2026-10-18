# Web dev server

During development, `bunaway dev` starts the template's web dev server (Vite) with the command and
URL from `src-bunaway/bunaway.json`, waits for it, then connects the native window. The server
serves the UI entry with the Vite client for HMR and the CSP the CLI injects.

## Sub-features

- `web-start` the `dev.command` starts and answers on the configured port.
- `web-vite-client` the page carries `src="/@vite/client"`.
- `web-csp` the page's CSP allows `'self'` styles and the HMR WebSocket on the loopback port.

## How to get to it (user POV)

- Run `bun run dev` inside a Vite-family project; the CLI starts `dev:web` and the native window.
- Run `bun run dev:web` alone to get only the web server, which is what this drive does.

## Driving it with verify-bunaway

Preconditions:

- A project created with `--template vite`, `react`, `vue` or `svelte`, `doctor` all `OK`.

- **Start and fetch.** Run `verify-bunaway web build/verify-bunaway/<run>/app --evidence
  build/verify-bunaway/<run>/evidence`. Exit code `0` and "PASS web dev server at
  http://127.0.0.1:<port>/".
- **Vite client.** `evidence/web.json` has `pass` true and `html` containing
  `<script type="module" src="/@vite/client">`.
- **CSP.** The same `html` carries the CSP meta tag the template injects, with `style-src 'self'
  'unsafe-inline'` and `connect-src 'self' ws://127.0.0.1:<port>`.
- **Proof.** Quote the two HTML lines and the exit code.

## Gotchas

- The vanilla template has no `dev` block; `web` exits 1 with a message naming the templates that
  have one.
- The helper picks a free port and passes `--port`; the port in `bunaway.json` is not used, so the
  CSP's `connect-src` port in the served page is the helper's port.
- The dev server's stderr in `web.json` ends with exit code 143 because the helper kills it after
  the fetch; that is cleanup, not a failure.
- The native window and HMR delivery into a real WebView are not covered here; they need the OS
  runners in [Native hosts](./native-hosts.md).
