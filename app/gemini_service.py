"""Gemini-backed intent parsing with a small, bounded local fallback."""
from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import re
import threading
import time
from datetime import datetime, timezone
from decimal import Decimal
from functools import lru_cache
from typing import Literal, Optional

from pydantic import BaseModel, Field, PrivateAttr

from app.config import get_settings

logger = logging.getLogger(__name__)


class ParsedEntry(BaseModel):
    customer_name: str = ""
    amount: Decimal = Field(default=Decimal("0"), ge=0)
    entry_type: Literal["udhaar", "jama"] = "udhaar"
    relative_date: str = "today"
    note: str = ""


class QueryTarget(BaseModel):
    customer_name: Optional[str] = None
    query_type: Literal["total_credit_today", "total_payment_today", "customer_balance", "none"] = "none"


class FollowupEntry(BaseModel):
    customer_name: str = ""
    customer_id: Optional[str] = None
    amount: Optional[Decimal] = None
    entry_type: Literal["udhaar", "jama"] = "udhaar"
    relative_date: str = "today"
    note: str = ""


class ParsedTranscript(BaseModel):
    intent: Literal["TRANSACTION", "QUERY_TODAY_SUMMARY", "QUERY_CUSTOMER_BALANCE", "DISAMBIGUATION", "UNKNOWN"] = "UNKNOWN"
    language_detected: str = "hi"
    entries: list[ParsedEntry] = Field(default_factory=list)
    query_target: QueryTarget = Field(default_factory=QueryTarget)
    needs_clarification: bool = False
    spoken_response: str = ""
    _fallback_issue: Optional[str] = PrivateAttr(default=None)


class FollowupResult(BaseModel):
    action: Literal["ANSWER", "CORRECT", "CONFIRM", "CANCEL", "CLARIFY"] = "CLARIFY"
    normalized_answer: str = ""
    updated_entry: FollowupEntry = Field(default_factory=FollowupEntry)
    spoken_response: str = ""
    _fallback_issue: Optional[str] = PrivateAttr(default=None)


class ShortVoiceQuestion(BaseModel):
    question: str = Field(min_length=1, max_length=240)


_cache: dict[str, tuple[float, ParsedTranscript]] = {}
_cache_lock = threading.Lock()
_CACHE_TTL = 45
_CACHE_MAX = 256


def _normalize_model_name(model: str) -> str:
    value = str(model or "").strip()
    if value.casefold().startswith("models/"):
        value = value[7:]
    display_name = re.fullmatch(
        r"gemini\s+([0-9]+(?:\.[0-9]+)*)\s+(flash(?:\s+lite)?|pro)",
        value,
        flags=re.IGNORECASE,
    )
    if display_name:
        family = display_name.group(2).casefold().replace(" ", "-")
        return f"gemini-{display_name.group(1)}-{family}"
    return value


@lru_cache(maxsize=2)
def _client(api_key: str, model: str):
    from google import genai
    from google.genai import types

    return genai.Client(api_key=api_key, http_options=types.HttpOptions(timeout=10000)), _normalize_model_name(model)


_SYSTEM = """You are VoiceKhata AI, a respectful Indian kirana ledger assistant. Parse noisy spoken text in Hindi, Hinglish, Tamil, Telugu, Bengali, Marathi, Kannada, Gujarati, and English. Return only JSON matching the supplied schema. Understand udhaar as credit given and jama as payment received. Resolve spoken numerals and colloquial amounts (dhai sau=250, dedh sau=150, teen sau chaalis=340, three-forty=340, ek hazar do sau=1200). Preserve each ledger event as a separate entry, with relative dates today/yesterday or YYYY-MM-DD. For self-correction, keep the final corrected value and discard the earlier one. Never invent a customer; use shop context to resolve names. If names collide, ask a concise clarification naming the choices. CUSTOMER NAME SCRIPT RULE: Write every new customer_name and query_target.customer_name only in Latin/English letters, even when the spoken transcript is in Devanagari or another Indian script. Transliterate the spoken name phonetically; do not translate its meaning. If matching an existing customer from shop context, return that customer's stored name exactly. Do not add sentence words such as hua, hue, hai, or hain to a name. If unsure of the spelling, ask a short clarification instead of returning an Indian-script name. Keep notes/transcript and spoken_response in their natural language. For database queries, use the supplied computed facts only. Keep spoken_response short and in the speaker's language. The first response in a new conversation should disclose: Main VoiceKhata AI assistant hoon."""

_FOLLOWUP_SYSTEM = """You are VoiceKhata AI handling one shop-ledger clarification turn. Understand the shopkeeper's answer in any Indian language or code-mix relative to the exact assistant question and current pending entry. Do not use rigid keyword matching: infer intent from the full utterance. Return JSON only. Choose ANSWER when the reply answers the asked question; normalize normalized_answer to a short canonical answer for the app (amount as digits, udhaar/jama, yes/no, old/new, or a customer name). Write new customer names only with Latin/English letters by phonetic transliteration; for an existing matched customer, preserve the stored name exactly, including its script. Choose CORRECT when the user changes any pending ledger detail, even if correcting a different field than the question asked; update only what the user clearly corrected and preserve all other current details. Choose CONFIRM only for a clear approval to save the current transaction, and CANCEL only for a clear refusal/cancellation. If uncertain or customer identity is ambiguous, choose CLARIFY and ask one concise question in the user's language. Never confirm on an ambiguous reply. Use the supplied customer list to resolve an existing customer; don't invent IDs. spoken_response must be the clarification prompt when action=CLARIFY, otherwise may be a short acknowledgement."""

_DEVANAGARI_CONSONANTS = {
    "क": "k", "ख": "kh", "ग": "g", "घ": "gh", "ङ": "n", "च": "ch", "छ": "chh",
    "ज": "j", "झ": "jh", "ञ": "ny", "ट": "t", "ठ": "th", "ड": "d", "ढ": "dh",
    "ण": "n", "त": "t", "थ": "th", "द": "d", "ध": "dh", "न": "n", "प": "p",
    "फ": "ph", "ब": "b", "भ": "bh", "म": "m", "य": "y", "र": "r", "ल": "l",
    "व": "v", "श": "sh", "ष": "sh", "स": "s", "ह": "h",
}
_DEVANAGARI_VOWELS = {
    "अ": "a", "आ": "a", "इ": "i", "ई": "i", "उ": "u", "ऊ": "u", "ऋ": "ri",
    "ए": "e", "ऐ": "ai", "ओ": "o", "औ": "au",
}
_DEVANAGARI_MATRAS = {
    "ा": "a", "ि": "i", "ी": "i", "ु": "u", "ू": "u", "ृ": "ri", "े": "e",
    "ै": "ai", "ो": "o", "ौ": "au",
}
_NAME_FILLER_WORDS = {
    "rupee", "rupees", "rs", "inr", "paisa", "paise", "ka", "ke", "ki", "ko", "se", "ne", "par",
    "udhaar", "udhar", "credit", "debit", "jama", "payment", "paid", "received", "likho", "likh",
    "add", "record", "entry", "customer", "today", "aaj", "kal", "rupaye", "rupya", "hue", "hua",
    "hai", "hain", "tha", "the", "thi", "ho", "and", "is", "was", "were",
    "रुपये", "रुपए", "रुपया", "रुपयों", "पैसे", "पैसा", "पैसों", "उधार", "उधर", "उधारी", "जमा",
    "लिखो", "लिख", "कर", "करो", "आज", "कल", "का", "के", "की", "को", "ने", "से", "पर", "और",
    "हुए", "हुआ", "हुई", "हुईं", "है", "हैं", "था", "थे", "थी", "हूँ", "हो", "हों",
}


def _transliterate_devanagari_word(word: str) -> str:
    output = []
    index = 0
    ends_with_inherent_vowel = False
    while index < len(word):
        char = word[index]
        if char in _DEVANAGARI_CONSONANTS:
            output.append(_DEVANAGARI_CONSONANTS[char])
            if index + 1 < len(word) and word[index + 1] == "्":
                index += 2
                ends_with_inherent_vowel = False
            elif index + 1 < len(word) and word[index + 1] in _DEVANAGARI_MATRAS:
                output.append(_DEVANAGARI_MATRAS[word[index + 1]])
                index += 2
                ends_with_inherent_vowel = False
            else:
                output.append("a")
                index += 1
                ends_with_inherent_vowel = True
        elif char in _DEVANAGARI_VOWELS:
            output.append(_DEVANAGARI_VOWELS[char])
            index += 1
            ends_with_inherent_vowel = False
        elif char in {"ं", "ँ"}:
            output.append("n")
            index += 1
            ends_with_inherent_vowel = False
        elif char == "ः":
            output.append("h")
            index += 1
            ends_with_inherent_vowel = False
        else:
            # Nukta and joiner marks modify the preceding sound; dropping them
            # keeps the simple Latin spelling usable for customer lookup.
            index += 1
    if ends_with_inherent_vowel and output and output[-1] == "a":
        output.pop()
    return "".join(output)


def _transliterate_devanagari(text: str) -> str:
    return re.sub(r"[\u0900-\u097f]+", lambda match: _transliterate_devanagari_word(match.group(0)), str(text or ""))


def _clean_customer_name(value: str) -> str:
    devanagari = bool(re.search(r"[\u0900-\u097f]", str(value or "")))
    words = re.findall(r"[\w\u0900-\u097f]+", str(value or ""), flags=re.UNICODE)
    words = [word for word in words if word.casefold() not in _NAME_FILLER_WORDS and not word.isdigit()]
    cleaned = _transliterate_devanagari(" ".join(words)).strip()
    if devanagari:
        cleaned = " ".join(word[:1].upper() + word[1:] for word in cleaned.split())
    return cleaned[:120]


def display_customer_name(value: str) -> str:
    """Return a customer's readable Latin-script name for all app/API surfaces."""
    return _clean_customer_name(value)


def _canonical_customer_name(value: str, customers: list[dict]) -> str:
    cleaned = _clean_customer_name(value)
    normalized = normalize_local_name(cleaned)
    matches = [str(customer.get("name", "")).strip() for customer in customers
               if customer.get("name") and normalize_local_name(str(customer["name"])) == normalized]
    return matches[0] if len(matches) == 1 else cleaned


def _canonicalize_parsed_names(parsed: ParsedTranscript, customers: list[dict]) -> ParsedTranscript:
    for entry in parsed.entries:
        entry.customer_name = _canonical_customer_name(entry.customer_name, customers)
    if parsed.query_target.customer_name:
        parsed.query_target.customer_name = _canonical_customer_name(parsed.query_target.customer_name, customers)
    return parsed


def _is_clear_single_customer_entry(transcript: str, context: dict, parsed: ParsedTranscript) -> bool:
    """Use the fast local path only for a clear entry matched to one existing account."""
    if parsed.intent != "TRANSACTION" or parsed.needs_clarification or len(parsed.entries) != 1 or parsed.entries[0].amount <= 0:
        return False
    text = _transliterate_devanagari(transcript.casefold())
    if re.search(r"\b(?:actually|instead|correction|sorry|but|phir|then|or|maybe|perhaps|shayad)\b|नहीं|नही|गलत|मतलब|बल्कि|फिर|या|शायद", text):
        return False
    if re.search(r"[,;]", text) or len(re.findall(r"\d+(?:\.\d{1,2})?", text)) > 1:
        return False
    if not re.search(r"\d|ek hazar|teen sau|dhai sau|dedh sau|एक हजार|एक हज़ार|तीन सौ|ढाई सौ|डेढ़ सौ", text):
        return False
    if not re.search(r"udhaar|udhar|उधार|credit|jama|जमा|payment|paid", text):
        return False
    names = [str(customer.get("name", "")).strip() for customer in context.get("customers", []) if customer.get("name")]
    matches = [name for name in names if re.search(rf"(?<!\w){re.escape(normalize_local_name(name))}(?!\w)", text)]
    return len(matches) == 1 and normalize_local_name(parsed.entries[0].customer_name) == normalize_local_name(matches[0])


def _cache_key(transcript: str, context: dict) -> str:
    return hashlib.sha256((transcript + "\0" + json.dumps(context, sort_keys=True, default=str, ensure_ascii=False)).encode()).hexdigest()


def _cached(key: str) -> Optional[ParsedTranscript]:
    now = time.monotonic()
    with _cache_lock:
        item = _cache.get(key)
        if item and now - item[0] < _CACHE_TTL:
            return item[1].model_copy(deep=True)
        _cache.pop(key, None)
    return None


def _store(key: str, value: ParsedTranscript) -> None:
    with _cache_lock:
        if len(_cache) >= _CACHE_MAX:
            oldest = min(_cache, key=lambda k: _cache[k][0])
            _cache.pop(oldest, None)
        _cache[key] = (time.monotonic(), value.model_copy(deep=True))


def _regex_fallback(transcript: str, context: dict) -> ParsedTranscript:
    text = transcript.strip().translate(str.maketrans("०१२३४५६७८९", "0123456789"))
    lowered = text.casefold()
    matching_text = _transliterate_devanagari(text).casefold()
    customers = context.get("customers", [])
    names = [str(c.get("name", "")) for c in customers if c.get("name")]
    matches = [name for name in names if re.search(
        rf"(?<!\w){re.escape(normalize_local_name(name))}(?!\w)", matching_text
    )]
    if len(matches) > 1:
        return ParsedTranscript(intent="DISAMBIGUATION", needs_clarification=True,
                                spoken_response=f"Aap {matches[0]} ki baat kar rahe hain ya {matches[1]} ki?")
    if any(word in lowered for word in ("kitna", "कितना", "total", "कुल", "balance", "baaki", "baki", "बाकी", "how much")):
        if any(word in lowered for word in ("aaj", "आज", "today", "gaya", "गया", "diya", "दिया")):
            typ = "total_payment_today" if any(w in lowered for w in ("jama", "जमा", "payment", "diya", "दिया")) else "total_credit_today"
            return ParsedTranscript(intent="QUERY_TODAY_SUMMARY", query_target=QueryTarget(query_type=typ))
        if matches:
            return ParsedTranscript(intent="QUERY_CUSTOMER_BALANCE", query_target=QueryTarget(customer_name=matches[0], query_type="customer_balance"))
        return ParsedTranscript(intent="UNKNOWN")

    # Last mentioned amount wins, covering common mid-sentence corrections.
    amount_patterns = [
        r"(?<!\d)\d[\d,]*(?:\.\d{1,2})?(?!\d)",
        r"(?<![\w])(?:ek hazar do sau|teen sau chaalis|dhai sau|dedh sau|dhai|dedh|teen sau|do sau|char sau|paanch sau)(?![\w])",
        r"(?<![\w])(?:एक हजार दो सौ|एक हज़ार दो सौ|तीन सौ चालीस|ढाई सौ|डेढ़ सौ|तीन सौ|दो सौ|चार सौ|पांच सौ|पाँच सौ)(?![\w])",
    ]
    tokens = [(m.start(), m.group(0)) for pattern in amount_patterns for m in re.finditer(pattern, lowered)]
    if not tokens:
        return ParsedTranscript(intent="UNKNOWN")
    token = max(tokens)[1]
    colloquial = {"dhai": "250", "dhai sau": "250", "dedh": "150", "dedh sau": "150", "teen sau chaalis": "340", "ek hazar do sau": "1200", "teen sau": "300", "do sau": "200", "char sau": "400", "paanch sau": "500",
                  "ढाई सौ": "250", "डेढ़ सौ": "150", "तीन सौ चालीस": "340", "एक हजार दो सौ": "1200", "एक हज़ार दो सौ": "1200", "तीन सौ": "300", "दो सौ": "200", "चार सौ": "400", "पांच सौ": "500", "पाँच सौ": "500"}
    try:
        amount = Decimal(colloquial.get(token, token))
    except Exception:
        return ParsedTranscript(intent="UNKNOWN")
    kind = "jama" if any(w in lowered for w in ("jama", "जमा", "payment", "diya", "दिया", "paid")) else "udhaar"
    # Keep each comma-delimited event. Within a single correction clause, the
    # last amount wins; earlier values are discarded.
    parts = re.split(r"[,;]|\b(?:and then|phir)\b", text, flags=re.I)
    entries = []
    for part in parts:
        part_tokens = [(m.start(), m.group(0)) for pattern in amount_patterns for m in re.finditer(pattern, part)]
        if not part_tokens:
            continue
        val = max(part_tokens)[1]
        try:
            part_amount = Decimal(colloquial.get(val, val))
        except Exception:
            continue
        if any(w in part for w in ("jama", "जमा", "payment", "diya", "दिया", "paid")):
            part_kind = "jama"
        elif any(w in part for w in ("udhaar", "udhar", "उधार", "उधार", "credit", "likho", "likh", "लिखो", "लिख")):
            part_kind = "udhaar"
        else:
            part_kind = kind
        part_date = "yesterday" if any(w in part for w in ("kal", "yesterday")) else "today"
        part_match_text = _transliterate_devanagari(part).casefold()
        part_matches = [name for name in names if re.search(
            rf"(?<!\w){re.escape(normalize_local_name(name))}(?!\w)", part_match_text
        )]
        customer_name = part_matches[0] if len(part_matches) == 1 else _extract_fallback_customer_name(part, amount_patterns)
        entries.append(ParsedEntry(customer_name=customer_name, amount=part_amount,
                                   entry_type=part_kind, relative_date=part_date))
    if not entries:
        entries = [ParsedEntry(customer_name=matches[0] if matches else "", amount=amount, entry_type=kind)]
    return ParsedTranscript(intent="TRANSACTION", entries=entries)


def _extract_fallback_customer_name(text: str, amount_patterns: list[str]) -> str:
    cleaned = text
    for pattern in amount_patterns:
        cleaned = re.sub(pattern, " ", cleaned, flags=re.IGNORECASE)
    return _clean_customer_name(cleaned)


def _question_preserves_clarification(draft: str, question: str, candidate_names: list[str]) -> bool:
    """Reject a fluent AI question if it changes the ledger decision being asked."""
    normalized = question.casefold()
    # A customer's physical location is never relevant to choosing a ledger account.
    if re.search(
        r"\b(?:paas|near|nearby|door|far|location|located|at the shop|in the shop)\b"
        r"|पास|नज़दीक|नजदीक|दूर|कहाँ|कहां|दुकान पर|दुकान में",
        normalized,
    ):
        return False

    asks_old_or_new = bool(
        re.search(r"पुरान|\b(?:old|existing)\b", draft.casefold())
        and re.search(r"नय|\bnew\b", draft.casefold())
    )
    if asks_old_or_new:
        asks_old = bool(re.search(r"पुरान|\b(?:old|existing)\b", normalized))
        asks_new = bool(re.search(r"नय|\bnew\b", normalized))
        if not (asks_old and asks_new):
            return False

    asks_new_customer = bool(re.search(r"नया ग्राहक|new customer", draft.casefold()))
    if asks_new_customer and not re.search(r"नय|\bnew\b", normalized):
        return False

    asks_name = bool(re.search(r"नाम|\bname\b", draft.casefold()))
    if asks_name and not re.search(r"नाम|\bname\b", normalized):
        return False

    # When choosing among accounts, retain each distinguishing name and any
    # supplied phone suffix. This prevents a short rewrite from erasing choices.
    if len(candidate_names) > 1:
        for candidate in candidate_names:
            name = candidate.split("(", 1)[0].strip()
            if name and name.casefold() not in normalized:
                return False
            suffix = re.search(r"\d{2,}", candidate)
            if suffix and suffix.group(0) not in normalized:
                return False
    return True


def normalize_local_name(value: str) -> str:
    return " ".join(_transliterate_devanagari(str(value or "")).split()).casefold()


async def parse_transcript(transcript: str, shop_context: dict) -> ParsedTranscript:
    """Parse with a bounded provider wait; return a safe local parse on failure."""
    key = _cache_key(transcript, shop_context)
    result = _cached(key)
    if result:
        return result
    settings = get_settings()
    customers = shop_context.get("customers", [])
    fallback = _canonicalize_parsed_names(_regex_fallback(transcript, shop_context), customers)
    if _is_clear_single_customer_entry(transcript, shop_context, fallback):
        _store(key, fallback)
        return fallback
    api_key = (settings.gemini_api_key or "").strip()
    if not api_key:
        _store(key, fallback)
        return fallback

    prompt = (f"Shop context: {json.dumps(shop_context, ensure_ascii=False, default=str)}\n"
              f"Current UTC date: {datetime.now(timezone.utc).date().isoformat()}\n"
              f"Shopkeeper said: {transcript}")
    try:
        client, model = _client(api_key, settings.gemini_model)
        from google.genai import types

        response = await asyncio.wait_for(asyncio.to_thread(
            client.models.generate_content,
            model=model,
            contents=prompt,
            config=types.GenerateContentConfig(
                system_instruction=_SYSTEM,
                response_mime_type="application/json",
                response_schema=ParsedTranscript,
                temperature=0,
            ),
        ), timeout=10.0)
        parsed = ParsedTranscript.model_validate_json(response.text or "{}")
        parsed = _canonicalize_parsed_names(parsed, customers)
        _store(key, parsed)
        return parsed
    except Exception as exc:
        logger.warning("Gemini parsing failed; using the local parser (%s)", type(exc).__name__)
        if "API_KEY_INVALID" in str(exc):
            fallback._fallback_issue = "Google rejected GEMINI_API_KEY. Replace it in the backend .env, then restart VoiceKhata."
        else:
            fallback._fallback_issue = "Gemini is unavailable; VoiceKhata used local fallback parsing."
        _store(key, fallback)
        return fallback


def _fallback_followup(question: str, transcript: str, current_entry: dict) -> FollowupResult:
    text = transcript.strip()
    words = set(re.findall(r"[\w\u0900-\u097f]+", text.casefold()))
    no_words = {"no", "nahi", "nahin", "नहीं", "नही", "ना", "रद्द", "cancel", "मत"}
    yes_words = {"yes", "yeah", "haan", "han", "हाँ", "हां", "जी", "सही", "ठीक", "confirm", "save"}
    detected = _regex_fallback(text, {"customers": []})
    updated = dict(current_entry)
    if detected.entries and (any(char.isdigit() for char in text) or any(w in text for w in ("सौ", "हज़ार", "हजार", "ढाई", "डेढ़"))):
        updated["amount"] = str(detected.entries[-1].amount)
        if any(w in text.casefold() for w in ("udhaar", "udhar", "उधार", "credit", "जमा", "jama", "payment")):
            updated["entry_type"] = detected.entries[-1].entry_type
        return FollowupResult(action="CORRECT", updated_entry=updated)
    if words & no_words:
        return FollowupResult(action="CANCEL", normalized_answer="no", updated_entry=current_entry)
    if words & yes_words and any(w in question.casefold() for w in ("confirm", "save", "सही है", "सेव", "हाँ")):
        return FollowupResult(action="CONFIRM", normalized_answer="yes", updated_entry=current_entry)
    if any(w in text.casefold() for w in ("udhaar", "udhar", "उधार", "credit")):
        updated["entry_type"] = "udhaar"
        return FollowupResult(action="ANSWER", normalized_answer="udhaar", updated_entry=updated)
    if any(w in text.casefold() for w in ("jama", "जमा", "payment", "paid")):
        updated["entry_type"] = "jama"
        return FollowupResult(action="ANSWER", normalized_answer="jama", updated_entry=updated)
    return FollowupResult(action="ANSWER", normalized_answer=text, updated_entry=updated)


def _classify_customer_choice(question: str, transcript: str, current_entry: dict) -> Optional[FollowupResult]:
    """Resolve clear old/new answers before the model can mislabel them as corrections."""
    question_text = question.casefold()
    answer_text = transcript.casefold().strip()
    asks_old_or_new = (
        bool(re.search(r"पुरान|\b(?:old|existing|purana|purani|purane|pehle)\b", question_text))
        and bool(re.search(r"नय|\b(?:new|naya|nayi|naye)\b", question_text))
    )
    if asks_old_or_new:
        says_old = bool(re.search(r"पुरान|\b(?:old|existing|purana|purani|purane|pehle)\b|पहले|वही", answer_text))
        says_new = bool(re.search(r"नय|\b(?:new|naya|nayi|naye)\b", answer_text))
        if says_old != says_new:
            return FollowupResult(
                action="ANSWER",
                normalized_answer="old" if says_old else "new",
                updated_entry=FollowupEntry.model_validate(current_entry),
            )

    asks_if_new = bool(re.search(r"नया ग्राहक|नया कस्टमर|\b(?:new|naya|nayi|naye) customer\b|नया है|नया खाता", question_text))
    if asks_if_new:
        says_yes = bool(re.search(r"\b(?:yes|yeah|yep|haan|han|ji|ha)\b|हाँ|हां|जी|हाँजी", answer_text))
        says_no = bool(re.search(r"\b(?:no|nahi|nahin)\b|नहीं|नही|ना", answer_text))
        if says_yes != says_no:
            return FollowupResult(
                action="ANSWER",
                normalized_answer="yes" if says_yes else "no",
                updated_entry=FollowupEntry.model_validate(current_entry),
            )
    return None


async def parse_followup(question: str, transcript: str, current_entry: dict, shop_context: dict) -> FollowupResult:
    settings = get_settings()
    fallback = _fallback_followup(question, transcript, current_entry)
    customer_choice = _classify_customer_choice(question, transcript, current_entry)
    if customer_choice is not None:
        return customer_choice
    question_is_confirmation = bool(re.search(r"confirm|save|सेव|सही है|पक्का", question.casefold()))
    answer = transcript.strip().casefold().strip(" .!?,।")
    if question_is_confirmation and fallback.action == "CANCEL" and re.fullmatch(r"(?:no|nahi|nahin|नहीं|नही|ना|रद्द|cancel|मत)(?:\s+(?:please|करो|करना))?", answer):
        return fallback


    if question_is_confirmation and fallback.action == "CONFIRM" and re.fullmatch(r"(?:yes|yeah|yep|haan|han|हाँ|हां|जी|सही|ठीक|confirm|save)(?:\s+(?:hai|है|हैं|जी|ji))?", answer):
        return fallback
    api_key = (settings.gemini_api_key or "").strip()
    if not api_key:
        return fallback
    prompt = (f"Shop context: {json.dumps(shop_context, ensure_ascii=False, default=str)}\n"
              f"Pending entry: {json.dumps(current_entry, ensure_ascii=False, default=str)}\n"
              f"Assistant question: {question}\nShopkeeper reply: {transcript}")
    try:
        client, model = _client(api_key, settings.gemini_model)
        from google.genai import types

        response = await asyncio.wait_for(asyncio.to_thread(
            client.models.generate_content,
            model=model,
            contents=prompt,
            config=types.GenerateContentConfig(
                system_instruction=_FOLLOWUP_SYSTEM,
                response_mime_type="application/json",
                response_schema=FollowupResult,
                temperature=0,
            ),
        ), timeout=10.0)
        result = FollowupResult.model_validate_json(response.text or "{}")
        result.updated_entry.customer_name = _canonical_customer_name(
            result.updated_entry.customer_name, shop_context.get("customers", [])
        )
        return result
    except Exception as exc:
        logger.warning("Gemini follow-up parsing failed; using local interpretation (%s)", type(exc).__name__)
        if "API_KEY_INVALID" in str(exc):
            fallback._fallback_issue = "Google rejected GEMINI_API_KEY. Replace it in the backend .env, then restart VoiceKhata."
        else:
            fallback._fallback_issue = "Gemini is unavailable; this reply used local interpretation."
        return fallback


async def make_short_voice_question(draft_question: str, current_entry: dict, candidate_names: list[str], language_code: str) -> tuple[str, Optional[str]]:
    """Turn a required clarification into one brief, speakable Hindi/Hinglish question."""
    settings = get_settings()
    draft = " ".join(draft_question.split())
    draft_words = re.findall(r"[\w\u0900-\u097f]+", draft.casefold())
    asks_old_or_new = (
        bool(re.search(r"पुरान|\b(?:old|existing|purana|purani|purane)\b", draft.casefold()))
        and bool(re.search(r"नय|\b(?:new|naya|nayi|naye)\b", draft.casefold()))
    )
    # These short, safety-critical choices are already phrased clearly by the
    # app. Avoid a slow model round-trip that only rewords the same question.
    if asks_old_or_new and len(draft_words) <= 18:
        return draft, None
    api_key = (settings.gemini_api_key or "").strip()
    if not api_key:
        return draft, "Gemini is not configured; using the short built-in question."

    prompt = (
        f"Language: {language_code}.\n"
        f"Required clarification (preserve its meaning and every necessary choice): {draft}\n"
        f"Current ledger details: {json.dumps(current_entry, ensure_ascii=False, default=str)}\n"
        f"Known customer choices (use only these names): {json.dumps(candidate_names, ensure_ascii=False)}"
    )
    try:
        client, model = _client(api_key, settings.gemini_model)
        from google.genai import types

        response = await asyncio.wait_for(asyncio.to_thread(
            client.models.generate_content,
            model=model,
            contents=prompt,
            config=types.GenerateContentConfig(
                system_instruction=(
                    "Write exactly one short spoken question in Hindi/Hinglish. Aim for 4–10 words and one sentence. "
                    "Keep all information needed to answer safely, including customer choices or whether the entry is udhaar/jama. "
                    "For customer identity, ask only old/existing versus new, or name the supplied account choices. "
                    "Never ask whether a customer is near, far, at the shop, or where they are. "
                    "Do not add greetings, explanations, amounts, names, choices, or facts not supplied. Return JSON only."
                ),
                response_mime_type="application/json",
                response_schema=ShortVoiceQuestion,
                temperature=0.2,
            ),
        ), timeout=6.0)
        question = " ".join(ShortVoiceQuestion.model_validate_json(response.text or "{}").question.split())
        required_digits = re.findall(r"\d{2,}", draft)
        question_words = re.findall(r"[\w\u0900-\u097f]+", question.casefold())
        if (not question or len(question) > 180 or len(question_words) > 16
                or any(number not in question for number in required_digits)
                or not _question_preserves_clarification(draft, question, candidate_names)):
            return draft, "Gemini returned an invalid question; using the short built-in question."
        return question, None
    except Exception as exc:
        logger.warning("Gemini short-question generation failed (%s)", type(exc).__name__)
        notice = "Gemini is unavailable; using the short built-in question."
        if "API_KEY_INVALID" in str(exc):
            notice = "Google rejected GEMINI_API_KEY; using the short built-in question."
        return draft, notice
