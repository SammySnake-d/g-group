import { isTrustedOrigin } from '../../../packages/ui-core/src/ipc.ts'

/** The upstream Copy button needs sanitized writes, never clipboard reads.
 * Other system permissions remain denied, including in child frames. */
export function rendererPermissionAllowed(permission: string, frame: {
  isMainFrame: boolean
  requestingUrl: string
  topLevelUrl: string
  focused: boolean
}, devOrigin?: string): boolean {
  return permission === 'clipboard-sanitized-write' && frame.isMainFrame && frame.focused
    && isTrustedOrigin(frame.topLevelUrl, devOrigin) && isTrustedOrigin(frame.requestingUrl, devOrigin)
}
