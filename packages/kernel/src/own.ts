// 包内部工具(不从 index.ts 导出,package.json 的 exports 只开放 "."):只用于内核自己刚建的结果数组与对象。
// 对外公开的追加入口是 plain.ts 的 appendOwn,它先按普通数组合同整体判定目标再调用这里。

/** 传给 defineProperty 的描述符:空原型对象,不会从 Object.prototype 继承 get/set/value/writable/enumerable/configurable */
export function dataDesc(value: unknown): PropertyDescriptor {
  const d: PropertyDescriptor = Object.create(null);
  d.value = value;
  d.writable = true;
  d.enumerable = true;
  d.configurable = true;
  return d;
}

/** 往内核自建数组末尾追加自有元素:用 defineProperty,不经过 Array.prototype 上的同名 setter 或只读下标 */
export function pushOwn<T>(out: T[], v: T): void {
  Object.defineProperty(out, out.length, dataDesc(v));
}
