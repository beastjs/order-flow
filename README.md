# cfx

A [Beast](https://www.npmjs.com/package/beast-tsrx) project powered by
[TSRX](https://tsrx.dev/) and [Octane](https://octanejs.dev/).

```bash
bun install
bun run dev
```

The starter is one quiet screen: a headline, a counter that shows component
state, and links to the docs. It follows the system light/dark preference. The
palette, type, and motion live in a few custom properties at the top of
`src/style.css`.

Edit `src/App.btsx` to get started. Declare typed props at the top of the BTSX
file; the Beast bundler adapter compiles it into native TSRX and then lets Octane
produce the browser module.

The starter pins the tested `octane@0.16.0` toolchain. Run the complete local
verification before shipping:

```bash
bun run check
```

Use `scope` when setup belongs to an exact child position instead of the whole
component:

```btsx
scope
  setup const label = "Owned by this child";
  p #{label}
```

Octane signals need no build option. Import `octane/signals` in a module to
enable native signal reads there:

```btsx
import { createScope } from "octane/signals"
```

Record application changes in [CHANGELOG.md](CHANGELOG.md).

Node compiler builds require `@tsrx/oxc@0.20.0`, included explicitly in the
starter. The TSRX type-checking plugin is pinned to `0.6.3`.

## Selected stack

- Bundler: rsbuild
- UI: base-ui (@octanejs/base-ui)
- Styling: Tailwind CSS v4

```ts
import { Button } from "@octanejs/base-ui/button";
```

## Optional tools

- Beast Devtools: press **Alt+Shift+D** while the dev server runs. Octane profiling is enabled only in development.
- Beast Page Builder: press **⌘B / Ctrl+B** while the dev server runs. Creating routes requires a TanStack router and an app shell with an Outlet; this starter does not create those automatically.
- Beast UI: `bun run beast-ui add button` copies editable components into `src/components/ui`. Tailwind CSS v4 and the `@/*` alias are already configured.
- Beast icons: import `{ Icon }` from `@/lib/icons`. Add SVGs to `src/lib/icons/svg`, then run `bun run icons:build`. Check generated output with `bun run icons:check`.

Setup commands (the builder runs these after installation; run them yourself with `--no-install`):

```sh
bun install
bun run beast-ui init --package-manager bun
bun run beast-ui icons init --framework beast
```

## Asgard user directory

The Users page requires a Firebase sign-in on the current origin and the `god` claim. Add the Asgard hostname to Firebase Authentication's authorized domains for Google sign-in. [Firebase Authentication settings](https://firebase.google.com/docs/auth/faq-and-troubleshooting#limit_your_authorized_authentication_domains)

The directory API uses Firebase Admin credentials from `.env` with `bun run dev`, `.dev.vars` with `bun run cf:dev`, or the deployed Worker bindings. Supply `FIREBASE_PROJECT_ID`, `FIREBASE_CLIENT_EMAIL`, and `FIREBASE_PRIVATE_KEY`, or a `FIREBASE_SERVICE_ACCOUNT_KEY` JSON secret. [Cloudflare Worker secrets](https://developers.cloudflare.com/workers/configuration/secrets/)

For Open Up and Open Down counts, configure the server with the matching Convex `CONVEX_SITE_URL` and the same randomly generated `ASGARD_POSITION_COUNTS_SECRET` on both the server and the Convex deployment. The counts include cloud paper positions and OKX positions that are open or still closing.

## Paper Total TP/SL polling

Set `PAPER_TOTAL_EXIT_POLL_SECONDS` to a positive whole number of seconds. The default is `60`.
For development, put it in `.env` and start the backend with `bun run dev:convex`.
This copies the value to the configured Convex dev deployment before pushing the backend.
For other deployments, set it under **Settings → Environment Variables** in the Convex dashboard and redeploy to apply the new interval.

## My OKX trading

Set `OKX_USER_KEY_ENCRYPTION_KEY` on the Convex deployment to a randomly generated 32-byte hex key. Keep it stable and use a separate value for each deployment. Convex uses it to encrypt user credentials at rest. My OKX becomes available when the deployment has a valid key.

```sh
openssl rand -hex 32 | bunx convex env set OKX_USER_KEY_ENCRYPTION_KEY
```

Signed-in users can connect a demo or live key under **Account → My OKX**. Use a dedicated global OKX sub-account with Futures or Multi-currency margin account mode, Long/short position mode, and an API key with Read and Trade permissions. Fund the OKX trading account with USDT and select **My OKX** on an OKX market to place isolated-margin market orders. OKX applies its own margin and liquidation rules. If a position is closed in OKX, use **Close position** in CFX to verify that it is flat and update the history.

Users can replace a key for the same OKX account and environment while positions are active. Close the positions and wait for pending orders to settle before switching accounts, switching environments, or disconnecting. See the [OKX API guide](https://www.okx.com/docs-v5/en/).
