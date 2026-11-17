"""The pipeline's rules, read from policy.yaml. Nothing in the solution hard-codes a rule."""

import datetime
import hashlib
import os
import pathlib

import yaml

CASE_STUDY_DIR = pathlib.Path(__file__).resolve().parents[3]


def load_policy() -> dict:
    with open(CASE_STUDY_DIR / "policy.yaml", encoding="utf-8") as policy_file:
        return yaml.safe_load(policy_file)


def today(policy: dict) -> datetime.date:
    """The world's date. It stays fixed so the traps keep working; HCP_TODAY overrides it."""
    override = os.environ.get("HCP_TODAY")
    if override:
        return datetime.date.fromisoformat(override)
    return policy["clock"]


def allowed_uses(policy: dict, requester_kind: str) -> list[str]:
    """Which kinds of approved document a doctor or a rep may be answered from."""
    return policy["approved_use"][requester_kind]


def policy_version() -> str:
    """A short hash of policy.yaml, so each audit entry says which rules were in force."""
    content = (CASE_STUDY_DIR / "policy.yaml").read_bytes()
    return hashlib.sha256(content).hexdigest()[:12]
