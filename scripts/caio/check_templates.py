#!/usr/bin/env python3
"""Validate CAIO template files against SPEC.md, and scan them for copied text.

Usage:
  python3 -I check_templates.py [--originality] [--refs DIR] FILE...
  python3 -I check_templates.py [--originality] templates/        (every NN-*.md in the folder)

Checks per file: front matter (number, title, slug; file name NN-slug.md matches), required sections in order,
placeholders written as **[UPPER CASE]** only (no stray square brackets, no lower-case placeholders), standard
Document control rows, word count window, no secrets-like strings, and that placeholders named like a register
column use that column's exact label. With --originality, any run of 8+ identical consecutive words shared with a
reference text (default ~/backups/caio-reference/*.txt) is reported. Exit code 1 if anything fails.
"""
import json, re, sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
REQUIRED = ["Document control", "How to use", "Decision and approval", "Register links", "Evidence"]
CONTROL_ROWS = ["Client", "Engagement ID", "Document owner", "Approver", "Version", "Status", "Date", "Next review", "Approval reference"]
PH = re.compile(r"\*\*\[([^\]\n]+)\]\*\*")
SECRET = re.compile(r"(-----BEGIN [A-Z ]*PRIVATE KEY-----|\bAKIA[0-9A-Z]{16}\b|\bsk-[A-Za-z0-9_-]{20,}|\bgh[pousr]_[A-Za-z0-9]{30,})")
LONG_OK = {9, 14, 35}


def load_labels():
    regs = json.loads((HERE / "data" / "registers.json").read_text())
    return {c["label"].upper() for r in regs for c in r["columns"]}, regs


def front_matter(text):
    m = re.match(r"^---\n(.*?)\n---\n", text, re.S)
    if not m:
        return None, text
    meta = {}
    for line in m.group(1).splitlines():
        if ":" in line:
            k, v = line.split(":", 1)
            meta[k.strip()] = v.strip()
    return meta, text[m.end():]


def words(s):
    return re.findall(r"[a-z0-9']+", s.lower())


def ngrams(ws, n):
    return {" ".join(ws[i:i + n]) for i in range(len(ws) - n + 1)}


def check(path, labels, ref_grams):
    errs = []
    text = Path(path).read_text()
    meta, body = front_matter(text)
    name = Path(path).name
    m = re.match(r"^(\d\d)-([a-z0-9-]+)\.md$", name)
    if not m:
        return [f"{name}: file name must be NN-slug.md"]
    num = int(m.group(1))
    if not meta:
        return [f"{name}: missing front matter"]
    for k in ("number", "title", "slug"):
        if k not in meta:
            errs.append(f"{name}: front matter missing {k}")
    if meta.get("number") and int(meta["number"]) != num:
        errs.append(f"{name}: front matter number {meta['number']} != file number {num}")
    if meta.get("slug") and meta["slug"] != m.group(2):
        errs.append(f"{name}: slug does not match file name")
    if not re.search(r"^# .+", body, re.M):
        errs.append(f"{name}: no '# Title' heading")
    heads = [h.strip("# ").strip().lower() for h in re.findall(r"^#{2,3} .+$", body, re.M)]
    pos = -1
    for req in REQUIRED:
        idx = next((i for i, h in enumerate(heads) if h.startswith(req.lower())), None)
        if idx is None:
            errs.append(f"{name}: missing section '{req}'")
        elif idx < pos:
            errs.append(f"{name}: section '{req}' is out of order")
        else:
            pos = idx
    ctrl = body.split("Document control", 1)[-1][:1500] if "Document control" in body else ""
    for row in CONTROL_ROWS:
        if not re.search(rf"\|\s*{re.escape(row)}\s*\|", ctrl):
            errs.append(f"{name}: Document control table lacks a '{row}' row")
    stripped = PH.sub("", body)
    # square brackets that are not markdown links or task-list boxes
    stray = [s for s in re.findall(r"\[[^\]\n]{2,}\](?!\()", re.sub(r"- \[[ xX]\]", "", stripped))]
    for s in stray[:5]:
        errs.append(f"{name}: stray bracketed text {s!r}: use **[UPPER CASE]** for fill-ins or remove the brackets")
    for ph in PH.findall(body):
        if ph != ph.upper():
            errs.append(f"{name}: placeholder not upper case: [{ph}]")
        if len(ph) > 70:
            errs.append(f"{name}: placeholder too long: [{ph[:40]}...]")
    phs = set(PH.findall(body))
    if len(phs) < 8:
        errs.append(f"{name}: only {len(phs)} distinct placeholders (expected a real form)")
    nwords = len(words(PH.sub(" ", body)))
    hi = 1700 if num in LONG_OK else 1200
    if not 300 <= nwords <= hi:
        errs.append(f"{name}: body is {nwords} words (expected 300-{hi})")
    if SECRET.search(text):
        errs.append(f"{name}: contains a secret-like string")
    # a placeholder that is *almost* a register label (typo) is flagged
    for ph in phs:
        for lab in labels:
            if ph != lab and ph.replace("S", "").replace(" ", "") == lab.replace("S", "").replace(" ", ""):
                errs.append(f"{name}: [{ph}] looks like register column '{lab}': use the exact label")
    if ref_grams:
        mine = ngrams(words(PH.sub(" ", body)), 8)
        for ref, grams in ref_grams.items():
            hit = mine & grams
            if hit:
                sample = sorted(hit)[0]
                errs.append(f"{name}: {len(hit)} copied 8-word run(s) from {ref}, e.g. {sample!r}")
    return errs


def main(argv):
    orig = "--originality" in argv
    argv = [a for a in argv if a != "--originality"]
    refs = Path.home() / "backups" / "caio-reference"
    if "--refs" in argv:
        i = argv.index("--refs")
        refs = Path(argv[i + 1])
        del argv[i:i + 2]
    files = []
    for a in argv:
        p = Path(a)
        files += sorted(p.glob("[0-9][0-9]-*.md")) if p.is_dir() else [p]
    if not files:
        print("no template files given")
        return 1
    labels, _ = load_labels()
    ref_grams = {}
    if orig:
        for t in sorted(refs.glob("*.txt")):
            ref_grams[t.name] = ngrams(words(t.read_text(errors="ignore")), 8)
        if not ref_grams:
            print(f"warning: no reference texts in {refs}; originality scan skipped")
    bad = 0
    for f in files:
        errs = check(f, labels, ref_grams)
        print(("OK   " if not errs else "FAIL ") + Path(f).name)
        for e in errs:
            print("     " + e)
        bad += bool(errs)
    print(f"\n{len(files) - bad}/{len(files)} templates pass")
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
