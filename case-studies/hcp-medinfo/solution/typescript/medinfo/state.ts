// What the graph carries from node to node for one question, and the line each node prints.
import { Annotation } from "@langchain/langgraph";
import type { Passage } from "./knowledge";
import type { Requester } from "./profile";
import type { Sentence } from "./signature";
import type { Verification } from "./verifier";

export type SrdMatch = { document: string | null; coverage: string };

export const RunState = Annotation.Root({
  question_id: Annotation<string>(),
  requester: Annotation<Requester>(),
  question_text: Annotation<string>(),
  questions: Annotation<string[]>(),
  topics: Annotation<string[]>(),
  search_status: Annotation<string | null>(),
  passages: Annotation<Passage[]>(),
  srd_match: Annotation<SrdMatch | null>(),
  draft: Annotation<Sentence[]>(),
  verifier: Annotation<Verification | null>(),
  model_problems: Annotation<string[]>(),
  queue: Annotation<string | null>(),
  reasons: Annotation<string[]>(),
  due_at: Annotation<string | null>(),
  decision_id: Annotation<number>(),
  decision_action: Annotation<string>(),
  acknowledged: Annotation<boolean>(),
  outcome: Annotation<string>(),
});

export type Run = typeof RunState.State;
export type Update = Partial<Run>;

// One line per node that runs, so a resume can be seen not to start over.
export const trace = (node: string) => console.log(`  node ${node}`);
