/**
 * Post-install script to patch meridian to support MERIDIAN_CLAUDE_BIN
 * Run manually after npm install
 */

import { readFileSync, writeFileSync, existsSync } from "fs"
import { dirname, join } from "path"
import { fileURLToPath } from "url"

const __dirname = dirname(fileURLToPath(import.meta.url))

function patchMeridian() {
  try {
    const meridianPath = join(__dirname, "../node_modules/@rynfar/meridian/dist/cli.js")
    if (!existsSync(meridianPath)) {
      console.log("Meridian cli.js not found, skipping...")
      return false
    }
    
    let content = readFileSync(meridianPath, "utf8")
    
    // Add defaultClaudeCliBin and claudeCliBin
    const insertPoint = 'var exec = promisify(execCallback);'
    const patchCode = `
var defaultClaudeCliBin = process.env.HOME && existsSync(process.env.HOME + "/.local/bin/suclaude") ? process.env.HOME + "/.local/bin/suclaude" : "claude";
var claudeCliBin = process.env.MERIDIAN_CLAUDE_BIN ?? process.env.CLAUDE_PROXY_CLAUDE_BIN ?? process.env.CLAUDE_BIN ?? defaultClaudeCliBin;`
    
    if (!content.includes("var defaultClaudeCliBin")) {
      content = content.replace(insertPoint, insertPoint + patchCode)
      
      // Replace "claude auth status" with variable
      content = content.replace(/await runExec\("claude auth status"/g, "await runExec(`${claudeCliBin} auth status`")
      
      writeFileSync(meridianPath, content, "utf8")
      console.log("Meridian cli.js patched successfully")
    }
    
    // Now patch the bundled CLI
    const distDir = join(__dirname, "../node_modules/@rynfar/meridian/dist")
    const cliBundledPath = join(distDir, "cli-6hehvt9f.js")
    
    if (existsSync(cliBundledPath)) {
      let bundledContent = readFileSync(cliBundledPath, "utf8")
      
      // Add claudeCliBin variable
      const insertPoint2 = "var cachedClaudePath = null;"
      const patchCode2 = `var cachedClaudePath = null;
var defaultClaudeCliBin = process.env.HOME && existsSync2(process.env.HOME + "/.local/bin/suclaude") ? process.env.HOME + "/.local/bin/suclaude" : "claude";
var claudeCliBin = process.env.MERIDIAN_CLAUDE_BIN ?? process.env.CLAUDE_PROXY_CLAUDE_BIN ?? process.env.CLAUDE_BIN ?? defaultClaudeCliBin;`
      
      if (!bundledContent.includes("var defaultClaudeCliBin")) {
        bundledContent = bundledContent.replace(insertPoint2, patchCode2)
        
        // Update resolveClaudeExecutableAsync to check custom bin first
        const oldResolveStart = "const runningUnderBun = typeof process.versions.bun !== \"undefined\";"
        const newResolveStart = `if (claudeCliBin && claudeCliBin !== "claude") {
      try {
        if (claudeCliBin.includes("/") && existsSync2(claudeCliBin)) {
          cachedClaudePath = claudeCliBin;
          return claudeCliBin;
        }
        const { stdout } = await exec(\`type -p \${claudeCliBin}\`);
        const claudePath = stdout.trim();
        if (claudePath && existsSync2(claudePath)) {
          cachedClaudePath = claudePath;
          return claudePath;
        }
      } catch {}
    }
    const runningUnderBun = typeof process.versions.bun !== "undefined";`
        
        bundledContent = bundledContent.replace(oldResolveStart, newResolveStart)
        
        writeFileSync(cliBundledPath, bundledContent, "utf8")
        console.log("Meridian bundled CLI patched successfully")
      }
    }
    
    return true
  } catch (err) {
    console.error("Failed to patch meridian:", err.message)
    return false
  }
}

// Run patch
console.log("Applying MERIDIAN_CLAUDE_BIN patch...")
const result = patchMeridian()

if (result) {
  console.log("Patch applied!")
} else {
  console.log("Patch not needed or failed")
}