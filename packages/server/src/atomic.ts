export interface AtomicWriteOptions { mode?: number; durable?: boolean }
export function renameWithRetry(_from: string, _to: string, _rename?: (from: string, to: string) => void): void {}
export function writeFileAtomic(_path: string, _data: string | Uint8Array, _options?: AtomicWriteOptions): void {}
export function writeFileAtomicIfChanged(_path: string, _data: string, _options?: AtomicWriteOptions): boolean { return false; }
