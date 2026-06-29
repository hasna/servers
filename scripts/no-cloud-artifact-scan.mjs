#!/usr/bin/env node
import { readFileSync } from "node:fs"
import { spawnSync } from "node:child_process"

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

const pack = spawnSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], {
  encoding: "utf8",
})

if (pack.status !== 0) {
  process.stderr.write(pack.stderr)
  process.exit(pack.status ?? 1)
}

const [artifact] = JSON.parse(pack.stdout)
const hits = []

for (const entry of artifact.files ?? []) {
  const path = entry.path
  try {
    const content = readFileSync(path, "utf8")
    for (const marker of forbiddenMarkers) {
      if (content.includes(marker)) hits.push(`${path}: ${marker}`)
    }
  } catch {
    // Ignore binary/generated files that are not readable as UTF-8.
  }
}

if (hits.length > 0) {
  console.error("Packed artifact contains retired cloud runtime markers:")
  for (const hit of hits) console.error(`- ${hit}`)
  process.exit(1)
}

console.log(`Packed artifact no-cloud scan passed (${artifact.files?.length ?? 0} files).`)
