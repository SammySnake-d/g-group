import fs from "node:fs";
import path from "node:path";
import type { Page } from "@playwright/test";

// 走查截图:只在设了 GG_SHOTS(输出目录)时才存,测试本身不写死交付路径。
// `npm run shots` 把它指到交付目录;埋雷(界面故意改坏)时不设,免得坏图覆盖交付截图。
const DIR = process.env.GG_SHOTS;

/** settleMs:等动画走完再拍(页签淡入等) */
export async function shot(page: Page, name: string, settleMs = 150) {
  if (!DIR) return;
  const file = path.join(DIR, `${name}.png`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  await page.waitForTimeout(settleMs);
  await page.screenshot({ path: file });
}
