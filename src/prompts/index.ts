import plan from "./anthropic/plan.txt"
import build from "./anthropic/build.txt"

const prompts: Record<string, string> = { plan, build }

export const loadPrompt = (name: string): string => prompts[name] ?? prompts.build ?? ""
