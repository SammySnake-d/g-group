export class Feed<T> {
  push(_value: T) {}
  async *iterate(): AsyncGenerator<T> {}
}
