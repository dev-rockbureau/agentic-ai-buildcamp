"""One model call, by role (fast, smart or judge). The code never names a model.

Replay is the default: replies come from world/replies/, so the pipeline and the check run with no
key. The file format and the key are the repo's own (reference/src/model.ts):
<label>--<key>.json, where key = sha256 of {"role", "system", "user"} as compact JSON, cut to 16
characters. A changed prompt has a new key, so a stale reply is never used by mistake.

LLM_PROVIDER=anthropic, openrouter or openai calls that provider, with the model id that
config/models.ts gives the role. MODEL_MODE=record calls the provider only for replies that
aren't recorded yet, and saves each one to world/replies/. Delete a reply to record it again.
"""

import hashlib
import json
import os
import re
import urllib.request
from dataclasses import dataclass

from medinfo.policy import CASE_STUDY_DIR

REPLAY_DIR = CASE_STUDY_DIR / "world" / "replies"
MAX_TOKENS = 1000
KEY_ENV = {
    "anthropic": "ANTHROPIC_API_KEY",
    "openrouter": "OPENROUTER_API_KEY",
    "openai": "OPENAI_API_KEY",
}
CHAT_URL = {
    "openrouter": "https://openrouter.ai/api/v1/chat/completions",
    "openai": "https://api.openai.com/v1/chat/completions",
}
# Replies in world/replies/ were recorded with this provider's ids, as config/models.ts says.
REPLAY_RECORDED_ON = "anthropic"


@dataclass(frozen=True)
class Reply:
    text: str
    model: str
    usage: dict


@dataclass(frozen=True)
class Request:
    label: str
    role: str
    system: str
    user: str


def provider() -> str:
    """replay, anthropic, openrouter or openai. MODEL_MODE=replay wins over LLM_PROVIDER."""
    if os.environ.get("MODEL_MODE") == "replay":
        return "replay"
    chosen = os.environ.get("LLM_PROVIDER", "replay").strip().lower()
    if chosen != "replay" and chosen not in KEY_ENV:
        raise RuntimeError(f'LLM_PROVIDER is "{chosen}". Set it to replay, {", ".join(KEY_ENV)}.')
    return chosen


def model_id(role: str, chosen: str) -> str:
    """The id config/models.ts gives this role on this provider."""
    recorded_on = REPLAY_RECORDED_ON if chosen == "replay" else chosen
    models_file = CASE_STUDY_DIR.parents[1] / "config" / "models.ts"
    block = re.search(rf"^\s*{recorded_on}:\s*\{{([^}}]*)\}}", models_file.read_text(), re.M)
    found = block and re.search(rf'{role}:\s*"([^"]+)"', block.group(1))
    if not found:
        raise RuntimeError(f"config/models.ts has no {role} model for {recorded_on}")
    return found.group(1)


def replay_key(request: Request) -> str:
    """The same key as reference/src/model.ts: JSON.stringify({role, system, user})."""
    asked = {"role": request.role, "system": request.system, "user": request.user}
    compact = json.dumps(asked, separators=(",", ":"), ensure_ascii=False)
    return hashlib.sha256(compact.encode("utf-8")).hexdigest()[:16]


def _replayed(request: Request, key: str) -> Reply:
    found = sorted(REPLAY_DIR.glob(f"*--{key}.json"))
    if not found:
        raise LookupError(
            f"No recorded reply for {request.label} (key {key}). Record one with "
            "MODEL_MODE=record, a live LLM_PROVIDER and its key."
        )
    recording = json.loads(found[0].read_text(encoding="utf-8"))
    return Reply(recording["reply"], model_id(request.role, "replay"), recording["usage"])


def _anthropic(request: Request, key: str, model: str) -> Reply:
    import anthropic

    reply = anthropic.Anthropic(api_key=key).messages.create(
        model=model,
        max_tokens=MAX_TOKENS,
        system=request.system,
        messages=[{"role": "user", "content": request.user}],
    )
    text = "".join(getattr(block, "text", "") for block in reply.content)
    usage = {
        "input_tokens": reply.usage.input_tokens,
        "output_tokens": reply.usage.output_tokens,
        "cache_read_input_tokens": reply.usage.cache_read_input_tokens or 0,
    }
    return Reply(text, model, usage)


def _chat_completions(request: Request, chosen: str, key: str, model: str) -> Reply:
    """OpenRouter and OpenAI both answer the same chat completions request."""
    messages = [
        {"role": "system", "content": request.system},
        {"role": "user", "content": request.user},
    ]
    body = json.dumps({"model": model, "max_tokens": MAX_TOKENS, "messages": messages}).encode()
    headers = {"content-type": "application/json", "authorization": f"Bearer {key}"}
    sent = urllib.request.Request(CHAT_URL[chosen], data=body, headers=headers)
    with urllib.request.urlopen(sent, timeout=60) as response:
        reply = json.load(response)
    usage = {
        "input_tokens": reply["usage"]["prompt_tokens"],
        "output_tokens": reply["usage"]["completion_tokens"],
        "cache_read_input_tokens": 0,
    }
    return Reply(reply["choices"][0]["message"]["content"] or "", model, usage)


def _live(request: Request, chosen: str) -> Reply:
    key = os.environ.get(KEY_ENV[chosen])
    if not key:
        raise RuntimeError(f"LLM_PROVIDER is {chosen} but {KEY_ENV[chosen]} is not set.")
    model = model_id(request.role, chosen)
    if chosen == "anthropic":
        return _anthropic(request, key, model)
    return _chat_completions(request, chosen, key, model)


def _save(request: Request, key: str, reply: Reply, chosen: str) -> None:
    REPLAY_DIR.mkdir(parents=True, exist_ok=True)
    recording = {
        "label": request.label,
        "role": request.role,
        "reply": reply.text,
        "usage": reply.usage,
        "source": f"recorded on {chosen}",
    }
    path = REPLAY_DIR / f"{request.label}--{key}.json"
    path.write_text(json.dumps(recording, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")


def chat(request: Request) -> Reply:
    record = os.environ.get("MODEL_MODE") == "record"
    chosen = provider()
    key = replay_key(request)
    if chosen == "replay":
        if record:
            raise RuntimeError("MODEL_MODE=record needs a live LLM_PROVIDER and its key.")
        return _replayed(request, key)
    if record and any(REPLAY_DIR.glob(f"*--{key}.json")):
        return _replayed(request, key)
    reply = _live(request, chosen)
    if record:
        _save(request, key, reply, chosen)
    return reply
