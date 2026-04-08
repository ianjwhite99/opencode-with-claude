import { defineConfig } from "tsup"
import { readFileSync } from "fs"

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  dts: true,
  clean: true,
  minify: true,
  esbuildOptions(options) {
    options.supported = { ...options.supported, "template-literal": false }
  },
  esbuildPlugins: [
    {
      name: "minify-txt",
      setup(build) {
        build.onLoad({ filter: /\.txt$/ }, (args) => {
          const raw = readFileSync(args.path, "utf8")
          const minified = raw
            .split("\n")
            .map((l) => l.trimEnd())
            .join("\n")
            .replace(/\n{3,}/g, "\n")
            .trim()
          return {
            contents: `export default ${JSON.stringify(minified)}`,
            loader: "js",
          }
        })
      },
    },
  ],
})
