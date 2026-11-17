// bun run hcp <command>: the HCP medical information pipeline's commands.
//
//   seed                  reset the database and load the synthetic world
//   check                 reseed, then run every rule against the solution in pipeline.toml
//                         (firewall, retrieval, delivery, identity, verification, routes,
//                         safety, audit)
//   check --wrong <name>  the same, against the solution with the planted mistake wrong/<name>
//   gate                  the check must pass on the solution and fail on every planted mistake
//   scan <question_id>    the safety scan alone (safe to run again)
//   ask <question_id>     the safety scan, then the graph until it waits for review
//   resume <question_id>  carry on a paused question with its recorded decision
//   review <...>          the reviewer CLI: list, show, approve, edit, sign, reject
//
// ask, resume and review run the solution named in pipeline.toml.
// Start Postgres first: docker compose -f case-studies/hcp-medinfo/compose.yml up -d --wait
import { spawnSync } from "node:child_process";
import { judge, readMistakes, runAgainst, runSafely } from "./lib/gate";
import type { Result } from "./lib/rules";
import { seed } from "./lib/seed";
import { invocation, solutionName } from "./lib/solution";

const SOLUTION_COMMANDS = ["scan", "ask", "resume", "review"];

function printResults(results: Result[]): boolean {
  for (const result of results) {
    const detail = result.detail ? ` (${result.detail})` : "";
    const outcome = result.result.toUpperCase().padEnd(10);
    console.log(`  ${outcome} ${result.rule}: ${result.says}${detail}`);
  }
  return results.some((result) => result.result === "fail");
}

async function check(mistake?: string): Promise<number> {
  const against = mistake ? ` with the planted mistake ${mistake}` : "";
  console.log(`Checking the ${solutionName()} solution${against}.`);
  const failed = printResults(await runAgainst(mistake));
  console.log(failed ? "Some lines did not pass." : "Every line passes.");
  return failed ? 1 : 0;
}

// The solution must pass every line. Each mistake must fail the lines its mistake.toml names.
async function gate(): Promise<number> {
  console.log(`Gate for the ${solutionName()} solution.`);
  const solutionFailures = (await runSafely()).filter((result) => result.result === "fail");
  const solutionPasses = solutionFailures.length === 0;
  const passed = solutionPasses ? "every line passes" : `${solutionFailures.length} lines fail`;
  console.log(`  ${solutionPasses ? "PASS" : "FAIL"}  solution: ${passed}`);
  let caughtAll = true;
  for (const mistake of readMistakes()) {
    const verdict = judge(mistake, await runSafely(mistake.name));
    console.log(`  ${verdict.caught ? "PASS" : "FAIL"}  ${verdict.name}: ${verdict.detail}`);
    caughtAll &&= verdict.caught;
  }
  const ok = solutionPasses && caughtAll;
  console.log(ok ? "The gate passes." : "The gate fails.");
  return ok ? 0 : 1;
}

// Hand the terminal to the solution, so the reviewer's PIN prompt stays hidden.
function passThrough(args: string[]): number {
  const { command, cwd, env } = invocation(args);
  return spawnSync(command[0], command.slice(1), { cwd, env, stdio: "inherit" }).status ?? 1;
}

async function main(): Promise<number> {
  const [command, ...rest] = process.argv.slice(2);
  if (command === "seed") {
    console.log(await seed());
    return 0;
  }
  if (command === "check") return check(rest[0] === "--wrong" ? rest[1] : undefined);
  if (command === "gate") return gate();
  if (SOLUTION_COMMANDS.includes(command)) return passThrough([command, ...rest]);
  const commands = "seed | check [--wrong <name>] | gate | scan | ask | resume | review";
  console.error(`Usage: bun run hcp <${commands}>`);
  return 2;
}

process.exit(await main());
