"""Offline coverage for representative Gemini parsing and fallback cases."""
import asyncio
from types import SimpleNamespace

from app import gemini_service


def parse_offline(monkeypatch, transcript, customers=None):
    monkeypatch.setattr(gemini_service, "get_settings", lambda: SimpleNamespace(gemini_api_key=None))
    return asyncio.run(gemini_service.parse_transcript(transcript, {"customers": customers or []}))


def test_single_credit(monkeypatch):
    result = parse_offline(monkeypatch, "Ramesh ka 500 udhaar", [{"name": "Ramesh"}])
    assert result.intent == "TRANSACTION"
    assert [(entry.customer_name, entry.amount, entry.entry_type) for entry in result.entries] == [
        ("Ramesh", 500, "udhaar")
    ]


def test_amount_attached_to_rupee_suffix_and_new_name(monkeypatch):
    result = parse_offline(monkeypatch, "Akshay Kumar ke 500rs udhaar likho")
    assert result.intent == "TRANSACTION"
    assert [(entry.customer_name, entry.amount, entry.entry_type) for entry in result.entries] == [
        ("Akshay Kumar", 500, "udhaar")
    ]


def test_devanagari_name_is_transliterated_and_sentence_filler_removed():
    result = gemini_service._regex_fallback(
        "करण पटेरिया हुए 500 रुपये उधार लिखो", {"customers": []}
    )
    assert result.entries[0].customer_name == "Karan Pateriya"
    assert "हुए" not in result.entries[0].customer_name


def test_devanagari_name_matches_existing_latin_customer():
    result = gemini_service._regex_fallback(
        "करण के 500 रुपये उधार लिखो", {"customers": [{"name": "Karan"}]}
    )
    assert result.entries[0].customer_name == "Karan"


def test_existing_devanagari_customer_is_returned_in_latin_script():
    parsed = gemini_service.ParsedTranscript(
        intent="TRANSACTION",
        entries=[gemini_service.ParsedEntry(customer_name="अभय पटेरिया हुए", amount=500)],
    )
    result = gemini_service._canonicalize_parsed_names(
        parsed, [{"name": "अभय पटेरिया"}]
    )
    assert result.entries[0].customer_name == "अभय पटेरिया"


def test_gemini_display_model_name_is_normalized_to_api_id():
    assert gemini_service._normalize_model_name("Gemini 3.5 Flash Lite") == "gemini-3.5-flash-lite"
    assert gemini_service._normalize_model_name("models/gemini-3.5-flash-lite") == "gemini-3.5-flash-lite"


def test_multi_action_and_relative_date(monkeypatch):
    result = parse_offline(monkeypatch, "Ramesh 300 udhaar, kal 100 jama", [{"name": "Ramesh"}])
    assert [(entry.amount, entry.entry_type, entry.relative_date) for entry in result.entries] == [
        (300, "udhaar", "today"), (100, "jama", "yesterday")
    ]


def test_spoken_correction_keeps_final_amount(monkeypatch):
    result = parse_offline(monkeypatch, "Suresh 200 nahi 250 likho", [{"name": "Suresh"}])
    assert len(result.entries) == 1
    assert result.entries[0].amount == 250


def test_query_today_summary(monkeypatch):
    result = parse_offline(monkeypatch, "Aaj kitna udhaar gaya?")
    assert result.intent == "QUERY_TODAY_SUMMARY"
    assert result.query_target.query_type == "total_credit_today"


def test_code_mix_tamil_telugu_and_hinglish(monkeypatch):
    tamil = parse_offline(monkeypatch, "Suresh-ku 500 kadan ezhuthu", [{"name": "Suresh"}])
    telugu = parse_offline(monkeypatch, "Ramesh ki 300 udhaar raayi", [{"name": "Ramesh"}])
    hinglish = parse_offline(monkeypatch, "Ramesh ka dhai sau udhaar", [{"name": "Ramesh"}])
    assert tamil.entries[0].amount == 500 and tamil.entries[0].customer_name == "Suresh"
    assert telugu.entries[0].amount == 300
    assert hinglish.entries[0].amount == 250


def test_devanagari_spoken_amount_fallback(monkeypatch):
    result = parse_offline(monkeypatch, "रमेश के पाँच सौ रुपये उधार", [{"name": "रमेश"}])
    assert result.intent == "TRANSACTION"
    assert result.entries[0].amount == 500
    assert result.entries[0].entry_type == "udhaar"


def test_followup_confirmation_and_cancellation():
    current = {"customer_name": "Ramesh", "amount": "500", "entry_type": "udhaar"}
    yes = gemini_service._fallback_followup("Save this entry?", "haan ji", current)
    no = gemini_service._fallback_followup("Save this entry?", "nahi cancel", current)
    correction = gemini_service._fallback_followup("Is this correct?", "nahi, 650 likho", current)
    assert yes.action == "CONFIRM"
    assert no.action == "CANCEL"
    assert correction.action == "CORRECT" and correction.updated_entry.amount == 650


def test_customer_choice_followups_do_not_become_transaction_corrections():
    current = {"customer_name": "Abhay Pateriya", "amount": "500", "entry_type": "udhaar"}
    choose_new = gemini_service._classify_customer_choice(
        "Abhay pehle se hai. Purana account ya naya customer?", "naya hai", current
    )
    choose_old = gemini_service._classify_customer_choice(
        "Abhay pehle se hai. Purana account ya naya customer?", "purana hai", current
    )
    yes_new = gemini_service._classify_customer_choice(
        "Abhay nahi mila. Naya customer hai?", "haan", current
    )
    assert choose_new.action == "ANSWER" and choose_new.normalized_answer == "new"
    assert choose_old.action == "ANSWER" and choose_old.normalized_answer == "old"
    assert yes_new.action == "ANSWER" and yes_new.normalized_answer == "yes"


def test_question_guard_rejects_irrelevant_proximity_question():
    draft = "Akshay Kumar nahi mila. Naya customer hai?"
    assert not gemini_service._question_preserves_clarification(
        draft, "Akshay Kumar paas hai ya door?", []
    )
    assert gemini_service._question_preserves_clarification(
        draft, "Akshay Kumar naya customer hai?", []
    )


def test_question_guard_keeps_old_new_choice_and_distinguishing_accounts():
    draft = "Ramesh pehle se hai. Purana khata ya naya customer?"
    assert not gemini_service._question_preserves_clarification(
        draft, "Kya Ramesh paas hain?", ["Ramesh (ending 1234)"]
    )
    assert gemini_service._question_preserves_clarification(
        draft, "Purana account ya naya customer?", ["Ramesh (ending 1234)"]
    )
