// U58 / D11：P1 只读摘要插件。只处理宿主交来的当前会话快照，不调用写接口。
const firstLine = (s) => String(s).split(/\r?\n/)[0].slice(0, 80);
export default {
  kind: "ui-extension",
  command(req) {
    const s = req.snapshot;
    if (!s) throw new Error("/ketchup 需要 chat:read 权限");
    const changes = [];
    for (const t of s.tasks) {
      if (t.sourceSeq > s.fromSeq) changes.push(`新建:「${t.title}」(${t.id})#${t.sourceSeq}`);
      if (t.deliveredSeq !== null && t.deliveredSeq > s.fromSeq) changes.push(`交付:「${t.title}」(${t.id})#${t.deliveredSeq}`);
      if ((!s.boundaryAt || t.updatedAt > s.boundaryAt) && (t.state === "T11_Failed" || t.state === "T10_Cancelled")) changes.push(`${t.state === "T11_Failed" ? "失败" : "取消"}:「${t.title}」(${t.id})（当前状态）`);
    }
    const prefix = `/ketchup · 自 #${s.fromSeq} 之后到 #${s.toSeq}:`;
    if (s.messageCount === 0 && changes.length === 0 && s.pending.length === 0) return { text: `${prefix}没有新消息,没有任务变更,也没有等你拍板的事。` };
    const groups = new Map();
    for (const m of s.messages) {
      const key = `${m.sender.kind}:${m.sender.id}`;
      if (!groups.has(key)) groups.set(key, { name: m.name, lines: [] });
      groups.get(key).lines.push(`#${m.seq} ${firstLine(m.text)}`);
    }
    const pendingLabel = { question: "等你回答", authorization: "等你授权", delivery: "待你确认交付" };
    const lines = [prefix, `新消息 ${s.messageCount} 条${s.truncated ? "（只列最近 200 条）" : ""}`];
    for (const g of groups.values()) lines.push(`${g.name}:`, ...g.lines);
    if (changes.length) lines.push("任务变更:", ...changes);
    for (const p of s.pending) lines.push(`${pendingLabel[p.kind]}:「${p.title}」(${p.taskId ?? "无任务"})#${p.seq}`);
    return { text: lines.join("\n") };
  },
};
