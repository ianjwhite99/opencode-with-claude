/**
 * Request identity headers for Meridian.
 *
 * Meridian keys its per-session turn lease on `x-opencode-session` (falling
 * back to `x-session-affinity`), picks the model tier from
 * `x-opencode-agent-mode` (primary → 1M context, subagent → 200k), and treats
 * subagent-mode requests as independent flows that may run concurrently with
 * the session's primary turn.
 *
 * OpenCode runs a few hidden one-shot requests (title, summary) on the *same*
 * session id as the user's prompt, concurrently with it. If they carry the
 * session header they contend for the lease and whichever request waited is
 * rejected with "This session advanced while the request was waiting" — about
 * half the time that is the user's first message. Those requests are detached
 * here: no session header, subagent mode, and an `x-meridian-source` marker so
 * the proxy can still tell where they came from. This mirrors what Meridian's
 * own OpenCode plugins do.
 *
 * Leaf module: no imports from index.ts or proxy.ts.
 */

export type AgentMode = "primary" | "subagent"

export interface RequestIdentity {
  sessionID: string
  /** ASCII-only agent name, "unknown" when OpenCode did not pass one. */
  agentName: string
  agentMode: AgentMode
  /** True for hidden one-shots that must not share the session's lease. */
  detached: boolean
  /** Optional `x-meridian-source` value for attached requests (compaction). */
  source?: string
}

/** Hidden one-shot agents OpenCode runs concurrently with the primary turn. */
export const DETACHED_AGENTS: ReadonlySet<string> = new Set(["title", "summary"])

/** Compaction runs in the session's lineage but on the subagent model tier. */
export const COMPACTION_AGENT = "compaction"

/**
 * Modes of OpenCode's built-in agents. Built-ins are not listed in the merged
 * config unless the user overrides them, so a config-derived map alone cannot
 * see them.
 */
const BUILTIN_AGENT_MODES: Record<string, AgentMode> = {
  build: "primary",
  plan: "primary",
  general: "subagent",
  explore: "subagent",
  title: "primary",
  summary: "primary",
  compaction: "primary",
}

/** Every header spelling that can bind a request to a session. */
const SESSION_HEADERS = [
  "x-opencode-session",
  "x-session-affinity",
  "x-session-id",
  "x-parent-session-id",
] as const

const CONTROL_HEADERS = [
  "x-meridian-source",
  "x-opencode-agent-mode",
  "x-opencode-agent-name",
] as const

/** Strip non-ASCII (e.g. zero-width spaces) that make undici reject the header. */
export function safeAgentName(raw: unknown): string {
  return String(raw ?? "unknown").replace(/[^\x20-\x7E]/g, "").trim() || "unknown"
}

/** Meridian only understands primary|subagent; "all" agents act as primary. */
export function normalizeAgentMode(mode: unknown): AgentMode {
  return mode === "subagent" ? "subagent" : "primary"
}

/**
 * Resolve an agent's mode from, in order: an explicit runtime mode, the modes
 * captured from OpenCode's config, and the built-in table.
 */
export function resolveAgentMode(
  agentName: string,
  explicit: unknown,
  configured: ReadonlyMap<string, string>,
): AgentMode {
  if (typeof explicit === "string") return normalizeAgentMode(explicit)
  const key = agentName.toLowerCase()
  const fromConfig = configured.get(key)
  if (fromConfig !== undefined) return normalizeAgentMode(fromConfig)
  return BUILTIN_AGENT_MODES[key] ?? "primary"
}

export function deleteHeader(headers: Record<string, string>, name: string): void {
  const wanted = name.toLowerCase()
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === wanted) delete headers[key]
  }
}

/**
 * Rewrite the Meridian identity headers on an outgoing Anthropic request.
 *
 * Anything already present — from provider config, another plugin, or an
 * earlier hook — is removed first, case-insensitively, so a stale session or
 * mode header can never rebind the request. `anthropic-beta` is dropped
 * because Meridian speaks to the Agent SDK, not the raw Messages API.
 */
export function applyMeridianHeaders(
  headers: Record<string, string>,
  identity: RequestIdentity,
): void {
  deleteHeader(headers, "anthropic-beta")
  for (const name of SESSION_HEADERS) deleteHeader(headers, name)
  for (const name of CONTROL_HEADERS) deleteHeader(headers, name)

  if (identity.detached) {
    headers["x-meridian-source"] = `subagent-${identity.agentName}`
  } else {
    headers["x-opencode-session"] = identity.sessionID
    if (identity.source) headers["x-meridian-source"] = identity.source
  }
  headers["x-opencode-agent-mode"] = identity.detached
    ? "subagent"
    : identity.agentMode
  headers["x-opencode-agent-name"] = identity.agentName
}
