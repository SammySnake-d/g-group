import { expect, test, type Page } from '@playwright/test';
import { shot } from './shots';

const hop = (page: Page, id: string) => page.getByTestId(`file-hop-${id}`).filter({ visible: true });
const toBottom = (page: Page) => page.getByTestId('file-scroll').evaluate((el) => { el.scrollTop = el.scrollHeight; });

for (const theme of ['light', 'dark'] as const) {
  test(`来处 ${theme}：在正文右侧、不动手就看得到人、动作和原话；长文档翻到底仍在旁边；任一站可跳、可回`, async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.goto(`/?section=files&file=a1&prov-fixture=long${theme === 'dark' ? '&theme=dark' : ''}`);
    await expect(page.getByTestId('rail').getByTestId('brand-mark')).toHaveCount(0);
    const aside = page.getByTestId('file-aside');
    const paper = await page.getByTestId('file-preview').boundingBox();
    expect((await aside.boundingBox())!.x, '来处在正文右边').toBeGreaterThan(paper!.x + paper!.width);
    // 三站:Astra 连发两条(说明 + 文件)并成一站「交付」→ 你「派活」→ Argon「已做」(g3 的交代 ref 指向 g3b)
    await expect(page.locator('[data-testid^="file-hop-"]').filter({ visible: true })).toHaveCount(3);
    await expect(hop(page, 'g2')).toHaveAttribute('data-source', 'true');
    await expect(hop(page, 'g2')).toHaveAccessibleName(/^Astra 交付：IM 竞品的交互对照整理好了.*回到原消息$/);
    await expect(hop(page, 'g3')).toHaveAccessibleName(/^39impacts 派活：第 3 节这个观点不错/);
    await expect(hop(page, 'g3b')).toHaveAccessibleName(/^Argon 已做：我来记/);
    // 原话不用悬停就在:交付附言里的读法提示直接可见
    await expect(aside.getByText(/重点看第 3 节/)).toBeVisible();
    await expect(aside.getByText(/写进了群协作手册/)).toBeVisible();
    await shot(page, `provenance/${theme}/top`, 300);
    // 往下翻到底:来处还在视口里,没被正文卷走
    await toBottom(page);
    expect(await page.getByTestId('file-scroll').evaluate((el) => el.scrollTop), '文档确实翻下去了').toBeGreaterThan(600);
    await expect(hop(page, 'g2')).toBeInViewport();
    await expect(hop(page, 'g3b')).toBeInViewport();
    await shot(page, `provenance/${theme}/scrolled`, 300);
    // 点「已做」跳到 Argon 那条
    await hop(page, 'g3b').click();
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
  await expect(page.locator('[data-testid^="file-hop-"][data-source="true"]').filter({ visible: true })).toHaveAccessibleName(/^Helper 存下：/);
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

test('来处：站多时先列 5 站、其余点开；右栏放不下时自己滚动，正文不动', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 640 });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/?section=files&file=a1&prov-fixture=busy-long');
  const shown = page.locator('[data-testid^="file-hop-"]').filter({ visible: true });
  await expect(shown).toHaveCount(5);
  await page.getByTestId('file-hops-more').click();
  await expect(shown).toHaveCount(8);
  const aside = page.getByTestId('file-aside');
  expect(await aside.evaluate((el) => el.scrollHeight > el.clientHeight), '8 站在 640 高的窗口里放不下,右栏自己滚').toBe(true);
  await aside.evaluate((el) => { el.scrollTop = el.scrollHeight; });
  await expect(hop(page, 'pv5')).toBeInViewport();
  expect(await page.getByTestId('file-scroll').evaluate((el) => el.scrollTop), '滚右栏不带动正文').toBe(0);
  await shot(page, 'provenance/busy/aside-scrolled', 300);
});

test('来处：1024 窗口仍在右侧、带原话；列表栏拉到最宽时收成一列头像，悬停看原话、点了能跳；不横向溢出', async ({ page }) => {
  await page.setViewportSize({ width: 1024, height: 768 });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/?section=files&file=a1&prov-fixture=long');
  const aside = page.getByTestId('file-aside');
  await expect(page.getByTestId('file-source')).toHaveAttribute('data-place', 'margin');
  await expect(aside.getByText(/重点看第 3 节/)).toBeVisible();
  const paper = await page.getByTestId('file-preview').boundingBox();
  expect(paper!.width, '正文仍够读').toBeGreaterThan(360);
  await toBottom(page);
  await expect(hop(page, 'g3b')).toBeInViewport();
  expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(0);
  await shot(page, 'provenance/narrow/scrolled', 300);
  // 把列表栏拉到最宽,阅读区只剩 500 多,来处收成头像列
  const divider = page.getByTestId('div-list');
  const box = await divider.boundingBox();
  await page.mouse.move(box!.x + box!.width / 2, box!.y + 200);
  await page.mouse.down();
  await page.mouse.move(box!.x + 400, box!.y + 200, { steps: 6 });
  await page.mouse.up();
  await expect(page.getByTestId('file-source')).toHaveAttribute('data-place', 'rail');
  expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(0);
  await hop(page, 'g2').hover();
  await expect(page.getByText(/重点看第 3 节/).filter({ visible: true })).toBeVisible();
  await shot(page, 'provenance/narrow/rail-hover', 300);
  await hop(page, 'g3b').click();
  await expect(page.locator('#m-g3b')).toBeInViewport();
});
