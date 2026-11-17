// The gate: the check must pass on the solution and fail on every planted mistake in wrong/.
// Each mistake must fail on the lines its mistake.toml names, so a mistake that breaks for an
// unrelated reason doesn't count as caught.
//
// A mistake folder holds only the files that differ from the solution. The gate copies the
// solution to a temporary folder outside the repo, lays the mistake's files over it, and points
// the check at the copy with HCP_SOLUTION_DIR.
import { cpSync, existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { named, type Result, runRules } from "./rules";
import { CASE_STUDY_DIR } from "./world";

const WRONG_DIR = join(CASE_STUDY_DIR, "wrong");
const SOLUTION_DIR = join(CASE_STUDY_DIR, "solution", "python");
const COPIES_DIR = join(tmpdir(), "hcp-medinfo-wrong");

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
  const copy = join(COPIES_DIR, name);
  rmSync(copy, { recursive: true, force: true });
  const keep = (path: string) => !path.includes("__pycache__") && !path.endsWith(".venv");
  cpSync(SOLUTION_DIR, copy, { recursive: true, filter: keep });
  const notToml = (path: string) => !path.endsWith("mistake.toml");
  cpSync(join(WRONG_DIR, name), copy, { recursive: true, filter: notToml });
  return copy;
}

// Run every rule against the solution, or against a mistake when one is named.
export async function runAgainst(mistake?: string): Promise<Result[]> {
  if (mistake) process.env.HCP_SOLUTION_DIR = prepareMistake(mistake);
  else delete process.env.HCP_SOLUTION_DIR;
  return runRules();
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
