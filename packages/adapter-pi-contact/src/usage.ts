import type { PiProtocol } from "./protocols.ts";
export interface RequestProbe { readonly prefixHash: string; readonly breakpoints: number; readonly explicitBreakpoints?: boolean }
export function probeRequest(_payload: unknown, _protocol?: PiProtocol): RequestProbe { throw new Error("B4 red stub: prefix probe"); }
export function placeBreakpoints(_payload: unknown): unknown { throw new Error("B4 red stub: breakpoint placement"); }
export function usageLine(_provider: string, _baseUrl: string, _model: string, _secret: string): string { throw new Error("B4 red stub: usage line"); }
