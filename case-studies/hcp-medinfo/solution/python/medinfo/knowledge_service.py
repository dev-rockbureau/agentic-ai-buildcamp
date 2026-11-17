"""Search over the approved library.

The mandatory filters live in the SQL below, not in the caller. Whatever the graph or a model asks
for, this search can only return sections of documents that are approved, in date, approved for
the requester's country, and allowed for the requester's kind (a doctor or a rep).
"""

import re
from dataclasses import dataclass

import psycopg

from medinfo.policy import allowed_uses, today
from medinfo.profile_service import Requester

# Any word may match ("|"), and ts_rank_cd's normalization 32 keeps every score between 0 and 1.
SEARCH = """
with asked as (
  select replace(plainto_tsquery('english', %(terms)s)::text, ' & ', ' | ')::tsquery as terms
)
select c.chunk_id, c.doc_id, c.version, d.kind, d.product, d.content_hash, c.section, c.text,
       ts_rank_cd(c.tsv, asked.terms, 32) as score
from knowledge.chunks c
join knowledge.documents d on d.doc_id = c.doc_id and d.version = c.version
cross join asked
where d.status = 'approved'
  and d.effective_date <= %(today)s and %(today)s < d.expiry_date
  and %(country)s = any(d.countries)
  and d.approved_use = any(%(allowed_uses)s)
  and (cardinality(%(products)s::text[]) = 0 or d.product = any(%(products)s))
  and c.tsv @@ asked.terms
order by score desc, c.chunk_id
limit %(top_k)s
"""

PRODUCTS = "select distinct product from knowledge.documents order by product"

VERSION = """select doc_id, version, status, countries, approved_use, effective_date, expiry_date,
  content_hash from knowledge.documents where doc_id = %s and version = %s"""


@dataclass(frozen=True)
class Passage:
    chunk_id: str
    doc_id: str
    version: int
    kind: str
    product: str
    content_hash: str
    section: str
    text: str
    score: float


@dataclass(frozen=True)
class SearchResult:
    """status is "found", "nothing_found" (a writer is needed) or "country_unknown" (no search)."""

    status: str
    passages: list[Passage]


def named_products(connection: psycopg.Connection, question: str) -> list[str]:
    """The products the question names. Every document mentions its own product, so the name
    narrows the search but is no use for ranking."""
    products = [row["product"] for row in connection.execute(PRODUCTS).fetchall()]
    return [product for product in products if product.lower() in question.lower()]


def without_names(question: str, products: list[str]) -> str:
    for product in products:
        question = re.sub(re.escape(product), " ", question, flags=re.IGNORECASE)
    return question


def search(
    connection: psycopg.Connection, question: str, requester: Requester, policy: dict
) -> SearchResult:
    if requester.country is None:
        return SearchResult("country_unknown", [])
    products = named_products(connection, question)
    parameters = {
        "terms": without_names(question, products),
        "today": today(policy),
        "country": requester.country,
        "allowed_uses": allowed_uses(policy, requester.kind),
        "products": products,
        "top_k": policy["retrieval"]["top_k"],
    }
    rows = connection.execute(SEARCH, parameters).fetchall()
    minimum = policy["retrieval"]["min_score"]
    passages = [Passage(**row) for row in rows if row["score"] >= minimum]
    if not passages:
        return SearchResult("nothing_found", [])
    return SearchResult("found", passages)


def current_version(connection: psycopg.Connection, doc_id: str, version: int) -> dict | None:
    """One document version as it stands now, which may differ from when it was retrieved."""
    return connection.execute(VERSION, (doc_id, version)).fetchone()


def why_not_allowed(document: dict, requester: Requester, policy: dict) -> str | None:
    """The same rules as the search filters, for a version that was cited earlier."""
    key = f"{document['doc_id']}@{document['version']}"
    clock = today(policy)
    if document["status"] != "approved":
        return f"{key} is {document['status']}"
    if not document["effective_date"] <= clock < document["expiry_date"]:
        return f"{key} is not in date"
    if requester.country not in document["countries"]:
        return f"{key} is not approved in {requester.country}"
    if document["approved_use"] not in allowed_uses(policy, requester.kind):
        return f"{key} can't be used to answer a {requester.kind}"
    return None
