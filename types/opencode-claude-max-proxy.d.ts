// TEMPORARY: Hand-written declarations until opencode-claude-max-proxy ships
// its own .d.ts files. Remove this once the upstream package includes types.

declare module "opencode-claude-max-proxy" {
  export interface ProxyConfig {
    port?: number
    host?: string
    debug?: boolean
    idleTimeoutSeconds?: number
    silent?: boolean
  }

  export interface ProxyInstance {
    server: import("node:http").Server
    config: Required<ProxyConfig>
    close(): Promise<void>
  }

  export function startProxyServer(config?: ProxyConfig): Promise<ProxyInstance>
  export function createProxyServer(config?: ProxyConfig): {
    app: unknown
    config: Required<ProxyConfig>
  }
  export function startSessionCleanup(): ReturnType<typeof setInterval>
  export function clearSessionCache(): void
  export function computeLineageHash(messages: unknown[]): string
  export function getMaxSessionsLimit(): number
}
