import { expect, test } from '@playwright/test'

test('附件先进入待发区,删除或发送都由用户明确触发', async ({ page }) => {
  await page.goto('/')
  await page.getByTestId('conv-g').click()
  await expect(page.getByTestId('composer')).toBeVisible()

  await page.getByTestId('file-input').setInputFiles({ name: '待发.png', mimeType: 'image/png', buffer: Buffer.from([137, 80, 78, 71]) })
  await expect(page.getByTestId('pending-attachments')).toBeVisible()
  await expect(page.getByText('待发送 · 0 KB · 你发的')).toBeVisible()
  await expect(page.getByTestId('attachment-待发.png')).toHaveCount(0)

  const pending = page.locator('[data-testid^="pending-attachment-"]').first()
  await pending.getByRole('button', { name: '移除待发.png' }).click()
  await expect(page.getByTestId('pending-attachments')).toHaveCount(0)

  await page.getByTestId('file-input').setInputFiles({ name: '待发.png', mimeType: 'image/png', buffer: Buffer.from([137, 80, 78, 71]) })
  await page.getByTestId('send').click()
  await expect(page.getByTestId('pending-attachments')).toHaveCount(0)
})
