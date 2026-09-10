/** Convert the pinned Wry runtime's drag coordinates to DOM client coordinates. */
export function nativeDragClientPosition(
  position: { x: number; y: number },
  isMac: boolean,
  devicePixelRatio: number,
  nativeScaleFactor: number,
): { x: number; y: number } {
  // Wry 0.55.1 WKWebView forwards NSDraggingInfo points without scaling them,
  // although Tauri's JS wrapper calls the value PhysicalPosition.
  // On macOS only webview zoom needs conversion; elsewhere use physical pixels.
  const ratio = devicePixelRatio > 0 ? devicePixelRatio : 1;
  const scale = nativeScaleFactor > 0 ? nativeScaleFactor : 1;
  const divisor = isMac ? ratio / scale : ratio;
  return { x: position.x / divisor, y: position.y / divisor };
}
