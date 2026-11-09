import { expect, test } from '@playwright/test';
import { shot } from './shots';
import { BASELINE_CONSOLE } from './console-baseline';

for (const theme of ['light', 'dark'] as const) {
  test(`文件设计 ${theme}：找文件、空格预览、回到同一对象、带引用继续聊`, async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.goto(theme === 'dark' ? '/?theme=dark' : '/');
    await page.getByTestId('nav-files').click();
    await expect(page.locator('[data-testid^="shelf-a"]')).toHaveCount(5);
    await shot(page, `files-design/${theme}/catalog`, 300);
    await page.getByRole('button', { name: '文档', exact: true }).click();
    await expect(page.locator('[data-testid^="shelf-a"]')).toHaveCount(2);
    const search = page.getByRole('searchbox', { name: '搜索文件' });
    await search.fill('不存在的文件');
    await expect(page.getByText('没有找到文件', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: '清除筛选' }).click();
    await expect(page.locator('[data-testid^="shelf-a"]')).toHaveCount(5);
    await search.fill('IM');
    const card = page.getByRole('button', { name: '打开IM 竞品交互对照', exact: true });
    await card.focus();
    await page.keyboard.press('Space');
    const peek = page.getByRole('dialog', { name: 'IM 竞品交互对照' });
    await expect(peek).toBeVisible();
    expect(await peek.evaluate((el) => getComputedStyle(el).animationName)).toBe('none');
    await shot(page, `files-design/${theme}/quick-look`, 300);
    await page.keyboard.press('Escape');
    await expect(peek).toBeHidden();
    await expect(card).toBeFocused();
    await expect(search).toHaveValue('IM');
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('files-main')).toHaveAttribute('data-file', 'a1');
    await shot(page, `files-design/${theme}/reader`, 300);
    await page.getByTestId('file-context-toggle').click();
    await expect(page.getByTestId('file-related-g2')).toBeVisible();
    await shot(page, `files-design/${theme}/context`, 300);
    await page.getByRole('button', { name: '收起对话' }).click();
    await page.getByTestId('file-discuss').click();
    await expect(page.getByTestId('chat-column')).toBeVisible();
    await expect(page.getByTestId('quote-text')).toContainText('IM 竞品交互对照');
    const composer = page.getByTestId('composer');
    await expect(composer).toHaveValue(/@Astra/);
    await expect(composer).toBeFocused();
    await shot(page, `files-design/${theme}/continue-chat`, 300);
    expect(errors).toEqual(BASELINE_CONSOLE);
  });

  test(`文件设计 ${theme}：没有原消息时不伪造引用、不发送，目录筛选可恢复`, async ({ page }) => {
    await page.goto(`/?section=files${theme === 'dark' ? '&theme=dark' : ''}`);
    await page.getByRole('searchbox', { name: '搜索文件' }).fill('VPS');
    await page.getByTestId('shelf-a4').getByRole('heading').click();
    await page.getByRole('button', { name: '全部文件', exact: true }).click();
    await expect(page.getByRole('searchbox', { name: '搜索文件' })).toHaveValue('VPS');
    await expect(page.locator('[data-testid^="shelf-a"]')).toHaveCount(1);
    await page.getByTestId('shelf-a4').getByRole('heading').click();
    await page.getByTestId('file-discuss').click();
    const composer = page.getByTestId('composer');
    await expect(composer).toHaveValue(/@Helper.*VPS · 香港 1 号机/);
    await expect(page.getByTestId('quote-text')).toHaveCount(0);
    // 动作只预填；没有自动生成一条用户消息。
    await expect(page.locator('[data-from="me"]').filter({ hasText: '关于「VPS · 香港 1 号机」' })).toHaveCount(0);
  });
}

test('文件设计：1024 窗口仍能完整浏览和阅读，无横向溢出', async ({ page }) => {
  await page.setViewportSize({ width: 1024, height: 768 });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/?section=files');
  await expect(page.locator('[data-testid^="shelf-a"]')).toHaveCount(5);
  expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(0);
  await shot(page, 'files-design/narrow/catalog', 300);
  await page.getByTestId('shelf-a1').getByRole('heading').click();
  await expect(page.getByTestId('file-preview')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(0);
  await shot(page, 'files-design/narrow/reader', 300);
});
