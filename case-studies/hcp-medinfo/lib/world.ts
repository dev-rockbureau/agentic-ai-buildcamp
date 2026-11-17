// Reads the synthetic world from world/ and turns each document into searchable sections.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

export const CASE_STUDY_DIR = join(import.meta.dir, "..");
const WORLD_DIR = join(CASE_STUDY_DIR, "world");

export type Person = {
  id: string;
  name: string;
  email: string;
  country: string | null;
  language: string;
  verified: boolean;
  kind: "doctor" | "rep";
};

export type Reviewer = {
  id: string;
  name: string;
  role: "specialist" | "senior_reviewer" | "writer" | "data_steward";
  countries: string[];
  pin: string;
};

export type DocumentMeta = {
  doc_id: string;
  version: number;
  kind: "prescribing_information" | "srd";
  title: string;
  product: string;
  status: "approved" | "withdrawn" | "superseded";
  countries: string[];
  language: string;
  effective_date: string;
  expiry_date: string;
  approval_ref: string;
};

export type ApprovedDocument = DocumentMeta & { body: string; content_hash: string };

export type Question = {
  id: string;
  requester_id: string;
  channel: string;
  received_at: string;
  text: string;
};

export type Section = {
  chunk_id: string;
  doc_id: string;
  version: number;
  section: string;
  start_char: number;
  end_char: number;
  text: string;
};

function readJson<Shape>(fileName: string): Shape {
  return JSON.parse(readFileSync(join(WORLD_DIR, fileName), "utf8")) as Shape;
}

export function readPolicy(): Record<string, unknown> {
  const text = readFileSync(join(CASE_STUDY_DIR, "policy.yaml"), "utf8");
  return Bun.YAML.parse(text) as Record<string, unknown>;
}

// The world's "today" as YYYY-MM-DD. It stays fixed so the traps keep working; HCP_TODAY overrides.
export function worldClock(): string {
  const clock = readPolicy().clock;
  const written = clock instanceof Date ? clock.toISOString() : String(clock);
  return (process.env.HCP_TODAY ?? written).slice(0, 10);
}

export function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

export function readPeople(): Person[] {
  return readJson<Person[]>("doctors.json");
}

export function readReviewers(): Reviewer[] {
  return readJson<Reviewer[]>("reviewers.json");
}

export function readQuestions(): Question[] {
  return readJson<Question[]>("questions.json");
}

// Each version's body lives in world/fixtures/<doc_id>@<version>.md. The folder is named fixtures
// because these are test data written like real labeling, not learner pages, so the
// plain-English check skips them.
export function readDocuments(): ApprovedDocument[] {
  const metas = readJson<DocumentMeta[]>("documents.json");
  return metas.map((meta) => {
    const fileName = `${meta.doc_id}@${meta.version}.md`;
    const body = readFileSync(join(WORLD_DIR, "fixtures", fileName), "utf8");
    return { ...meta, body, content_hash: sha256(body) };
  });
}

// A stand-in for re-authentication, not real credential storage: the PINs are synthetic.
export function pinHash(reviewerId: string, pin: string): string {
  return sha256(`hcp-medinfo:${reviewerId}:${pin}`);
}

// Split a document by its "## " headings, so a citation points to one section of one version.
// Each section keeps its character offsets in the body, so a quote can be found again exactly.
export function sectionsOf(document: ApprovedDocument): Section[] {
  const headings = [...document.body.matchAll(/^## (.+)$/gm)];
  return headings.map((heading, index) => {
    const headingEnd = (heading.index ?? 0) + heading[0].length;
    const nextHeading = headings[index + 1]?.index ?? document.body.length;
    const raw = document.body.slice(headingEnd, nextHeading);
    const leading = raw.length - raw.trimStart().length;
    const text = raw.trim();
    const startChar = headingEnd + leading;
    return {
      chunk_id: `${document.doc_id}@${document.version}#${index + 1}`,
      doc_id: document.doc_id,
      version: document.version,
      section: heading[1].trim(),
      start_char: startChar,
      end_char: startChar + text.length,
      text,
    };
  });
}
