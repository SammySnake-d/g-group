import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import { AstryxRoot } from './astryx/AstryxRoot'
import { AstryxProbe } from './astryx/Probe'
import { AnimateUIProvider } from '@animate-ui/react/provider'
import { applyMotionCssVars, TEMPO } from './config/motion'

// 首帧前就定好主题,避免先亮后暗闪一下
if (new URLSearchParams(location.search).get('theme') === 'dark') document.documentElement.classList.add('dark')

// 动效时长/曲线取自 Animate UI 的 token,首帧前写到根元素
applyMotionCssVars()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <AnimateUIProvider tempo={TEMPO}><AstryxRoot>{new URLSearchParams(location.search).get('preview') === 'astryx' ? <AstryxProbe /> : <App />}</AstryxRoot></AnimateUIProvider>
  </StrictMode>,
)
