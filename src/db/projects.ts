import type { Database } from "bun:sqlite";
import { Project, CreateProjectInput } from "../types/index.js";
import { getDatabase, now, uuid } from "./database.js";

export function createProject(input: CreateProjectInput, db?: Database): Project {
  const d = db || getDatabase();
  const id = uuid();
  const t = now();

  d.run(
    `INSERT INTO projects (id, name, path, description, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [id, input.name, input.path, input.description || null, t, t],
  );
  return getProject(id, d)!;
}

export function getProject(id: string, db?: Database): Project | null {
  const d = db || getDatabase();
  return d.query("SELECT * FROM projects WHERE id = ?").get(id) as Project | null;
}

export function getProjectByPath(path: string, db?: Database): Project | null {
  const d = db || getDatabase();
  return d.query("SELECT * FROM projects WHERE path = ?").get(path) as Project | null;
}

export function listProjects(db?: Database): Project[] {
  const d = db || getDatabase();
  return d.query("SELECT * FROM projects ORDER BY name").all() as Project[];
}

export function updateProject(id: string, updates: { name?: string; path?: string; description?: string | null }, db?: Database): Project {
  const d = db || getDatabase();
  const existing = getProject(id, d);
  if (!existing) throw new Error(`Project not found: ${id}`);

  const parts: string[] = [];
  const values: (string | number | null)[] = [];

  if (updates.name !== undefined) { parts.push("name = ?"); values.push(updates.name); }
  if (updates.path !== undefined) { parts.push("path = ?"); values.push(updates.path); }
  if (updates.description !== undefined) { parts.push("description = ?"); values.push(updates.description); }

  parts.push("updated_at = ?");
  values.push(now());
  values.push(id);

  d.run(`UPDATE projects SET ${parts.join(", ")} WHERE id = ?`, values);
  return getProject(id, d)!;
}

export function deleteProject(id: string, db?: Database): boolean {
  const d = db || getDatabase();
  return d.run("DELETE FROM projects WHERE id = ?", [id]).changes > 0;
}
