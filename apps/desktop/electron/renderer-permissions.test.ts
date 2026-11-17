import assert from 'node:assert/strict'
import { test } from 'node:test'
import { rendererPermissionAllowed } from './renderer-permissions.ts'

const frame = { isMainFrame: true, requestingUrl: 'app://renderer/index.html', topLevelUrl: 'app://renderer/index.html', focused: true }
test('原版复制只允许聚焦的本应用主页面写剪贴板', () => {
  assert.equal(rendererPermissionAllowed('clipboard-sanitized-write', frame), true)
  assert.equal(rendererPermissionAllowed('clipboard-sanitized-write', { ...frame, requestingUrl: 'http://localhost:5219', topLevelUrl: 'http://localhost:5219' }, 'http://localhost:5219'), true)
})
test('读剪贴板、系统权限、子框架、外部页面与后台窗口保持拒绝', () => {
  for (const permission of ['clipboard-read', 'deprecated-sync-clipboard-read', 'media', 'notifications', 'geolocation', 'unknown']) {
    assert.equal(rendererPermissionAllowed(permission, frame), false, permission)
  }
  for (const denied of [
    { ...frame, isMainFrame: false }, { ...frame, focused: false },
    { ...frame, requestingUrl: 'https://example.invalid/' }, { ...frame, topLevelUrl: 'https://example.invalid/' },
    { ...frame, requestingUrl: 'app://renderer.evil/' }, { ...frame, requestingUrl: '' },
  ]) assert.equal(rendererPermissionAllowed('clipboard-sanitized-write', denied), false)
})
