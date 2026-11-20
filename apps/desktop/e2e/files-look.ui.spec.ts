import { test } from '@playwright/test';
import { shot } from './shots';

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
