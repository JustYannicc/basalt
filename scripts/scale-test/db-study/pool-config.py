"""Fixture-only override; the runtime image and Home/node binaries are unchanged."""
import os
import runpy
from pool import pool_contract

size = int(os.environ['DENSITY_DB_POOL_SIZE'])
if size not in [6, 12, 24]:
    raise ValueError('Only the declared pool sensitivity sizes are permitted')
original = pool_contract.cluster_yaml


def fixture_config(*args, **kwargs):
    text = original(*args, **kwargs)
    for name in ['max-open-conns', 'max-idle-conns']:
        before = f'  {name}: 6\n'
        if text.count(before) != 1:
            raise ValueError('Frozen generated cluster config changed')
        text = text.replace(before, f'  {name}: {size}\n')
    return text


pool_contract.cluster_yaml = fixture_config
if os.environ.get('DENSITY_SQL_TRACE') == '1':
    original_environment = pool_contract.child_environment

    def fixture_environment(*args, **kwargs):
        env = original_environment(*args, **kwargs)
        env['BASALT_FIXTURE_SQL_TRACE'] = '/tmp/sql-profile.ndjson'
        return env

    pool_contract.child_environment = fixture_environment
runpy.run_module('pool.supervisor', run_name='__main__')
