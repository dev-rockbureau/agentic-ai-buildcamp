// The gate: the check must pass on the solution and fail on every planted mistake in wrong/.
// Each mistake must fail on the lines its mistake.toml names, so a mistake that breaks for an
// unrelated reason doesn't count as caught.
//
// A mistake folder holds, for each solution, only the files that differ from it:
// wrong/<mistake>/<solution>/. The gate copies the solution into .planted/, lays the mistake's
// files over it, points the check at the copy with HCP_SOLUTION_DIR, and deletes the copy after.
// The copy sits at the same depth as solution/<solution>/, so the TypeScript solution's imports of
// config/models.ts and the repo's node_modules still resolve.
import { cpSync, existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { named, type Result, runRules } from "./rules";
import { solutionName } from "./solution";
import { CASE_STUDY_DIR } from "./world";

const WRONG_DIR = join(CASE_STUDY_DIR, "wrong");
const COPIES_DIR = join(CASE_STUDY_DIR, ".planted");

export type Mistake = { name: string; says: string; fails: string[] };
export type Verdict = { name: string; caught: boolean; detail: string };

export function readMistakes(): Mistake[] {
  if (!existsSync(WRONG_DIR)) return [];
  // A mistake is a folder with a mistake.toml. Anything else, such as ruff.toml, is not one.
  return readdirSync(WRONG_DIR)
    .filter((name) => existsSync(join(WRONG_DIR, name, "mistake.toml")))
    .sort()
    .map((name) => {
      const text = readFileSync(join(WRONG_DIR, name, "mistake.toml"), "utf8");
      return { name, ...(Bun.TOML.parse(text) as { says: string; fails: string[] }) };
    });
}

// The solution with the mistake's files laid over it, in a fresh temporary folder.
export function prepareMistake(name: string): string {
  const solution = solutionName();
  const planted = join(WRONG_DIR, name, solution);
  if (!existsSync(planted)) throw new Error(`wrong/${name} has no ${solution}/ folder`);
  const copy = join(COPIES_DIR, `${name}-${solution}`);
  rmSync(copy, { recursive: true, force: true });
  const keep = (path: string) => !path.includes("__pycache__") && !path.endsWith(".venv");
  cpSync(join(CASE_STUDY_DIR, "solution", solution), copy, { recursive: true, filter: keep });
  cpSync(planted, copy, { recursive: true });
  return copy;
}

// Run every rule against the solution, or against a mistake when one is named.
export async function runAgainst(mistake?: string): Promise<Result[]> {
  delete process.env.HCP_SOLUTION_DIR;
  if (!mistake) return runRules();
  const copy = prepareMistake(mistake);
  process.env.HCP_SOLUTION_DIR = copy;
  try {
    return await runRules();
  } finally {
    rmSync(copy, { recursive: true, force: true });
    if (readdirSync(COPIES_DIR).length === 0) rmSync(COPIES_DIR, { recursive: true });
    delete process.env.HCP_SOLUTION_DIR;
  }
}

// The same, but a check that crashes becomes one failing line instead of stopping the gate.
export async function runSafely(mistake?: string): Promise<Result[]> {
  try {
    return await runAgainst(mistake);
  } catch (error) {
    const says = `the check crashed: ${(error as Error).message}`;
    return [{ rule: "check", says, result: "fail" }];
  }
}

export function judge(mistake: Mistake, results: Result[]): Verdict {
  const failed = results.filter((result) => result.result === "fail").map(named);
  const missed = mistake.fails.filter((wanted) => !failed.some((line) => line.startsWith(wanted)));
  if (missed.length > 0) {
    const detail = `these lines didn't fail: ${missed.join("; ")}`;
    return { name: mistake.name, caught: false, detail };
  }
  const others = failed.length - mistake.fails.length;
  const extra = others > 0 ? `, and ${others} more` : "";
  return { name: mistake.name, caught: true, detail: `fails ${mistake.fails.join("; ")}${extra}` };
}
