import { createHash, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { API_VERSION, ATTACHMENT_UPLOAD_IPC_BYTES, type ErrorCode } from "@g-group/api-contract";
import { WebSocket, WebSocketServer } from "ws";
import { startServer, type Started, type StartOptions } from "./start.ts";

export interface HttpWsOptions {
  readonly host?: string;
  readonly port?: number;
  readonly token?: string;
  /** Omit for HTTP(S) loopback origins only; file:// and null require explicit opt-in. */
  readonly corsOrigins?: readonly string[];
  readonly pingIntervalMs?: number;
  readonly maxBufferedBytes?: number;
}
export interface HttpWsServer {
  readonly httpUrl: string;
  /** Endpoint without credentials; append sinceEventSeq/token as needed. */
  readonly wsUrl: string;
  readonly server: Server;
  readonly wss: WebSocketServer;
  close(): Promise<void>;
}
const BODY_LIMIT = ATTACHMENT_UPLOAD_IPC_BYTES + 4096;
const failure = (code: ErrorCode, message: string) => ({ ok: false, error: { code, message } });

/** Owns the transport only. The caller retains ownership of its Started host. */
export async function createHttpWsBridge(started: Pick<Started, "host" | "service">, options: HttpWsOptions = {}): Promise<HttpWsServer> {
  const host = options.host ?? "127.0.0.1";
  const port = options.port ?? 0;
  const pingIntervalMs = options.pingIntervalMs ?? 30_000;
  const maxBufferedBytes = options.maxBufferedBytes ?? 8 * 1024 * 1024;
  if (!Number.isSafeInteger(port) || port < 0 || port > 65535) throw new Error("port must be an integer from 0 to 65535");
  if (!Number.isSafeInteger(pingIntervalMs) || pingIntervalMs <= 0) throw new Error("pingIntervalMs must be a positive integer");
  if (!Number.isSafeInteger(maxBufferedBytes) || maxBufferedBytes <= 0) throw new Error("maxBufferedBytes must be a positive integer");
  const tokenHash = options.token ? createHash("sha256").update(options.token).digest() : undefined;
  const matches = (candidate: string | undefined) => tokenHash === undefined || (candidate !== undefined && timingSafeEqual(tokenHash, createHash("sha256").update(candidate).digest()));
  const bearer = (req: IncomingMessage) => req.headers.authorization?.startsWith("Bearer ") ? req.headers.authorization.slice(7) : undefined;
  const originAllowed = (origin: string | undefined): boolean => {
    if (origin === undefined) return true;
    if (options.corsOrigins) return options.corsOrigins.includes("*") || options.corsOrigins.includes(origin);
    try {
      const url = new URL(origin);
      return origin === url.origin && (url.protocol === "http:" || url.protocol === "https:") && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
    } catch { return false; }
  };
  const json = (res: ServerResponse, status: number, value: unknown) => {
    if (res.destroyed || res.writableEnded) return;
    res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify(value));
  };
  const server = createServer((req, res) => {
    // Fixed parsing base: neither Host nor a request URL can influence a destination.
    let url: URL;
    try { url = new URL(req.url ?? "/", "http://localhost"); }
    catch { req.resume(); json(res, 400, failure("invalid_params", "Invalid request URL")); return; }
    const origin = req.headers.origin;
    res.setHeader("Vary", "Origin");
    req.on("error", () => { json(res, 400, failure("invalid_params", "Incomplete request body")); });
    if (!originAllowed(origin)) { req.resume(); json(res, 403, failure("forbidden", "Origin not allowed")); return; }
    if (origin !== undefined) res.setHeader("Access-Control-Allow-Origin", options.corsOrigins?.includes("*") ? "*" : origin);
    if (req.method === "OPTIONS" && ["/api/invoke", "/api/health", "/api/events"].includes(url.pathname)) {
      req.resume();
      res.writeHead(204, { "Access-Control-Allow-Methods": "POST, GET, OPTIONS", "Access-Control-Allow-Headers": "Content-Type, Authorization" });
      res.end(); return;
    }
    if (req.method === "GET" && url.pathname === "/api/health") {
      req.resume();
      json(res, 200, tokenHash ? { ok: true } : { ok: true, apiVersion: API_VERSION, eventSeq: started.host.bus.head() });
      return;
    }
    if (req.method !== "POST" || url.pathname !== "/api/invoke") { req.resume(); json(res, 404, failure("not_found", "Route not found")); return; }
    if (!matches(bearer(req))) { req.resume(); json(res, 401, failure("forbidden", "Authentication required")); return; }
    if (Number(req.headers["content-length"]) > BODY_LIMIT) { req.resume(); json(res, 413, failure("invalid_params", "Request body exceeds upload limit")); return; }
    let size = 0;
    let chunks: Buffer[] = [];
    let oversized = false;
    req.on("data", (chunk: Buffer) => {
      if (oversized) return;
      size += chunk.length;
      if (size > BODY_LIMIT) {
        oversized = true; chunks = [];
        json(res, 413, failure("invalid_params", "Request body exceeds upload limit"));
      } else chunks.push(chunk);
    });
    req.on("end", () => {
      if (oversized) return;
      let payload: unknown;
      try { payload = JSON.parse(Buffer.concat(chunks, size).toString("utf8")); }
      catch { json(res, 400, failure("invalid_params", "Request must contain valid JSON")); return; }
      finally { chunks = []; }
      if (payload === null || typeof payload !== "object" || Array.isArray(payload) || !("method" in payload) || typeof payload.method !== "string") {
        json(res, 400, failure("invalid_params", "Expected an object with a string method")); return;
      }
      const params = "params" in payload ? payload.params : undefined;
      void started.service.handle(payload.method, params).then(
        result => json(res, 200, result),
        () => json(res, 500, failure("internal", "Invocation failed")),
      );
    });
  });
  const wss = new WebSocketServer({ noServer: true, maxPayload: 4096, perMessageDeflate: false });
  const clients = new Map<WebSocket, { alive: boolean; off?: () => void; disposed: boolean }>();
  const dispose = (ws: WebSocket) => {
    const state = clients.get(ws);
    if (!state || state.disposed) return;
    state.disposed = true; state.off?.(); clients.delete(ws);
  };
  let closing: Promise<void> | undefined;
  server.on("upgrade", (req, socket, head) => {
    const reject = (status: number, phrase: string) => {
      socket.end(`HTTP/1.1 ${status} ${phrase}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
    };
    socket.on("error", () => socket.destroy());
    let url: URL;
    try { url = new URL(req.url ?? "/", "http://localhost"); } catch { reject(400, "Bad Request"); return; }
    if (closing) { reject(503, "Service Unavailable"); return; }
    if (url.pathname !== "/api/events") { reject(404, "Not Found"); return; }
    if (!originAllowed(req.headers.origin)) { reject(403, "Forbidden"); return; }
    if (!matches(bearer(req)) && !matches(url.searchParams.get("token") ?? undefined)) { reject(401, "Unauthorized"); return; }
    const cursors = url.searchParams.getAll("sinceEventSeq");
    const raw = cursors[0];
    const since = raw === undefined ? undefined : Number(raw);
    if (cursors.length > 1 || (raw !== undefined && (!/^\d+$/.test(raw) || !Number.isSafeInteger(since) || (since ?? -1) < 0))) { reject(400, "Bad Request"); return; }
    wss.handleUpgrade(req, socket, head, ws => {
      const state: { alive: boolean; off?: () => void; disposed: boolean } = { alive: true, disposed: false };
      clients.set(ws, state);
      ws.on("pong", () => { state.alive = true; });
      ws.once("close", () => dispose(ws));
      ws.on("error", () => { dispose(ws); ws.terminate(); });
      const off = started.service.subscribe(event => {
        if (state.disposed || ws.readyState !== WebSocket.OPEN) return;
        const data = JSON.stringify(event);
        // Include the next frame: a single oversized event must not bypass the cap.
        if (ws.bufferedAmount + Buffer.byteLength(data) > maxBufferedBytes) {
          dispose(ws); ws.close(1008, "Event consumer exceeded buffer limit"); return;
        }
        ws.send(data, error => { if (error) { dispose(ws); ws.terminate(); } });
      }, since);
      // subscribe may synchronously replay enough data to dispose this connection.
      if (state.disposed) off(); else state.off = off;
    });
  });
  const pingTimer = setInterval(() => {
    for (const [ws, state] of clients) {
      if (!state.alive || ws.bufferedAmount > maxBufferedBytes) { dispose(ws); ws.terminate(); continue; }
      state.alive = false;
      if (ws.readyState === WebSocket.OPEN) ws.ping();
    }
    // Bound the close handshake of slow consumers removed from the subscription map.
    for (const ws of wss.clients) if (!clients.has(ws)) ws.terminate();
  }, pingIntervalMs);
  pingTimer.unref();
  try {
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => { server.off("listening", onListen); reject(error); };
      const onListen = () => { server.off("error", onError); resolve(); };
      server.once("error", onError); server.once("listening", onListen); server.listen(port, host);
    });
  } catch (error) { clearInterval(pingTimer); wss.close(); throw error; }
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("HTTP bridge has no TCP address");
  const authority = `${address.address.includes(":") ? `[${address.address}]` : address.address}:${address.port}`;
  return {
    httpUrl: `http://${authority}`, wsUrl: `ws://${authority}/api/events`, server, wss,
    close() {
      closing ??= (async () => {
        clearInterval(pingTimer);
        for (const ws of clients.keys()) dispose(ws);
        for (const ws of wss.clients) ws.terminate();
        await Promise.all([
          new Promise<void>((resolve, reject) => wss.close(error => error ? reject(error) : resolve())),
          new Promise<void>((resolve, reject) => {
            server.close(error => error ? reject(error) : resolve()); server.closeAllConnections();
          }),
        ]);
      })();
      return closing;
    },
  };
}

/** Owns both transport and host; failed listen also releases the host. */
export async function serveHttpWs(options: StartOptions & HttpWsOptions): Promise<HttpWsServer & { readonly started: Started }> {
  const started = await startServer(options);
  let bridge: HttpWsServer;
  try { bridge = await createHttpWsBridge(started, options); }
  catch (error) { await started.close(); throw error; }
  let closing: Promise<void> | undefined;
  return { ...bridge, started, close() {
    closing ??= (async () => { try { await bridge.close(); } finally { await started.close(); } })();
    return closing;
  } };
}
