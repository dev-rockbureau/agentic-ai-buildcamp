// Runs the solution named in pipeline.toml as a program. The check never imports its code.
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CASE_STUDY_DIR } from "./world";

type SolutionCommands = { directory: string; command: string[] };
type PipelineFile = { solution: string } & Record<string, SolutionCommands>;

export type SearchedPassage = {
  chunk_id: string;
  doc_id: string;
  version: number;
  kind: string;
  content_hash: string;
  score: number;
};

export type SearchOutput = {
  question_id: string;
  requester: { kind: "doctor" | "rep"; country: string | null };
  status: "found" | "nothing_found" | "country_unknown";
  passages: SearchedPassage[];
};

export type Ran = { status: number | null; stdout: string; stderr: string };

function readPipeline(): { name: string; commands: SolutionCommands } {
  const text = readFileSync(join(CASE_STUDY_DIR, "pipeline.toml"), "utf8");
  const pipeline = Bun.TOML.parse(text) as PipelineFile;
  const name = process.env.HCP_SOLUTION ?? pipeline.solution;
  const commands = pipeline[name];
  if (!commands) throw new Error(`pipeline.toml has no [${name}] table`);
  return { name, commands };
}

// Every solution pipeline.toml describes: each table with a command.
export function solutionNames(): string[] {
  const text = readFileSync(join(CASE_STUDY_DIR, "pipeline.toml"), "utf8");
  const pipeline = Bun.TOML.parse(text) as Record<string, unknown>;
  return Object.keys(pipeline).filter((key) => typeof pipeline[key] === "object");
}

export function solutionName(): string {
  return readPipeline().name;
}

// Keep uv's virtual environment out of the repo, so the standard check never walks into it.
function environment(): NodeJS.ProcessEnv {
  const venv = process.env.UV_PROJECT_ENVIRONMENT ?? join(tmpdir(), "hcp-medinfo-venv");
  // Environment variable names are UPPER_CASE, so this one is set by name, not as a property.
  const names = Object.fromEntries([
    ["UV_PROJECT_ENVIRONMENT", venv],
    ["HCP_CASE_STUDY_DIR", CASE_STUDY_DIR],
  ]);
  return { ...process.env, ...names };
}

// The full command line, the folder to run it in, and its environment.
export function invocation(args: string[]) {
  const { commands } = readPipeline();
  // HCP_SOLUTION_DIR runs a copy instead, such as the solution with a planted mistake.
  const cwd = process.env.HCP_SOLUTION_DIR ?? join(CASE_STUDY_DIR, commands.directory);
  return { command: [...commands.command, ...args], cwd, env: environment() };
}

// No single solution command should take this long. One that does is stopped and counts as
// failed, so a hung solution fails its lines instead of stopping the whole check.
const COMMAND_LIMIT_MS = 120_000;

// Run the solution to the end. `input` is written to its standard input, such as a PIN.
export function runSolution(args: string[], input = ""): Ran {
  const { command, cwd, env } = invocation(args);
  const options = { cwd, env, input, encoding: "utf8" as const, timeout: COMMAND_LIMIT_MS };
  const run = spawnSync(command[0], command.slice(1), options);
  return { status: run.status, stdout: run.stdout, stderr: run.stderr };
}

// Start the solution without waiting, so the check can kill it part way through.
export function startSolution(args: string[]) {
  const { command, cwd, env } = invocation(args);
  return Bun.spawn(command, { cwd, env, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
}

export function runSearch(questionId: string): SearchOutput {
  const run = runSolution(["search", questionId]);
  if (run.status !== 0) {
    throw new Error(`search ${questionId} exited with ${run.status}: ${run.stderr.trim()}`);
  }
  return JSON.parse(run.stdout) as SearchOutput;
}
