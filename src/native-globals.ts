/**
 * Workaround for @hono/node-server overriding global Response/Request.
 *
 * Hono's Node adapter replaces globalThis.Response and globalThis.Request
 * with _Response/_Request wrappers via Object.defineProperty. Under Bun,
 * this breaks Bun.serve() which requires native Response objects.
 *
 * Each override layer inherits from the previous via Object.setPrototypeOf,
 * so we walk the prototype chain to find the actual native constructors
 * (where Object.getPrototypeOf(fn) === Function.prototype).
 *
 * TEMPORARY: Remove this file once the upstream fix is released:
 * https://github.com/rynfar/opencode-claude-max-proxy/pull/141
 */

function getNative(current: Function): Function {
  let fn = current
  while (Object.getPrototypeOf(fn) !== Function.prototype) {
    fn = Object.getPrototypeOf(fn)
  }
  return fn
}

const NativeResponse = getNative(globalThis.Response)
const NativeRequest = getNative(globalThis.Request)

export function restoreNativeGlobals() {
  Object.defineProperty(globalThis, "Response", {
    value: NativeResponse,
    writable: true,
    configurable: true,
  })
  Object.defineProperty(globalThis, "Request", {
    value: NativeRequest,
    writable: true,
    configurable: true,
  })
}
