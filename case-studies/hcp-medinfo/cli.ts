// bun run hcp <command>: the HCP medical information pipeline's commands.
//
//   seed                  reset the database and load the synthetic world
//   check                 reseed, then run the check's rules against the solution in pipeline.toml
//                         (so far: firewall, retrieval, delivery)
//   ask <question_id>     run one question until it waits for review
//   resume <question_id>  carry on a paused question with its recorded decision
//   review <...>          the reviewer CLI: list, show, approve, sign, reject
//
// ask, resume and review run the solution named in pipeline.toml.
// Start Postgres first: docker compose -f case-studies/hcp-medinfo/compose.yml up -d --wait
import { spawnSync } from "node:child_process";
import { checkDelivery } from "./lib/delivery";
import { checkFirewall, type Line } from "./lib/firewall";
import { checkRetrieval } from "./lib/retrieval";
import { seed } from "./lib/seed";
import { invocation, solutionName } from "./lib/solution";

const SOLUTION_COMMANDS = ["ask", "resume", "review"];

function printLines(rule: string, lines: Line[]): boolean {
  let failed = false;
  for (const line of lines) {
    const detail = line.detail ? ` (${line.detail})` : "";
    console.log(`  ${line.result.toUpperCase().padEnd(7)} ${rule}: ${line.says}${detail}`);
    if (line.result !== "pass") failed = true;
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
  ];
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
  console.error("Usage: bun run hcp <seed | check | ask | resume | review>");
  return 2;
}

process.exit(await main());
