// 你自己和 Helper 在界面里的身份。它们不是演示数据:连上后端时也一直在(后端的 contacts.list 只给联系人)。
// 你的显示名先用「我」;账户资料接上后换成真实名字。
import type { Person } from '@/data'

export const SELF: Person = { id: 'me', name: '我', initials: '我', role: '你', human: true, color: '#52525b' }
export const HELPER: Person = { id: 'helper', name: 'Helper', shape: 'lightbulb', color: '#f8a01c', role: '帮你操作这个软件' }
