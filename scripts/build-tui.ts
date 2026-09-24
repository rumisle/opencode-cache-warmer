// Compile tui.tsx to tui.js with OpenTUI's Solid settings (universal renderer, @opentui/solid).
// Installed plugins live under node_modules, where OpenTUI's runtime Solid transform does not run,
// so the published TUI entry must be precompiled. Runtime imports (solid-js, @opentui/solid,
// @opencode/plugin/tui) stay bare; OpenTUI rewrites them to the host's own modules at load time.
import { transformAsync } from "@babel/core"
import ts from "@babel/preset-typescript"
import solid from "babel-preset-solid"

const source = await Bun.file("tui.tsx").text()
const result = await transformAsync(source, {
  filename: "tui.tsx",
  configFile: false,
  babelrc: false,
  presets: [[solid, { moduleName: "@opentui/solid", generate: "universal" }], [ts]],
})
if (!result?.code) throw new Error("transform produced no code")
await Bun.write("tui.js", `// Generated from tui.tsx by scripts/build-tui.ts. Do not edit.\n${result.code}\n`)
console.log("wrote tui.js")
