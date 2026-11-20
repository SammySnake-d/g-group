import fs from "node:fs";
import path from "node:path";
import type { Page } from "@playwright/test";

const DIR = process.env.GG_SHOTS;

export async function shot(page: Page, name: string, settleMs = 150) {
  if (!DIR) return;
  const file = path.join(DIR, `${name}.png`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  await page.waitForTimeout(settleMs);
  await page.screenshot({ path: file });
}
