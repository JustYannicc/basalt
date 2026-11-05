#!/usr/bin/env python3
"""Constrain only the existing pool fixture and retain bounded timing evidence."""
import json
import os
from pathlib import Path
import subprocess
import sys
import time

ROOT = Path(os.environ['POOL_BUDGET_OUTPUT']).resolve()
ROOT.mkdir(parents=True, exist_ok=True)
REAL = os.environ['POOL_BUDGET_DOCKER']
args = sys.argv[1:]
state_path = ROOT / 'container.json'


def docker(arguments):
    return subprocess.run([REAL, *arguments], capture_output=True, text=True)


def save(state):
    state_path.write_text(json.dumps(state, indent=2) + '\n')


if args and args[0] == 'run' and '--name' in args and args[args.index('--name') + 1].startswith('basalt-1409-pool-test-'):
    index = args.index('--memory')
    assert args[index + 1] == '256m', 'Original fixture resource contract changed'
    args[index:index + 2] = ['--cpus=0.25', '--memory=1g']
    started = time.time() * 1000
    run = docker(args)
    if run.returncode == 0:
        identifier = run.stdout.strip()
        inspected = docker(['inspect', identifier])
        item = json.loads(inspected.stdout)[0]
        assert item['HostConfig']['NanoCpus'] == 250000000
        assert item['HostConfig']['Memory'] == 1073741824
        assert item['Platform'] == 'linux'
        state = {'id': identifier, 'startedMs': started, 'nanoCpus': 250000000, 'memoryBytes': 1073741824,
                 'image': item['Image'], 'boots': []}
        # The host observer runs outside the constrained container's cgroup.
        process = subprocess.Popen(['sudo', 'nsenter', '--target', str(item['State']['Pid']), '--net',
                                    sys.executable, str(Path(__file__).resolve().with_name('pong.py')),
                                    str(ROOT / 'pong.json'), str(started)],
                                   stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        state['observerPid'] = process.pid
        save(state)
    sys.stdout.write(run.stdout)
    sys.stderr.write(run.stderr)
    sys.exit(run.returncode)

if state_path.exists() and args and args[0] in ['restart', 'rm']:
    state = json.loads(state_path.read_text())
    if state['id'] in args:
        logs = docker(['logs', state['id']])
        state['phases'] = [json.loads(line.removeprefix('POOL_STARTUP_PHASE '))
                           for line in (logs.stdout + '\n' + logs.stderr).splitlines()
                           if line.startswith('POOL_STARTUP_PHASE ')]
        if args[0] == 'restart':
            state.setdefault('restartsMs', []).append(time.time() * 1000)
        else:
            pidfile = ROOT / 'pong.json.pid'
            if pidfile.exists():
                subprocess.run(['sudo', 'kill', '-TERM', pidfile.read_text().strip()], check=False,
                               stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            state['finishedMs'] = time.time() * 1000
        save(state)
result = docker(args)
sys.stdout.write(result.stdout)
sys.stderr.write(result.stderr)
sys.exit(result.returncode)
