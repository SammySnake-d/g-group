import { expect, test } from '@playwright/test';
import { shot } from './shots';
for (const theme of ['light', 'dark'] as const) {
  test(`文件原版对照 ${theme}`, async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.goto(theme === 'dark' ? '/?theme=dark' : '/');
    await page.getByTestId('nav-files').click();
    await shot(page, `files-comparison/${theme}/catalog`, 300);
    await page.getByTestId('file-a1').click();
    await expect(page.getByTestId('files-main')).toHaveAttribute('data-file', 'a1');
    await shot(page, `files-comparison/${theme}/reader`, 300);
  });
}
