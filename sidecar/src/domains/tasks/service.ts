import { randomUUID } from "node:crypto";
import type { RuntimeContext } from "../../runtime/context";
import { mutate } from "../../runtime/unitOfWork";
import { addWorktree, removeWorktree } from "../../connectors/git";
import { taskWorktreePath } from "../../connectors/workspace";
import { getProject } from "../projects/service";

export type TaskStatus = "open" | "in_progress" | "in_review" | "done" | "abandoned";

export interface TaskRow {
  id: string;
  company_id: string;
  project_id: string;
  employee_id: string | null;
  title: string;
  status: TaskStatus;
  base_branch: string;
  branch_name: string | null;
  worktree_path: string | null;
  pr_url: string | null;
  created_at: string;
  updated_at: string;
}

function slugify(title: string): string {
  return (
    title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "task"
  );
}

export interface CreateTaskInput {
  companyId: string;
  projectId: string;
  employeeId: string | null;
  title: string;
}

export async function createTask(ctx: RuntimeContext, input: CreateTaskInput): Promise<TaskRow> {
  const title = input.title.trim();
  if (!title) throw new Error("task title is required");
  const project = await getProject(ctx, input.projectId);
  if (!project || project.company_id !== input.companyId) throw new Error("project not found in this company");
  const id = randomUUID();
  await mutate(ctx, async (trx, emit) => {
    await trx
      .insertInto("tasks")
      .values({
        id,
        company_id: input.companyId,
        project_id: input.projectId,
        employee_id: input.employeeId,
        title,
        status: "open",
        base_branch: project.default_branch,
      })
      .execute();
    await emit({ companyId: input.companyId, type: "task.created", subjectId: id, actor: { kind: "system" }, payload: { projectId: input.projectId, title } });
  });
  // Read back OUTSIDE the transaction — querying ctx.db inside mutate() would
  // deadlock on better-sqlite3's single connection.
  return getTaskOrThrow(ctx, id);
}

/**
 * Move a task to in_progress by materializing its isolated git worktree + branch
 * off the project's default branch. Idempotent: re-starting a task that already
 * has a worktree just returns it. The worktree is where the agent does all edits.
 */
export async function startTask(ctx: RuntimeContext, taskId: string): Promise<{ worktreePath: string; branchName: string }> {
  const task = await getTaskOrThrow(ctx, taskId);
  if (task.worktree_path && task.branch_name) {
    return { worktreePath: task.worktree_path, branchName: task.branch_name };
  }
  const project = await getProject(ctx, task.project_id);
  if (!project) throw new Error("task's project no longer exists");

  const branchName = `cofounder/${slugify(task.title)}-${taskId.slice(0, 8)}`;
  const worktreePath = taskWorktreePath(task.company_id, taskId);
  await addWorktree(project.root_path, worktreePath, branchName, task.base_branch || project.default_branch);

  await mutate(ctx, async (trx, emit) => {
    await trx
      .updateTable("tasks")
      .set({ status: "in_progress", branch_name: branchName, worktree_path: worktreePath, updated_at: new Date().toISOString() })
      .where("id", "=", taskId)
      .execute();
    await emit({ companyId: task.company_id, type: "task.started", subjectId: taskId, actor: { kind: "system" }, payload: { branchName } });
  });
  return { worktreePath, branchName };
}

export async function setTaskStatus(ctx: RuntimeContext, taskId: string, status: TaskStatus, extra?: { prUrl?: string | null }): Promise<void> {
  const task = await getTaskOrThrow(ctx, taskId);
  await mutate(ctx, async (trx, emit) => {
    await trx
      .updateTable("tasks")
      .set({ status, ...(extra?.prUrl !== undefined ? { pr_url: extra.prUrl } : {}), updated_at: new Date().toISOString() })
      .where("id", "=", taskId)
      .execute();
    await emit({ companyId: task.company_id, type: "task.updated", subjectId: taskId, actor: { kind: "system" }, payload: { status } });
  });
}

/** Tear down a task's worktree (branch is preserved for its PR). */
export async function cleanupTaskWorktree(ctx: RuntimeContext, taskId: string): Promise<void> {
  const task = await getTaskOrThrow(ctx, taskId);
  if (!task.worktree_path) return;
  const project = await getProject(ctx, task.project_id);
  if (project) await removeWorktree(project.root_path, task.worktree_path);
  await ctx.db.updateTable("tasks").set({ worktree_path: null, updated_at: new Date().toISOString() }).where("id", "=", taskId).execute();
}

export async function getTask(ctx: RuntimeContext, taskId: string): Promise<TaskRow | null> {
  return ((await ctx.db.selectFrom("tasks").where("id", "=", taskId).selectAll().executeTakeFirst()) as TaskRow | undefined) ?? null;
}

async function getTaskOrThrow(ctx: RuntimeContext, taskId: string): Promise<TaskRow> {
  const t = await getTask(ctx, taskId);
  if (!t) throw new Error(`task ${taskId} not found`);
  return t;
}

export interface ListTasksFilter {
  projectId?: string;
  employeeId?: string;
  status?: TaskStatus;
}

export async function listTasks(ctx: RuntimeContext, companyId: string, filter: ListTasksFilter = {}): Promise<TaskRow[]> {
  let q = ctx.db.selectFrom("tasks").where("company_id", "=", companyId);
  if (filter.projectId) q = q.where("project_id", "=", filter.projectId);
  if (filter.employeeId) q = q.where("employee_id", "=", filter.employeeId);
  if (filter.status) q = q.where("status", "=", filter.status);
  return (await q.selectAll().orderBy("created_at", "desc").execute()) as TaskRow[];
}
