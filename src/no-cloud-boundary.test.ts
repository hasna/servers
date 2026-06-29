import { describe, expect, it } from "bun:test"
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs"
import { join } from "node:path"

const repoRoot = join(import.meta.dir, "..")
const forbiddenMarkers = [
  ["@hasna", "cloud"].join("/"),
  ["open", "cloud"].join("-"),
  ["cloud", "mcp"].join("-"),
  ["register", "Cloud", "Tools"].join(""),
  ["register", "Cloud", "Commands"].join(""),
  [".hasna", "cloud"].join("/"),
  ["HASNA", "CLOUD", ""].join("_"),
  ["HASNA", "RDS"].join("_"),
  ["Sqlite", "Adapter"].join(""),
  ["Pg", "Adapter"].join(""),
  ["cloud", "sync"].join(" "),
]

function collectFiles(path: string): string[] {
  if (!existsSync(path)) return []
  const stat = statSync(path)
  if (stat.isFile()) return [path]
  if (!stat.isDirectory()) return []

  return readdirSync(path).flatMap((entry) => collectFiles(join(path, entry)))
}

describe("no shared cloud runtime boundary", () => {
  it("package, lockfile, docs, skills, and runtime sources do not reference retired cloud runtime markers", () => {
    const files = [
      join(repoRoot, "package.json"),
      join(repoRoot, "bun.lock"),
      join(repoRoot, "README.md"),
      ...collectFiles(join(repoRoot, "skills")),
      ...collectFiles(join(repoRoot, "src")).filter((path) => !path.endsWith("no-cloud-boundary.test.ts")),
    ]

    const hits = []
    for (const file of files) {
      const content = readFileSync(file, "utf8")
      for (const marker of forbiddenMarkers) {
        if (content.includes(marker)) hits.push(`${file.replace(`${repoRoot}/`, "")}: ${marker}`)
      }
    }

    expect(hits).toEqual([])
  })
})
