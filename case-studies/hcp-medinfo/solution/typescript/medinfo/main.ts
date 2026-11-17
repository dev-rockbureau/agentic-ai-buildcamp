// bun medinfo/main.ts <command>
//
// search <question_id>                       the approved passages search returns, as JSON
// scan <question_id>                         the safety scan alone (safe to run again)
// ask <question_id>                          the safety scan, then the graph, until review
// resume <question_id>                       carry on a paused question with its recorded decision
// review list                                the items waiting for review
// review show <item_id>                      one item: question, queue, draft and citations
// review approve <item_id> --reviewer <id>   sign the draft, then resume the question
// review edit <item_id> --reviewer <id> --edit <n>:<words>   change sentence n, then sign
// review sign <item_id> --reviewer <id>      sign only; `resume` sends it later
// review reject <item_id> --reviewer <id> --reason <text>
// review set-country <item_id> --reviewer <id> --country <code>   data steward: run it again
// review close <item_id> --reviewer <id> --reason <text>          data steward: no answer is sent
//
// approve, edit and sign take --override <n>:<reason> for each sentence the verifier flags:
// signing is refused while any flag has no reason. If a cited source was withdrawn or changed,
// nothing is signed and the question is redrafted.
//
// Every review decision asks for the reviewer's PIN at a hidden prompt (or reads it from standard
// input when that isn't a terminal).
import { inTransaction } from "./database";
import { ask, resume } from "./graph";
import { search } from "./knowledge";
import { loadPolicy } from "./policy";
import { medicalView } from "./profile";
import * as review from "./review";
import { scan } from "./safety-scan";

const QUESTION = "select requester_id, text from medical.questions where id = $1";
const SIGNING = ["approve", "edit", "sign"];

type Flags = { values: Map<string, string[]>; positional: string[] };

function parseFlags(args: string[]): Flags {
  const values = new Map<string, string[]>();
  const positional: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const name = args[index].startsWith("--") ? args[index].slice(2) : undefined;
    if (!name) {
      positional.push(args[index]);
      continue;
    }
    values.set(name, [...(values.get(name) ?? []), args[index + 1] ?? ""]);
    index += 1;
  }
  return { values, positional };
}

const flag = (flags: Flags, name: string) => flags.values.get(name)?.[0];

async function searchCommand(questionId: string): Promise<string> {
  const found = await inTransaction("graph", async (client) => {
    const question = (await client.query(QUESTION, [questionId])).rows[0];
    if (!question) throw new Error(`No question with id ${questionId}`);
    const requester = await medicalView(client, question.requester_id);
    return { requester, result: await search(client, question.text, requester, loadPolicy()) };
  });
  const output = {
    question_id: questionId,
    requester: found.requester,
    status: found.result.status,
    passages: found.result.passages,
  };
  return JSON.stringify(output, null, 2);
}

async function scanCommand(questionId: string): Promise<string> {
  const scanned = await scan(questionId);
  if (scanned.alreadyScanned) return `${questionId} was already scanned. Nothing new written.`;
  if (scanned.packetId) return `Safety packet ${scanned.packetId} written.`;
  return "No configured safety term found.";
}

// The safety scan runs first and on its own, so no route through the graph can skip it.
async function askCommand(questionId: string): Promise<string> {
  return `${await scanCommand(questionId)}\n${await ask(questionId)}`;
}

async function resumeCommand(questionId: string): Promise<string> {
  return resume(questionId, await review.latestDecision(`RV-${questionId}`));
}

// Read keys one at a time without showing them, until Enter. Backspace removes one character.
async function readHidden(): Promise<string> {
  process.stdin.setRawMode(true);
  let typed = "";
  for await (const chunk of process.stdin) {
    const key = String(chunk);
    if (key === "\u0003") process.exit(130);
    if (key === "\r" || key === "\n") break;
    typed = key === "\u007f" ? typed.slice(0, -1) : typed + key;
  }
  process.stdin.setRawMode(false);
  return typed;
}

// A PIN typed at a terminal is never shown. Piped in, it is read as one line.
async function readPin(): Promise<string> {
  if (!process.stdin.isTTY) {
    for await (const line of console) return line.trim();
    return "";
  }
  process.stdout.write("PIN: ");
  const pin = await readHidden();
  process.stdout.write("\n");
  return pin;
}

// --edit and --override values: "<sentence number>:<words>".
function bySentence(values: string[] | undefined, name: string): Map<number, string> {
  const found = new Map<number, string>();
  for (const value of values ?? []) {
    const [number, ...rest] = value.split(":");
    const words = rest.join(":").trim();
    if (!/^\d+$/.test(number.trim()) || !words) {
      throw new review.RefusedError(`--${name} takes <sentence number>:<words>.`);
    }
    found.set(Number(number), words);
  }
  return found;
}

async function recordSigning(action: string, itemId: string, signer: review.Signer, flags: Flags) {
  const edits = bySentence(flags.values.get("edit"), "edit");
  if (action === "edit" && edits.size === 0) {
    throw new review.RefusedError("review edit needs at least one --edit.");
  }
  const overrides = bySentence(flags.values.get("override"), "override");
  await review.sign(itemId, signer, { edits, overrides });
  return edits.size > 0 ? "Edited and signed" : "Signed";
}

// The decisions that don't sign. Each needs one more value, and says what it did.
const OTHER_DECISIONS: Record<string, [string, string, typeof review.reject]> = {
  reject: ["reason", "Rejected", review.reject],
  "set-country": ["country", "Country set", review.setCountry],
  close: ["reason", "Closed", review.close],
};

async function recordDecision(action: string, itemId: string, signer: review.Signer, flags: Flags) {
  if (SIGNING.includes(action)) return recordSigning(action, itemId, signer, flags);
  const [needs, done, decide] = OTHER_DECISIONS[action];
  const value = flag(flags, needs);
  if (!value) throw new review.RefusedError(`review ${action} needs --${needs}.`);
  await decide(itemId, signer, value);
  return done;
}

async function decideCommand(action: string, flags: Flags): Promise<string> {
  const [itemId] = flags.positional;
  const reviewerId = flag(flags, "reviewer") ?? "";
  const signer = { reviewerId, pin: await readPin() };
  const questionId = itemId.replace(/^RV-/, "");
  let done: string;
  try {
    done = await recordDecision(action, itemId, signer, flags);
  } catch (error) {
    if (!(error instanceof review.InvalidatedError)) throw error;
    // The invalidation is recorded. Resume now, so the question is searched and redrafted.
    throw new review.RefusedError(`${error.message}\n${await resumeCommand(questionId)}`);
  }
  const said = `${done} by ${reviewerId}.`;
  if (action === "sign") return `${said} Run resume ${questionId} to send it.`;
  return `${said}\n${await resumeCommand(questionId)}`;
}

async function listCommand(): Promise<string> {
  const items = await review.waiting();
  const rows = items.map(
    (item) => `${item.id}  ${item.queue}  due ${item.due_at?.toISOString() ?? null}`,
  );
  return rows.join("\n") || "Nothing is waiting for review.";
}

const QUESTION_COMMANDS: Record<string, (questionId: string) => Promise<string>> = {
  search: searchCommand,
  scan: scanCommand,
  ask: askCommand,
  resume: resumeCommand,
};

async function run(args: string[]): Promise<string> {
  const [command, ...rest] = args;
  if (command in QUESTION_COMMANDS && rest[0]) return QUESTION_COMMANDS[command](rest[0]);
  if (command !== "review") throw new review.RefusedError("Unknown command. See medinfo/main.ts.");
  const [action, ...flagArgs] = rest;
  if (action === "list") return listCommand();
  if (action === "show") return review.show(flagArgs[0]);
  const flags = parseFlags(flagArgs);
  if (!flags.positional[0] || !flag(flags, "reviewer")) {
    throw new review.RefusedError(`review ${action} needs an item id and --reviewer.`);
  }
  return decideCommand(action, flags);
}

async function main(): Promise<number> {
  try {
    console.log(await run(process.argv.slice(2)));
  } catch (error) {
    if (!(error instanceof review.RefusedError)) throw error;
    console.error(`Refused: ${error.message}`);
    return 1;
  }
  return 0;
}

process.exit(await main());
