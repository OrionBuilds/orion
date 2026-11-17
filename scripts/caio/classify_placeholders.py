#!/usr/bin/env python3
"""Classify every bold **[PLACEHOLDER]** in the 40 CAIO templates by who may fill it, and write:

  data/placeholder_map.json   one entry per distinct placeholder (resolver, target, uses, templates)
  data/fact_defs.json         the company-profile fact catalog (what the owner fills in once per client)
  <mig-dir>/20261106100100_caio_automation_seed.sql   both of the above as idempotent upserts

Resolvers (see supabase/functions/_shared/caio/hydrate.ts):
  engagement  a column of caio_engagements
  computed    derived (today, document version/status, the document's system id)
  register    a column of a register record (target = "register_key.field_key[,register_key.field_key...]";
              several candidates are tried in the order of the template's `feeds`)
  fact        a confirmed company fact (target = fact_key)
  llm         narrative the model may DRAFT from facts, records and interview sources (always marked for review)
  human       an attestation, decision, measured outcome or date: NEVER auto-filled

Run:  python3 -I scripts/caio/classify_placeholders.py [migrations-dir]
Review data/placeholder_map.json; the owner can reclassify any entry (edit the rules below, re-run, re-apply the seed).
"""
import collections, glob, json, os, re, sys

HERE = os.path.dirname(os.path.abspath(__file__))
D = os.path.join(HERE, "data")

# ── who can fill it ─────────────────────────────────────────────────────────────────────────
ENGAGEMENT = {
    "CLIENT LEGAL NAME": "client_legal_name", "ENGAGEMENT ID": "engagement_code",
    "DOCUMENT OWNER": "register_owner", "REGISTER OWNER": "register_owner",
    "EXECUTIVE SPONSOR": "executive_sponsor", "SPONSOR NAME": "executive_sponsor",
}
COMPUTED = {
    "DATE": "today", "VERSION": "doc_version", "STATUS": "doc_status", "SYSTEM ID": "system_key",
}
# attestations: approvals, evidence, sign-offs, dated verification (same rule set as the measurement)
HUMAN_RX = re.compile(
    r"EVIDENCE|APPROV|ACCEPTED BY|DECISION MADE|DECISION MAKER|TESTER|^RESULT|PASS|SIGN|ATTENDANCE|COMPREHENSION|"
    r"REVIEWER|VERIFIED|DECIDED|CONDITIONS|REASON|NEXT REVIEW|ACCEPTANCE|CONFIRM|DUE DATE|RECOVERY APPROVAL|"
    r"NOTIFICATION DECISION|REVOCATION|FINANCE VALIDATION|^APPROVER$")
# measured outcomes, dates of things that happened, yes/no determinations, results of tests/exercises/reviews
OUTCOME_RX = re.compile(
    r"^(ACTUAL|ACTUAL RESPONSE|ADOPTION RESULT|ADVERSE RESULT|COUNT|COUNTS|SCORE|TIME TAKEN|DETECTION TIME|CONCLUSION|"
    r"VARIANCE|REMAINING|FORECAST|REWORK RATE|FAILED TEST OR RISK|HOW DETECTED|INCIDENT SUMMARY|INJECT|INJECT NUMBER|"
    r"CALLER|REQUESTER|CHECKER|SCRIBE|FACILITATOR|ATTENDEES?|REVOKED BY|NAME|VALUE|TIME|STEP|EVENT|CHECK|RESPONSE|"
    r"EXERCISE DATE|LAST TESTED DATE|RETEST DATE|READOUT DATE|START DATE|END DATE|PILOT START|PILOT END|"
    r"STOP DECISION|DISCLOSURE DECISION|FOLLOW-UP DECISION|READINESS VERDICT|KEEP, CHANGE OR RETIRE|"
    r"QUALITY RESULT|MUST HAVE RESULT|SOURCE COMPARED|OPEN ISSUE|UNKNOWN|PILOT CHARTER ID|PLAN VERSION|QUARTER|PERIOD|"
    r"MEASUREMENT PERIOD|REVIEW TIME|REVIEW VOLUME|PLANNED|PLANNED TIME|PLANNED WORK|HANDLING TIME|VOLUME|BEFORE|AFTER|"
    r"CURRENT COST|CASH SAVING|CAPACITY GAIN|REVENUE CONTRIBUTION|COST EFFECT|ESTIMATE AMOUNT|BUDGET AMOUNT|"
    r"LEVEL FROM|LEVEL TO|OBSERVATIONS?|LESSONS?|MISSING ITEMS|OUTDATED ITEMS|OPEN GAPS|OPEN OBLIGATIONS|"
    r"OPEN QUESTIONS?|USER COUNT|STAFF COUNT)$|^YES|^WHAT (WORKED|DID NOT|WENT)|FINDING$|^GAP|GAP$|GAP AND RESOLUTION|"
    r"^LAST |LAST TESTED")
# people, contact routes and lists: the model must never invent who someone is or how to reach them
PEOPLE_RX = re.compile(r"(CONTACT|OWNER|PERSON|RECIPIENT|NAME|BACKUP|ROUTE|LIST|PUBLISHER|ROLE|RESPONDER|DECIDER)$|PERSON OR ROLE")
# a stable company fact: placeholder name -> fact_key
FACTS = {
    # key: (label, group, type, help, [placeholder aliases], minimum?)
    "trading_name": ("Trading or short name", "company", "text", "How staff and customers refer to the company.", [], False),
    "industry": ("Industry and main activities", "company", "longtext", "What the company does, for whom, in a few lines.", ["INDUSTRY", "INDUSTRY AND ACTIVITIES"], True),
    "staff_count": ("Number of staff", "company", "number", "Employees plus regular contractors.", ["STAFF COUNT"], True),
    "locations": ("Office and staff locations", "company", "longtext", "Where people work, including remote staff.", ["LOCATIONS", "PEOPLE LOCATIONS"], True),
    "operating_jurisdictions": ("Jurisdictions the company operates in", "company", "longtext", "States, countries and regulators that govern its work. A qualified reviewer confirms what applies.", ["OPERATING JURISDICTIONS"], True),
    "customer_types": ("Customer types", "company", "longtext", "Who the company sells to.", ["CUSTOMER TYPES"], False),
    "existing_software": ("Core software in use", "stack", "longtext", "CRM, ERP, planning, communications and other systems of record.", ["EXISTING SOFTWARE"], True),
    "existing_ai": ("AI already in use", "stack", "longtext", "AI tools and embedded AI features staff use today, approved or not.", ["EXISTING AI"], True),
    "executive_sponsor_title": ("Sponsor job title", "leadership", "text", "Title of the executive sponsor.", [], False),
    "sponsor_backup": ("Sponsor backup", "leadership", "text", "Who decides when the sponsor is unavailable.", ["SPONSOR BACKUP"], False),
    "data_owner": ("Data owner", "leadership", "text", "Person accountable for the main business data.", ["DATA OWNER"], False),
    "source_owner": ("Knowledge source owner", "leadership", "text", "Person who owns the documents the AI will read.", ["SOURCE OWNER"], False),
    "control_owner": ("Control owner", "leadership", "text", "Person who runs the day-to-day AI controls.", ["CONTROL OWNER"], False),
    "monitor_owner": ("Monitoring owner", "leadership", "text", "Person who watches AI quality and drift.", ["MONITOR OWNER"], False),
    "alert_recipient": ("Alert recipient", "leadership", "text", "Who is alerted when a check fails.", ["ALERT RECIPIENT"], False),
    "backup_owner": ("Backup owner", "leadership", "text", "Named deputy for the main owner.", ["BACKUP OWNER"], False),
    "process_champion": ("Process champion", "leadership", "text", "Staff member who champions the change.", ["PROCESS CHAMPION", "CHAMPION NAME"], False),
    "incident_contact": ("Incident contact", "operations", "text", "Who staff tell first about an AI incident, with how to reach them.", ["INCIDENT CONTACT"], True),
    "incident_responder": ("Incident responder", "operations", "text", "Who leads the response.", ["INCIDENT RESPONDER"], False),
    "incident_decider": ("Incident decision-maker", "operations", "text", "Who decides to stop, notify and recover.", ["INCIDENT DECIDER"], False),
    "escalation_contact": ("Escalation contact", "operations", "text", "Who problems escalate to.", ["ESCALATION CONTACT", "ESCALATION ORDER"], True),
    "out_of_hours_route": ("Out-of-hours route", "operations", "text", "How to reach someone outside working hours.", ["OUT OF HOURS ROUTE"], False),
    "tool_request_contact": ("Tool request contact", "operations", "text", "Where staff ask for a new AI tool.", ["TOOL REQUEST CONTACT"], False),
    "data_questions_contact": ("Data questions contact", "operations", "text", "Where staff and customers send data questions.", ["DATA QUESTIONS CONTACT"], False),
    "support_contact": ("Support contact", "operations", "text", "First line of support for AI systems.", ["SUPPORT CONTACT", "SUPPORT ROUTE", "SUPPORT CONTACTS AND WINDOW"], False),
    "support_window": ("Support window", "operations", "text", "Days and hours support is available.", ["SUPPORT WINDOW", "OFFICE HOURS"], False),
    "stop_authority": ("Who may stop an AI system", "operations", "text", "Named person (not a role) with authority to pause or stop any AI system immediately.", ["STOP AUTHORITY", "PAUSE AUTHORITY", "WHO CAN STOP"], True),
    "stop_authority_backup": ("Stop authority backup", "operations", "text", "Deputy with the same authority.", ["STOP AUTHORITY BACKUP"], False),
    "reporting_channel": ("Reporting channel", "operations", "text", "Where AI concerns and incidents are reported.", ["REPORTING CHANNEL", "REPORTING ROUTE"], False),
    "records_owner": ("Records owner", "operations", "text", "Person who keeps the governance records.", ["RECORDS OWNER"], False),
    "spend_limit": ("Spending limit the CAIO may commit", "finance", "text", "Monthly or per-item limit before the sponsor must approve.", ["SPEND LIMIT", "SPENDING LIMIT"], True),
    "budget_range": ("AI budget range", "finance", "text", "Budget the sponsor has made available.", ["BUDGET RANGE"], False),
    "access_review_interval": ("Access review interval", "rules", "text", "How often access to AI tools is reviewed.", ["ACCESS REVIEW INTERVAL"], False),
    "removal_timeframe": ("Access removal timeframe", "rules", "text", "How fast access is removed on role change or departure.", ["REMOVAL TIMEFRAME"], False),
    "personal_account_rule": ("Personal AI account rule", "rules", "longtext", "May staff use personal AI accounts for company work?", ["PERSONAL ACCOUNT RULE"], False),
    "offboarding_rule": ("Offboarding rule for AI accounts", "rules", "longtext", "What happens to chat history and files when someone leaves.", ["OFFBOARDING RULE"], False),
    "shadow_use_process": ("Unapproved tool discovery process", "rules", "longtext", "How unapproved AI use is found and handled.", ["SHADOW USE PROCESS"], False),
    "refresher_interval": ("Training refresher interval", "rules", "text", "How often staff repeat AI training.", ["REFRESHER INTERVAL", "TRAINING FREQUENCY"], False),
    "review_cadence": ("Governance review cadence", "rules", "text", "How often the CAIO and sponsor review governance.", ["REVIEW CADENCE", "REVIEW INTERVAL", "UPDATE INTERVAL"], False),
    "public_examples": ("Public data: examples", "data_classes", "longtext", "What counts as public information here.", ["PUBLIC EXAMPLES"], False),
    "public_rule": ("Public data: handling rule", "data_classes", "longtext", "", ["PUBLIC RULE"], False),
    "confidential_examples": ("Confidential data: examples", "data_classes", "longtext", "", ["CONFIDENTIAL EXAMPLES"], False),
    "confidential_rule": ("Confidential data: handling rule", "data_classes", "longtext", "", ["CONFIDENTIAL RULE"], False),
    "restricted_examples": ("Restricted data: examples", "data_classes", "longtext", "Personal, financial, health or client-confidential records.", ["RESTRICTED EXAMPLES"], False),
    "restricted_rule": ("Restricted data: handling rule", "data_classes", "longtext", "", ["RESTRICTED RULE"], False),
    "records_kept": ("Records kept and retention", "rules", "longtext", "What governance records are kept, and for how long.", ["RECORDS KEPT"], False),
    "severity_definition": ("Incident severity definitions", "rules", "longtext", "What makes an AI incident low, medium, high or critical.", ["SEVERITY DEFINITION"], False),
    "impact_scale": ("Impact scale", "rules", "longtext", "Definitions for the impact levels used in risk scoring.", ["IMPACT SCALE"], False),
    "likelihood_scale": ("Likelihood scale", "rules", "longtext", "Definitions for the likelihood levels used in risk scoring.", ["LIKELIHOOD SCALE"], False),
    "scoring_scale": ("Scoring scale", "rules", "longtext", "How scores are calculated and banded.", ["SCORING SCALE"], False),
    "risk_tier_rule": ("Risk tier rule", "rules", "longtext", "How a score becomes Low, Medium or High risk.", ["RISK TIER RULE"], False),
}
ALIAS = {a: k for k, v in FACTS.items() for a in v[4]}


def classify(name, labels):
    if name in ENGAGEMENT: return "engagement", ENGAGEMENT[name]
    if name in COMPUTED: return "computed", COMPUTED[name]
    if name == "SYSTEM NAME": return "register", "ai_systems.system_name"
    if name in ALIAS: return "fact", ALIAS[name]
    if HUMAN_RX.search(name): return "human", ""
    if name.upper() in labels: return "register", ",".join(sorted(labels[name.upper()]))
    if OUTCOME_RX.search(name) or PEOPLE_RX.search(name): return "human", ""
    return "llm", ""


def main(mig_dir=None):
    regs = json.load(open(os.path.join(D, "registers.json")))
    labels = collections.defaultdict(list)
    for r in regs:
        for c in r["columns"]:
            labels[c["label"].upper()].append(f'{r["register_key"]}.{c["field_key"]}')
    uses, tpls = collections.Counter(), collections.defaultdict(set)
    for f in sorted(glob.glob(os.path.join(HERE, "templates", "[0-9][0-9]-*.md"))):
        n = int(os.path.basename(f)[:2])
        for p in re.findall(r"\*\*\[([^\]\n]+)\]\*\*", open(f).read()):
            uses[p] += 1; tpls[p].add(n)
    out = []
    for name in sorted(uses):
        res, target = classify(name, labels)
        out.append({"name": name, "resolver": res, "target": target, "uses": uses[name], "templates": sorted(tpls[name])})
    json.dump(out, open(os.path.join(D, "placeholder_map.json"), "w"), indent=1)
    facts = []
    for i, (k, v) in enumerate(FACTS.items()):
        t = sorted({n for a in v[4] for n in tpls.get(a, ())})
        facts.append({"fact_key": k, "label": v[0], "grp": v[1], "type": v[2], "help": v[3], "sort": i + 1,
                      "profile_minimum": v[5], "templates": t})
    json.dump(facts, open(os.path.join(D, "fact_defs.json"), "w"), indent=1)
    tot = sum(o["uses"] for o in out); by = collections.Counter(); byu = collections.Counter()
    for o in out: by[o["resolver"]] += 1; byu[o["resolver"]] += o["uses"]
    for k in ("engagement", "computed", "register", "fact", "llm", "human"):
        print(f"{k:11} {by[k]:4} distinct  {byu[k]:5} uses  {100*byu[k]/tot:4.1f}%")
    print("total uses", tot, "| facts", len(facts), "| fact minimum", sum(1 for f in facts if f["profile_minimum"]))
    if mig_dir: write_sql(mig_dir, out, facts)


def q(s):
    return "'" + str(s).replace("'", "''") + "'"


def arr(xs):
    return "ARRAY[" + ",".join(str(x) for x in xs) + "]::integer[]" if xs else "'{}'::integer[]"


def write_sql(mig_dir, pm, facts):
    L = ["/*", "  # CAIO automation: seed (generated by scripts/caio/classify_placeholders.py; do not hand-edit)", "",
         "  caio_fact_defs: the company-profile catalog. caio_placeholder_defs: who may fill each of the placeholders in the 40",
         "  templates (engagement | computed | register | fact | llm | human). Idempotent upserts.", "*/", ""]
    L.append("INSERT INTO public.caio_fact_defs (fact_key, label, grp, type, help, sort, profile_minimum, templates) VALUES")
    L.append(",\n".join(f"({q(f['fact_key'])},{q(f['label'])},{q(f['grp'])},{q(f['type'])},{q(f['help'])},{f['sort']},"
                        f"{'true' if f['profile_minimum'] else 'false'},{arr(f['templates'])})" for f in facts))
    L.append("ON CONFLICT (fact_key) DO UPDATE SET label=EXCLUDED.label, grp=EXCLUDED.grp, type=EXCLUDED.type, help=EXCLUDED.help,"
             " sort=EXCLUDED.sort, profile_minimum=EXCLUDED.profile_minimum, templates=EXCLUDED.templates;\n")
    L.append("INSERT INTO public.caio_placeholder_defs (name, resolver, target, uses, templates) VALUES")
    L.append(",\n".join(f"({q(p['name'])},{q(p['resolver'])},{q(p['target'])},{p['uses']},{arr(p['templates'])})" for p in pm))
    # an owner's reclassification (source = 'edited') survives re-seeding
    L.append("ON CONFLICT (name) DO UPDATE SET resolver=EXCLUDED.resolver, target=EXCLUDED.target, uses=EXCLUDED.uses,"
             " templates=EXCLUDED.templates WHERE public.caio_placeholder_defs.source = 'seed';\n")
    open(os.path.join(mig_dir, "20261106100100_caio_automation_seed.sql"), "w").write("\n".join(L))
    print("wrote", os.path.join(mig_dir, "20261106100100_caio_automation_seed.sql"))


if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else None)
