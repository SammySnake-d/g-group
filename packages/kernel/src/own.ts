
export function dataDesc(value: unknown): PropertyDescriptor {
  const d: PropertyDescriptor = Object.create(null);
  d.value = value;
  d.writable = true;
  d.enumerable = true;
  d.configurable = true;
  return d;
}

export function pushOwn<T>(out: T[], v: T): void {
  Object.defineProperty(out, out.length, dataDesc(v));
}
