// Runs the solution named in pipeline.toml as a program. The check never imports its code.
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CASE_STUDY_DIR } from "./world";

type SolutionCommands = { directory: string; search: string[] };
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

function readPipeline(): { name: string; commands: SolutionCommands } {
  const text = readFileSync(join(CASE_STUDY_DIR, "pipeline.toml"), "utf8");
  const pipeline = Bun.TOML.parse(text) as PipelineFile;
  const commands = pipeline[pipeline.solution];
  if (!commands) throw new Error(`pipeline.toml has no [${pipeline.solution}] table`);
  return { name: pipeline.solution, commands };
}

export function solutionName(): string {
  return readPipeline().name;
}

// Keep uv's virtual environment out of the repo, so the standard check never walks into it.
function environment(): NodeJS.ProcessEnv {
  const venv = process.env.UV_PROJECT_ENVIRONMENT ?? join(tmpdir(), "hcp-medinfo-venv");
  // Environment variable names are UPPER_CASE, so this one is set by name, not as a property.
  const names = Object.fromEntries([["UV_PROJECT_ENVIRONMENT", venv]]);
  return { ...process.env, ...names };
}

export function runSearch(questionId: string): SearchOutput {
  const { commands } = readPipeline();
  const command = commands.search.map((part) => part.replace("{question_id}", questionId));
  const cwd = join(CASE_STUDY_DIR, commands.directory);
  const run = spawnSync(command[0], command.slice(1), {
    cwd,
    env: environment(),
    encoding: "utf8",
  });
  if (run.status !== 0) {
    throw new Error(`search ${questionId} exited with ${run.status}: ${run.stderr.trim()}`);
  }
  return JSON.parse(run.stdout) as SearchOutput;
}
