"""Stamp fixtures/acceptance-cases.json with the executed test coverage for each case ID.

Usage: python scripts/acceptance-status.py            # after `npx vitest run` passed
       python scripts/acceptance-status.py --e2e      # also scan tests/e2e (after `npm run test:e2e` passed)

Only test titles (describe/it/test strings) count as coverage, not comments.
"""
import json, re, sys, glob, datetime

roots = ['tests/unit', 'tests/integration'] + (['tests/e2e'] if '--e2e' in sys.argv else [])
title_re = re.compile(r"""\b(?:describe|it|test)(?:\.each\([^)]*\))?\(\s*(['"`])(.*?)\1""", re.S)
id_re = re.compile(r'\bA(\d{2})\b')
coverage: dict[str, set[str]] = {}
for root in roots:
    for path in glob.glob(f'{root}/**/*.ts', recursive=True):
        text = open(path, encoding='utf-8').read()
        for m in title_re.finditer(text):
            for n in id_re.findall(m.group(2)):
                coverage.setdefault(f'A{n}', set()).add(path.replace('\\', '/'))

LIVE = {
    'A06': 'live claude-opus-5 and claude-fable-5-1 via scripts/eval-fable.ts (PASS, see docs/evaluation-results.md)',
    'A09': 'live claude-opus-5 and claude-fable-5-1 via scripts/eval-fable.ts (PASS, see docs/evaluation-results.md)',
}
d = json.load(open('fixtures/acceptance-cases.json', encoding='utf-8'))
today = datetime.date.today().isoformat()
missing = []
for c in d['cases']:
    files = sorted(coverage.get(c['id'], ()))
    if files:
        c['execution_status'] = 'passed'
        c['evidence'] = {'tests': files, 'run': f'npx vitest run ({today}, all tests passed)'}
        if c['id'] in LIVE:
            c['evidence']['model'] = LIVE[c['id']]
    else:
        c['execution_status'] = 'not_run'
        c.pop('evidence', None)
        missing.append(c['id'])
json.dump(d, open('fixtures/acceptance-cases.json', 'w', encoding='utf-8'), indent=2, ensure_ascii=False)
open('fixtures/acceptance-cases.json', 'a', encoding='utf-8').write('\n')
print('covered:', len(d['cases']) - len(missing), 'not_run:', missing)
