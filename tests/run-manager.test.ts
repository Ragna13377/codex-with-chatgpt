import {
  describe,
  expect,
  it,
} from "vitest";

import {
  RunManager,
  type TaskRunner,
} from "../src/orchestration/run-manager.js";

const completedRunner: TaskRunner =
  async (input) => ({
    status: "completed",
    result:
      `completed:${input.taskId}`,
  });

const flush = async (): Promise<void> => {
  await new Promise((resolve) =>
    setTimeout(resolve, 0)
  );
};

describe("RunManager", () => {
  it(
    "advances through approved plan items and finalizes",
    async () => {
      const manager =
        new RunManager(
          completedRunner
        );

      const run =
        manager.startRun({
          items: [
            {
              id: "P1",
              summary: "First",
            },
            {
              id: "P2",
              summary: "Second",
            },
          ],

          maxFixAttemptsPerTask:
            2,
        });

      expect(
        run.currentPlanItemId
      ).toBe("P1");

      const first =
        manager.startTask({
          runId: run.runId,
          planItemId: "P1",
          kind: "execute",
          scope: ["P1/task.txt"],
          instruction:
            "Calculate 2 + 2",
          validation:
            "Return 4",
        });

      await flush();

      expect(
        manager.getTask(
          first.taskId
        )?.status
      ).toBe("completed");

      const firstReview =
        manager.submitReview({
          runId: run.runId,
          taskId: first.taskId,
          outcome: "accepted",
          planItemComplete: true,
        });

      expect(
        firstReview.event
      ).toBe("RUN_CONTINUE");

      expect(
        firstReview.nextAction
      ).toBe("EXECUTE");

      expect(
        firstReview.planItemId
      ).toBe("P2");

      const second =
        manager.startTask({
          runId: run.runId,
          planItemId: "P2",
          kind: "execute",
          scope: ["P2/task.txt"],
          instruction:
            "Calculate 3 + 3",
          validation:
            "Return 6",
        });

      await flush();

      const secondReview =
        manager.submitReview({
          runId: run.runId,
          taskId: second.taskId,
          outcome: "accepted",
          planItemComplete: true,
        });

      expect(
        secondReview.nextAction
      ).toBe("FINALIZE");

      const done =
        manager.finalizeRun(
          run.runId
        );

      expect(done.status).toBe(
        "done"
      );
    }
  );

  it(
    "tracks fix budgets independently per root task",
    async () => {
      const manager =
        new RunManager(
          completedRunner
        );

      const run =
        manager.startRun({
          items: [
            {
              id: "P1",
              summary:
                "Multiple bounded tasks",
            },
          ],

          maxFixAttemptsPerTask:
            2,
        });

      const rootA =
        manager.startTask({
          runId: run.runId,
          planItemId: "P1",
          kind: "execute",
          scope: ["A"],
          instruction:
            "Execute A",
          validation:
            "Validate A",
        });

      await flush();

      manager.submitReview({
        runId: run.runId,
        taskId: rootA.taskId,
        outcome:
          "fix_required",
      });

      const fixA1 =
        manager.startTask({
          runId: run.runId,
          planItemId: "P1",
          kind: "fix",
          rootTaskId:
          rootA.taskId,
          scope: ["A"],
          instruction:
            "Fix A once",
          validation:
            "Validate A",
        });

      await flush();

      manager.submitReview({
        runId: run.runId,
        taskId: fixA1.taskId,
        outcome:
          "fix_required",
      });

      const fixA2 =
        manager.startTask({
          runId: run.runId,
          planItemId: "P1",
          kind: "fix",
          rootTaskId:
          rootA.taskId,
          scope: ["A"],
          instruction:
            "Fix A twice",
          validation:
            "Validate A",
        });

      await flush();

      manager.submitReview({
        runId: run.runId,
        taskId: fixA2.taskId,
        outcome: "accepted",
        planItemComplete: false,
      });

      expect(
        manager.getTask(
          rootA.taskId
        )?.fixAttemptsUsed
      ).toBe(2);

      const rootB =
        manager.startTask({
          runId: run.runId,
          planItemId: "P1",
          kind: "execute",
          scope: ["B"],
          instruction:
            "Execute B",
          validation:
            "Validate B",
        });

      expect(
        manager.getTask(
          rootB.taskId
        )?.fixAttemptsUsed
      ).toBe(0);
    }
  );
});