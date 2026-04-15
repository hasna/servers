import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import {
  getDatabase,
  closeDatabase,
  resetDatabase,
} from "./database.js";
import {
  createProject,
  getProject,
  getProjectByPath,
  listProjects,
  updateProject,
  deleteProject,
} from "./projects.js";

function setup() {
  process.env["SERVERS_DB_PATH"] = ":memory:";
  resetDatabase();
  return { db: getDatabase() };
}

function teardown() {
  closeDatabase();
  delete process.env["SERVERS_DB_PATH"];
}

describe("createProject", () => {
  beforeEach(setup);
  afterEach(teardown);

  it("creates a project", () => {
    const p = createProject({ name: "My Project", path: "/path/to/project" });
    expect(p.id).toBeTruthy();
    expect(p.name).toBe("My Project");
    expect(p.path).toBe("/path/to/project");
    expect(p.description).toBeNull();
    expect(p.created_at).toBeTruthy();
    expect(p.updated_at).toBeTruthy();
  });

  it("creates a project with description", () => {
    const p = createProject({ name: "My Project", path: "/path", description: "A test project" });
    expect(p.description).toBe("A test project");
  });
});

describe("getProject", () => {
  beforeEach(setup);
  afterEach(teardown);

  it("returns the project by id", () => {
    const created = createProject({ name: "test", path: "/path" });
    const found = getProject(created.id)!;
    expect(found.id).toBe(created.id);
  });

  it("returns null for non-existent id", () => {
    expect(getProject("nonexistent")).toBeNull();
  });
});

describe("getProjectByPath", () => {
  beforeEach(setup);
  afterEach(teardown);

  it("returns the project by path", () => {
    createProject({ name: "test", path: "/path/to/project" });
    const found = getProjectByPath("/path/to/project")!;
    expect(found.path).toBe("/path/to/project");
  });

  it("returns null for non-existent path", () => {
    expect(getProjectByPath("/nope")).toBeNull();
  });
});

describe("listProjects", () => {
  beforeEach(setup);
  afterEach(teardown);

  it("lists all projects", () => {
    createProject({ name: "a", path: "/a" });
    createProject({ name: "b", path: "/b" });
    expect(listProjects().length).toBe(2);
  });

  it("returns empty array when no projects", () => {
    expect(listProjects()).toEqual([]);
  });

  it("orders by name", () => {
    createProject({ name: "zebra", path: "/z" });
    createProject({ name: "alpha", path: "/a" });
    const list = listProjects();
    expect(list[0]!.name).toBe("alpha");
    expect(list[1]!.name).toBe("zebra");
  });
});

describe("updateProject", () => {
  beforeEach(setup);
  afterEach(teardown);

  it("updates name", () => {
    const p = createProject({ name: "old", path: "/path" });
    const updated = updateProject(p.id, { name: "new" });
    expect(updated.name).toBe("new");
  });

  it("updates path", () => {
    const p = createProject({ name: "test", path: "/old" });
    const updated = updateProject(p.id, { path: "/new" });
    expect(updated.path).toBe("/new");
  });

  it("updates description", () => {
    const p = createProject({ name: "test", path: "/path" });
    const updated = updateProject(p.id, { description: "updated desc" });
    expect(updated.description).toBe("updated desc");
  });

  it("sets description to null", () => {
    const p = createProject({ name: "test", path: "/path", description: "desc" });
    const updated = updateProject(p.id, { description: null });
    expect(updated.description).toBeNull();
  });

  it("updates updated_at timestamp", () => {
    const p = createProject({ name: "test", path: "/path" });
    const old = p.updated_at;
    const updated = updateProject(p.id, { name: "new" });
    expect(updated.updated_at >= old).toBe(true);
  });

  it("throws for non-existent id", () => {
    expect(() => updateProject("fake", { name: "x" })).toThrow("Project not found");
  });
});

describe("deleteProject", () => {
  beforeEach(setup);
  afterEach(teardown);

  it("deletes a project", () => {
    const p = createProject({ name: "test", path: "/path" });
    expect(deleteProject(p.id)).toBe(true);
    expect(getProject(p.id)).toBeNull();
  });

  it("returns false for non-existent id", () => {
    expect(deleteProject("nonexistent")).toBe(false);
  });
});
