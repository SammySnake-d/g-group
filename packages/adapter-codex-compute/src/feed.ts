export class Feed<T> {
  private queue: T[] = [];
  private wake: (() => void) | undefined;
  push(value: T) { this.queue.push(value); this.wake?.(); }
  async *iterate(): AsyncGenerator<T> {
    try {
      for (;;) {
        while (this.queue.length) yield this.queue.shift()!;
        await new Promise<void>(resolve => { this.wake = resolve; });
      }
    } finally { this.wake = undefined; }
  }
}
