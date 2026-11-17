// bun run hcp <command>: the HCP medical information pipeline's commands.
//
//   seed    reset the database and load the synthetic world
//   check   run the check's rules (step 1: the firewall rule only)
//
// Start Postgres first: docker compose -f case-studies/hcp-medinfo/compose.yml up -d --wait
import { checkFirewall, type Line } from "./lib/firewall";
import { seed } from "./lib/seed";

function printLines(rule: string, lines: Line[]): boolean {
  let failed = false;
  for (const line of lines) {
    const detail = line.detail ? ` (${line.detail})` : "";
    console.log(`  ${line.result.toUpperCase().padEnd(7)} ${rule}: ${line.says}${detail}`);
    if (line.result !== "pass") failed = true;
  }
  return failed;
}

async function check(): Promise<number> {
  const failed = printLines("firewall", await checkFirewall());
  console.log(failed ? "Some lines did not pass." : "Every line passes.");
  return failed ? 1 : 0;
}

async function main(): Promise<number> {
  const command = process.argv[2];
  if (command === "seed") {
    console.log(await seed());
    return 0;
  }
  if (command === "check") return check();
  console.error("Usage: bun run hcp <seed | check>");
  return 2;
}

process.exit(await main());
