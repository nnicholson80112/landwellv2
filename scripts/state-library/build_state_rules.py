"""Build src/leases/state-rules.json from the source tables in scripts/state-library/sources.

Run: python3 -I scripts/state-library/build_state_rules.py

sources/ holds text copied from other sites while researching, so it stays out of this public repo
(.gitignore). The built state-rules.json is committed; re-fetch the sources only to rebuild it.

Source tables (fetched 2026-10-23) are compilations, not statutes. Where they disagreed
or were out of date, the value below was checked against the statute or a 2026 source
and the state gets a `verify` note. Nate reviews the rules before documents built on them go out.
"""
import csv, json, os, re

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.join(HERE, "sources")
OUT = os.path.join(HERE, "..", "..", "src", "leases", "state-rules.json")

STATES = {
    "AL": "Alabama", "AK": "Alaska", "AZ": "Arizona", "AR": "Arkansas", "CA": "California",
    "CO": "Colorado", "CT": "Connecticut", "DE": "Delaware", "DC": "District of Columbia",
    "FL": "Florida", "GA": "Georgia", "HI": "Hawaii", "ID": "Idaho", "IL": "Illinois",
    "IN": "Indiana", "IA": "Iowa", "KS": "Kansas", "KY": "Kentucky", "LA": "Louisiana",
    "ME": "Maine", "MD": "Maryland", "MA": "Massachusetts", "MI": "Michigan", "MN": "Minnesota",
    "MS": "Mississippi", "MO": "Missouri", "MT": "Montana", "NE": "Nebraska", "NV": "Nevada",
    "NH": "New Hampshire", "NJ": "New Jersey", "NM": "New Mexico", "NY": "New York",
    "NC": "North Carolina", "ND": "North Dakota", "OH": "Ohio", "OK": "Oklahoma", "OR": "Oregon",
    "PA": "Pennsylvania", "RI": "Rhode Island", "SC": "South Carolina", "SD": "South Dakota",
    "TN": "Tennessee", "TX": "Texas", "UT": "Utah", "VT": "Vermont", "VA": "Virginia",
    "WA": "Washington", "WV": "West Virginia", "WI": "Wisconsin", "WY": "Wyoming",
}
NAME_ALIASES = {"Washington D.C.": "District of Columbia", "Washington, D.C.": "District of Columbia"}

SOURCES = {
    "deposit": "https://nomadlease.com/blog/security-deposit-deadlines-maximums",
    "depositCheck": "https://ipropertymanagement.com/laws/security-deposit-returns",
    "entry": "https://ipropertymanagement.com/laws/landlords-right-to-entry",
    "lateFee": "https://www.baselane.com/resources/late-fees-for-rent",
    "lateFeeCheck": "https://hemlane.com/resources/late-fee-laws-by-state",
    "monthToMonth": "https://ezel.ai/surveys/month-to-month-tenancy-termination-notice",
    "eviction": "https://ipropertymanagement.com/laws/eviction-process",
}


def table(name):
    rows = list(csv.reader(open(os.path.join(SRC, name), encoding="utf-8"), delimiter="|"))
    return [r for r in rows if r and not r[0].startswith("===")]


def clean_state(s):
    s = re.sub(r"\[\d+\]", "", s).replace(";", "").strip()
    s = re.sub(r"\s+verified.*$", "", s)
    return NAME_ALIASES.get(s, s)


def by_state(rows):
    out = {}
    for r in rows:
        name = clean_state(r[0])
        if name in STATES.values():
            out[name] = [re.sub(r"\s*\[\d+\]", "", c).strip() for c in r[1:]]
    return out


deposit = by_state(table("nomad_dep.txt"))
entry = by_state(table("ipm_entry.txt"))
late = by_state(table("baselane_late.txt"))
evict = {NAME_ALIASES.get(k, k): v for k, v in json.load(open(os.path.join(SRC, "evict.json"))).items()}

# Short month-to-month summaries written from the Ezel 50-state survey (verified 2026).
M2M = {
    "AL": ("30 days, written", "30 days, written", False),
    "AK": ("30 days, written", "30 days, written", False),
    "AZ": ("30 days, written", "30 days, written", False),
    "AR": ("30 days, written", "30 days, written", False),
    "CA": ("30 days if tenant has lived there under 1 year; 60 days after 1 year. Just cause required after 12 months for most rentals", "30 days", True),
    "CO": ("21 days for tenancies not covered by Colorado's for-cause law; covered tenancies (12+ months) need a legal cause", "21 days", True),
    "CT": ("No fixed period; tenancy ends at the end of the rental month, then a notice to quit", "Not set by statute", False),
    "DE": ("60 days, written, starting the first of the next month", "60 days, written", False),
    "DC": ("No no-cause termination; a landlord needs a legal ground", "30 days, written", True),
    "FL": ("30 days, written, before the end of a monthly period", "30 days, written", False),
    "GA": ("60 days", "30 days", False),
    "HI": ("45 days, written", "28 days, written", False),
    "ID": ("1 month, written", "1 month, written", False),
    "IL": ("30 days, written", "30 days", False),
    "IN": ("1 month", "1 month", False),
    "IA": ("30 days, written", "30 days, written", False),
    "KS": ("30 days, written", "30 days, written", False),
    "KY": ("30 days, written", "30 days, written", False),
    "LA": ("10 days before the end of the month", "10 days before the end of the month", False),
    "ME": ("30 days, written", "30 days, written", False),
    "MD": ("60 days, written", "30 days, written", False),
    "MA": ("30 days or one rental period, whichever is longer", "Same as landlord", False),
    "MI": ("1 month", "1 month", False),
    "MN": ("One full rental period, written", "One full rental period, written", False),
    "MS": ("30 days, written", "30 days, written", False),
    "MO": ("1 month, written", "1 month, written", False),
    "MT": ("30 days, written", "30 days, written", False),
    "NE": ("30 days, written", "30 days, written", False),
    "NV": ("30 days", "Not set by statute", False),
    "NH": ("30 days, written; good cause required for most residential property", "30 days, written", True),
    "NJ": ("No no-cause termination for covered tenancies; a landlord needs a statutory ground", "1 month", True),
    "NM": ("30 days, written", "30 days, written", False),
    "NY": ("30 days (under 1 year), 60 days (1 to 2 years), 90 days (2+ years); good-cause law in some cities", "1 month", True),
    "NC": ("7 days", "7 days", False),
    "ND": ("1 calendar month", "1 calendar month", False),
    "OH": ("30 days before the end of a rental period", "30 days", False),
    "OK": ("30 days, written", "30 days, written", False),
    "OR": ("30 days in the first year; after the first year only for cause or a qualifying landlord reason (90 days)", "30 days, written", True),
    "PA": ("15 days", "Not set by statute", False),
    "RI": ("30 days, written", "30 days, written", False),
    "SC": ("30 days, written", "30 days, written", False),
    "SD": ("One full rental period (up to 1 month)", "One full rental period", False),
    "TN": ("30 days, written", "30 days, written", False),
    "TX": ("1 month", "1 month", False),
    "UT": ("15 days, ending at the end of a rental period", "Not set by statute", False),
    "VT": ("60 to 90 days depending on how long the tenant has lived there", "One rental period", False),
    "VA": ("30 days, written, before the next rent due date", "30 days, written", False),
    "WA": ("No no-cause termination; a landlord needs a statutory cause", "20 days, written", True),
    "WV": ("One full rental period, written", "One full rental period, written", False),
    "WI": ("28 days, written", "28 days, written", False),
    "WY": ("No statutory period", "No statutory period", False),
}

# Late fees: merged from Baselane and Hemlane, corrected where they conflicted.
LATE = {
    "AL": ("None", "No statutory cap; must be reasonable and in the lease"),
    "AK": ("None", "No statutory cap; must be reasonable and in the lease"),
    "AZ": ("None", "No statutory cap; must be reasonable and in the lease"),
    "AR": ("None", "No statutory cap; must be reasonable and in the lease"),
    "CA": ("None", "No statutory cap; must be a reasonable estimate of the landlord's actual cost"),
    "CO": ("7 days", "Greater of $50 or 5% of the past-due rent"),
    "CT": ("9 days", "Lesser of $5 per day up to $50, or 5% of the late payment"),
    "DE": ("5 days", "5% of monthly rent"),
    "DC": ("5 days", "5% of monthly rent"),
    "FL": ("None", "No statutory cap; must be reasonable and in the lease"),
    "GA": ("None", "No statutory cap; must be reasonable and in the lease"),
    "HI": ("5 days", "8% of monthly rent"),
    "ID": ("None", "No statutory cap; must be reasonable and in the lease"),
    "IL": ("None", "No hard cap; $10 a month on the first $1,000 of rent plus 5% above that is deemed reasonable. Chicago is stricter"),
    "IN": ("None", "No statutory cap; must be reasonable and in the lease"),
    "IA": ("None", "Rent up to $700: $12/day, $60/month max. Over $700: $20/day, $100/month max"),
    "KS": ("None", "No statutory cap; must be reasonable and in the lease"),
    "KY": ("None", "No statutory cap; must be reasonable and in the lease"),
    "LA": ("None", "No statutory cap; must be reasonable and in the lease"),
    "ME": ("15 days", "4% of monthly rent"),
    "MD": ("None", "5% of the rent due"),
    "MA": ("30 days", "No cap, but no fee until rent is 30 days late"),
    "MI": ("None", "No statutory cap; must be reasonable and in the lease"),
    "MN": ("None", "8% of the overdue rent"),
    "MS": ("None", "No statutory cap; must be reasonable and in the lease"),
    "MO": ("None", "No statutory cap; must be reasonable and in the lease"),
    "MT": ("None", "No statutory cap; must be reasonable and in the lease"),
    "NE": ("None", "No statutory cap; must be reasonable and in the lease"),
    "NV": ("3 days", "5% of the periodic rent"),
    "NH": ("None", "No statutory cap; must be reasonable and in the lease"),
    "NJ": ("5 business days for tenants 62+", "No statutory cap; must be reasonable and in the lease"),
    "NM": ("None", "10% of the rent for the period"),
    "NY": ("5 days", "Lesser of $50 or 5% of monthly rent"),
    "NC": ("5 days", "Greater of $15 or 5% of monthly rent"),
    "ND": ("None", "No statutory cap; must be reasonable and in the lease"),
    "OH": ("None", "No statutory cap; must be reasonable and in the lease"),
    "OK": ("None", "No statutory cap; must be reasonable and in the lease"),
    "OR": ("4 days", "A reasonable flat fee, a daily fee up to 6% of that flat fee, or 5% of rent per 5 days late"),
    "PA": ("None", "No statutory cap; must be reasonable and in the lease"),
    "RI": ("None", "No statutory cap; must be reasonable and in the lease"),
    "SC": ("None", "No statutory cap; must be reasonable and in the lease"),
    "SD": ("None", "No statutory cap; must be reasonable and in the lease"),
    "TN": ("5 days", "10% of the past-due rent"),
    "TX": ("Rent unpaid 2 full days after due", "12% of monthly rent (4 or fewer units in the building) or 10% (more than 4 units)"),
    "UT": ("None", "Greater of 10% of monthly rent or $75"),
    "VT": ("None", "No statutory cap; must be reasonable and in the lease"),
    "VA": ("None", "Lesser of 10% of the periodic rent or 10% of the remaining balance"),
    "WA": ("5 days", "No statutory cap; must be in the lease"),
    "WV": ("None", "No statutory cap; must be reasonable and in the lease"),
    "WI": ("None", "No statutory cap; must be in the lease and reasonable"),
    "WY": ("None", "No statutory cap; must be reasonable and in the lease"),
}

# Required state disclosures beyond the federal lead-paint rule (pre-1978 housing).
# Curated from statutes and state guides; incomplete by nature, so check new states against the statute.
DISCLOSURES = {
    "AL": ["Owner and manager name and address"],
    "AK": ["Owner and manager name and address"],
    "AZ": ["Owner and manager name and address", "Tenant may get a copy of the Arizona Residential Landlord and Tenant Act", "Move-in condition form", "Purpose of any nonrefundable fees", "Pool safety notice (if there is a pool)"],
    "AR": [],
    "CA": ["Registered sex offender database notice", "Bed bug information", "Mold disclosure", "Shared utility meters", "Flood hazard area notice", "Pest control treatments", "Former military ordnance nearby", "Just-cause and rent-cap notice (unless exempt)", "Smoking policy", "Demolition permit applied for"],
    "CO": ["Radon brochure, testing history and signed radon warning, before signing", "All required fees listed in the lease"],
    "CT": ["Owner and manager name and address", "Common interest community notice (if applicable)"],
    "DE": ["Owner and manager name and address", "Summary of the Delaware Landlord-Tenant Code"],
    "DC": ["DC Tenant Bill of Rights", "Rental housing license (BBL) number", "Rent control status and rent history", "Lead disclosure (DC rules are stricter than federal)"],
    "FL": ["Radon gas notice", "Owner or agent name and address", "Where the security deposit is held and the deposit statute text", "Fire protection notice (buildings over 3 stories)", "Flood history and insurance notice"],
    "GA": ["Flooding in the past 5 years", "Owner and manager name and address", "Move-in inspection list (before collecting a deposit)"],
    "HI": ["Owner or agent name and address", "Move-in inventory"],
    "ID": [],
    "IL": ["Radon test results (if known)", "Shared utility costs", "Chicago: RLTO summary and other city notices"],
    "IN": ["Owner and manager name and address", "Move-in inventory and damage list"],
    "IA": ["Owner and manager name and address", "Shared utility allocation", "Known environmental contamination"],
    "KS": ["Owner and manager name and address", "Move-in inventory"],
    "KY": ["Owner and manager name and address (where URLTA applies)", "Where the security deposit is held", "Move-in damage list"],
    "LA": [],
    "ME": ["Energy efficiency disclosure", "Radon testing and risk disclosure", "Smoking policy", "Bed bug information", "Where the security deposit is held"],
    "MD": ["Security deposit receipt with tenant rights", "Owner and manager name and address", "Right to a move-in inspection"],
    "MA": ["Security deposit receipt and statement of condition", "Massachusetts tenant lead law notification", "Bank and account for the deposit"],
    "MI": ["Truth in Renting Act notice", "Security deposit and forwarding address notice", "Move-in inventory checklist", "Domestic violence early termination notice"],
    "MN": ["Owner and manager name and address", "Outstanding inspection orders", "Shared utility allocation"],
    "MS": [],
    "MO": [],
    "MT": ["Owner and manager name and address", "Move-in condition list"],
    "NE": ["Owner and manager name and address"],
    "NV": ["Owner and manager name and address", "Move-in inventory", "Foreclosure notice (if applicable)"],
    "NH": ["Security deposit receipt and move-in condition checklist"],
    "NJ": ["Truth in Renting statement", "Flood zone and flood history notice", "Bank and account for the deposit (within 30 days)"],
    "NM": ["Owner and manager name and address"],
    "NY": ["Sprinkler system notice", "Flood history and flood zone notice", "Bank and account for the deposit", "NYC: bed bug history and other city notices"],
    "NC": ["Where the security deposit is held"],
    "ND": [],
    "OH": ["Owner and manager name and address"],
    "OK": ["Owner and manager name and address", "Flooding history"],
    "OR": ["Owner and manager name and address", "Flood zone notice", "Smoking policy", "Carbon monoxide alarm information"],
    "PA": [],
    "RI": ["Owner and manager name and address", "Outstanding code violations"],
    "SC": ["Owner and manager name and address"],
    "SD": [],
    "TN": ["Owner and manager name and address (where URLTA applies)"],
    "TX": ["Owner and management company (on request)", "Flood zone and flood history notice", "Towing and parking rules (multi-unit)", "Emergency phone number"],
    "UT": [],
    "VT": [],
    "VA": ["Statement of Tenant Rights and Responsibilities (state form)", "Visible mold disclosure", "Owner and manager name and address", "Move-in inspection report", "Military air installation notice (if applicable)"],
    "WA": ["Owner and manager name and address", "Mold information", "Fire safety and smoke detection", "Move-in condition checklist (required to take a deposit)"],
    "WV": [],
    "WI": ["Check-in sheet", "Known uncorrected code violations", "Utility charge arrangements", "Domestic abuse protections notice"],
    "WY": [],
}

# Cities with their own landlord-tenant rules that override or add to state law.
LOCAL = {
    "CA": "Los Angeles, San Francisco, Oakland, San Jose and others have rent control and extra notices.",
    "CO": "Denver and Boulder have rental licensing and extra rules.",
    "IL": "Chicago's Residential Landlord and Tenant Ordinance adds rules on deposits, late fees and notices.",
    "MN": "Minneapolis and St. Paul have extra tenant protections.",
    "NY": "New York City adds many notices and rent stabilization rules.",
    "OR": "Portland has relocation payments and screening rules.",
    "WA": "Seattle has extra notice, deposit and screening rules.",
    "MD": "Montgomery County and Baltimore City have extra rules.",
    "NJ": "Many towns have rent control ordinances.",
    "DC": "Most DC rentals are covered by rent stabilization.",
}

# Notes where sources disagreed or the law changed recently.
VERIFY = {
    "VA": "Nonpayment notice changed from 5 to 14 days on July 1, 2026 (Va. Code 55.1-1245(F)).",
    "FL": "Entry notice for repairs changed from 12 to 24 hours in 2023; confirm current Fla. Stat. 83.53.",
    "TX": "Late-fee caps tied to building size (Tex. Prop. Code 92.019).",
    "IL": "Late-fee safe-harbor amount from 770 ILCS 95/; confirm current text.",
    "CO": "For-cause eviction law (2024) and radon disclosure (C.R.S. 38-12-803) are recent.",
    "GA": "Deposit cap of 2 months applies to leases signed or renewed since July 1, 2024.",
    "LA": "Deposit statement deadline changes Aug. 1, 2026.",
    "OH": "Sources disagree on whether Ohio caps late fees.",
    "UT": "Late-fee cap from Utah Code 57-22-4; confirm current text.",
    "NY": "Late-fee cap and occupancy-based notice from the 2019 HSTPA; good-cause law applies in some cities.",
}

# Nonpayment notice corrections (newer than the eviction source).
NONPAY_FIX = {"VA": "14 days"}
ENTRY_FIX = {
    "FL": ("24 hours for repairs; reasonable notice otherwise", "Fla. Stat. 83.53"),
    "CO": ("No general statute; give reasonable notice (24 hours recommended). 24 hours required for bed bug inspections", "Colo. Rev. Stat. § 38-12-503"),
}


def entry_fields(code, name):
    if code in ENTRY_FIX:
        return ENTRY_FIX[code]
    row = entry.get(name, ["", ""])
    notice, form = row[0], row[1] if len(row) > 1 else ""
    cite = re.search(r"\(([^)]*§[^)]*)\)", form)
    notice = "No statute; give reasonable notice (24 hours recommended)" if notice == "None" else notice
    return notice, cite.group(1) if cite else ""


rules = []
for code, name in STATES.items():
    dep = deposit.get(name)
    if not dep:
        raise SystemExit(f"missing deposit row for {name}")
    ev = evict.get(name, {})
    entry_notice, entry_cite = entry_fields(code, name)
    m_ll, m_t, just_cause = M2M[code]
    grace, cap = LATE[code]
    rules.append({
        "code": code,
        "name": name,
        "deposit": {"max": dep[0], "returnDeadline": dep[1], "holding": dep[2], "penalty": dep[3]},
        "entry": {"notice": entry_notice, "statute": entry_cite},
        "lateFee": {"grace": grace, "cap": cap},
        "monthToMonth": {"landlord": m_ll, "tenant": m_t, "justCause": just_cause},
        "notices": {
            "nonpayment": NONPAY_FIX.get(code) or ev.get("Nonpayment of rent", "Check statute"),
            "leaseViolation": ev.get("Lease violation", "Check statute"),
        },
        "disclosures": DISCLOSURES[code],
        "local": LOCAL.get(code, ""),
        "verify": VERIFY.get(code, ""),
    })

json.dump({
    "updated": "2026-10-23",
    "status": "Researched from statutes and 50-state surveys (Oct 2026). Not legal advice; check city and county rules too.",
    "sources": SOURCES,
    "states": rules,
}, open(OUT, "w", encoding="utf-8"), indent=1, ensure_ascii=False)
print(f"wrote {len(rules)} jurisdictions to {os.path.relpath(OUT)}")
