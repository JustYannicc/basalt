"""Summarize every planned cold trial, including failures, without rerunning it."""
import json
from pathlib import Path
import sys

root = Path(sys.argv[1])
trials = []
for trial in sorted(root.glob('trial-*')):
    state = json.loads((trial / 'container.json').read_text()) if (trial / 'container.json').exists() else {}
    events = [json.loads(line) for line in (trial / 'http.jsonl').read_text().splitlines()] if (trial / 'http.jsonl').exists() else []
    cutoff = min(state.get('restartsMs', [float('inf')]))
    readiness = [event for event in events if event['path'] == '/ready' and event['atMs'] < cutoff]
    ready = next((event for event in readiness if event.get('status') == 200), None)
    stream = next((event for event in events if event['path'] == '/v1/chat/completions'), None)
    row = {'trial': trial.name, 'exitCode': int((trial / 'exit-code').read_text()),
           'coldReadyMs': round(ready['atMs'] - state['startedMs'], 3) if ready else None,
           'coldReadinessProbes': len(readiness), 'coldReadiness200': sum(e.get('status') == 200 for e in readiness),
           'firstStreamingStatus': stream.get('status') if stream else None,
           'firstHomePongMs': None,
           'limits': {key: state.get(key) for key in ['nanoCpus', 'memoryBytes']},
           'phases': state.get('phases', [])}
    trials.append(row)
summary = {'source': sys.argv[2], 'trials': trials,
           'readyWithin60s': sum(t['coldReadyMs'] is not None and t['coldReadyMs'] <= 60_000 for t in trials),
           'firstStreaming200': sum(t['firstStreamingStatus'] == 200 for t in trials),
           'testsPassed': sum(t['exitCode'] == 0 for t in trials),
           'homePongMeasurement': 'unavailable: Home subscription traffic uses TLS; wire capture cannot observe plaintext PONG',
           'measurementComplete': False}
(root / 'summary.json').write_text(json.dumps(summary, indent=2) + '\n')
print(json.dumps(summary, indent=2))
sys.exit(0 if len(trials) == 3 and summary['readyWithin60s'] == 3 and summary['firstStreaming200'] == 3 and summary['testsPassed'] == 3 else 1)
