// Every rule of the check, in the order they must run. Each run starts from a fresh world,
// because the rules ask questions, sign replies and withdraw a source.
import { checkAudit } from "./audit";
import { checkDelivery } from "./delivery";
import { checkFirewall, type Line } from "./firewall";
import { checkIdentity } from "./identity";
import { checkRetrieval } from "./retrieval";
import { checkRoutes } from "./routes";
import { checkSafety } from "./safety";
import { seed } from "./seed";
import { runSolution } from "./solution";
import { checkVerification } from "./verification";
import { readQuestions } from "./world";

export type Result = Line & { rule: string };

const label = (rule: string) => (lines: Line[]) => lines.map((line) => ({ ...line, rule }));

export async function runRules(): Promise<Result[]> {
  await seed();
  const results = [
    ...label("firewall")(await checkFirewall()),
    ...label("retrieval")(await checkRetrieval()),
    ...label("delivery")(await checkDelivery()),
    ...label("identity")(await checkIdentity()),
  ];
  // Ask every question no rule has asked yet, before the verification rule withdraws a source
  // (T12). A withdrawal changes what every later search finds, so asking after it would search
  // a different library from the one the replies were recorded against.
  for (const question of readQuestions()) runSolution(["ask", question.id]);
  return [
    ...results,
    ...label("verification")(await checkVerification()),
    ...label("routes")(await checkRoutes()),
    ...label("safety")(await checkSafety()),
    ...label("audit")(await checkAudit()),
  ];
}

// "rule: what the line says", the form the gate's expected failures are written in.
export const named = (result: Result) => `${result.rule}: ${result.says}`;
