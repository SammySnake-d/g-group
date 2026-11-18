# Contracts and Bridge

`packages/api-contract` owns method names, runtime schemas, views, and `ServerEvent`. Its public source entry is [index.ts](../../packages/api-contract/src/index.ts). `packages/ui-core` consumes the bridge contract. The backend transport adapts it through [HTTP/WS](../../packages/server/src/http-ws.ts), including auth, replay, and resync.

Keep the frontend contract mirror compatible across releases. New RPCs and events can land on the backend first. A frontend-only RPC or event fails the parity check. The gate tracks names and exports. The transport and schema tests cover behavior.

Run `npm run check:contracts` and the owning API and transport tests when changing this boundary.
