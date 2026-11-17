// bun run hcp <command>: the HCP medical information pipeline's commands.
//
//   seed                  reset the database and load the synthetic world
//   check                 reseed, then run the check's rules against the solution in pipeline.toml
//                         (firewall, retrieval, delivery, identity, verification, routes,
//                         safety, audit)
//   scan <question_id>    the safety scan alone (safe to run again)
//   ask <question_id>     the safety scan, then the graph until it waits for review
//   resume <question_id>  carry on a paused question with its recorded decision
//   review <...>          the reviewer CLI: list, show, approve, sign, reject
//
// ask, resume and review run the solution named in pipeline.toml.
// Start Postgres first: docker compose -f case-studies/hcp-medinfo/compose.yml up -d --wait
import { spawnSync } from "node:child_process";
import { checkAudit } from "./lib/audit";
import { checkDelivery } from "./lib/delivery";
import { checkFirewall, type Line } from "./lib/firewall";
import { checkIdentity } from "./lib/identity";
import { checkRetrieval } from "./lib/retrieval";
import { checkRoutes } from "./lib/routes";
import { checkSafety } from "./lib/safety";
import { seed } from "./lib/seed";
import { invocation, runSolution, solutionName } from "./lib/solution";
import { checkVerification } from "./lib/verification";
import { readQuestions } from "./lib/world";

const SOLUTION_COMMANDS = ["scan", "ask", "resume", "review"];

function printLines(rule: string, lines: Line[]): boolean {
  let failed = false;
  for (const line of lines) {
    const detail = line.detail ? ` (${line.detail})` : "";
    console.log(`  ${line.result.toUpperCase().padEnd(10)} ${rule}: ${line.says}${detail}`);
    if (line.result === "fail") failed = true;
  }
  return failed;
}

// Every run starts from a fresh world, because the delivery rule asks questions and signs replies.
async function check(): Promise<number> {
  console.log(`Checking the ${solutionName()} solution. ${await seed()}`);
  const results = [
    printLines("firewall", await checkFirewall()),
    printLines("retrieval", await checkRetrieval()),
    printLines("delivery", await checkDelivery()),
    printLines("identity", await checkIdentity()),
  ];
  // Ask every question no rule has asked yet, before the verification rule withdraws a source
  // (T12). A withdrawal changes what every later search finds, so asking after it would search
  // a different library from the one the replies were recorded against.
  for (const question of readQuestions()) runSolution(["ask", question.id]);
  results.push(
    printLines("verification", await checkVerification()),
    printLines("routes", await checkRoutes()),
    printLines("safety", await checkSafety()),
    printLines("audit", await checkAudit()),
  );
  const failed = results.some(Boolean);
  console.log(failed ? "Some lines did not pass." : "Every line passes.");
  return failed ? 1 : 0;
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
  if (command === "check") return check();
  if (SOLUTION_COMMANDS.includes(command)) return passThrough([command, ...rest]);
  console.error("Usage: bun run hcp <seed | check | scan | ask | resume | review>");
  return 2;
}

process.exit(await main());
