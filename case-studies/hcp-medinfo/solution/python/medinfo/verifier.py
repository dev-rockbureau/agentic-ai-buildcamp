"""The verifier: is every sentence of a reply backed by the sections it cites?

Two kinds of check, and a sentence is flagged if either finds a problem:
- The judge model says whether each sentence is supported, partly supported or unsupported, and
  quotes the words that support it.
- Code checks what the model can't be trusted to: (1) every cited section was retrieved, (2) the
  judge's quote is in a cited section word for word, (3) every number in the sentence, with its
  unit, is in a cited section.

The model's confidence is never used. It runs on every draft, and again on a reviewer's edit.
"""

import re

from medinfo import model_steps

# A number with an optional unit: "20 mg", "40%", "250 mL", "0.5 g/kg", "7 days".
NUMBER = re.compile(
    r"\d+(?:\.\d+)?"
    r"(?:\s*(?:%|mg/kg|mg|mL/min|mL|g/kg|g|kg|hours?|days?|weeks?|months?|years?)(?![A-Za-z]))?"
)


def normalized(text: str) -> str:
    """Spacing, case and curly quotes don't change what a passage says."""
    text = text.replace("’", "'").replace("“", '"').replace("”", '"')
    return re.sub(r"\s+", " ", text).strip().lower()


def numbers_in(text: str) -> list[str]:
    return [normalized(found) for found in NUMBER.findall(text)]


def missing_numbers(sentence: str, cited_text: str) -> list[str]:
    """The numbers in the sentence that no cited section contains, each with its unit."""
    source = normalized(cited_text)

    def present(number: str) -> bool:
        return re.search(rf"(?<![\d.]){re.escape(number)}(?![\d])", source) is not None

    return [number for number in numbers_in(sentence) if not present(number)]


def code_problems(sentence: dict, claim: dict, passages: dict[str, str]) -> list[str]:
    """What code finds wrong with one sentence, whatever the judge said."""
    unknown = [chunk for chunk in sentence["cites"] if chunk not in passages]
    if unknown:
        return [f"cites {', '.join(unknown)}, which wasn't retrieved"]
    cited_text = "\n".join(passages[chunk] for chunk in sentence["cites"])
    problems = [
        f'"{number}" is not in a cited section'
        for number in missing_numbers(sentence["text"], cited_text)
    ]
    quote = claim.get("quote", "")
    if claim["status"] != "unsupported" and normalized(quote) not in normalized(cited_text):
        problems.append("the judge's quote is not in a cited section")
    return problems


def judged_problems(claim: dict) -> list[str]:
    return {
        "supported": [],
        "partly_supported": ["the judge found it only partly supported"],
        "unsupported": ["the judge found it unsupported"],
    }[claim["status"]]


def verify(question_id: str, step: str, sentences: list[dict], passages: dict[str, str]) -> dict:
    """Check each sentence. passages maps each retrieved section id to its words.
    The result lists every claim, and a flag for each sentence with any problem."""
    try:
        answer = model_steps.judge(question_id, step, sentences, passages)
        claims, call, problem = answer.value["claims"], answer.call, None
    except model_steps.InvalidReplyError as error:
        claims, call, problem = None, {}, f"{error}"
    flags = []
    for number, sentence in enumerate(sentences, start=1):
        if claims is None:
            reasons = ["the judge's reply didn't validate"]
        else:
            claim = claims[number - 1]
            reasons = judged_problems(claim) + code_problems(sentence, claim, passages)
        if reasons:
            flags.append({"sentence": number, "reasons": reasons})
    return {"claims": claims, "flags": flags, "problem": problem, **call}
