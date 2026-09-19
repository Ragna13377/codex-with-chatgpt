# C2C Orchestration Protocol

ChatGPT is the orchestrator.
C2C is the deterministic control plane.
Codex workers execute one bounded task at a time.

## Responsibilities

### ChatGPT

ChatGPT owns:

- the approved plan;
- workspace audit before each task;
- bounded task construction;
- independent review;
- deciding whether a task is accepted or needs a fix;
- deciding when a plan item is complete.

### C2C

C2C owns:

- run state;
- plan order;
- task ids;
- task state;
- fix counters;
- transition validation;
- continuation delivery;
- enforcing that no unapproved top-level plan item is created.

C2C never interprets review prose to decide whether work is correct.

### Codex worker

A Codex worker owns only one bounded task.

It does not own:

- the global plan;
- queue progression;
- review;
- fix policy;
- finalization;
- commit or push.

## Commands

Commands are sent from ChatGPT to C2C.

### start_run

Create a run from an already approved finite top-level plan.

Input:

- plan items
- maxFixAttemptsPerTask

Top-level plan items are locked after the run starts.

### start_task

Start one bounded execution task.

Kinds:

- execute
- fix

Every execute task creates a new root task chain.

Every fix references that root task chain.

Fix limits are counted independently per root task chain.

### submit_review

Submit ChatGPT's independent review result.

Outcomes:

- accepted
- fix_required
- blocked

When accepted, ChatGPT also states whether the current top-level
plan item is complete.

### get_run

Read current run state.

Recovery/debug operation only.

### get_task

Read current task state.

Recovery/debug operation and continuation polling.

### finalize_run

Finalize a run only after every approved top-level plan item is accepted.

The mock implementation performs no git commit or push.
Real finalization will be implemented separately.

## Events

Events are delivered from C2C to ChatGPT.

### TASK_COMPLETED

The worker finished.

This does NOT mean the task is accepted.

ChatGPT must independently review it.

### TASK_FAILED

Execution failed.

### TASK_BLOCKED

Execution could not continue within the supplied scope.

### RUN_CONTINUE

C2C requests another orchestration step.

NEXT_ACTION is one of:

- EXECUTE
- FIX
- FINALIZE

### RUN_BLOCKED

The run cannot automatically continue.

Examples:

- fix limit reached;
- explicit review block;
- invalid state transition.

### RUN_FINALIZED

Finalization completed.

ChatGPT may now report DONE.

## Fix budget

`maxFixAttemptsPerTask` applies independently to each root execution task.

Example with limit 2:

P1 task A
- execute
- fix 1
- fix 2

P1 task B
- execute
- fix 1
- fix 2

P2 task A
- execute
- fix 1
- fix 2

All are valid independent chains.

A request for another fix after a task chain has consumed its own
budget transitions the run to RUN_BLOCKED.

## Plan locking

If a run starts with:

- P1
- P2
- P3

ChatGPT may execute several bounded tasks inside P2.

ChatGPT may not create a new top-level P4.

When all approved plan items are complete, the only valid next action
is FINALIZE.

## Core flow

USER START
→ start_run

RUN_CONTINUE(EXECUTE)
→ ChatGPT AUDIT
→ start_task(execute)

TASK_COMPLETED
→ ChatGPT REVIEW
→ submit_review

submit_review(fix_required)
→ RUN_CONTINUE(FIX)
→ start_task(fix)

submit_review(accepted, planItemComplete=false)
→ RUN_CONTINUE(EXECUTE) for the same plan item

submit_review(accepted, planItemComplete=true)
→ RUN_CONTINUE(EXECUTE) for the next approved plan item

last plan item accepted
→ RUN_CONTINUE(FINALIZE)

finalize_run
→ RUN_FINALIZED
→ DONE

## Safety rules

- TASK_COMPLETED never implies accepted.
- Only ChatGPT review may accept work.
- C2C validates state transitions but does not judge code quality.
- Codex never decides NEXT, FIX, FINALIZE, or DONE.
- No new top-level plan items after start_run.
- No automatic loop after RUN_BLOCKED.