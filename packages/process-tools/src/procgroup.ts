export const IS_WINDOWS = process.platform === "win32";
export interface ProcRow { readonly pid: number; readonly ppid: number; readonly pgid: number; readonly stat: string; }
export function signalGroup(_pid: number | undefined, _sig: NodeJS.Signals): void {}
export function processTable(_run: () => string): readonly ProcRow[] | null { return null; }
export function treeOf(_root: number, _table: readonly ProcRow[]): readonly ProcRow[] { return []; }
export function treeByPgrep(_root: number, _pgrep: (args: readonly string[]) => readonly number[] | null): readonly ProcRow[] | null { return null; }
export function stillAlive(_known: ProcRow, _table: readonly ProcRow[]): boolean { return false; }
