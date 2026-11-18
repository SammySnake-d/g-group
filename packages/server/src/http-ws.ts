import type { Server } from "node:http";
import type { WebSocketServer } from "ws";
import type { Started, StartOptions } from "./start.ts";

export interface HttpWsOptions {
  readonly host?: string;
  readonly port?: number;
  readonly token?: string;
  readonly corsOrigins?: readonly string[];
  readonly pingIntervalMs?: number;
  readonly maxBufferedBytes?: number;
}
export interface HttpWsServer {
  readonly httpUrl: string;
  readonly wsUrl: string;
  readonly server: Server;
  readonly wss: WebSocketServer;
  close(): Promise<void>;
}
export async function createHttpWsBridge(_started: Pick<Started, "host" | "service">, _options: HttpWsOptions = {}): Promise<HttpWsServer> {
  throw new Error("P1-C HTTP/WS bridge not implemented");
}
export async function serveHttpWs(_options: StartOptions & HttpWsOptions): Promise<HttpWsServer & { readonly started: Started }> {
  throw new Error("P1-C serve not implemented");
}
