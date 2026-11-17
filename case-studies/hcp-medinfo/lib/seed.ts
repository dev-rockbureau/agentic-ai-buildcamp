// `bun run hcp seed`: reset the database and load the synthetic world.
// It runs as the database owner, because it creates the roles and the grants that limit
// everyone else.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { type DatabaseClient, withRole } from "./database";
import {
  type ApprovedDocument,
  CASE_STUDY_DIR,
  pinHash,
  readDocuments,
  readPeople,
  readQuestions,
  readReviewers,
  sectionsOf,
  worldClock,
} from "./world";

const INSERT_PERSON = `insert into shared.doctors
  (id, name, email, country, language, verified, kind)
  values ($1, $2, $3, $4, $5, $6, $7)`;
const INSERT_REVIEWER = `insert into review.reviewers (id, name, role, countries, pin_hash)
  values ($1, $2, $3, $4, $5)`;
const INSERT_QUESTION = `insert into medical.questions
  (id, requester_id, channel, received_at, text)
  values ($1, $2, $3, $4, $5)`;
const INSERT_DOCUMENT = `insert into knowledge.documents (doc_id, version, kind, title, product,
  status, countries, approved_use, language, effective_date, expiry_date, approval_ref,
  content_hash, body) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`;
const INSERT_SECTION = `insert into knowledge.chunks (chunk_id, doc_id, version, section,
  start_char, end_char, text) values ($1, $2, $3, $4, $5, $6, $7)`;

// A trap document is one a correct search must never return to most doctors: withdrawn, expired,
// or an SRD approved for a single country.
function isTrapDocument(document: ApprovedDocument, today: string): boolean {
  const expired = document.expiry_date <= today;
  const notEverywhere = document.countries.length === 1 && document.kind === "srd";
  return document.status !== "approved" || expired || notEverywhere;
}

async function loadPeople(client: DatabaseClient): Promise<number> {
  const people = readPeople();
  for (const person of people) {
    const values = [person.id, person.name, person.email, person.country, person.language];
    await client.query(INSERT_PERSON, [...values, person.verified, person.kind]);
  }
  return people.length;
}

async function loadReviewers(client: DatabaseClient): Promise<number> {
  const reviewers = readReviewers();
  for (const reviewer of reviewers) {
    const hash = pinHash(reviewer.id, reviewer.pin);
    const values = [reviewer.id, reviewer.name, reviewer.role, reviewer.countries, hash];
    await client.query(INSERT_REVIEWER, values);
  }
  return reviewers.length;
}

async function loadQuestions(client: DatabaseClient): Promise<number> {
  const questions = readQuestions();
  for (const question of questions) {
    const values = [question.id, question.requester_id, question.channel, question.received_at];
    await client.query(INSERT_QUESTION, [...values, question.text]);
  }
  return questions.length;
}

async function loadDocument(client: DatabaseClient, document: ApprovedDocument): Promise<void> {
  const identity = [document.doc_id, document.version, document.kind, document.title];
  const approval = [document.product, document.status, document.countries, document.kind];
  const dates = [document.language, document.effective_date, document.expiry_date];
  const proof = [document.approval_ref, document.content_hash, document.body];
  await client.query(INSERT_DOCUMENT, [...identity, ...approval, ...dates, ...proof]);
  for (const section of sectionsOf(document)) {
    const where = [section.chunk_id, section.doc_id, section.version, section.section];
    const content = [section.start_char, section.end_char, section.text];
    await client.query(INSERT_SECTION, [...where, ...content]);
  }
}

async function loadDocuments(client: DatabaseClient): Promise<{ total: number; traps: number }> {
  const documents = readDocuments();
  const today = worldClock();
  for (const document of documents) await loadDocument(client, document);
  const traps = documents.filter((document) => isTrapDocument(document, today)).length;
  return { total: documents.length, traps };
}

export async function seed(): Promise<string> {
  const schema = readFileSync(join(CASE_STUDY_DIR, "schema.sql"), "utf8");
  return withRole("postgres", async (client) => {
    await client.query(schema);
    await client.query("begin");
    const people = await loadPeople(client);
    const reviewers = await loadReviewers(client);
    const documents = await loadDocuments(client);
    const questions = await loadQuestions(client);
    await client.query("commit");
    const documentCount = `${documents.total} documents (${documents.traps} trap documents)`;
    const peopleCount = `${people} people, ${reviewers} reviewers`;
    return `Seeded ${peopleCount}, ${documentCount}, ${questions} questions.`;
  });
}
