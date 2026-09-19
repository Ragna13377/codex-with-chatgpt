import type {
  TaskRunner,
} from "./run-manager.js";

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

export const arithmeticMockTaskRunner: TaskRunner =
  async (input) => {
    await delay(1500);

    const match =
      input.instruction.match(
        /(-?\d+(?:\.\d+)?)\s*\+\s*(-?\d+(?:\.\d+)?)/
      );

    if (!match) {
      return {
        status: "blocked",
        result:
          "Mock runner supports only simple addition tasks.",
      };
    }

    const left = Number(match[1]);
    const right = Number(match[2]);

    return {
      status: "completed",
      result: String(left + right),
    };
  };