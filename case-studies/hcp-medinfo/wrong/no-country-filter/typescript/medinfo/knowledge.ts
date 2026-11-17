// Search over the approved library.
// The mandatory filters live in the SQL below, not in the caller. Whatever the graph or a model
// asks for, this search can only return sections of documents that are approved, in date,
// approved for the requester's country, and allowed for the requester's kind (a doctor or a rep).
import { type Client, firstRow } from "./database";
import { allowedUses, type Policy, today } from "./policy";
import type { Requester } from "./profile";

// Any word may match ("|"), and ts_rank_cd's normalization 32 keeps every score between 0 and 1.
const SEARCH = `with asked as (
  select replace(plainto_tsquery('english', $1)::text, ' & ', ' | ')::tsquery as terms
)
select c.chunk_id, c.doc_id, c.version, d.kind, d.product, d.content_hash, c.section, c.text,
       ts_rank_cd(c.tsv, asked.terms, 32) as score
from knowledge.chunks c
join knowledge.documents d on d.doc_id = c.doc_id and d.version = c.version
cross join asked
where d.status = 'approved'
  and d.effective_date <= $2::date and $2::date < d.expiry_date
  and $3::text = $3::text
  and d.approved_use = any($4)
  and (cardinality($5::text[]) = 0 or d.product = any($5))
  and c.tsv @@ asked.terms
order by score desc, c.chunk_id
limit $6`;
const PRODUCTS = "select distinct product from knowledge.documents order by product";
// Dates as text, YYYY-MM-DD, so they compare with the world's date as strings.
const VERSION = `select doc_id, version, status, countries, approved_use,
  effective_date::text as effective_date, expiry_date::text as expiry_date, content_hash
  from knowledge.documents where doc_id = $1 and version = $2`;

export type Passage = {
  chunk_id: string;
  doc_id: string;
  version: number;
  kind: string;
  product: string;
  content_hash: string;
  section: string;
  text: string;
  score: number;
};

export type Stored = {
  doc_id: string;
  version: number;
  status: string;
  countries: string[];
  approved_use: string;
  effective_date: string;
  expiry_date: string;
  content_hash: string;
};

// status is "found", "nothing_found" (a writer is needed) or "country_unknown" (no search).
export type SearchResult = { status: string; passages: Passage[] };

const literal = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// The products the question names. Every document mentions its own product, so the name
// narrows the search but is no use for ranking.
async function namedProducts(client: Client, question: string): Promise<string[]> {
  const rows = (await client.query(PRODUCTS)).rows as { product: string }[];
  const products = rows.map((row) => row.product);
  const asked = question.toLowerCase();
  return products.filter((product) => asked.includes(product.toLowerCase()));
}

function withoutNames(question: string, products: string[]): string {
  return products.reduce(
    (text, product) => text.replace(new RegExp(literal(product), "gi"), " "),
    question,
  );
}

export async function search(
  client: Client,
  question: string,
  requester: Requester,
  policy: Policy,
): Promise<SearchResult> {
  if (requester.country === null) return { status: "country_unknown", passages: [] };
  const products = await namedProducts(client, question);
  const filters = [today(policy), requester.country, allowedUses(policy, requester.kind)];
  const values = [withoutNames(question, products), ...filters, products, policy.retrieval.top_k];
  const rows = (await client.query(SEARCH, values)).rows as Passage[];
  const passages = rows.filter((row) => row.score >= policy.retrieval.min_score);
  return { status: passages.length > 0 ? "found" : "nothing_found", passages };
}

// One document version as it stands now, which may differ from when it was retrieved.
export function currentVersion(client: Client, docId: string, version: number) {
  return firstRow<Stored>(client, VERSION, [docId, version]);
}

// The same rules as the search filters, for a version that was cited earlier.
export function whyNotAllowed(document: Stored, requester: Requester, policy: Policy) {
  const key = `${document.doc_id}@${document.version}`;
  const clock = today(policy);
  if (document.status !== "approved") return `${key} is ${document.status}`;
  if (!(document.effective_date <= clock && clock < document.expiry_date)) {
    return `${key} is not in date`;
  }
  if (!document.countries.includes(requester.country ?? "")) {
    return `${key} is not approved in ${requester.country}`;
  }
  if (!allowedUses(policy, requester.kind).includes(document.approved_use)) {
    return `${key} can't be used to answer a ${requester.kind}`;
  }
  return undefined;
}
