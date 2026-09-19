import { randomUUID } from "node:crypto";

export type RunStatus =
  | "active"
  | "blocked"
  | "finalizing"
  | "done";

export type PlanItemStatus =
  | "pending"
  | "active"
  | "accepted"
  | "blocked";

export type TaskKind =
  | "execute"
  | "fix";

export type TaskStatus =
  | "running"
  | "completed"
  | "blocked"
  | "failed";

export type ReviewOutcome =
  | "accepted"
  | "fix_required"
  | "blocked";

export type NextAction =
  | "EXECUTE"
  | "FIX"
  | "FINALIZE";

export interface PlanItem {
  id: string;
  summary: string;
  status: PlanItemStatus;
}

export interface TaskRecord {
  taskId: string;
  rootTaskId: string;
  runId: string;
  planItemId: string;
  kind: TaskKind;

  label?: string;
  scope: string[];
  instruction: string;
  validation: string;

  status: TaskStatus;
  result?: string;

  fixAttempt?: number;
  fixAttemptsUsed: number;

  reviewed: boolean;

  startedAt: string;
  completedAt?: string;
}

export interface RunRecord {
  runId: string;
  status: RunStatus;

  items: PlanItem[];

  currentPlanItemId: string | null;
  currentTaskId: string | null;
  nextAction: NextAction | null;

  maxFixAttemptsPerTask: number;

  createdAt: string;
  updatedAt: string;
}

export interface TaskRunnerInput {
  runId: string;
  taskId: string;
  rootTaskId: string;
  planItemId: string;
  kind: TaskKind;
  scope: string[];
  instruction: string;
  validation: string;
  fixAttempt?: number;
}

export interface TaskRunnerResult {
  status: "completed" | "blocked" | "failed";
  result: string;
}

export type TaskRunner = (
  input: TaskRunnerInput
) => Promise<TaskRunnerResult>;

export class RunManagerError extends Error {
  constructor(
    public readonly code: string,
    message: string
  ) {
    super(message);
  }
}

export interface ReviewTransition {
  runId: string;
  runStatus: RunStatus;
  event: "RUN_CONTINUE" | "RUN_BLOCKED";
  nextAction?: NextAction;
  planItemId?: string;
  rootTaskId?: string;
  fixAttemptsUsed?: number;
  fixAttemptsRemaining?: number;
  reason?: string;
}

export class RunManager {
  private readonly runs =
    new Map<string, RunRecord>();

  private readonly tasks =
    new Map<string, TaskRecord>();

  constructor(
    private readonly runner: TaskRunner
  ) {}

  startRun(input: {
    items: Array<{
      id: string;
      summary: string;
    }>;
    maxFixAttemptsPerTask: number;
  }): RunRecord {
    if (input.items.length === 0) {
      throw new RunManagerError(
        "EMPTY_PLAN",
        "A run requires at least one plan item."
      );
    }

    if (input.maxFixAttemptsPerTask < 0) {
      throw new RunManagerError(
        "INVALID_FIX_LIMIT",
        "maxFixAttemptsPerTask must be non-negative."
      );
    }

    const ids = new Set<string>();

    for (const item of input.items) {
      if (ids.has(item.id)) {
        throw new RunManagerError(
          "DUPLICATE_PLAN_ITEM",
          `Duplicate plan item id: ${item.id}`
        );
      }

      ids.add(item.id);
    }

    const now = new Date().toISOString();
    const runId = `c2c_run_${randomUUID()}`;

    const items: PlanItem[] =
      input.items.map((item, index) => ({
        ...item,
        status:
          index === 0
            ? "active"
            : "pending",
      }));

    const run: RunRecord = {
      runId,
      status: "active",
      items,
      currentPlanItemId: items[0].id,
      currentTaskId: null,
      nextAction: "EXECUTE",
      maxFixAttemptsPerTask:
      input.maxFixAttemptsPerTask,
      createdAt: now,
      updatedAt: now,
    };

    this.runs.set(runId, run);

    return this.cloneRun(run);
  }

  startTask(input: {
    runId: string;
    planItemId: string;
    kind: TaskKind;
    rootTaskId?: string;
    label?: string;
    scope: string[];
    instruction: string;
    validation: string;
  }): TaskRecord {
    const run = this.requireRun(input.runId);

    if (run.status !== "active") {
      throw new RunManagerError(
        "RUN_NOT_ACTIVE",
        `Run ${run.runId} is ${run.status}.`
      );
    }

    if (
      run.currentPlanItemId !==
      input.planItemId
    ) {
      throw new RunManagerError(
        "PLAN_ITEM_NOT_CURRENT",
        `Current plan item is ${run.currentPlanItemId}.`
      );
    }

    const expectedAction =
      input.kind === "execute"
        ? "EXECUTE"
        : "FIX";

    if (run.nextAction !== expectedAction) {
      throw new RunManagerError(
        "INVALID_TRANSITION",
        `Expected ${run.nextAction}, not ${expectedAction}.`
      );
    }

    const taskId =
      `c2c_task_${randomUUID()}`;

    let rootTaskId = taskId;
    let fixAttempt: number | undefined;
    let fixAttemptsUsed = 0;

    if (input.kind === "fix") {
      if (!input.rootTaskId) {
        throw new RunManagerError(
          "ROOT_TASK_REQUIRED",
          "A fix task requires rootTaskId."
        );
      }

      const root =
        this.requireTask(input.rootTaskId);

      if (
        root.runId !== run.runId ||
        root.planItemId !== input.planItemId ||
        root.kind !== "execute"
      ) {
        throw new RunManagerError(
          "INVALID_ROOT_TASK",
          "The root task does not belong to this execution chain."
        );
      }

      if (
        root.fixAttemptsUsed >=
        run.maxFixAttemptsPerTask
      ) {
        run.status = "blocked";
        run.nextAction = null;
        run.updatedAt =
          new Date().toISOString();

        throw new RunManagerError(
          "FIX_LIMIT_REACHED",
          "The root task has exhausted its fix budget."
        );
      }

      root.fixAttemptsUsed += 1;

      rootTaskId = root.taskId;
      fixAttempt = root.fixAttemptsUsed;
      fixAttemptsUsed =
        root.fixAttemptsUsed;
    }

    const task: TaskRecord = {
      taskId,
      rootTaskId,
      runId: run.runId,
      planItemId: input.planItemId,
      kind: input.kind,
      label: input.label,
      scope: [...input.scope],
      instruction: input.instruction,
      validation: input.validation,
      status: "running",
      fixAttempt,
      fixAttemptsUsed,
      reviewed: false,
      startedAt:
        new Date().toISOString(),
    };

    this.tasks.set(taskId, task);

    run.currentTaskId = taskId;
    run.nextAction = null;
    run.updatedAt =
      new Date().toISOString();

    void this.runner({
      runId: task.runId,
      taskId: task.taskId,
      rootTaskId: task.rootTaskId,
      planItemId: task.planItemId,
      kind: task.kind,
      scope: task.scope,
      instruction: task.instruction,
      validation: task.validation,
      fixAttempt: task.fixAttempt,
    })
      .then((result) => {
        const current =
          this.tasks.get(taskId);

        if (!current) return;

        current.status = result.status;
        current.result = result.result;
        current.completedAt =
          new Date().toISOString();

        const currentRun =
          this.runs.get(run.runId);

        if (currentRun) {
          currentRun.updatedAt =
            new Date().toISOString();
        }
      })
      .catch((error: unknown) => {
        const current =
          this.tasks.get(taskId);

        if (!current) return;

        current.status = "failed";
        current.result =
          error instanceof Error
            ? error.message
            : String(error);

        current.completedAt =
          new Date().toISOString();
      });

    return this.cloneTask(task);
  }

  submitReview(input: {
    runId: string;
    taskId: string;
    outcome: ReviewOutcome;
    planItemComplete?: boolean;
  }): ReviewTransition {
    const run =
      this.requireRun(input.runId);

    const task =
      this.requireTask(input.taskId);

    if (task.runId !== run.runId) {
      throw new RunManagerError(
        "TASK_RUN_MISMATCH",
        "Task does not belong to this run."
      );
    }

    if (task.status !== "completed") {
      throw new RunManagerError(
        "TASK_NOT_REVIEWABLE",
        `Task status is ${task.status}.`
      );
    }

    if (task.reviewed) {
      throw new RunManagerError(
        "TASK_ALREADY_REVIEWED",
        "This task already has a review result."
      );
    }

    task.reviewed = true;

    if (input.outcome === "blocked") {
      run.status = "blocked";
      run.nextAction = null;

      const item =
        this.requirePlanItem(
          run,
          task.planItemId
        );

      item.status = "blocked";

      run.updatedAt =
        new Date().toISOString();

      return {
        runId: run.runId,
        runStatus: run.status,
        event: "RUN_BLOCKED",
        planItemId: task.planItemId,
        rootTaskId: task.rootTaskId,
        reason: "REVIEW_BLOCKED",
      };
    }

    if (
      input.outcome ===
      "fix_required"
    ) {
      const root =
        this.requireTask(
          task.rootTaskId
        );

      if (
        root.fixAttemptsUsed >=
        run.maxFixAttemptsPerTask
      ) {
        run.status = "blocked";
        run.nextAction = null;
        run.updatedAt =
          new Date().toISOString();

        return {
          runId: run.runId,
          runStatus: run.status,
          event: "RUN_BLOCKED",
          planItemId: task.planItemId,
          rootTaskId: root.taskId,
          fixAttemptsUsed:
          root.fixAttemptsUsed,
          fixAttemptsRemaining: 0,
          reason: "FIX_LIMIT_REACHED",
        };
      }

      run.nextAction = "FIX";
      run.currentTaskId = task.taskId;
      run.updatedAt =
        new Date().toISOString();

      return {
        runId: run.runId,
        runStatus: run.status,
        event: "RUN_CONTINUE",
        nextAction: "FIX",
        planItemId: task.planItemId,
        rootTaskId: root.taskId,
        fixAttemptsUsed:
        root.fixAttemptsUsed,
        fixAttemptsRemaining:
          run.maxFixAttemptsPerTask -
          root.fixAttemptsUsed,
      };
    }

    if (!input.planItemComplete) {
      run.nextAction = "EXECUTE";
      run.currentTaskId = null;
      run.updatedAt =
        new Date().toISOString();

      return {
        runId: run.runId,
        runStatus: run.status,
        event: "RUN_CONTINUE",
        nextAction: "EXECUTE",
        planItemId: task.planItemId,
      };
    }

    const current =
      this.requirePlanItem(
        run,
        task.planItemId
      );

    current.status = "accepted";

    const currentIndex =
      run.items.findIndex(
        (item) =>
          item.id === current.id
      );

    const next =
      run.items
        .slice(currentIndex + 1)
        .find(
          (item) =>
            item.status === "pending"
        );

    if (next) {
      next.status = "active";

      run.currentPlanItemId =
        next.id;

      run.currentTaskId = null;
      run.nextAction = "EXECUTE";
      run.updatedAt =
        new Date().toISOString();

      return {
        runId: run.runId,
        runStatus: run.status,
        event: "RUN_CONTINUE",
        nextAction: "EXECUTE",
        planItemId: next.id,
      };
    }

    run.currentPlanItemId = null;
    run.currentTaskId = null;
    run.nextAction = "FINALIZE";
    run.updatedAt =
      new Date().toISOString();

    return {
      runId: run.runId,
      runStatus: run.status,
      event: "RUN_CONTINUE",
      nextAction: "FINALIZE",
    };
  }

  finalizeRun(runId: string): RunRecord {
    const run =
      this.requireRun(runId);

    if (
      run.status !== "active" ||
      run.nextAction !== "FINALIZE"
    ) {
      throw new RunManagerError(
        "RUN_NOT_READY_TO_FINALIZE",
        "The run is not ready for finalization."
      );
    }

    if (
      run.items.some(
        (item) =>
          item.status !== "accepted"
      )
    ) {
      throw new RunManagerError(
        "PLAN_NOT_COMPLETE",
        "Every approved plan item must be accepted first."
      );
    }

    run.status = "done";
    run.nextAction = null;
    run.updatedAt =
      new Date().toISOString();

    return this.cloneRun(run);
  }

  getRun(
    runId: string
  ): RunRecord | undefined {
    const run =
      this.runs.get(runId);

    return run
      ? this.cloneRun(run)
      : undefined;
  }

  getTask(
    taskId: string
  ): TaskRecord | undefined {
    const task =
      this.tasks.get(taskId);

    if (!task) return undefined;

    const copy =
      this.cloneTask(task);

    const root =
      this.tasks.get(task.rootTaskId);

    if (root) {
      copy.fixAttemptsUsed =
        root.fixAttemptsUsed;
    }

    return copy;
  }

  private requireRun(
    runId: string
  ): RunRecord {
    const run =
      this.runs.get(runId);

    if (!run) {
      throw new RunManagerError(
        "RUN_NOT_FOUND",
        `Unknown run: ${runId}`
      );
    }

    return run;
  }

  private requireTask(
    taskId: string
  ): TaskRecord {
    const task =
      this.tasks.get(taskId);

    if (!task) {
      throw new RunManagerError(
        "TASK_NOT_FOUND",
        `Unknown task: ${taskId}`
      );
    }

    return task;
  }

  private requirePlanItem(
    run: RunRecord,
    planItemId: string
  ): PlanItem {
    const item =
      run.items.find(
        (candidate) =>
          candidate.id === planItemId
      );

    if (!item) {
      throw new RunManagerError(
        "PLAN_ITEM_NOT_FOUND",
        `Plan item ${planItemId} is not part of this run.`
      );
    }

    return item;
  }

  private cloneRun(
    run: RunRecord
  ): RunRecord {
    return {
      ...run,
      items: run.items.map(
        (item) => ({ ...item })
      ),
    };
  }

  private cloneTask(
    task: TaskRecord
  ): TaskRecord {
    return {
      ...task,
      scope: [...task.scope],
    };
  }
}