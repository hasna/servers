import { existsSync, readFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

export function getMcpVersion(fromUrl = import.meta.url): string {
  try {
    const dir = dirname(fileURLToPath(fromUrl));
    const candidates = [
      join(dir, "..", "..", "package.json"),
      join(dir, "..", "package.json"),
    ];
    for (const pkgPath of candidates) {
      if (existsSync(pkgPath)) {
        return JSON.parse(readFileSync(pkgPath, "utf-8")).version || "0.0.0";
      }
    }
    return "0.0.0";
  } catch {
    return "0.0.0";
  }
}
