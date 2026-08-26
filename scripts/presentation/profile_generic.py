"""
Generic branding profile for generate_presentation.py.

This profile produces a presentation suitable for any organisation.
For a client-specific branded deck, use a private profile with --profile.
"""

BRAND = {
    # ── Organisation ──────────────────────────────────────────────────────────
    "org":             "your organisation",
    "org_poss":        "your organisation's",
    "org_upper":       "YOUR ORG  ·  AGENT PLATFORM",

    # ── Platform ──────────────────────────────────────────────────────────────
    "platform":        "the agent platform",
    "platform_title":  "AGENT PLATFORM",

    # ── LLM platform ──────────────────────────────────────────────────────────
    "llm_platform":    "In-House LLM",

    # ── Attribution ───────────────────────────────────────────────────────────
    "prepared_by":     "Prepared by: Senior AI Engineer",

    # ── Output ────────────────────────────────────────────────────────────────
    "out_stem":        "web-intelligence-brief",

    # ── Palette — navy, nobody's brand ────────────────────────────────────────
    "primary":         (0x1B, 0x3A, 0x5C),
    "primary_dark":    (0x12, 0x28, 0x40),
    "primary_tint":    (0xEC, 0xF1, 0xF7),

    # ── Notes substitutions — empty for the generic profile ───────────────────
    # The internal profile populates this list to restore org-specific copy
    # in speaker notes at runtime (see generate_presentation.py:_b()).
    "note_subs": [],
}
