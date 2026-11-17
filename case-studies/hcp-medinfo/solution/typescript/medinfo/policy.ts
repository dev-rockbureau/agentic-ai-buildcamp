// The pipeline's rules, read from policy.yaml. Nothing in the solution hard-codes a rule.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// The case study folder, with policy.yaml and world/. The check sets HCP_CASE_STUDY_DIR when it
// runs a copy of the solution from somewhere else, such as a planted mistake in a temporary folder.
export const CASE_STUDY_DIR =
  process.env.HCP_CASE_STUDY_DIR ?? join(import.meta.dir, "..", "..", "..");

type Queue = { role: string; due_minutes: number | null };

export type Policy = {
  countries: string[];
  clock: string | Date;
  topics: {
    escalate_with_draft: string[];
    human_only: string[];
    rules: Record<string, string[]>;
  };
  safety_terms: string[];
  approved_use: Record<string, string[]>;
  retrieval: { min_score: number; top_k: number };
  queues: Record<string, Queue>;
};

const policyText = () => readFileSync(join(CASE_STUDY_DIR, "policy.yaml"), "utf8");

export function loadPolicy(): Policy {
  return Bun.YAML.parse(policyText()) as Policy;
}

// The world's date, YYYY-MM-DD. It stays fixed so the traps keep working; HCP_TODAY overrides it.
export function today(policy: Policy): string {
  const clock = policy.clock instanceof Date ? policy.clock.toISOString() : String(policy.clock);
  return (process.env.HCP_TODAY ?? clock).slice(0, 10);
}

// Which kinds of approved document a doctor or a rep may be answered from.
export function allowedUses(policy: Policy, requesterKind: string): string[] {
  return policy.approved_use[requesterKind];
}

// A short hash of policy.yaml, so each audit entry says which rules were in force.
export function policyVersion(): string {
  const content = readFileSync(join(CASE_STUDY_DIR, "policy.yaml"));
  return createHash("sha256").update(content).digest("hex").slice(0, 12);
}
