import path from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";

const upstream = path.resolve(import.meta.dirname, "src/dsbot-base/upstream");
const primitives = path.join(upstream, "app/ui/src/primitives.js");
const bridge = path.resolve(import.meta.dirname, "src/dsbot/bridge.ts");
const attachments = path.resolve(import.meta.dirname, "src/dsbot/attachments.js");

// Fail a build on upstream drift instead of silently dropping an integration seam.
function replaceOnce(source: string, before: string, after: string): string {
  if (source.split(before).length !== 2) throw new Error(`DS-Bot 接缝不再唯一: ${before.slice(0, 100)}`);
  return source.replace(before, after);
}

// The desktop window uses precisely the upstream renderer. Only its two transport
// modules and product branding are rebound. Attachment controls and the removal
// of a non-existent admin role are explicit additions, never substitute screens.
function dsBotWindow(): Plugin {
  return {
    name: "g-group-ds-bot-window",
    enforce: "pre",
    resolveId(source, importer) {
      if (source === "./dsh-primitives.js" && importer?.replaceAll("\\", "/").includes("/ds-bot/src/client/")) return primitives;
      return null;
    },
    load(id) {
      const file = id.split("?")[0];
      if (file === path.join(upstream, "ds-bot/src/client/api.js")) return `export { call } from ${JSON.stringify(bridge)}`;
      if (file === path.join(upstream, "app/ui/src/api.js")) return `export { openFeed } from ${JSON.stringify(bridge)}`;
      return null;
    },
    transform(code, id) {
      if (!id.startsWith(upstream) || !id.endsWith(".js")) return null;
      let branded = code.replaceAll("DS Bot", "g-group");
      if (id.endsWith("/characters.js")) {
        branded = branded.replace("Object.freeze({ shape: 'whale', color: 'deepseek' })", "Object.freeze({ shape: 'ring', color: 'blue' })")
          .replace("PICKER_SHAPES = Object.keys(CHARACTERS)", "PICKER_SHAPES = Object.keys(CHARACTERS).filter(id => id !== 'whale')");
      }
      // The standalone upstream window only asks for Bot history. A g-group
      // group has its own real room/session ID; keep its existing Chat tree.
      if (id.endsWith("/app/ui/src/chat.js")) {
        branded = `import { usePendingAttachments, PendingAttachments } from ${JSON.stringify(attachments)};\n` + branded;
        for (const [before, after] of [
          ["useChat(bot?.id, sessionId, feed)", "useChat(bot?.id ?? roster.roomsById[sessionId]?.id, sessionId, feed)"],
          ["const send = async (text, actions, sessionId) =>", "const send = async (text, actions, sessionId, attachments = []) =>"],
          ["const entry = { kind: 'user', text, time: Date.now() }", "const entry = { kind: 'user', text, time: Date.now(), attachments }"],
          ["await actions.send(sessionId, text)", "await actions.send(sessionId, text, attachments)\n      setPending(list => list.filter(item => item !== entry))"],
          ["function Composer({ sessionId, placeholder, disabled, onSend, actions, useUi, useRoster }) {", "function Composer({ sessionId, placeholder, disabled, onSend, actions, useUi, useRoster }) {\n  const queue = usePendingAttachments(sessionId, disabled)"],
          ["if (value === '' || disabled) return", "if ((value === '' && queue.items.length === 0) || disabled || queue.sending) return"],
          ["await onSend(value)", "await queue.send(value, onSend)"],
          ["return h('div', { className: 'dsb-composer-wrap' },", "return h('div', { className: 'dsb-composer-wrap', onPaste: queue.paste },\n    h(PendingAttachments, { queue }),"],
          ["h('div', { className: 'dsb-composer-tools' }", "h('input', { type: 'file', multiple: true, hidden: true, disabled: disabled || queue.sending, 'aria-label': '添加附件', onChange: event => { queue.add([...event.target.files]); event.target.value = '' } }),\n      h('div', { className: 'dsb-composer-tools' }"],
          ["          disabled,", "          disabled: disabled || queue.sending,"],
          ["disabled: disabled || text.trim() === ''", "disabled: disabled || queue.sending || (text.trim() === '' && queue.items.length === 0)"],
          ["onSend: text => send(text, actions, sessionId)", "onSend: (text, attachments) => send(text, actions, sessionId, attachments)"],
        ]) branded = replaceOnce(branded, before, after);
      }
      if (id.endsWith("/client/team-actions.js")) {
        branded = replaceOnce(branded, "send: (sessionId, text) => after(call('send', { sessionId: partFor(sessionId), text }))", "send: (sessionId, text, attachments = []) => after(call('send', { sessionId: partFor(sessionId), text, attachments }))");
      }
      if (id.endsWith("/client/user-message.js")) branded += "\nexport { Attachments };\n";
      if (id.endsWith("/client/cells.js")) {
        branded = `import { MessageAttachments } from ${JSON.stringify(attachments)};\n` + branded;
        for (const [before, after] of [
          ["    row.images ? h('span'", "    h(MessageAttachments, { row }),\n    !row.attachments?.length && row.images ? h('span'"],
          ["item.kind === 'bot' && last?.kind === 'bot'", "item.kind === 'bot' && last?.kind === 'bot' && !item.attachments?.length && !last.attachments?.length"],
          ["{ kind: 'bot', texts: [item.text], time: item.time, end: item.time }", "{ ...item, kind: 'bot', texts: [item.text], time: item.time, end: item.time }"],
          ["return speaker ? h(Fragment, { key }, h(SpeakerHead, { bot: speaker, time: row.time }), bubbles) : bubbles", "const content = speaker ? h(Fragment, { key }, h(SpeakerHead, { bot: speaker, time: row.time }), bubbles) : bubbles\n      return row.attachments?.length ? h(Fragment, { key }, content, h(MessageAttachments, { row })) : content"],
          ["      return h(GroupMessage, {\n        key, bot: poster, text: row.file", "      return h(Fragment, { key }, h(GroupMessage, {\n        key, bot: poster, text: row.file"],
          ["whole: row.file ? { length: row.length, load: () => actions.fileText(row.file) } : undefined,\n      })", "whole: row.file ? { length: row.length, load: () => actions.fileText(row.file) } : undefined,\n      }), h(MessageAttachments, { row }))"],
        ]) branded = replaceOnce(branded, before, after);
      }
      // g-group groups consist of equal members. Keep NewChat's original picker,
      // tokens and controls, but never ask the user to invent an administrator.
      if (id.endsWith("/client/new-chat.js")) {
        for (const [before, after] of [
          ["const choosingAdmin = group && admin === null", "const choosingAdmin = false"],
          ["if (admin === null || picked.length === 0) return", "if (picked.length < 2) return"],
          ["actions.createRoom([admin, ...picked], { admin, ...(sectionId ? { sectionId } : {}), ...(text ? {} : { greet: true }) })", "actions.createRoom(picked, sectionId ? { sectionId } : {})"],
          ["if (group && admin !== null)", "if (group)"],
          ["group && admin !== null ? h('button'", "group && picked.length > 0 ? h('button'"],
          ["disabled: busy || picked.length === 0,", "disabled: busy || picked.length < 2,"],
          ["title: picked.length === 0 ?", "title: picked.length < 2 ?"],
        ]) branded = replaceOnce(branded, before, after);
      }
      return branded === code ? null : { code: branded, map: null };
    },
  };
}

// 渲染层构建。Electron 用 app:// 协议从 dist/ 读文件,所以 base 用相对路径。
export default defineConfig({
  base: "./",
  plugins: [dsBotWindow(), react()],
  resolve: {
    dedupe: ["react", "react-dom"],
    alias: {
      "@": path.resolve(import.meta.dirname, "./src"),
      "@g-group/ui-core": path.resolve(import.meta.dirname, "../../packages/ui-core/src/index.ts"),
      "@g-group/api-contract": path.resolve(import.meta.dirname, "../../packages/api-contract/src/index.ts"),
    },
  },
  server: { port: 5199, strictPort: true },
  build: { outDir: "dist", emptyOutDir: true },
});
