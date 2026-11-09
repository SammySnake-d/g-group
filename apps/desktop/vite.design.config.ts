import { readFileSync } from 'node:fs'
import { mergeConfig } from 'vite'
import { viteSingleFile } from 'vite-plugin-singlefile'
import base from './vite.config'

// 独立离线评审产物：内联资源。只在该导出中删除禁止内联脚本的生产 meta，生产配置不动。
export default mergeConfig(base, {
  plugins: [viteSingleFile(), {
    name: 'offline-design-artifact',
    transformIndexHtml: {
      order: 'pre',
      handler(html: string) {
        const favicon = readFileSync(new URL('./public/favicon.svg', import.meta.url)).toString('base64')
        return html.replace(/<meta http-equiv="Content-Security-Policy"[^>]*\/>/, '')
          .replace('./favicon.svg', `data:image/svg+xml;base64,${favicon}`)
      },
    },
  }],
  build: { outDir: 'design-dist', emptyOutDir: true },
})
