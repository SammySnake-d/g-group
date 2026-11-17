import type { Page } from '@/ctx'
import { ProcessView } from '@/components/Workbench'
import { CloneFlow } from './clone/CloneFlow'
import { PersonPage, ToolsPage } from './PersonPage'
import { InnerPage } from './InnerPage'
import { DetailPage } from './DetailPage'
import { TalkPage } from './TalkPage'
import { WorkspacePage } from './WorkspacePage'
import { PinsPage } from './PinsPage'
import { GroupPage } from './GroupPage'
import { FilesPage } from './FilesPage'
import { PoolPage } from './PoolPage'
import { LinkPickPage, LinksPage } from './LinksPage'
import { PlaybookPage } from './PlaybookPage'
import { CommitsPage } from './CommitsPage'
import { SearchPage } from './SearchPage'
import { HuddlePage } from './HuddlePage'
import { ForwardPickPage, ForwardViewPage } from './ForwardPages'
import { HelperPage } from './HelperPage'
import { SettingsPage } from './SettingsPage'
import { AddContactPage } from './AddContactPage'
import { NewGroupPage } from './NewGroupPage'
import { SourcePage, SourcesPage } from './SourcesPage'
import { PageScroll } from './kit/parts'

/* 浮层路由:一种页一个组件,这里只做分发 */
export function PageBody({ p }: { p: Page }) {
  switch (p.t) {
    case 'person': return <PersonPage id={p.id} />
    case 'personTools': return <ToolsPage id={p.id} />
    case 'inner': return <InnerPage id={p.id} conv={p.conv} />
    case 'detail': return <DetailPage id={p.id} conv={p.conv} tab={p.tab} />
    case 'talk': return <TalkPage id={p.id} />
    case 'workspace': return <WorkspacePage id={p.id} />
    case 'pins': return <PinsPage id={p.id} />
    case 'members': return <GroupPage id={p.id} />
    case 'files': return <FilesPage id={p.id} />
    case 'group': return <GroupPage id={p.id} />
    case 'pool': return <PoolPage id={p.id} />
    case 'links': return <LinksPage id={p.id} />
    case 'linkPick': return <LinkPickPage id={p.id} />
    case 'playbook': return <PlaybookPage id={p.id} />
    case 'commits': return <CommitsPage id={p.id} />
    case 'clone': return <CloneFlow id={p.id} />
    case 'search': return <SearchPage id={p.id} />
    case 'huddle': return <HuddlePage conv={p.conv} msgId={p.msgId} />
    case 'forwardView': return <ForwardViewPage conv={p.conv} msgId={p.msgId} />
    case 'forwardPick': return <ForwardPickPage from={p.from} msgIds={p.msgIds} />
    case 'helper': return <HelperPage />
    case 'settings': return <SettingsPage />
    case 'addContact': return <AddContactPage />
    case 'newGroup': return <NewGroupPage />
    case 'sources': return <SourcesPage />
    case 'source': return <SourcePage id={p.id} />
    case 'process': return <PageScroll><ProcessView id={p.id} conv={p.conv} /></PageScroll>
    case 'cron': return null
    case 'task': return <PageScroll><ProcessView id={'claude'} /></PageScroll>
  }
}
