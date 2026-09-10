/** Prevent the private Next HMR client's retry limit from reloading shared pages. */
export function installShareDevClient() {
  if (!/^\/share\/[a-f0-9-]{36}$/.test(location.pathname)) return;
  const NativeWebSocket = window.WebSocket;
  class InactiveHmrSocket extends EventTarget {
    constructor(readonly url: string) { super(); }
    CONNECTING = 0; OPEN = 1; CLOSING = 2; CLOSED = 3;
    readyState = 3; bufferedAmount = 0; extensions = ""; protocol = "";
    binaryType = "blob"; onopen = null; onmessage = null; onerror = null; onclose = null;
    send() {} close() {}
  }
  window.WebSocket = new Proxy(NativeWebSocket, {
    construct(target, args) {
      const url = new URL(String(args[0]), location.href);
      if (url.host === location.host && url.pathname === "/_next/webpack-hmr") {
        return new InactiveHmrSocket(String(args[0]));
      }
      return Reflect.construct(target, args);
    },
  });
}
