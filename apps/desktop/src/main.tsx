import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import { applyMotionCssVars } from './config/motion'
import { ComputePreview } from './components/compute/Preview'

const query = new URLSearchParams(location.search)
// 首帧前就定好主题,避免先亮后暗闪一下
if (query.get('theme') === 'dark') document.documentElement.classList.add('dark')

// 动效时长/曲线取自 Animate UI 的 token,首帧前写到根元素
applyMotionCssVars()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {/* 开发预览(R5):?preview=compute&id=<computeId> 只渲染 Compute 卡与 harness 会话窗口,给 e2e 与截图用 */}
    {query.get('preview') === 'compute' ? <ComputePreview id={query.get('id') ?? 'login'} /> : <App />}
  </StrictMode>,
)
