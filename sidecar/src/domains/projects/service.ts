import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import type { RuntimeContext } from "../../runtime/context";
import { mutate } from "../../runtime/unitOfWork";
import { isGitRepo, repoInfo, repoToplevel } from "../../connectors/git";

export interface ProjectRow {
  id: string;
  company_id: string;
  name: string;
  root_path: string;
  remote_url: string | null;
  default_branch: string;
  created_at: string;
}

export interface CreateProjectInput {
  name: string;
  rootPath: string;
}

/**
 * Register a project: a real git repo on disk the company's agents can work in.
 * Validates the path exists and is a git repo, resolves it to the repo toplevel,
 * and captures its default branch + origin remote (null remote = local-only).
 */
export async function createProject(ctx: RuntimeContext, companyId: string, input: CreateProjectInput): Promise<ProjectRow> {
  const name = input.name.trim();
  if (!name) throw new Error("project name is required");
  const requested = input.rootPath.trim();
  if (!requested) throw new Error("project root path is required");
  if (!fs.existsSync(requested) || !fs.statSync(requested).isDirectory()) {
    throw new Error(`path does not exist or is not a directory: ${requested}`);
  }
  if (!(await isGitRepo(requested))) {
    throw new Error(`not a git repository: ${requested} (run 'git init' or point at an existing repo)`);
  }
  const rootPath = await repoToplevel(requested);
  const { defaultBranch, remoteUrl } = await repoInfo(rootPath);

  const id = randomUUID();
  return mutate(ctx, async (trx, emit) => {
    await trx
      .insertInto("projects")
      .values({ id, company_id: companyId, name, root_path: rootPath, remote_url: remoteUrl, default_branch: defaultBranch })
      .execute();
    await emit({ companyId, type: "project.created", subjectId: id, actor: { kind: "user" }, payload: { name, rootPath } });
    return { id, company_id: companyId, name, root_path: rootPath, remote_url: remoteUrl, default_branch: defaultBranch, created_at: new Date().toISOString() };
  });
}

export async function listProjects(ctx: RuntimeContext, companyId: string): Promise<ProjectRow[]> {
  return ctx.db.selectFrom("projects").where("company_id", "=", companyId).selectAll().orderBy("name").execute();
}

export async function getProject(ctx: RuntimeContext, projectId: string): Promise<ProjectRow | null> {
  return (await ctx.db.selectFrom("projects").where("id", "=", projectId).selectAll().executeTakeFirst()) ?? null;
}

/** Remove a project + its employee scopings and tasks (application-layer cascade). */
export async function removeProject(ctx: RuntimeContext, companyId: string, projectId: string): Promise<void> {
  await mutate(ctx, async (trx, emit) => {
    const proj = await trx.selectFrom("projects").where("id", "=", projectId).where("company_id", "=", companyId).select("id").executeTakeFirst();
    if (!proj) throw new Error("project not found");
    await trx.deleteFrom("employee_projects").where("project_id", "=", projectId).execute();
    await trx.deleteFrom("tasks").where("project_id", "=", projectId).execute();
    await trx.deleteFrom("projects").where("id", "=", projectId).execute();
    await emit({ companyId, type: "project.removed", subjectId: projectId, actor: { kind: "user" }, payload: {} });
  });
}

/** Replace an employee's project allowlist (set in employee settings). */
export async function setEmployeeProjects(ctx: RuntimeContext, companyId: string, employeeId: string, projectIds: string[]): Promise<void> {
  const unique = Array.from(new Set(projectIds));
  await mutate(ctx, async (trx, emit) => {
    // Guard: every id must be a project in this company.
    if (unique.length) {
      const valid = await trx.selectFrom("projects").where("company_id", "=", companyId).where("id", "in", unique).select("id").execute();
      if (valid.length !== unique.length) throw new Error("one or more projects do not belong to this company");
    }
    await trx.deleteFrom("employee_projects").where("employee_id", "=", employeeId).execute();
    if (unique.length) {
      await trx.insertInto("employee_projects").values(unique.map((project_id) => ({ employee_id: employeeId, project_id }))).execute();
    }
    await emit({ companyId, type: "employee.projectsUpdated", subjectId: employeeId, actor: { kind: "user" }, payload: { projectIds: unique } });
  });
}

export async function listEmployeeProjectIds(ctx: RuntimeContext, employeeId: string): Promise<string[]> {
  const rows = await ctx.db.selectFrom("employee_projects").where("employee_id", "=", employeeId).select("project_id").execute();
  return rows.map((r) => r.project_id);
}

/** Full project rows an employee is scoped to — used to build its act-time context. */
export async function listProjectsForEmployee(ctx: RuntimeContext, employeeId: string): Promise<ProjectRow[]> {
  return ctx.db
    .selectFrom("projects as p")
    .innerJoin("employee_projects as ep", "ep.project_id", "p.id")
    .where("ep.employee_id", "=", employeeId)
    .selectAll("p")
    .orderBy("p.name")
    .execute();
}
