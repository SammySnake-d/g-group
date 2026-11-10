import { expect, test } from '@playwright/test';
import { shot } from './shots';

for (const theme of ['light', 'dark'] as const) {
  test(`来处 ${theme}：页头一行,不占正文宽度；动作从消息结构读出；任一站可跳、可回`, async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.goto(`/?section=files&file=a1${theme === 'dark' ? '&theme=dark' : ''}`);
    await expect(page.getByTestId('rail').getByTestId('brand-mark')).toHaveCount(0);
    // 不再有侧栏;正文卡片居中、整宽可用
    await expect(page.getByTestId('file-related')).toHaveCount(0);
    const header = await page.getByTestId('file-source').boundingBox();
    expect(header!.height, '来处只占一行').toBeLessThanOrEqual(36);
    const main = await page.getByTestId('files-main').boundingBox();
    const preview = await page.getByTestId('file-preview').boundingBox();
    expect(Math.abs((preview!.x + preview!.width / 2) - (main!.x + main!.width / 2)), '正文居中,右边没有被侧栏挤').toBeLessThan(4);
    // 三站:Astra 连发两条(说明 + 文件)并成一站「交付」→ 你「派活」→ Argon「已做」(g3 的交代 ref 指向 g3b)
    const hops = page.locator('[data-testid^="file-hop-"]').filter({ visible: true });
    await expect(hops).toHaveCount(3);
    await expect(page.getByTestId('file-hop-g2').filter({ visible: true })).toHaveAttribute('data-source', 'true');
    await expect(page.getByTestId('file-hop-g2').filter({ visible: true })).toHaveAccessibleName('Astra 交付，回到原消息');
    await expect(page.getByTestId('file-hop-g3').filter({ visible: true })).toHaveAccessibleName('39impacts 派活，回到原消息');
    await expect(page.getByTestId('file-hop-g3b').filter({ visible: true })).toHaveAccessibleName('Argon 已做，回到原消息');
    // 悬停看原话,一站里两条都在
    await page.getByTestId('file-hop-g2').filter({ visible: true }).hover();
    const words = page.getByRole('group').filter({ hasText: '重点看第 3 节' });
    await expect(words).toBeVisible();
    await expect(words).toContainText('IM 竞品交互对照');
    await shot(page, `provenance/${theme}/hover`, 300);
    // 点「已做」跳到 Argon 那条
    await page.getByTestId('file-hop-g3b').filter({ visible: true }).click();
    await expect(page.getByTestId('chat-column')).toBeVisible();
    await expect(page.locator('#m-g3b')).toBeInViewport();
    await shot(page, `provenance/${theme}/jumped`, 300);
    // 回程:一下回到同一份文件
    await page.getByTestId('file-return').click();
    await expect(page.getByTestId('files-main')).toHaveAttribute('data-file', 'a1');
    await expect(page.getByTestId('file-return')).toHaveCount(0);
  });
}

test('来处：对话名打开对话；资产从「存下」那条来；没有来处时只留对话名', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/?section=files&file=a4');
  await expect(page.locator('[data-testid^="file-hop-"][data-source="true"]').filter({ visible: true })).toHaveAccessibleName(/存下，回到原消息$/);
  await page.goto('/?section=files&file=a3');
  await expect(page.locator('[data-testid^="file-hop-"]').filter({ visible: true })).toHaveCount(0);
  await page.getByTestId('file-open-conv').click();
  await expect(page.getByTestId('chat-column')).toBeVisible();
  await expect(page.getByTestId('file-return')).toBeVisible();
  // 换到别的对话,回程作废
  await page.getByTestId('nav-files').click();
  await page.getByTestId('nav-chat').click();
  await expect(page.getByTestId('file-return')).toHaveCount(0);
});

test('来处：窄窗放不下时收进「+N」,收起的那几站仍能跳;页面不横向溢出', async ({ page }) => {
  await page.setViewportSize({ width: 900, height: 700 });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/?section=files&file=a1');
  // 把列表栏拉到最宽,逼来处那一行变窄
  const divider = page.getByTestId('div-list');
  const box = await divider.boundingBox();
  await page.mouse.move(box!.x + box!.width / 2, box!.y + 200);
  await page.mouse.down();
  await page.mouse.move(box!.x + 400, box!.y + 200, { steps: 6 });
  await page.mouse.up();
  const more = page.getByTestId('file-hops-more').filter({ visible: true });
  await expect(more).toBeVisible();
  const shown = await page.locator('[data-testid^="file-hop-"]').filter({ visible: true }).count();
  expect(shown).toBeGreaterThanOrEqual(1);
  expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(0);
  await shot(page, 'provenance/narrow/collapsed', 300);
  await more.click();
  const menu = page.getByRole('dialog', { name: '其余来处' });
  await expect(menu).toBeVisible();
  await shot(page, 'provenance/narrow/more', 300);
  await menu.getByRole('button', { name: /回到原消息$/ }).last().click();
  await expect(page.getByTestId('chat-column')).toBeVisible();
});
