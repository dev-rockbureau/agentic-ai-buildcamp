// One model call, by role (fast, smart or judge). The code never names a model.
//
// Replay is the default: replies come from world/replies/, so the pipeline and the check run with
// no key. The file format and the key are the repo's own (reference/src/model.ts):
// <label>--<key>.json, where key = sha256 of {"role", "system", "user"} as compact JSON, cut to 16
// characters. Both solutions share these files, so their prompts must be the same, byte for byte.
//
// LLM_PROVIDER=anthropic, openrouter or openai calls that provider through config/models.ts.
// MODEL_MODE=record calls the provider only for replies that aren't recorded yet, and saves each.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  languageModel,
  modelId,
  type Provider,
  provider,
  type Role,
} from "../../../../../config/models";
import { CASE_STUDY_DIR } from "./policy";

const REPLAY_DIR = join(CASE_STUDY_DIR, "world", "replies");
const MAX_TOKENS = 1000;

export type Usage = {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens: number;
};
export type Reply = { text: string; model: string; usage: Usage };
export type Request = { label: string; role: Role; system: string; user: string };

// The same key as reference/src/model.ts: JSON.stringify({role, system, user}).
export function replayKey(request: Request): string {
  const asked = JSON.stringify({ role: request.role, system: request.system, user: request.user });
  return createHash("sha256").update(asked).digest("hex").slice(0, 16);
}

function recordedFile(key: string): string | undefined {
  if (!existsSync(REPLAY_DIR)) return undefined;
  return readdirSync(REPLAY_DIR)
    .sort()
    .find((name) => name.endsWith(`--${key}.json`));
}

function replayed(request: Request, key: string): Reply {
  const fileName = recordedFile(key);
  if (!fileName) {
    throw new Error(
      `No recorded reply for ${request.label} (key ${key}). Record one with ` +
        "MODEL_MODE=record, a live LLM_PROVIDER and its key.",
    );
  }
  const recording = JSON.parse(readFileSync(join(REPLAY_DIR, fileName), "utf8"));
  return { text: recording.reply, model: modelId(request.role, "replay"), usage: recording.usage };
}

async function live(request: Request, chosen: Provider): Promise<Reply> {
  const { generateText } = await import("ai");
  const result = await generateText({
    model: await languageModel(request.role, chosen),
    system: request.system,
    prompt: request.user,
    maxOutputTokens: MAX_TOKENS,
  });
  const usage = {
    input_tokens: result.usage.inputTokens ?? 0,
    output_tokens: result.usage.outputTokens ?? 0,
    cache_read_input_tokens: result.usage.inputTokenDetails?.cacheReadTokens ?? 0,
  };
  return { text: result.text, model: modelId(request.role, chosen), usage };
}

function save(request: Request, key: string, reply: Reply, chosen: Provider): void {
  mkdirSync(REPLAY_DIR, { recursive: true });
  const recording = {
    label: request.label,
    role: request.role,
    reply: reply.text,
    usage: reply.usage,
    source: `recorded on ${chosen}`,
  };
  const file = join(REPLAY_DIR, `${request.label}--${key}.json`);
  writeFileSync(file, `${JSON.stringify(recording, null, 2)}\n`);
}

export async function chat(request: Request): Promise<Reply> {
  const record = process.env.MODEL_MODE === "record";
  const chosen = provider();
  const key = replayKey(request);
  if (chosen === "replay") {
    if (record) throw new Error("MODEL_MODE=record needs a live LLM_PROVIDER and its key.");
    return replayed(request, key);
  }
  if (record && recordedFile(key)) return replayed(request, key);
  const reply = await live(request, chosen);
  if (record) save(request, key, reply, chosen);
  return reply;
}
