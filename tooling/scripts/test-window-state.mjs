import { execFileSync } from 'node:child_process'

/**
 * Where a test window opens: on a Mac with a built-in display (a MacBook with an
 * external monitor), on that display, so test windows stay off the desk's main
 * screen; anywhere else (CI, Linux, Windows), at the old fixed spot. Cocoa frames
 * are bottom-left based, so the top edge is the primary screen's height minus
 * the screen's top.
 */
export function testWindowState(width, height) {
  if (process.platform === 'darwin') {
    try {
      const script = 'ObjC.import("AppKit"); const s = $.NSScreen.screens; const p = s.objectAtIndex(0).frame; let r = null; for (let i = 0; i < s.count; i++) { const sc = s.objectAtIndex(i); if (/Built-in/.test(ObjC.unwrap(sc.localizedName))) { const f = sc.frame; r = { x: f.origin.x, y: p.size.height - (f.origin.y + f.size.height), w: f.size.width, h: f.size.height } } } JSON.stringify(r)'
      const display = JSON.parse(execFileSync('osascript', ['-l', 'JavaScript', '-e', script], { encoding: 'utf8' }).trim())
      if (display) {
        return {
          x: Math.round(display.x + 40),
          y: Math.round(display.y + 40),
          width: Math.min(width, display.w - 80),
          height: Math.min(height, display.h - 80),
          isMaximized: false
        }
      }
    } catch {}
  }
  return { x: 60, y: 60, width, height, isMaximized: false }
}
