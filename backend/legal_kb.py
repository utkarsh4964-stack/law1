"""
A small, curated, LOCAL knowledge base used for two demo features:
  - "Legal Knowledge" chat mode (grounds answers in these entries instead
    of the case documents)
  - "Similar Cases" (compares the current case against these precedents)

This is intentionally a short, illustrative set for demo purposes - not a
real legal database. In a production build this would be replaced with a
proper indexed corpus (e.g. Indian Kanoon API, a licensed case database,
or an internal precedent library) behind the same interface below.
"""

LEGAL_PROVISIONS = [
    {
        "id": "LP-001",
        "title": "Cheating and dishonestly inducing delivery of property",
        "area": "Financial fraud",
        "note": "Applies where a person deceives another to induce them to part with property or money.",
    },
    {
        "id": "LP-002",
        "title": "Criminal breach of trust",
        "area": "Financial fraud / employment",
        "note": "Applies where a person entrusted with property dishonestly misappropriates it.",
    },
    {
        "id": "LP-003",
        "title": "Forgery of a valuable security or document",
        "area": "Document fraud",
        "note": "Applies where a document is falsely made with intent to cause damage or injury.",
    },
    {
        "id": "LP-004",
        "title": "Prevention of Money Laundering - proceeds of crime",
        "area": "Financial fraud",
        "note": "Applies where property is derived from criminal activity and is projected as untainted.",
    },
    {
        "id": "LP-005",
        "title": "Information Technology Act - identity theft / electronic fraud",
        "area": "Cyber / financial fraud",
        "note": "Applies where electronic records, digital signatures, or identity are fraudulently used.",
    },
    {
        "id": "LP-006",
        "title": "Landlord-tenant security deposit disputes",
        "area": "Civil / tenancy",
        "note": "Governs timelines and conditions for return of a security deposit at end of tenancy.",
    },
]

SIMILAR_CASE_LIBRARY = [
    {
        "id": "PREC-2031",
        "title": "State v. Undisclosed Financial Intermediary",
        "summary": "A case involving layered bank transfers between an individual and a shell entity, "
                    "used to obscure the origin of funds, uncovered through bank statement cross-referencing.",
        "tags": ["financial fraud", "bank transfer", "shell entity", "money laundering"],
        "outcome": "Charges framed under breach of trust and money-laundering provisions after "
                    "transaction timeline corroborated witness statements.",
    },
    {
        "id": "PREC-4172",
        "title": "Regional Bank v. Disputed Loan Guarantor",
        "summary": "A dispute over whether a payment between two parties represented a loan or a gift, "
                    "resolved primarily through correspondence and bank memo evidence.",
        "tags": ["financial dispute", "payment intent", "correspondence evidence"],
        "outcome": "Payment held to be a loan based on contemporaneous written communication, "
                    "despite absence of a formal signed agreement.",
    },
    {
        "id": "PREC-1187",
        "title": "Complainant v. Withheld Security Deposit",
        "summary": "A landlord-tenant dispute over a withheld security deposit, where the landlord "
                    "alleged property damage not documented at move-in.",
        "tags": ["tenancy", "security deposit", "landlord-tenant"],
        "outcome": "Deposit ordered returned in part; landlord's claim of damage held unsubstantiated "
                    "without move-in condition documentation.",
    },
    {
        "id": "PREC-3309",
        "title": "State v. Forged Purchase Agreement",
        "summary": "A property dispute where one party alleged a purchase agreement had been altered "
                    "after signing; resolved via document forensic comparison.",
        "tags": ["forgery", "document fraud", "property dispute"],
        "outcome": "Alteration confirmed; agreement held void as to the altered clause.",
    },
]
