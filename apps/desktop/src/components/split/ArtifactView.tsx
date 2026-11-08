import { useState } from 'react'
import { people, artifacts } from '@/data'
import { useApp } from '@/ctx'
import { Button } from '@/components/ui/button'
import { Avatar } from '@/components/Avatar'
import { ArtifactIcon } from '@/components/Messages'
import { Hint } from '@/components/pages/kit/parts'
import { Preview } from './Preview'
import { DocConflict } from './DocConflict'
import { ARTICLE_INTRO, ARTICLE_SEC4, ASSET_NOTE_SPLIT, ASSET_ROWS, BOARD_NOTE, articleSections } from './constants'

/* ---------- 分屏里的文件 / 任务板 / 资产预览 ---------- */

/** 资产:键值表(和「文件」主面板同一份数据) */
export function AssetTable() {
  return (
    <div className="overflow-hidden rounded-xl border border-line">
      {ASSET_ROWS.map(([k, v]) => (
        <div key={k} className="flex border-b border-line px-4 py-2.5 text-[13.5px] last:border-0"><span className="w-24 shrink-0 text-fg-2">{k}</span><span className="min-w-0 break-words">{v}</span></div>
      ))}
    </div>
  )
}

export function ArtifactView({ id }: { id: string }) {
  const { addQuote, boards, claim } = useApp()
  const a = artifacts.find((x) => x.id === id)!
  const b = boards.b1
  const [sec4, setSec4] = useState(ARTICLE_SEC4)
  return (
    <div className="scroll-thin min-h-0 flex-1 overflow-y-auto" data-testid={`artifact-${id}`}>
      <div className="mx-auto max-w-[680px] px-8 py-6">
        <div className="mb-5 flex items-center gap-3">
          <ArtifactIcon kind={a.kind} />
          <div className="min-w-0">
            <div className="truncate text-[17px] font-semibold tracking-tight">{a.name}</div>
            <div className="flex items-center gap-1.5 text-[12.5px] text-fg-2"><Avatar id={a.by} size={16} status={false} mood="idle" />{people[a.by].name} · {a.when}</div>
          </div>
        </div>
        {a.kind === 'page' ? <Preview kind="login" /> : a.kind === 'sheet' ? (
          <>
            <table className="w-full text-[13.5px]">
              <thead><tr className="border-b border-line text-left text-fg-2"><th className="py-2 font-medium">任务</th><th className="font-medium">认领</th><th /></tr></thead>
              <tbody>
                {b.rows.map((r, i) => (
                  <tr key={r.task} className="border-b border-line">
                    <td className="py-2.5">{r.task}</td>
                    <td>{r.who ? <span className="inline-flex items-center gap-1.5"><Avatar id={r.who} size={18} status={false} mood="idle" />{people[r.who].name}</span> : <span className="text-warm">没人领</span>}</td>
                    <td className="text-right">{!r.who && <Button data-testid={`claim-${i}`} variant="ghost" size="xs" onClick={() => claim('b1', i, 'grok')} className="h-6 px-2 font-normal">演示：让 Grok 认领</Button>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <Hint className="mt-3 text-[12px]">{BOARD_NOTE}</Hint>
          </>
        ) : a.kind === 'asset' ? (
          <div className="space-y-3">
            <AssetTable />
            <div className="text-[12.5px] text-fg-3">{ASSET_NOTE_SPLIT}</div>
          </div>
        ) : (
          <article className="space-y-3 text-[14.5px] leading-[1.8]">
            <p className="text-fg-2">{ARTICLE_INTRO}</p>
            {articleSections(sec4).map(([h, bb]) => (
              <section key={h} className="group/s relative -mx-3 rounded-lg px-3 py-1 transition-colors duration-fast ease-out hover:bg-hover/50">
                <h3 className="text-[15.5px] font-semibold">{h}</h3>
                <p>{bb}</p>
                <Button variant="floating" size="xs" onClick={() => addQuote({ msgId: 'g2', from: a.by, text: `${a.name} · ${h}：${bb}` })}
                  className="absolute right-2 top-1.5 h-6 px-2 text-[12px] font-normal text-fg-2 opacity-0 transition-[opacity,color,background-color] hover:text-fg focus-visible:opacity-100 group-hover/s:opacity-100">引用到对话</Button>
              </section>
            ))}
            <DocConflict sec={sec4} onResolved={setSec4} />
          </article>
        )}
      </div>
    </div>
  )
}
