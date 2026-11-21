import type { MessageView } from "@g-group/api-contract";
import type { InboundMessage } from "@g-group/kernel";

export function replyMentions(text: string, peers: readonly { id: string; name: string }[]): MessageView["mentions"] {
  const idsByName = new Map<string, string | null>();
  for (const { id, name } of peers) {
    if (name) idsByName.set(name, idsByName.has(name) ? null : id);
  }
  if (!idsByName.size) return [];

  const names = [...idsByName.keys()].sort((a, b) => b.length - a.length);
  const alternatives = names.map(name => name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
  const pattern = new RegExp(`(?<![\\p{L}\\p{M}\\p{N}_@.+-])@(${alternatives})(?![\\p{L}\\p{M}\\p{N}_])`, "gu");
  const mentioned = new Set<string>();
  for (const match of text.matchAll(pattern)) {
    const id = idsByName.get(match[1]!);
    if (id) mentioned.add(id);
  }
  return [...mentioned].map(id => ({ id, source: "auto" }));
}

const noReply = /(?:^|[，。！？!?；;,\n])\s*(?:其他人|其余人?|任何人|所有人)?(?:不用|无需|不要|别)回复[。！!\s]*$/u;

export function replyAudienceRefusal(
  user: InboundMessage,
  contactId: string,
  replyToSeq: number | null,
  repeated: () => boolean,
): string | null {
  const addressed = user.mentions.includes(contactId);
  const ref = `${user.roomId} #${user.seq}`;
  if (replyToSeq === user.seq && user.quotedSeqs.length > 0 && user.mentions.length > 0 && !addressed) {
    return `这条引用回复点名的是其他联系人,不是你(${ref})`;
  }
  if (!noReply.test(user.text)) return null;
  if (!addressed) return `用户已明确要求其他联系人不回复(${ref})`;
  return repeated() ? `本联系人已发过同样的回复(${ref})` : null;
}
