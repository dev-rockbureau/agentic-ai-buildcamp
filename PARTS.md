# Parts

This file is made from the folders in `parts/` and the minutes in each step's `step.toml`. Run `bun run parts` after you add or change a step. `bun run check` fails when this file is out of date.

## Parts

| Part                                                                        | Folder                       | Steps | Minutes |
| --------------------------------------------------------------------------- | ---------------------------- | ----: | ------: |
| [Meet the world](parts/00-meet-the-world/README.md)                         | `meet-the-world`             |     1 |      20 |
| [Design](parts/01-design/README.md)                                         | `design`                     |     7 |     200 |
| [Build](parts/02-build/README.md)                                           | `build`                      |    13 |     325 |
| [Deploy](parts/03-deploy/README.md)                                         | `deploy`                     |     9 |     215 |
| [Operate](parts/04-operate/README.md)                                       | `operate`                    |    12 |     295 |
| [Run the agent on LangGraph](parts/05-run-the-agent-on-langgraph/README.md) | `run-the-agent-on-langgraph` |     1 |      30 |
| **Total**                                                                   |                              |    43 |    1085 |

## Steps

| Part                         | Step                                                                                                        | Minutes | Files to edit                                           |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------- | ------: | ------------------------------------------------------- |
| `meet-the-world`             | [`meet-the-world`](parts/00-meet-the-world/01-meet-the-world/problem/README.md)                             |      20 | `notes.md`                                              |
| `design`                     | [`place-it-on-the-map`](parts/01-design/01-place-it-on-the-map/problem/README.md)                           |      20 | `map.md`                                                |
| `design`                     | [`write-the-hire-letter`](parts/01-design/02-write-the-hire-letter/problem/README.md)                       |      30 | `employee.toml`                                         |
| `design`                     | [`turn-the-hire-into-tests`](parts/01-design/03-turn-the-hire-into-tests/problem/README.md)                 |      30 | `acceptance.yaml`                                       |
| `design`                     | [`list-tools-and-permissions`](parts/01-design/04-list-tools-and-permissions/problem/README.md)             |      30 | `tools.yaml`                                            |
| `design`                     | [`price-the-outcome`](parts/01-design/05-price-the-outcome/problem/README.md)                               |      30 | `cost.yaml`                                             |
| `design`                     | [`record-the-decisions`](parts/01-design/06-record-the-decisions/problem/README.md)                         |      30 | `adr/`                                                  |
| `design`                     | [`pass-the-design-review`](parts/01-design/07-pass-the-design-review/problem/README.md)                     |      30 | `review.md`                                             |
| `build`                      | [`answer-the-contract`](parts/02-build/01-answer-the-contract/problem/README.md)                            |      30 | none                                                    |
| `build`                      | [`call-the-tools`](parts/02-build/02-call-the-tools/problem/README.md)                                      |      20 | none                                                    |
| `build`                      | [`pay-one-invoice`](parts/02-build/03-pay-one-invoice/problem/README.md)                                    |      25 | none                                                    |
| `build`                      | [`stop-the-loop-on-purpose`](parts/02-build/04-stop-the-loop-on-purpose/problem/README.md)                  |      30 | none                                                    |
| `build`                      | [`close-on-the-record`](parts/02-build/05-close-on-the-record/problem/README.md)                            |      30 | none                                                    |
| `build`                      | [`hold-the-must-never`](parts/02-build/06-hold-the-must-never/problem/README.md)                            |      30 | none                                                    |
| `build`                      | [`ask-for-approval`](parts/02-build/07-ask-for-approval/problem/README.md)                                  |      20 | none                                                    |
| `build`                      | [`check-who-approves`](parts/02-build/08-check-who-approves/problem/README.md)                              |      25 | none                                                    |
| `build`                      | [`add-a-checker`](parts/02-build/09-add-a-checker/problem/README.md)                                        |      25 | none                                                    |
| `build`                      | [`catch-a-bad-draft`](parts/02-build/10-catch-a-bad-draft/problem/README.md)                                |      20 | none                                                    |
| `build`                      | [`remember-what-matters`](parts/02-build/11-remember-what-matters/problem/README.md)                        |      30 | none                                                    |
| `build`                      | [`engineer-the-context`](parts/02-build/12-engineer-the-context/problem/README.md)                          |      20 | `context.yaml`                                          |
| `build`                      | [`design-the-tool-and-its-output`](parts/02-build/13-design-the-tool-and-its-output/problem/README.md)      |      20 | `tool.yaml`                                             |
| `deploy`                     | [`ship-it-as-a-service`](parts/03-deploy/01-ship-it-as-a-service/problem/README.md)                         |      30 | `Dockerfile`, `Dockerfile.dockerignore`, `compose.yaml` |
| `deploy`                     | [`save-progress`](parts/03-deploy/02-save-progress/problem/README.md)                                       |      20 | none                                                    |
| `deploy`                     | [`pay-once-after-a-crash`](parts/03-deploy/03-pay-once-after-a-crash/problem/README.md)                     |      25 | none                                                    |
| `deploy`                     | [`start-on-an-event-and-a-schedule`](parts/03-deploy/04-start-on-an-event-and-a-schedule/problem/README.md) |      30 | none                                                    |
| `deploy`                     | [`gate-writes-with-a-policy`](parts/03-deploy/05-gate-writes-with-a-policy/problem/README.md)               |      25 | `policy.yaml`                                           |
| `deploy`                     | [`refuse-the-hidden-instruction`](parts/03-deploy/06-refuse-the-hidden-instruction/problem/README.md)       |      15 | none                                                    |
| `deploy`                     | [`cap-the-spend`](parts/03-deploy/07-cap-the-spend/problem/README.md)                                       |      30 | none                                                    |
| `deploy`                     | [`isolate-the-second-tenant`](parts/03-deploy/08-isolate-the-second-tenant/problem/README.md)               |      25 | none                                                    |
| `deploy`                     | [`split-the-board-by-tenant`](parts/03-deploy/09-split-the-board-by-tenant/problem/README.md)               |      15 | none                                                    |
| `operate`                    | [`show-cost-per-outcome`](parts/04-operate/01-show-cost-per-outcome/problem/README.md)                      |      30 | none                                                    |
| `operate`                    | [`label-the-traces`](parts/04-operate/02-label-the-traces/problem/README.md)                                |      25 | `labels.csv`                                            |
| `operate`                    | [`count-the-failure-modes`](parts/04-operate/03-count-the-failure-modes/problem/README.md)                  |      20 | `failure-modes.md`                                      |
| `operate`                    | [`write-an-eval-per-failure`](parts/04-operate/04-write-an-eval-per-failure/problem/README.md)              |      25 | `evals/`                                                |
| `operate`                    | [`prove-each-eval-bites`](parts/04-operate/05-prove-each-eval-bites/problem/README.md)                      |      20 | none                                                    |
| `operate`                    | [`run-the-swap-gate`](parts/04-operate/06-run-the-swap-gate/problem/README.md)                              |      20 | `gate.md`, `gate.toml`                                  |
| `operate`                    | [`refuse-a-bad-model`](parts/04-operate/07-refuse-a-bad-model/problem/README.md)                            |      25 | `gate.md`, `gate.toml`                                  |
| `operate`                    | [`run-the-incident-drill`](parts/04-operate/08-run-the-incident-drill/problem/README.md)                    |      30 | `runbook.md`                                            |
| `operate`                    | [`present-on-demo-day`](parts/04-operate/09-present-on-demo-day/problem/README.md)                          |      30 | `demo.md`                                               |
| `operate`                    | [`sample-live-runs`](parts/04-operate/10-sample-live-runs/problem/README.md)                                |      20 | `sampling.yaml`                                         |
| `operate`                    | [`judge-what-code-cannot-check`](parts/04-operate/11-judge-what-code-cannot-check/problem/README.md)        |      20 | `judge.yaml`                                            |
| `operate`                    | [`run-it-on-your-own-job`](parts/04-operate/12-run-it-on-your-own-job/problem/README.md)                    |      30 | `cases.yaml`, `evidence.md`, `hire.yaml`                |
| `run-the-agent-on-langgraph` | [`resume-with-langgraph`](parts/05-run-the-agent-on-langgraph/01-resume-with-langgraph/problem/README.md)   |      30 | none                                                    |
