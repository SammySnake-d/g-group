import { test } from '@playwright/test';
import { shot } from './shots';

// 文件页前后对照截图:只导航、只拍,不依赖具体结构,改前改后用同一份跑。
const sizes = [
  { tag: 'wide', width: 1440, height: 900 },
  { tag: 'narrow', width: 1024, height: 768 },
] as const;

for (const theme of ['light', 'dark'] as const) {
  for (const s of sizes) {
    test(`文件页外观 ${theme} ${s.tag}`, async ({ page }) => {
      await page.setViewportSize({ width: s.width, height: s.height });
      await page.emulateMedia({ reducedMotion: 'reduce' });
      const t = theme === 'dark' ? '&theme=dark' : '';
      await page.goto(`/?section=files${t}`);
      await shot(page, `look/${theme}-${s.tag}-shelf`, 400);
      await page.goto(`/?section=files&file=a1${t}`);
      await shot(page, `look/${theme}-${s.tag}-reader-a1`, 400);
      await page.goto(`/?section=files&file=a3${t}`);
      await shot(page, `look/${theme}-${s.tag}-reader-a3`, 400);
    });
  }
}
