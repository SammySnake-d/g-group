import { expect, test } from '@playwright/test';
import { shot } from './shots';

for (const theme of ['light', 'dark'] as const) {
  test(`协作语境 ${theme}：去掉顶部品牌块，保留选中态；消息链默认展示、交付消息高亮、任意条可跳`, async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.goto(`/?section=files&file=a1${theme === 'dark' ? '&theme=dark' : ''}`);
    const rail = page.getByTestId('rail');
    await expect(rail.getByTestId('brand-mark')).toHaveCount(0);
    await expect(page.getByTestId('nav-files')).toHaveAttribute('data-on', '1');
    const first = await page.getByTestId('nav-chat').boundingBox();
    expect(first?.y, 'Logo 撤掉后不保留它的空位；仍留出桌面窗口顶部空间').toBeLessThan(60);
    const chain = page.getByTestId('file-related');
    await expect(chain).toBeVisible();
    await expect(chain.locator('[data-testid^="file-related-"]')).toHaveCount(4);
    await expect(page.getByTestId('file-related-g2')).toHaveAttribute('data-current', 'true');
    await expect(page.getByTestId('file-related-g1')).not.toHaveAttribute('data-current', 'true');
    await shot(page, `refine/${theme}/reader`, 300);
    await page.getByTestId('file-related-g1').locator('p').click();
    await expect(page.getByTestId('chat-column')).toBeVisible();
    await expect(page.locator('#m-g1')).toBeInViewport();
    await shot(page, `refine/${theme}/source-message`, 300);
  });
}

test('消息链：窄窗自动收起，宽窗自动恢复；手动选择跨尺寸、文件与导航保留', async ({ page }) => {
  await page.setViewportSize({ width: 1024, height: 768 });
  await page.goto('/?section=files&file=a1');
  const chain = page.getByTestId('file-related');
  const toggle = page.getByTestId('file-context-toggle');
  await expect(chain).toBeHidden();
  await page.setViewportSize({ width: 1440, height: 900 });
  await expect(chain).toBeVisible();
  await page.getByRole('button', { name: '收起对话' }).click();
  await page.getByTestId('file-a5').click();
  await expect(chain).toBeHidden();
  await page.getByTestId('nav-chat').click();
  await page.getByTestId('nav-files').click();
  await expect(chain).toBeHidden();
  await page.setViewportSize({ width: 1024, height: 768 });
  await toggle.click();
  await expect(chain).toBeVisible();
  await page.getByTestId('file-a1').click();
  await expect(chain).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(0);
  await shot(page, 'refine/narrow/manual-open', 300);
  await page.setViewportSize({ width: 1440, height: 900 });
  await expect(chain).toBeVisible();
});
