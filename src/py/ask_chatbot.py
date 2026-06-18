"""EduCloud course chatbot Lambda.

Backs the AppSync ``askCourseChatbot`` resolver and a few sibling fields
(``demystifyJargon``, ``getContentDemandTelemetry``, ``getChatEvaluations``).

Responsibilities
----------------
* Answer student questions grounded in two sources, in priority order:
    1. Platform course content retrieved from the S3 Vectors index (RAG).
    2. Live official cloud-provider documentation fetched via Tavily.
* Run a conversational onboarding flow that produces a personalised study plan.
* Build curricula that combine platform courses with *gaps the platform should
  fill* — never courses hosted on other learning platforms.
* Persist every user prompt to an immutable audit table.

The module is organised into clearly delimited sections; the Lambda entry point
is :func:`handler`, which dispatches on the AppSync field name.
"""

from __future__ import annotations

import hashlib
import json
import logging
import os
import random
import re
import time
import urllib.error
import urllib.request
import uuid
from datetime import datetime, timedelta, timezone
from typing import Any, Callable, Optional, TypeVar

import boto3
from boto3.dynamodb.types import TypeDeserializer

# ─────────────────────────────────────────────────────────────────────────────
# Logging
# ─────────────────────────────────────────────────────────────────────────────

logger = logging.getLogger()
logger.setLevel(logging.INFO)


# ─────────────────────────────────────────────────────────────────────────────
# Configuration & constants
# ─────────────────────────────────────────────────────────────────────────────

AWS_REGION = os.environ.get("AWS_REGION", "us-east-1")

# Media bucket — student diagrams uploaded for architecture review (PNG/JPG).
MEDIA_BUCKET_NAME = os.environ.get("MEDIA_BUCKET_NAME")

# DynamoDB tables
COURSES_TABLE_NAME = os.environ.get("COURSES_TABLE_NAME")
CHAT_SESSIONS_TABLE_NAME = os.environ.get("CHAT_SESSIONS_TABLE_NAME")
CONTENT_DEMAND_TELEMETRY_TABLE_NAME = os.environ.get("CONTENT_DEMAND_TELEMETRY_TABLE_NAME")
CHAT_EVALUATIONS_TABLE_NAME = os.environ.get(
    "CHAT_EVALUATIONS_TABLE_NAME", "730335533756-us-east-1-chat-evaluations-table"
)
PROMPT_AUDIT_TABLE_NAME = os.environ.get("PROMPT_AUDIT_TABLE_NAME")

# S3 Vectors index
VECTOR_BUCKET_NAME = os.environ.get("VECTOR_BUCKET_NAME")
VECTOR_INDEX_NAME = os.environ.get("VECTOR_INDEX_NAME")

# Bedrock guardrail
TUTOR_GUARDRAIL_ID = os.environ.get("TUTOR_GUARDRAIL_ID")
TUTOR_GUARDRAIL_VERSION = os.environ.get("TUTOR_GUARDRAIL_VERSION")

# AppSync streaming mutation
APPSYNC_ENDPOINT = os.environ.get("APPSYNC_ENDPOINT")
APPSYNC_API_KEY = os.environ.get("APPSYNC_API_KEY")

# Tavily live documentation search
TAVILY_API_KEY = os.environ.get("TAVILY_API_KEY", "")
TAVILY_SECRET_ID = os.environ.get("TAVILY_SECRET_NAME", "educloud/tavily-api-key")

# Bedrock models
MODEL_FAST = "amazon.nova-lite-v1:0"
MODEL_PRO = "amazon.nova-pro-v1:0"
# Architecture-review intent uses Claude Sonnet via the US cross-region inference
# profile. Claude's vision substantially outperforms Nova Pro on diagram reading —
# correctly counting nodes/arrows and identifying which services are drawn. The
# rest of the chatbot stays on Nova for cost.
MODEL_VISION = "us.anthropic.claude-sonnet-4-6"
EMBED_MODEL = "amazon.titan-embed-text-v2:0"
EMBED_DIMENSIONS = 1024

# Behavioural tuning
DAILY_TOKEN_LIMIT = 5_000_000
RAG_TOP_K = 5
SEMANTIC_CACHE_DISTANCE = 0.05          # max distance to treat as a cache hit
EXTERNAL_DEMAND_DISTANCE = 0.65         # above this, log unmet content demand
CHAT_HISTORY_WINDOW = 6                 # turns of context for normal chat
ONBOARDING_HISTORY_WINDOW = 8           # turns of context during onboarding
STREAM_FLUSH_CHARS = 40                 # buffer size before flushing a chunk
TAVILY_TIMEOUT_SECONDS = 20
APPSYNC_TIMEOUT_SECONDS = 5
AUDIT_RETENTION_DAYS = 365

# Single source of truth for the "out of scope" reply.
BLOCKED_MESSAGE = (
    "I am an educational tutor and can only assist with course-related, "
    "cloud development, and educational questions."
)

# Official documentation domains Tavily is allowed to draw from. Restricting the
# search keeps answers grounded in first-party cloud docs rather than arbitrary
# blogs or competing course platforms.
ALLOWED_DOC_DOMAINS = [
    "docs.aws.amazon.com",
    "learn.microsoft.com",
    "cloud.google.com",
    "kubernetes.io",
    "developer.hashicorp.com",
    "docs.docker.com",
    "aws.amazon.com",
    "azure.microsoft.com",
]

# Intent keyword sets.
ASSESSMENT_KEYWORDS = (
    "learning path", "where to start", "where should i start", "start learning",
    "diagnostic", "evaluation", "assessment", "quiz me", "which course", "how to start",
    "roadmap", "study plan", "curriculum", "what should i learn", "how do i become",
    "career path", "skills i need", "which courses", "course recommendation",
    # Open-ended learning-goal expressions — these signal the student wants a
    # tailored path rather than a one-off answer, so kick off onboarding.
    "want to learn", "would like to learn", "wanna learn",
    "want to become", "want to be a ", "want to be an ",
    "teach me about", "help me learn", "interested in learning",
    "i'm interested in", "looking to learn",
)
ONBOARDING_INTRO_SIGNALS = (
    "i've gained", "i have gained", "i've been", "i have been", "i've worked",
    "i have experience", "i've learned", "my background", "i'm currently", "i am currently",
    "i've taken", "i have taken", "i tried", "i'm exploring", "i am exploring",
    "i reached out", "i would really appreciate", "your guidance", "your platform",
    "help me figure", "not sure where", "don't know where", "identify the",
    "which specialization", "right path", "right roadmap", "solid career",
    "build a career", "get into", "break into",
)
PLAN_READY_KEYWORDS = (
    "study plan", "learning path", "roadmap", "curriculum", "generate",
    "create a plan", "let's start", "give me a plan", "ready", "proceed",
)
COMPLEX_QUERY_KEYWORDS = (
    "excalidraw", "architecture diagram", "system design", "system architecture",
    "design dynamic", "design system", "draw", "visualize",
)
RESET_COMMANDS = frozenset({"reset", "restart", "exit", "quit"})

# Pure greetings / small-talk that should be answered with a short welcome
# pointing the student at the platform's capabilities rather than triggering RAG.
SMALL_TALK_PATTERN = re.compile(
    r"^\s*(?:"
    r"hi+|hello+|hey+|yo+|sup+|hiya|howdy|"
    r"good\s+(?:morning|afternoon|evening|day|night)|"
    r"how\s+(?:are|r)\s+(?:you|u|ya)(?:\s+doing)?|"
    r"how'?s\s+it\s+going|"
    r"what'?s\s+up|whats?\s+up|"
    r"thanks(?:\s+a\s+lot)?|thank\s+you|ty|thx|"
    r"bye|goodbye|cya|see\s+(?:you|ya)(?:\s+later)?|"
    r"ok(?:ay)?|cool|nice"
    r")[\s!.?,]*$",
    re.IGNORECASE,
)

WELCOME_REPLY = (
    "Hi there! 👋 I'm your EduCloud Academy tutor. Here's how I can help:\n\n"
    "- **Answer questions** about any course in our library, or about cloud, AI, "
    "and software development topics — grounded in our course content and official docs.\n"
    "- **Build a personalized learning path** for you. Just share your background and "
    "career goal and I'll draw up a study plan from our course catalog.\n\n"
    "What would you like to do?"
)

# Local guardrail keyword sets (cheap pre-filter ahead of the Bedrock guardrail).
POLITICS_KEYWORDS = (
    "politics", "election", "democrat", "republican", "trump", "biden", "government policies",
)
FINANCIAL_PHRASES = (
    "buy stocks", "sell stocks", "stock tips", "stock picks",
    "buy bitcoin", "sell bitcoin", "buy crypto", "sell crypto",
    "financial advice", "financial recommendation",
    "investment advice", "invest in stocks", "invest in crypto",
    "crypto trading", "forex trading", "day trading",
)
INJECTION_PATTERNS = (
    "ignore previous instructions",
    "ignore all previous instructions",
    "system prompt",
    "write me a python script to scrape",
    "bypass guardrail",
)


# ─────────────────────────────────────────────────────────────────────────────
# AWS clients
# ─────────────────────────────────────────────────────────────────────────────

bedrock_runtime_client = boto3.client("bedrock-runtime", region_name=AWS_REGION)
dynamodb_client = boto3.client("dynamodb", region_name=AWS_REGION)
s3_vectors_client = boto3.client("s3vectors")
s3_client = boto3.client("s3", region_name=AWS_REGION)
_deserializer = TypeDeserializer()

# Lazily-initialised secrets client + cached Tavily key (warm-Lambda reuse).
_secrets_client = None
_tavily_key_cache: Optional[str] = None

T = TypeVar("T")


# ─────────────────────────────────────────────────────────────────────────────
# Generic retry helper
# ─────────────────────────────────────────────────────────────────────────────

_RETRYABLE_MARKERS = ("Throttling", "LimitExceeded", "ProvisionedThroughputExceeded", "500")


def execute_with_retry(
    func: Callable[[], T],
    max_retries: int = 5,
    initial_backoff: float = 1.0,
) -> T:
    """Run ``func`` with exponential backoff + jitter on transient AWS errors.

    Non-retryable errors are re-raised immediately. The final attempt always
    propagates its exception.
    """
    for attempt in range(max_retries):
        try:
            return func()
        except Exception as exc:  # noqa: BLE001 - we classify, then re-raise
            error_name = type(exc).__name__
            retryable = any(marker in error_name or marker in str(exc) for marker in _RETRYABLE_MARKERS)
            if not retryable or attempt == max_retries - 1:
                logger.error("Call failed (non-retryable or final attempt): %s", exc)
                raise
            sleep_time = random.uniform(0, initial_backoff * (2 ** attempt))
            logger.warning("Transient error %s; retrying in %.2fs", error_name, sleep_time)
            time.sleep(sleep_time)
    # Unreachable: the loop either returns or raises.
    raise RuntimeError("execute_with_retry exhausted without returning")


# ─────────────────────────────────────────────────────────────────────────────
# AppSync streaming
# ─────────────────────────────────────────────────────────────────────────────

_PUBLISH_CHUNK_MUTATION = """
mutation PublishChatbotChunk($sessionId: String!, $chunk: String!, $isComplete: Boolean!, $sequence: Int!) {
  publishChatbotChunk(sessionId: $sessionId, chunk: $chunk, isComplete: $isComplete, sequence: $sequence) {
    sessionId
    chunk
    isComplete
    sequence
  }
}
"""


def publish_chunk(session_id: str, chunk: str, sequence: int, is_complete: bool = False) -> None:
    """Push a streaming chunk to subscribed clients via the AppSync mutation.

    Best-effort: failures are logged but never interrupt answer generation.
    """
    if not APPSYNC_ENDPOINT or not APPSYNC_API_KEY:
        logger.warning("AppSync endpoint/key not configured; skipping stream chunk.")
        return

    payload = json.dumps({
        "query": _PUBLISH_CHUNK_MUTATION,
        "variables": {
            "sessionId": session_id,
            "chunk": chunk,
            "isComplete": is_complete,
            "sequence": sequence,
        },
    }).encode("utf-8")

    request = urllib.request.Request(
        APPSYNC_ENDPOINT,
        data=payload,
        headers={"Content-Type": "application/json", "x-api-key": APPSYNC_API_KEY},
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=APPSYNC_TIMEOUT_SECONDS) as response:
            response.read()
    except (urllib.error.URLError, TimeoutError) as exc:
        logger.error("Failed to publish chunk to AppSync: %s", exc)


# ─────────────────────────────────────────────────────────────────────────────
# DynamoDB helpers
# ─────────────────────────────────────────────────────────────────────────────

def deserialize_item(item: dict[str, Any]) -> dict[str, Any]:
    """Convert a DynamoDB low-level item into plain Python types."""
    return {key: _deserializer.deserialize(value) for key, value in item.items()}


def _maybe_load_json(value: Any) -> Any:
    """Parse a JSON string into Python types, returning it unchanged on failure."""
    if isinstance(value, str):
        try:
            return json.loads(value)
        except (ValueError, TypeError):
            return value
    return value


def get_session(session_id: str) -> Optional[dict[str, Any]]:
    """Load a chat session, decoding the JSON-encoded ``answers``/``chatHistory``."""
    if not CHAT_SESSIONS_TABLE_NAME:
        return None
    try:
        response = dynamodb_client.get_item(
            Key={"sessionId": {"S": session_id}},
            TableName=CHAT_SESSIONS_TABLE_NAME,
        )
    except Exception as exc:  # noqa: BLE001 - resilience: never fail the request on a read
        logger.error("Error getting session %s: %s", session_id, exc)
        return None

    if "Item" not in response:
        return None

    item = deserialize_item(response["Item"])
    item["answers"] = _maybe_load_json(item.get("answers")) if "answers" in item else item.get("answers")
    if "chatHistory" in item:
        item["chatHistory"] = _maybe_load_json(item["chatHistory"])
    return item


def save_session(session_id: str, data: dict[str, Any]) -> None:
    """Persist a chat session. Lists/dicts are stored as JSON strings."""
    if not CHAT_SESSIONS_TABLE_NAME:
        return
    item: dict[str, Any] = {"sessionId": {"S": session_id}}
    for key, value in data.items():
        if key == "sessionId":
            continue
        if isinstance(value, bool):
            item[key] = {"BOOL": value}
        elif isinstance(value, str):
            item[key] = {"S": value}
        elif isinstance(value, (int, float)):
            item[key] = {"N": str(value)}
        elif isinstance(value, (list, dict)):
            item[key] = {"S": json.dumps(value)}
    try:
        dynamodb_client.put_item(TableName=CHAT_SESSIONS_TABLE_NAME, Item=item)
    except Exception as exc:  # noqa: BLE001 - resilience
        logger.error("Error saving session %s: %s", session_id, exc)


def record_prompt_audit(
    session_id: str,
    message: str,
    *,
    field_name: str,
    course_id: Optional[str] = None,
) -> None:
    """Append an immutable audit record for a single user prompt.

    Fire-and-forget: auditing must never block or fail the user-facing response.
    Records are keyed by ``sessionId`` + an ISO-8601 ``timestamp`` and expire via
    the table's TTL attribute after :data:`AUDIT_RETENTION_DAYS`.
    """
    if not PROMPT_AUDIT_TABLE_NAME:
        logger.warning("PROMPT_AUDIT_TABLE_NAME not configured; skipping prompt audit.")
        return

    now = datetime.now(timezone.utc)
    item = {
        "sessionId": {"S": session_id},
        "timestamp": {"S": now.isoformat()},
        "auditId": {"S": uuid.uuid4().hex},
        "fieldName": {"S": field_name},
        "message": {"S": message},
        "ttl": {"N": str(int((now + timedelta(days=AUDIT_RETENTION_DAYS)).timestamp()))},
    }
    if course_id:
        item["courseId"] = {"S": course_id}
    try:
        dynamodb_client.put_item(TableName=PROMPT_AUDIT_TABLE_NAME, Item=item)
    except Exception as exc:  # noqa: BLE001 - auditing is best-effort
        logger.error("Failed to write prompt audit for session %s: %s", session_id, exc)


def log_content_demand(session_id: str, message: str, detected_topic: str = "external") -> None:
    """Record a signal that a student wanted content the platform doesn't cover.

    These rows tell platform admins which new courses to build.
    """
    if not CONTENT_DEMAND_TELEMETRY_TABLE_NAME:
        return
    try:
        dynamodb_client.put_item(
            TableName=CONTENT_DEMAND_TELEMETRY_TABLE_NAME,
            Item={
                "requestId": {"S": f"telemetry-{session_id}-{int(time.time())}"},
                "prompt": {"S": message},
                "timestamp": {"S": str(time.time())},
                "detectedTopic": {"S": detected_topic},
            },
        )
    except Exception as exc:  # noqa: BLE001 - telemetry is best-effort
        logger.error("Failed to log content demand telemetry: %s", exc)


# ─────────────────────────────────────────────────────────────────────────────
# Live documentation search — direct Tavily API
# ─────────────────────────────────────────────────────────────────────────────

def _get_tavily_key() -> str:
    """Return the Tavily API key from env (fast path) or Secrets Manager (cold start)."""
    global _secrets_client, _tavily_key_cache
    if TAVILY_API_KEY:
        return TAVILY_API_KEY
    if _tavily_key_cache:
        return _tavily_key_cache
    if _secrets_client is None:
        _secrets_client = boto3.client("secretsmanager", region_name=AWS_REGION)
    response = _secrets_client.get_secret_value(SecretId=TAVILY_SECRET_ID)
    _tavily_key_cache = response["SecretString"].strip()
    return _tavily_key_cache


def fetch_live_docs(query: str, max_results: int = 5) -> str:
    """Fetch live official cloud documentation for ``query`` via Tavily.

    Returns a formatted markdown digest, or an empty string on any failure so the
    caller falls back to model knowledge + RAG instead of crashing.
    """
    try:
        api_key = _get_tavily_key()
    except Exception as exc:  # noqa: BLE001 - missing key must not break the chat
        logger.warning("Could not load Tavily API key: %s. Skipping live search.", exc)
        return ""

    payload = json.dumps({
        "api_key": api_key,
        "query": query,
        "search_depth": "advanced",
        "include_answer": True,
        "include_raw_content": False,
        "max_results": max_results,
        "include_domains": ALLOWED_DOC_DOMAINS,
    }).encode("utf-8")

    request = urllib.request.Request(
        "https://api.tavily.com/search",
        data=payload,
        headers={"Content-Type": "application/json"},
        method="POST",
    )

    try:
        with urllib.request.urlopen(request, timeout=TAVILY_TIMEOUT_SECONDS) as response:
            result = json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        body = exc.read().decode("utf-8")[:300] if exc.fp else ""
        logger.warning("Tavily HTTP error %s: %s. Continuing without live docs.", exc.code, body)
        return ""
    except Exception as exc:  # noqa: BLE001 - degrade gracefully
        logger.warning("Tavily request failed: %s. Continuing without live docs.", exc)
        return ""

    parts: list[str] = []
    if result.get("answer"):
        parts.append(f"**Summary**: {result['answer']}\n")
    for entry in result.get("results", [])[:max_results]:
        content = (entry.get("content") or "").strip()
        if content:
            parts.append(f"**{entry.get('title', '')}**\nSource: {entry.get('url', '')}\n{content[:600]}\n")

    digest = "\n---\n".join(parts)
    if digest:
        logger.info("Tavily returned %d chars of live docs.", len(digest))
    return digest


# ─────────────────────────────────────────────────────────────────────────────
# Local guardrail (cheap pre-filter)
# ─────────────────────────────────────────────────────────────────────────────

def local_guardrail_check(message: str) -> Optional[str]:
    """Return :data:`BLOCKED_MESSAGE` if ``message`` is clearly out of scope, else ``None``.

    Politics and prompt-injection use word-boundary / phrase matching; financial
    matching uses multi-word phrases only, to avoid false positives on innocent
    words like "portfolio" or "shares".
    """
    msg_lower = message.lower()

    for keyword in POLITICS_KEYWORDS:
        if re.search(rf"\b{re.escape(keyword)}\b", msg_lower):
            return BLOCKED_MESSAGE
    for phrase in FINANCIAL_PHRASES:
        if phrase in msg_lower:
            return BLOCKED_MESSAGE
    for pattern in INJECTION_PATTERNS:
        if pattern in msg_lower:
            return BLOCKED_MESSAGE
    return None


# ─────────────────────────────────────────────────────────────────────────────
# Intent detection
# ─────────────────────────────────────────────────────────────────────────────

def _clean_option_text(raw: str) -> str:
    """Strip whitespace and any stray markdown bold markers from option text."""
    return raw.strip().strip("*").strip()


# Recognises single-letter replies like "A", "B.", "c)", "Other".
LETTER_REPLY_PATTERN = re.compile(r"^\s*([A-G])\s*[.)\-—:]?\s*$", re.IGNORECASE)
OTHER_REPLY_PATTERN = re.compile(r"^\s*other\s*[.)\-—:]?\s*$", re.IGNORECASE)
# Parses an option line from a prior assistant turn. Tolerates several markdown
# decorations:
#   **A.** I have no prior experience...
#   A) I have no prior experience...
#   **A** — I have no prior experience...
# The extra (?:\*\*)? after the punctuation handles the closing `**` from
# `**A.** text` — without it, the captured text leaks "** " at the front.
OPTION_LINE_PATTERN = re.compile(
    r"^\s*(?:\*\*)?\s*([A-G])\s*(?:\*\*)?\s*[.)\-—:]\s*(?:\*\*)?\s*(.+?)\s*(?:\*\*)?\s*$",
    re.IGNORECASE | re.MULTILINE,
)


def expand_letter_choice(message: str, history: list[dict[str, str]]) -> str:
    """Resolve a single-letter reply against the most recent assistant turn.

    If the student replies just "A" (or "B.", "c)", etc.) to a prior assistant
    message that listed lettered options, return the full option text so the
    model can't lose the context. Returns the original message if no expansion
    applies. "Other" replies pass through unchanged so the model treats them as
    free text.
    """
    if OTHER_REPLY_PATTERN.match(message):
        return message
    match = LETTER_REPLY_PATTERN.match(message)
    if not match:
        return message
    letter = match.group(1).upper()
    for turn in reversed(history):
        if turn.get("role") != "assistant":
            continue
        content = turn.get("content", "")
        options: dict[str, str] = {}
        for option_match in OPTION_LINE_PATTERN.finditer(content):
            options[option_match.group(1).upper()] = _clean_option_text(option_match.group(2))
        if letter in options:
            return f"{letter} — {options[letter]}"
        # Most recent assistant turn had no parseable lettered list; give up.
        break
    return message


# ─────────────────────────────────────────────────────────────────────────────
# A2UI — convert lettered options into a declarative button surface
# ─────────────────────────────────────────────────────────────────────────────
#
# The chatbot's onboarding turns produce multiple-choice questions formatted as
# markdown bullets like "**A.** ...". Rather than asking students to type "A",
# we replace the options block with an A2UI v0.9.1 ``updateComponents`` message
# inside a ``` ```a2ui ``` fenced code block. The frontend's markdown parser
# preserves the fenced block; a small renderer post-processes the rendered HTML
# and swaps the block for native clickable buttons that submit the full option
# text as the next user message.

A2UI_OPTION_LINE_PATTERN = re.compile(
    r"^\s*(?:\*\*)?\s*([A-G]|Other)\s*(?:\*\*)?\s*[.)\-—:]\s*(?:\*\*)?\s*(.+?)\s*(?:\*\*)?\s*$",
    re.IGNORECASE,
)
A2UI_VERSION = "v0.9.1"
A2UI_SURFACE_ID = "chatbot"


def convert_options_to_a2ui(answer: str) -> str:
    """Replace a contiguous lettered options block with a fenced ``a2ui`` block.

    Returns ``answer`` unchanged if no block is detected. The original markdown
    is what gets persisted to ``chatHistory`` (callers keep both versions); only
    the value streamed to the client is rewritten so users get clickable buttons
    in place of "**A.** ..." text lines.
    """
    lines = answer.split("\n")
    option_indices: list[int] = []
    options: list[tuple[str, str]] = []
    for idx, line in enumerate(lines):
        match = A2UI_OPTION_LINE_PATTERN.match(line)
        if match:
            option_indices.append(idx)
            letter = match.group(1).strip()
            text = _clean_option_text(match.group(2))
            options.append((letter, text))

    if len(options) < 2:
        return answer

    first, last = option_indices[0], option_indices[-1]
    for idx in range(first, last + 1):
        if idx in option_indices or not lines[idx].strip():
            continue
        return answer  # Non-contiguous block — leave as-is rather than mangle.

    components = []
    for i, (letter, text) in enumerate(options):
        is_other = letter.lower() == "other"
        label = text if is_other else f"{letter}. {text}"
        action_value = text if is_other else f"{letter} — {text}"
        components.append({
            "id": f"opt-{i}",
            "component": "Button",
            "label": label,
            "actionValue": action_value,
        })

    a2ui_message = {
        "version": A2UI_VERSION,
        "updateComponents": {
            "surfaceId": A2UI_SURFACE_ID,
            "components": components,
        },
    }
    block_lines = ["```a2ui", json.dumps(a2ui_message), "```"]
    new_lines = lines[:first] + block_lines + lines[last + 1:]
    return "\n".join(new_lines).strip()


def detect_assessment_intent(message: str) -> bool:
    """True when the student is asking for a learning path / curriculum."""
    msg = message.lower()
    return any(keyword in msg for keyword in ASSESSMENT_KEYWORDS)


def detect_onboarding_intro(message: str) -> bool:
    """True when a student introduces themselves / shares their background."""
    if len(message.split()) < 15:
        return False
    msg = message.lower()
    return any(signal in msg for signal in ONBOARDING_INTRO_SIGNALS)


# ─────────────────────────────────────────────────────────────────────────────
# Bedrock invocation (converse + converse_stream)
# ─────────────────────────────────────────────────────────────────────────────

def _consume_stream(stream: Any, session_id: str) -> tuple[str, bool, int]:
    """Consume a converse_stream response, publishing chunks as they arrive.

    Returns ``(full_text, blocked, tokens_used)``.
    """
    full_text = ""
    buffer = ""
    input_tokens = output_tokens = 0
    sequence = 0

    for event in stream:
        if "contentBlockDelta" in event:
            delta = event["contentBlockDelta"]["delta"].get("text", "")
            full_text += delta
            buffer += delta
            if len(buffer) >= STREAM_FLUSH_CHARS or "\n" in delta:
                publish_chunk(session_id, buffer, sequence=sequence, is_complete=False)
                sequence += 1
                buffer = ""
        elif "metadata" in event:
            usage = event["metadata"].get("usage", {})
            input_tokens = usage.get("inputTokens", 0)
            output_tokens = usage.get("outputTokens", 0)
        elif "messageStop" in event:
            if event["messageStop"].get("stopReason") == "guardrail_intervened":
                logger.warning("Guardrail intervened via Converse Stream API.")
                publish_chunk(session_id, BLOCKED_MESSAGE, sequence=sequence, is_complete=True)
                return BLOCKED_MESSAGE, True, 0

    if buffer:
        publish_chunk(session_id, buffer, sequence=sequence, is_complete=False)
        sequence += 1
    publish_chunk(session_id, "", sequence=sequence, is_complete=True)
    return full_text.strip(), False, input_tokens + output_tokens


def invoke_bedrock_with_guardrail(
    model_id: str,
    system_text: str,
    messages: list[dict[str, Any]],
    apply_guardrail: bool = True,
    stream_session_id: Optional[str] = None,
) -> tuple[str, bool, int]:
    """Invoke the Bedrock Converse API, optionally streaming and/or guard-railed.

    Returns ``(response_text, blocked, tokens_used)``.
    """
    params: dict[str, Any] = {"modelId": model_id, "messages": messages}
    if system_text:
        params["system"] = [{"text": system_text}]
    if apply_guardrail and TUTOR_GUARDRAIL_ID and TUTOR_GUARDRAIL_VERSION:
        params["guardrailConfig"] = {
            "guardrailIdentifier": TUTOR_GUARDRAIL_ID,
            "guardrailVersion": TUTOR_GUARDRAIL_VERSION,
        }

    # Streaming path.
    if stream_session_id:
        response = execute_with_retry(lambda: bedrock_runtime_client.converse_stream(**params))
        stream = response.get("stream")
        if stream:
            return _consume_stream(stream, stream_session_id)

    # Non-streaming path.
    response = execute_with_retry(lambda: bedrock_runtime_client.converse(**params))
    if response.get("stopReason") == "guardrail_intervened":
        logger.warning("Guardrail intervened via Converse API.")
        return BLOCKED_MESSAGE, True, 0

    try:
        answer = response["output"]["message"]["content"][0]["text"].strip()
    except (KeyError, IndexError, TypeError) as exc:
        logger.error("Failed to parse Bedrock Converse response: %s", exc)
        raise

    usage = response.get("usage", {})
    tokens = usage.get("inputTokens", 0) + usage.get("outputTokens", 0)
    return answer, False, tokens


def embed_text(text: str) -> list[float]:
    """Return the Titan embedding vector for ``text``."""
    def _invoke() -> list[float]:
        response = bedrock_runtime_client.invoke_model(
            modelId=EMBED_MODEL,
            contentType="application/json",
            accept="application/json",
            body=json.dumps({"inputText": text, "dimensions": EMBED_DIMENSIONS, "normalize": True}),
        )
        return json.loads(response["body"].read()).get("embedding")

    vector = execute_with_retry(_invoke)
    if not vector:
        raise ValueError("Failed to generate embedding")
    return vector


# ─────────────────────────────────────────────────────────────────────────────
# Course catalog & RAG
# ─────────────────────────────────────────────────────────────────────────────

def fetch_course_catalog() -> list[dict[str, Any]]:
    """Scan CoursesTable for a compact catalog of every available course."""
    try:
        response = dynamodb_client.scan(
            TableName=COURSES_TABLE_NAME,
            ProjectionExpression="courseId, title, description, difficulty, frameworks, aws_services",
        )
    except Exception as exc:  # noqa: BLE001 - degrade to empty catalog
        logger.error("Error scanning course catalog: %s", exc)
        return []

    catalog = []
    for item in response.get("Items", []):
        course = deserialize_item(item)
        catalog.append({
            "courseId": course.get("courseId", ""),
            "title": course.get("title", ""),
            "description": course.get("description", ""),
            "difficulty": course.get("difficulty", "Intermediate"),
            "frameworks": course.get("frameworks", []),
            "aws_services": course.get("aws_services", []),
        })
    return catalog


def format_catalog(catalog: list[dict[str, Any]]) -> str:
    """Render the catalog as a markdown bullet list for prompt context."""
    lines = []
    for course in catalog:
        frameworks = ", ".join(course["frameworks"]) if course["frameworks"] else "None"
        services = ", ".join(course["aws_services"]) if course["aws_services"] else "None"
        lines.append(
            f"- **{course['title']}** (ID: {course['courseId']} | Difficulty: {course['difficulty']} "
            f"| Frameworks: {frameworks} | Services: {services})\n  Description: {course['description']}"
        )
    return "\n".join(lines)


def query_rag_context(query_vector: list[float], course_id: Optional[str]) -> tuple[list[str], float]:
    """Query the S3 Vectors index and resolve matches to lesson context.

    Returns ``(context_chunks, min_distance)`` where ``min_distance`` is the
    closest match found (2.0 if none).
    """
    params: dict[str, Any] = {
        "vectorBucketName": VECTOR_BUCKET_NAME,
        "indexName": VECTOR_INDEX_NAME,
        "topK": RAG_TOP_K,
        "queryVector": {"float32": query_vector},
        "returnMetadata": True,
        "returnDistance": True,
    }
    if course_id:
        params["filter"] = {"course_id": {"$eq": course_id}}

    try:
        vectors = execute_with_retry(lambda: s3_vectors_client.query_vectors(**params)).get("vectors", [])
    except Exception as exc:  # noqa: BLE001 - retry once without the course filter
        logger.warning("RAG query failed: %s. Retrying without filter.", exc)
        params.pop("filter", None)
        try:
            vectors = s3_vectors_client.query_vectors(**params).get("vectors", [])
        except Exception as exc2:  # noqa: BLE001 - continue with empty context
            logger.error("RAG fallback also failed: %s. Continuing with empty context.", exc2)
            vectors = []

    context_chunks: list[str] = []
    min_distance = 2.0
    courses_cache: dict[str, Optional[dict[str, Any]]] = {}

    for vector in vectors:
        metadata = vector.get("metadata", {})
        c_id = metadata.get("course_id")
        l_id = metadata.get("lesson_id")
        distance = vector.get("distance", 1.0)
        min_distance = min(min_distance, distance)
        if not c_id or not l_id:
            continue

        course_data = _get_course_cached(c_id, courses_cache)
        if not course_data:
            continue

        lesson, module_title = _find_lesson(course_data, l_id)
        if lesson:
            context_chunks.append(
                f"Course: {course_data.get('title', '')} (courseId: {c_id})\n"
                f"Module: {module_title}\n"
                f"Lesson: {lesson.get('title', '')} (distance: {distance:.4f})\n"
                f"Content:\n{lesson.get('content', '')}"
            )

    return context_chunks, min_distance


def _get_course_cached(
    course_id: str,
    cache: dict[str, Optional[dict[str, Any]]],
) -> Optional[dict[str, Any]]:
    """Fetch a course by id, memoising within a single request."""
    if course_id in cache:
        return cache[course_id]
    try:
        response = dynamodb_client.get_item(
            TableName=COURSES_TABLE_NAME,
            Key={"courseId": {"S": course_id}},
        )
        cache[course_id] = deserialize_item(response["Item"]) if "Item" in response else None
    except Exception as exc:  # noqa: BLE001
        logger.error("Error fetching course %s: %s", course_id, exc)
        cache[course_id] = None
    return cache[course_id]


def _find_lesson(course_data: dict[str, Any], lesson_id: str) -> tuple[Optional[dict[str, Any]], str]:
    """Locate a lesson (and its module title) within a course document."""
    for module in course_data.get("modules", []):
        for lesson in module.get("lessons", []):
            if lesson.get("lessonId") == lesson_id:
                return lesson, module.get("title", "")
    return None, ""


def fix_course_links(answer: str, catalog: list[dict[str, Any]]) -> str:
    """Repair hallucinated course IDs in ``[Title](#course/ID)`` markdown links."""
    pattern = r"\[(?P<title>[^\]]+)\]\((?P<url>#course/[^\)]+|course:[^\)]+)\)"
    valid_ids = {course["courseId"] for course in catalog}

    def replace_link(match: re.Match[str]) -> str:
        title = match.group("title")
        course_id_part = match.group("url").split("/")[-1].split(":")[-1].strip()
        if course_id_part in valid_ids:
            return match.group(0)

        title_clean = title.strip().lower()
        for course in catalog:
            c_title = course["title"].strip().lower()
            if c_title == title_clean or title_clean in c_title or c_title in title_clean:
                return f"[{title}](#course/{course['courseId']})"

        best_match, best_score = None, 0
        title_words = set(title_clean.split())
        for course in catalog:
            overlap = len(title_words & set(course["title"].strip().lower().split()))
            if overlap > best_score:
                best_score, best_match = overlap, course
        if best_match and best_score >= 2:
            return f"[{title}](#course/{best_match['courseId']})"
        return match.group(0)

    return re.sub(pattern, replace_link, answer)


# ─────────────────────────────────────────────────────────────────────────────
# Prompt templates
# ─────────────────────────────────────────────────────────────────────────────

ONBOARDING_SYSTEM = """You are a warm, empathetic, and expert educational advisor for EduCloud Academy.

EduCloud Academy specialises in cloud computing and AI engineering. The career tracks we prepare students for are:
- Cloud Engineer / Cloud Developer
- Solutions Architect (AWS, Azure, GCP)
- AI Engineer / AI Cloud Engineer
- Forward Deployed Engineer
- DevOps / Platform Engineer
- Machine Learning Engineer
- Cloud Security Engineer

Your mission is to get to know the student, understand their background, goals, and current skill level through a friendly, natural conversation — NOT a rigid quiz.

Guidelines:
1. Ask thoughtful follow-up questions to understand: their current skills, their career goal, what they already know, and what they find confusing or exciting.
2. Be conversational, encouraging, and warm.
3. EVERY follow-up question you ask MUST be presented as a multiple-choice list with lettered options. Use 3 to 6 options labelled A, B, C, D, E, F. Put each option on its own line, formatted as `**A.** <option>`. Always include an "**Other** — tell me in your own words" option as the last choice so the student can free-text if none fit. Phrase the question first in one short sentence, then list the choices.
4. When asking about career goals, the lettered options MUST be drawn from EduCloud's tracks above (Cloud Engineer, Solutions Architect, AI Engineer / AI Cloud Engineer, Forward Deployed Engineer, DevOps / Platform Engineer, Machine Learning Engineer, Cloud Security Engineer). Do NOT suggest off-platform tracks like generic cybersecurity, data science, or web development unless the student volunteers them.
5. Ask ONE question per response. Do not stack a follow-up question and a "ready for plan?" prompt in the same message — pick one.
6. Once you have gathered enough information (background, goal, and skill level), offer to create a personalized study plan with two choices: `**A.** Yes, create my study plan` and `**B.** I'd like to share a bit more first`.
7. If they pick the "create my plan" option (or otherwise indicate they are ready), respond ONLY with the JSON marker: {"action": "generate_plan", "summary": "<one sentence summary of student background and goal>"}
8. Do NOT ask more than 3 follow-up questions before offering to create the plan.
9. You may answer general educational or cloud computing questions that come up naturally in the conversation — those answers do not need multiple-choice formatting, but any question you ask the student back does."""

ONBOARDING_INTRO_SYSTEM = """You are a warm, empathetic, and expert educational advisor for EduCloud Academy.
EduCloud Academy specialises in cloud computing and AI engineering — the tracks we prepare students for are Cloud Engineer, Solutions Architect, AI Engineer / AI Cloud Engineer, Forward Deployed Engineer, DevOps / Platform Engineer, Machine Learning Engineer, and Cloud Security Engineer.
A student has just introduced themselves and shared their background and goals. Your job is to:
1. Warmly acknowledge what they shared in one or two sentences, highlighting something genuinely impressive or interesting from their background.
2. Ask ONE focused follow-up question to better understand their primary goal or biggest challenge.
3. The follow-up question MUST be presented as a multiple-choice list with lettered options. Put each option on its own line, formatted as `**A.** <option>`, `**B.** <option>`, `**C.** <option>`, with a final `**Other** — tell me in your own words` choice so the student can free-text. Phrase the question first in one short sentence, then list the choices.
4. If the question is about career goals or career direction, the lettered options MUST be drawn from the EduCloud tracks listed above. Do NOT offer generic off-platform tracks (cybersecurity, data science, web dev) unless the student volunteers them.
5. Keep the overall response concise and warm."""

ASSESSMENT_OPENING_SYSTEM = """You are a warm, empathetic, and expert educational advisor for EduCloud Academy.
EduCloud Academy specialises in cloud computing and AI engineering — the tracks we prepare students for are Cloud Engineer, Solutions Architect, AI Engineer / AI Cloud Engineer, Forward Deployed Engineer, DevOps / Platform Engineer, Machine Learning Engineer, and Cloud Security Engineer.
A student wants a personalized learning path. Start the conversation by:
1. Warmly welcoming them in one short sentence and expressing enthusiasm about helping them find their path.
2. Asking ONE key question to understand their background and what they already know.
3. The question MUST be presented as a multiple-choice list with lettered options. Put each option on its own line, formatted as `**A.** <option>`, `**B.** <option>`, `**C.** <option>`, with a final `**Other** — tell me in your own words` choice so the student can free-text. Phrase the question first in one short sentence, then list the choices.
4. If the question is about career goals or career direction, the lettered options MUST be drawn from the EduCloud tracks listed above. Do NOT offer generic off-platform tracks (cybersecurity, data science, web dev) unless the student volunteers them.
Keep your response short and encouraging."""

# The curriculum builder is the heart of the platform's value proposition. It
# merges platform courses (catalog + RAG) with live documentation topics, and is
# explicitly forbidden from sending students to competing platforms — gaps become
# *suggestions for EduCloud to build*, recorded as content demand for admins.
PLAN_PROMPT_TEMPLATE = """You are an expert curriculum planner for EduCloud Academy. \
Based on the conversation with a student, design a personalized, comprehensive, and encouraging learning path.

Conversation:
{history_context}

Student Summary: {student_summary}

Design a complete study plan that is split into exactly two clearly labelled sections:

## Section 1 — Courses on EduCloud Academy
Recommend the most appropriate courses from the platform catalog below. Format every recommendation as a \
markdown bullet exactly like this (no extra brackets, no "Platform Course" prefix label, no nested square brackets):

- [Course Title](#course/CourseID) — one-line rationale for this student.

Use ONLY courses that appear in the catalog; never invent IDs. The exact link form `[Course Title](#course/CourseID)` \
must be used so the frontend can route clicks to the course page.

## Section 2 — Recommended new courses for EduCloud to build
Identify the skills and topics essential to the student's goal that are NOT yet covered by any platform course. \
Present each as a plain bullet with a bold suggested title and a one-line rationale, like:

- **Suggested course title** — one-line rationale.

Do NOT wrap these in square brackets or any link syntax. These are gaps the EduCloud admin team should \
create as future courses.

Strict rules:
- NEVER recommend, name, or link to courses, tutorials, videos, bootcamps, or programs on other platforms \
(e.g. Udemy, Coursera, edX, YouTube, Pluralsight, freeCodeCamp). Use the live documentation only to identify \
which TOPICS matter — never to send the student elsewhere.
- Begin with an encouraging, personalized note addressing what the student shared.
- Include a clear title, target difficulty, an estimated timeline, and step-by-step milestones in clean markdown.
- Explain why each milestone matters for this specific student's background and goals.

Available Course Catalog (platform courses):
{catalog_str}

Relevant platform lesson matches (from semantic search):
{rag_context}
{live_docs_section}

Answer:"""

CHAT_SYSTEM_TEMPLATE = """You are an expert educational tutor, career advisor, and virtual teaching assistant for EduCloud Academy.

Your role is to help students learn cloud computing, AI, and software development — answering questions with accuracy and warmth.

Rules:
1. Be warm, encouraging, and conversational. Students may ask broad career questions, not just specific technical ones.
2. Always ground your answers in the provided contexts:
   - **Platform Course Content** (from our video course lessons) — use for lesson-specific or course-related questions.
   - **Live Documentation** (fetched live from official AWS, Azure, GCP, Kubernetes and other cloud provider docs) — use for technical how-to questions, service definitions, quickstarts, and anything not covered in platform courses.
3. When recommending courses, ALWAYS link them using: `[Course Title](#course/CourseID)` and recommend ONLY courses from the catalog below.
4. NEVER recommend, name, or link to courses, tutorials, or programs on other learning platforms (e.g. Udemy, Coursera, edX, YouTube). If the platform lacks a relevant course, say the topic isn't covered yet and answer from official documentation instead.
5. If neither context covers the answer, use your broad knowledge but acknowledge it's not from a platform course.
6. Be professional, clear, and use markdown formatting where appropriate.

## Available Course Catalog:
{catalog_str}

## Platform Course Lesson Context (RAG):
{rag_context}
{live_docs_section}"""


def _history_to_messages(history: list[dict[str, str]], window: int) -> list[dict[str, Any]]:
    """Convert stored chat history into Bedrock Converse message dicts."""
    return [
        {"role": turn["role"], "content": [{"text": turn["content"]}]}
        for turn in history[-window:]
    ]


# ─────────────────────────────────────────────────────────────────────────────
# Curriculum builder
# ─────────────────────────────────────────────────────────────────────────────

def build_study_plan(
    session_id: str,
    student_summary: str,
    history: list[dict[str, str]],
    latest_message: str,
) -> tuple[str, int]:
    """Generate a personalized study plan and return ``(plan_markdown, tokens)``.

    Combines, per the platform spec:
      * the course catalog and S3 Vectors semantic matches (platform courses), and
      * live official documentation (to identify essential topics),
    and asks the model to surface gaps as *new courses for EduCloud to build*,
    never courses on competing platforms. Gaps are also logged as content demand.
    """
    catalog = fetch_course_catalog()
    catalog_str = format_catalog(catalog) if catalog else "No catalog available."

    # Semantic search over platform content for the student's goal.
    rag_context = "No platform lesson matches found."
    try:
        query_vector = embed_text(student_summary or latest_message)
        chunks, _ = query_rag_context(query_vector, course_id=None)
        if chunks:
            rag_context = "\n\n---\n\n".join(chunks)
    except Exception as exc:  # noqa: BLE001 - plan can still be built from the catalog
        logger.warning("Study-plan RAG step skipped: %s", exc)

    # Live documentation to surface the topics a strong curriculum should cover.
    live_docs = fetch_live_docs(
        query=f"{student_summary} cloud computing learning path best practices",
        max_results=4,
    )
    live_docs_section = f"\n\nLive Documentation Context:\n{live_docs}" if live_docs else ""

    history_context = "".join(
        f"{'Student' if turn['role'] == 'user' else 'Tutor'}: {turn['content']}\n"
        for turn in history
    )
    history_context += f"Student: {latest_message}\n"

    prompt = PLAN_PROMPT_TEMPLATE.format(
        history_context=history_context,
        student_summary=student_summary,
        catalog_str=catalog_str,
        rag_context=rag_context,
        live_docs_section=live_docs_section,
    )

    plan_answer, _, tokens = invoke_bedrock_with_guardrail(
        MODEL_PRO,
        "You are an expert curriculum planner.",
        [{"role": "user", "content": [{"text": prompt}]}],
        apply_guardrail=False,
        stream_session_id=session_id,
    )

    try:
        plan_answer = fix_course_links(plan_answer, catalog)
    except Exception as exc:  # noqa: BLE001 - link repair is non-critical
        logger.warning("Error in fix_course_links during plan build: %s", exc)

    # Record demand so admins can see which curricula students are requesting.
    log_content_demand(session_id, student_summary or latest_message, detected_topic="curriculum")
    return plan_answer, tokens


# ─────────────────────────────────────────────────────────────────────────────
# Field handlers
# ─────────────────────────────────────────────────────────────────────────────

def handle_get_content_demand_telemetry() -> list[dict[str, Any]]:
    """Return content-demand telemetry rows, newest first."""
    if not CONTENT_DEMAND_TELEMETRY_TABLE_NAME:
        return []
    try:
        response = dynamodb_client.scan(TableName=CONTENT_DEMAND_TELEMETRY_TABLE_NAME)
    except Exception as exc:  # noqa: BLE001
        logger.error("Error fetching telemetry: %s", exc)
        return []
    rows = [deserialize_item(item) for item in response.get("Items", [])]
    rows.sort(key=lambda row: row.get("timestamp", ""), reverse=True)
    return rows


def handle_get_chat_evaluations() -> list[dict[str, Any]]:
    """Return chat evaluation rows with numeric scores, newest first."""
    try:
        response = dynamodb_client.scan(TableName=CHAT_EVALUATIONS_TABLE_NAME)
    except Exception as exc:  # noqa: BLE001
        logger.error("Error fetching evaluations: %s", exc)
        return []

    evaluations = []
    for item in response.get("Items", []):
        row = deserialize_item(item)
        for score_field in ("relevanceScore", "politenessScore", "adherenceScore"):
            row[score_field] = int(row.get(score_field, 0))
        evaluations.append(row)
    evaluations.sort(key=lambda row: row.get("timestamp", ""), reverse=True)
    return evaluations


def handle_demystify_jargon(arguments: dict[str, Any]) -> str:
    """Explain a technical term in two simple sentences, grounded in live docs."""
    term = arguments.get("term", "").strip()
    if not term:
        raise ValueError("Missing 'term' argument")

    record_prompt_audit(f"demystify-{term[:40]}", term, field_name="demystifyJargon")
    logger.info("demystifyJargon: fetching live explanation for '%s'", term)

    live_context = fetch_live_docs(
        query=f"{term} cloud computing definition official documentation",
        max_results=3,
    )
    context_section = f"\n\nOfficial documentation context:\n{live_context}" if live_context else ""
    prompt = (
        f'Explain the technical concept or service "{term}" using a simple analogy that a '
        f"5-year-old would understand.\nKeep it to exactly 2 clear, engaging sentences."
        f"{context_section}\n\nBe simple, clear, and pedagogical."
    )

    # Guardrail disabled: ELI5 explanations are inherently educational, and the
    # guardrail over-blocks legitimate technical terms like 'VPC', 'Lambda', 'IAM'.
    answer, _, _ = invoke_bedrock_with_guardrail(
        MODEL_FAST,
        "You are a helpful educational tutor who explains complex technical concepts simply.",
        [{"role": "user", "content": [{"text": prompt}]}],
        apply_guardrail=False,
    )
    return answer


def _start_onboarding(session_id: str, message: str, system_text: str, token_usage: int, today: str) -> str:
    """Kick off the conversational onboarding flow and persist the first turn."""
    # Buffer — we rewrite the lettered options block into an A2UI button surface
    # before streaming, which we can't do incrementally.
    answer, blocked, tokens = invoke_bedrock_with_guardrail(
        MODEL_FAST,
        system_text,
        [{"role": "user", "content": [{"text": message}]}],
        apply_guardrail=False,
    )
    if blocked:
        return answer

    display = convert_options_to_a2ui(answer)
    publish_chunk(session_id, display, sequence=0, is_complete=False)
    publish_chunk(session_id, "", sequence=1, is_complete=True)

    save_session(session_id, {
        "state": "ONBOARDING",
        "chatHistory": [
            {"role": "user", "content": message},
            {"role": "assistant", "content": answer},
        ],
        "dailyTokenUsage": token_usage + tokens,
        "lastUsageDate": today,
    })
    return answer


def handle_onboarding_turn(
    session_id: str,
    message: str,
    session_data: dict[str, Any],
    token_usage: int,
    today: str,
) -> str:
    """Continue an in-progress onboarding conversation or generate the plan."""
    history: list[dict[str, str]] = session_data.get("chatHistory", [])

    # IMPORTANT: do NOT stream this turn. The model may respond with the JSON
    # "generate_plan" marker instead of a chat reply, in which case streaming
    # would leak the raw marker to the user and close the WebSocket before the
    # plan can be streamed. We buffer here, then either kick off the streaming
    # plan generation OR publish the chat reply as a single chunk.
    answer, _, tokens = invoke_bedrock_with_guardrail(
        MODEL_FAST,
        ONBOARDING_SYSTEM,
        _history_to_messages(history, ONBOARDING_HISTORY_WINDOW) + [
            {"role": "user", "content": [{"text": message}]}
        ],
        apply_guardrail=False,
    )

    # Did the model signal readiness to generate the plan?
    marker = re.search(r'\{\s*"action"\s*:\s*"generate_plan".*?\}', answer, re.DOTALL)
    if marker:
        try:
            student_summary = json.loads(marker.group(0)).get("summary", message)
            plan_answer, plan_tokens = build_study_plan(session_id, student_summary, history, message)
            history += [
                {"role": "user", "content": message},
                {"role": "assistant", "content": plan_answer},
            ]
            save_session(session_id, {
                "state": "COMPLETED",
                "chatHistory": history,
                "dailyTokenUsage": token_usage + tokens + plan_tokens,
                "lastUsageDate": today,
            })
            return f"🎉 **Here is your personalized study plan!**\n\n{plan_answer}"
        except Exception as exc:  # noqa: BLE001 - fall through to normal onboarding
            logger.warning("Onboarding plan transition failed: %s", exc)

    # Normal chat reply — publish it as a single chunk so the frontend renders
    # immediately (the WebSocket is still open waiting on the first chunk).
    # The lettered options block (if any) is rewritten to an A2UI surface so
    # the user gets clickable buttons instead of plain text.
    display = convert_options_to_a2ui(answer)
    publish_chunk(session_id, display, sequence=0, is_complete=False)
    publish_chunk(session_id, "", sequence=1, is_complete=True)

    history += [
        {"role": "user", "content": message},
        {"role": "assistant", "content": answer},
    ]
    save_session(session_id, {
        "state": "ONBOARDING",
        "chatHistory": history,
        "dailyTokenUsage": token_usage + tokens,
        "lastUsageDate": today,
    })
    return answer


def _check_semantic_cache(
    query_vector: list[float],
    session_id: str,
    message: str,
    history: list[dict[str, str]],
    state: str,
    token_usage: int,
    today: str,
) -> Optional[str]:
    """Return a cached answer for a near-identical prior question, or ``None``."""
    try:
        response = s3_vectors_client.query_vectors(
            vectorBucketName=VECTOR_BUCKET_NAME,
            indexName=VECTOR_INDEX_NAME,
            topK=1,
            queryVector={"float32": query_vector},
            returnMetadata=True,
            returnDistance=True,
            filter={"is_cache": {"$eq": "true"}},
        )
    except Exception as exc:  # noqa: BLE001 - cache miss on error
        logger.warning("Semantic cache check skipped: %s", exc)
        return None

    cache_vectors = response.get("vectors", [])
    if not cache_vectors:
        return None
    closest = cache_vectors[0]
    if closest.get("distance", 1.0) > SEMANTIC_CACHE_DISTANCE:
        return None

    cache_data = get_session(closest.get("key", ""))
    if not cache_data:
        return None
    cached_answer = cache_data.get("cached_response")
    if not cached_answer or "assist with" in cached_answer:
        return None

    logger.info("Semantic cache HIT (distance %.4f).", closest["distance"])
    history += [
        {"role": "user", "content": message},
        {"role": "assistant", "content": cached_answer},
    ]
    save_session(session_id, {
        "state": state,
        "chatHistory": history,
        "dailyTokenUsage": token_usage,
        "lastUsageDate": today,
    })
    return cached_answer


def _store_semantic_cache(message: str, answer: str, query_vector: list[float]) -> None:
    """Persist an answer so future near-identical questions can be served instantly."""
    try:
        cache_key = f"cache-{hashlib.md5(message.encode('utf-8')).hexdigest()}"
        save_session(cache_key, {"cached_response": answer, "state": "CACHE"})
        s3_vectors_client.put_vectors(
            vectorBucketName=VECTOR_BUCKET_NAME,
            indexName=VECTOR_INDEX_NAME,
            vectors=[{
                "key": cache_key,
                "data": {"float32": query_vector},
                "metadata": {"is_cache": "true", "prompt": message, "timestamp": str(time.time())},
            }],
        )
    except Exception as exc:  # noqa: BLE001 - caching is best-effort
        logger.warning("Failed to cache prompt response: %s", exc)


# ─────────────────────────────────────────────────────────────────────────────
# Architecture review (multimodal — image + prompt → AWS Well-Architected review)
# ─────────────────────────────────────────────────────────────────────────────

ARCHITECTURE_REVIEW_SYSTEM = """You are a senior cloud solutions architect at \
EduCloud Academy reviewing a student's architecture diagram. You are critiquing \
TOPOLOGY — the services drawn, where they sit, and the arrows between them. \
You are NOT critiquing runtime configuration.

## CRITICAL RULES — read these carefully before writing anything

1. **Only critique what is visible on the diagram.** A diagram shows topology: \
which services exist, where they sit, and how data flows between them via arrows. \
A diagram does NOT show runtime configuration. The following are INVISIBLE on a \
diagram and you MUST NOT mention them:
   - API Gateway stages, throttling, usage plans, custom domains
   - Lambda error handling, retries, timeouts, DLQ (unless a DLQ is drawn)
   - SQS visibility timeout, redrive policy, CloudWatch alarms, metrics
   - DynamoDB auto-scaling, capacity mode, throughput, GSI design
   - IAM least privilege, role policies, fine-grained permissions
   - Encryption at rest/in transit (unless KMS is drawn)
   - Logging, monitoring, observability, X-Ray, alarms
   - Tagging, cost allocation, billing
   - Backup, point-in-time recovery, retention
   - VPC, security groups, NACLs (unless a VPC boundary is drawn)
   If you find yourself writing about any of those, DELETE that bullet.

2. **Flag services that should not be drawn as nodes.** IAM, KMS, CloudTrail, \
CloudWatch (passive observers), Secrets Manager (when it's just a cross-cutting \
helper), and similar policy/observability services are PERMISSIONS or SIDECARS, \
not flow nodes. If they appear as a hop in a data flow (e.g. "Lambda → IAM → \
DynamoDB"), that's a topology mistake — the IAM box should be removed entirely \
and the arrow goes Lambda → DynamoDB directly. Always call this out when you see it.

3. **Focus your review on topology issues** that ARE visible:
   - **Wrong placement** — a service in the wrong position in the data flow (e.g. \
a queue between a Lambda and DynamoDB when the Lambda just needs to read).
   - **Wrong direction** — arrows that don't match the data flow (e.g. a "consumer" \
Lambda with arrows pointing INTO SQS rather than out of it).
   - **Missing service** — what the flow obviously needs but is not drawn (e.g. an \
async writer without a queue in front; an event-driven worker without a trigger).
   - **Anti-patterns** — lambda-calling-lambda synchronously, a single Lambda \
handling many unrelated operations, public S3 buckets in flow, missing event \
source mapping between SQS and its consumer Lambda.
   - **Naming confusion** — labels that don't match the role (a "consumer" that's \
actually producing).

4. **Reference the drawn labels.** Use the student's own labels ("the 'consumer' \
Lambda at the top", "Get All Apnt") so they can map your feedback to the picture.

5. **Don't invent components.** If something is missing, say "I don't see X". \
Don't assume it exists somewhere off-diagram.

## Output (strict markdown)

## Summary
One short paragraph describing what the diagram is trying to do, based purely on what's drawn.

## What's Working ✓
- Bulleted list of services that ARE placed and connected correctly, with one-line reasons.

## Issues ⚠
For each issue use this exact sub-structure:
- **<Specific element using the drawn label>** — <topology problem in one line>
  - **Why it matters:** <one-line concrete consequence>
  - **Fix:** <one concrete change to the diagram — move it, remove it, add a missing service, flip an arrow>

## Suggestions to Improve 💡
- Optional topology improvements that aren't strict issues (e.g. CloudFront in front \
of API Gateway for caching; an EventBridge bus for cleaner fan-out).

## Next Steps
- 2–3 prioritised topology principles or services the student should learn next.

## Structured findings — REQUIRED

After the markdown sections, emit a single fenced code block tagged \
`a2ui-findings` containing a JSON object listing every finding from the review \
that has a clear location on the diagram. The frontend uses this to power a \
click-to-focus zoom: clicking a finding pans/zooms the diagram to its bbox. \
Only one finding is highlighted at a time, so being slightly imprecise is OK — \
generous padding is better than tight.

bbox is `[x, y, w, h]` normalised to [0.0, 1.0] (0,0 = top-left, 1,1 = \
bottom-right). Pad to comfortably contain the service + a bit of surrounding \
context.

severity values: `"issue"` (problem with topology), `"working"` (correctly \
placed/used), `"suggestion"` (optional improvement).

Skip findings without a clear visual location. Every `id` must be unique.

Example (illustrative coordinates — do NOT copy them):

```a2ui-findings
{
  "version": "v0.9.1",
  "findings": [
    {
      "id": "iam-hop",
      "severity": "issue",
      "service": "IAM",
      "title": "IAM drawn as a runtime hop",
      "bbox": [0.58, 0.32, 0.18, 0.22],
      "detail": "Remove this box — IAM is a permission, not a flow node."
    }
  ]
}
```

The block must be valid JSON. Emit exactly one block, at the very end.

Tone: warm, mentoring, educational. The student is learning — show them the \
topology principle behind every critique. No nagging about config they couldn't draw."""


def _fetch_diagram_bytes(s3_key: str) -> tuple[bytes, str]:
    """Fetch a diagram from the media bucket. Returns ``(bytes, format)``.

    ``format`` is the Bedrock Converse image format string ("png" or "jpeg").
    Raises ``ValueError`` for unsupported formats or missing config.
    """
    if not MEDIA_BUCKET_NAME:
        raise ValueError("MEDIA_BUCKET_NAME is not configured")
    response = s3_client.get_object(Bucket=MEDIA_BUCKET_NAME, Key=s3_key)
    body = response["Body"].read()
    content_type = (response.get("ContentType") or "").lower()
    key_lower = s3_key.lower()

    if "png" in content_type or key_lower.endswith(".png"):
        return body, "png"
    if "jpeg" in content_type or "jpg" in content_type or key_lower.endswith((".jpg", ".jpeg")):
        return body, "jpeg"
    raise ValueError(f"Unsupported diagram format for {s3_key} (content-type {content_type!r})")


def handle_architecture_review(
    session_id: str,
    message: str,
    image_s3_key: str,
    session_data: dict[str, Any],
    token_usage: int,
    today: str,
) -> str:
    """Run a multimodal architecture review on an uploaded diagram.

    Streams the markdown review back through the existing chunk pipeline and
    persists the review (text only) into ``chatHistory`` so follow-up text-only
    turns can reference what the model said about the diagram.
    """
    try:
        image_bytes, image_format = _fetch_diagram_bytes(image_s3_key)
    except Exception as exc:  # noqa: BLE001 - bubble a friendly error to the user
        logger.error("Failed to fetch diagram %s: %s", image_s3_key, exc)
        publish_chunk(session_id, "I couldn't load that diagram — please try uploading it again.", sequence=0, is_complete=False)
        publish_chunk(session_id, "", sequence=1, is_complete=True)
        return "I couldn't load that diagram — please try uploading it again."

    user_prompt = message.strip() or (
        "Please review this cloud architecture diagram in depth, calling out "
        "what's working and what needs improvement."
    )

    messages = [{
        "role": "user",
        "content": [
            {"text": user_prompt},
            {"image": {"format": image_format, "source": {"bytes": image_bytes}}},
        ],
    }]

    # Guardrails disabled here: a well-formed architectural critique routinely
    # mentions services and patterns the tutor guardrail's "non-educational
    # software development" topic blocks. The review intent itself is purely
    # educational.
    answer, blocked, tokens = invoke_bedrock_with_guardrail(
        MODEL_VISION,
        ARCHITECTURE_REVIEW_SYSTEM,
        messages,
        apply_guardrail=False,
        stream_session_id=session_id,
    )
    if blocked:
        return answer

    # Save the review into chatHistory so subsequent text-only turns can
    # answer follow-up questions ("tell me more about the Lambda issue").
    history: list[dict[str, str]] = session_data.get("chatHistory", [])
    history += [
        {"role": "user", "content": f"[Uploaded diagram: {image_s3_key}]\n{user_prompt}"},
        {"role": "assistant", "content": answer},
    ]
    save_session(session_id, {
        "state": session_data.get("state", "ACTIVE"),
        "chatHistory": history,
        "lastDiagramS3Key": image_s3_key,
        "dailyTokenUsage": token_usage + tokens,
        "lastUsageDate": today,
    })
    return answer


def handle_chat(
    session_id: str,
    course_id: Optional[str],
    message: str,
    session_data: dict[str, Any],
    token_usage: int,
    today: str,
) -> str:
    """Answer a standard student question with RAG + live-docs grounding."""
    state = session_data.get("state", "ACTIVE")
    history: list[dict[str, str]] = session_data.get("chatHistory", [])

    # 1. Embed the query (needed for both cache lookup and RAG).
    query_vector = embed_text(message)

    # 2. Semantic cache.
    cached = _check_semantic_cache(query_vector, session_id, message, history, state, token_usage, today)
    if cached is not None:
        return cached

    # 3. Platform RAG.
    context_chunks, min_distance = query_rag_context(query_vector, course_id)

    # 4. Live documentation (always, to enrich the answer).
    logger.info("Fetching live docs for query: %.80s", message)
    live_docs = fetch_live_docs(query=message, max_results=5)

    # Log unmet demand when the platform has no good course match.
    if not context_chunks or min_distance > EXTERNAL_DEMAND_DISTANCE:
        log_content_demand(session_id, message, detected_topic="external")

    # 5. Build prompt context.
    catalog = fetch_course_catalog()
    catalog_str = format_catalog(catalog) if catalog else ""
    rag_context = "\n\n---\n\n".join(context_chunks) if context_chunks else \
        "No platform course content found for this query."
    live_docs_section = (
        f"\n\n## Live Documentation (from official cloud provider docs):\n{live_docs}"
        if live_docs else ""
    )
    system_prompt = CHAT_SYSTEM_TEMPLATE.format(
        catalog_str=catalog_str,
        rag_context=rag_context,
        live_docs_section=live_docs_section,
    )

    model_id = MODEL_PRO if any(kw in message.lower() for kw in COMPLEX_QUERY_KEYWORDS) else MODEL_FAST

    # 6. Invoke the model.
    messages = _history_to_messages(history, CHAT_HISTORY_WINDOW) + [
        {"role": "user", "content": [{"text": message}]}
    ]
    answer, blocked, tokens = invoke_bedrock_with_guardrail(
        model_id, system_prompt, messages, stream_session_id=session_id
    )
    if blocked:
        return answer

    try:
        answer = fix_course_links(answer, catalog)
    except Exception as exc:  # noqa: BLE001 - link repair is non-critical
        logger.warning("Error in fix_course_links: %s", exc)

    # 7. Persist history + populate the semantic cache.
    history += [
        {"role": "user", "content": message},
        {"role": "assistant", "content": answer},
    ]
    save_session(session_id, {
        "state": state,
        "chatHistory": history,
        "dailyTokenUsage": token_usage + tokens,
        "lastUsageDate": today,
    })
    _store_semantic_cache(message, answer, query_vector)
    return answer


# ─────────────────────────────────────────────────────────────────────────────
# Lambda entry point
# ─────────────────────────────────────────────────────────────────────────────

def handler(event: dict[str, Any], context: Any) -> Any:
    """AppSync resolver entry point; dispatches on the GraphQL field name."""
    logger.info("Received chatbot query event: %s", json.dumps(event))
    field_name = event.get("info", {}).get("fieldName", "askCourseChatbot")

    # Read-only admin/analytics fields.
    if field_name == "getContentDemandTelemetry":
        return handle_get_content_demand_telemetry()
    if field_name == "getChatEvaluations":
        return handle_get_chat_evaluations()
    if field_name == "demystifyJargon":
        return handle_demystify_jargon(event.get("arguments", {}))

    # ── askCourseChatbot ──────────────────────────────────────────────────
    arguments = event.get("arguments", {})
    course_id = arguments.get("courseId")
    message = arguments.get("message")
    session_id = arguments.get("sessionId")
    image_s3_key = arguments.get("imageS3Key")

    if not message:
        raise ValueError("Missing 'message' argument")
    if not session_id:
        session_id = f"anon-session-{course_id or 'global'}"

    logger.info(
        "Message: %s | CourseId: %s | SessionId: %s | Image: %s",
        message, course_id, session_id, image_s3_key,
    )

    # Audit EVERY user prompt before any processing or guardrail short-circuit.
    record_prompt_audit(session_id, message, field_name=field_name, course_id=course_id)

    session_data = get_session(session_id) or {}
    state = session_data.get("state", "ACTIVE")

    today = time.strftime("%Y-%m-%d")
    token_usage = int(session_data.get("dailyTokenUsage", 0))
    if session_data.get("lastUsageDate", "") != today:
        token_usage = 0

    # Architecture-review intent: signalled by an uploaded diagram. Short-circuits
    # all other routing (onboarding, RAG chat, etc.) because the diagram + user's
    # accompanying note is a self-contained turn.
    if image_s3_key:
        return handle_architecture_review(
            session_id, message, image_s3_key, session_data, token_usage, today,
        )

    # Global reset command.
    if message.strip().lower() in RESET_COMMANDS:
        save_session(session_id, {"state": "ACTIVE", "chatHistory": []})
        return "Got it. I've reset our conversation history. How can I help you today?"

    # If the student replied with just a letter ("A", "B.", "c)"), resolve it
    # to the full option text from the previous assistant turn so the model
    # can't lose what the letter referred to.
    expanded_message = expand_letter_choice(message, session_data.get("chatHistory", []))
    if expanded_message != message:
        logger.info("Expanded letter choice %r → %r", message, expanded_message[:120])
        message = expanded_message

    # Continue an in-progress onboarding conversation.
    if state == "ONBOARDING":
        return handle_onboarding_turn(session_id, message, session_data, token_usage, today)

    # Short-circuit pure greetings / small-talk with a canned welcome — no need
    # to spend a Tavily call + RAG round-trip to answer "hello".
    if SMALL_TALK_PATTERN.match(message.strip()):
        return WELCOME_REPLY

    # Token rate limiting.
    if token_usage >= DAILY_TOKEN_LIMIT:
        logger.warning("Session %s exceeded daily token limit: %d", session_id, token_usage)
        return (
            f"You have reached your daily limit of {DAILY_TOKEN_LIMIT:,} tokens for this "
            "session. Please try again tomorrow."
        )

    # Local guardrail pre-filter.
    block_message = local_guardrail_check(message)
    if block_message:
        logger.warning("Local guardrail blocked prompt: %s", message)
        return block_message

    # Enter onboarding when the student introduces themselves or asks for a path.
    if detect_onboarding_intro(message):
        return _start_onboarding(session_id, message, ONBOARDING_INTRO_SYSTEM, token_usage, today)
    if detect_assessment_intent(message):
        return _start_onboarding(session_id, message, ASSESSMENT_OPENING_SYSTEM, token_usage, today)

    # Standard grounded Q&A.
    return handle_chat(session_id, course_id, message, session_data, token_usage, today)
