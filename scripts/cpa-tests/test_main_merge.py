"""Exercise the workflow boundary on composed main merges and direct updates."""

import json
from pathlib import Path
import shutil
import subprocess
import tempfile
import textwrap
import unittest

ROOT = Path(__file__).resolve().parents[2]


class MainMergeFixture:
    def __init__(self, directory):
        self.root = Path(directory)
        self.git('init', '-q', '--initial-branch=main')
        self.git('config', 'user.name', 'CI fixture')
        self.git('config', 'user.email', 'ci@example.invalid')
        (self.root / 'scripts').mkdir()
        shutil.copyfile(ROOT / 'scripts/cpa-pipeline-guard.py', self.root / 'scripts/cpa-pipeline-guard.py')
        (self.root / 'containers/pool/patches').mkdir(parents=True)
        self.patches: list[dict[str, str]] = []
        self.node = {'repository': 'fixture/node', 'commit': 'old'}
        self.save_sources()
        self.base = self.commit()
        self.git('branch', 'candidate')
        workflow = (ROOT / '.github/workflows/ci.yml').read_text()
        step = workflow.split('      - name: Verify CPA updater and pipeline boundary\n', 1)[1]
        assert "MAIN_PUSH: ${{ github.event_name == 'push' && github.ref == 'refs/heads/main' }}" in step
        self.command = textwrap.dedent(step.split('        run: |\n', 1)[1].split('  client-connection:', 1)[0])
        self.command = '\n'.join(line for line in self.command.splitlines()
                                 if not line.startswith('python3 -m unittest '))

    def git(self, *args):
        return subprocess.check_output(['git', *args], cwd=self.root, text=True, stderr=subprocess.PIPE).strip()

    def save_sources(self):
        (self.root / 'containers/pool/sources.json').write_text(json.dumps({'artifacts': {'node': {**self.node, 'patches': self.patches}}}))

    def commit(self):
        self.git('add', '.')
        self.git('commit', '-qm', 'fixture')
        return self.git('rev-parse', 'HEAD')

    def bump(self, commit):
        self.node['commit'] = commit
        self.save_sources()
        return self.commit()

    def merge(self, head):
        self.git('merge', '--no-ff', '-qm', 'fixture merge', head)
        return self.git('rev-parse', 'HEAD')

    def check(self, base, head, main_push='true'):
        return subprocess.run(['bash', '-e', '-c', self.command], cwd=self.root,
                              text=True, capture_output=True, env={
                                  'PATH': '/opt/homebrew/bin:/usr/bin:/bin',
                                  'BASE_SHA': base, 'HEAD_SHA': head,
                                  'BATCH_MODE': 'false', 'MAIN_PUSH': main_push,
                              })

    def composed_main(self, bad_member=False):
        self.git('checkout', '-qb', 'update')
        if bad_member:
            (self.root / 'containers/pool/runtime.py').write_text('changed request behavior')
        bump = self.bump('new')
        self.git('checkout', 'candidate')
        self.merge(bump)
        self.git('checkout', '-qb', 'reviewed')
        self.patches.append({'file': 'reviewed.patch'})
        self.save_sources()
        (self.root / 'containers/pool/patches/reviewed.patch').write_text('+reviewed behavior\n')
        reviewed = self.commit()
        self.git('checkout', 'candidate')
        self.merge(reviewed)
        # The batch was composed on the prior batch tree, not its later main merge.
        self.git('checkout', 'main')
        (self.root / 'target-only').write_text('main advanced')
        first = self.commit()
        head = self.merge('candidate')
        return first, head


class MainMergeTests(unittest.TestCase):
    def fixture(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        return MainMergeFixture(temporary.name)

    def test_main_merge_attributes_update_and_reviewed_carry_to_separate_members(self):
        fixture = self.fixture()
        first, head = fixture.composed_main()
        self.assertEqual(fixture.git('rev-parse', f'{head}^1'), first)
        result = fixture.check(fixture.base, head)
        self.assertEqual(result.returncode, 0, result.stderr)
        # Ordinary mode must still reject this aggregate range.
        ordinary = fixture.check(first, head, main_push='false')
        self.assertNotEqual(ordinary.returncode, 0)
        self.assertIn('CPA carries changed', ordinary.stderr)

    def test_direct_bump_on_main_still_rejects_runtime_changes(self):
        fixture = self.fixture()
        fixture.composed_main()
        base = fixture.git('rev-parse', 'HEAD')
        (fixture.root / 'containers/pool/runtime.py').write_text('changed request behavior')
        head = fixture.bump('direct-main-bump')
        result = fixture.check(base, head)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('CPA bump changes runtime code: containers/pool/runtime.py', result.stderr)

    def test_ordinary_main_merge_does_not_gain_member_attribution(self):
        fixture = self.fixture()
        fixture.git('checkout', '-qb', 'ordinary-update')
        (fixture.root / 'containers/pool/runtime.py').write_text('changed request behavior')
        bump = fixture.bump('ordinary-bump')
        fixture.git('checkout', 'main')
        head = fixture.merge(bump)
        result = fixture.check(fixture.base, head)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('CPA bump changes runtime code: containers/pool/runtime.py', result.stderr)

    def test_composed_main_still_rejects_a_bad_update_member(self):
        fixture = self.fixture()
        first, head = fixture.composed_main(bad_member=True)
        result = fixture.check(first, head)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('CPA member ', result.stderr)
        self.assertIn('CPA bump changes runtime code: containers/pool/runtime.py', result.stderr)

    def test_main_sync_in_an_ordinary_update_does_not_create_a_batch(self):
        fixture = self.fixture()
        fixture.git('checkout', 'candidate')
        fixture.bump('ordinary-bump')
        (fixture.root / 'containers/pool/runtime.py').write_text('changed request behavior')
        fixture.commit()
        fixture.git('checkout', 'main')
        (fixture.root / 'target-only').write_text('main advanced')
        first = fixture.commit()
        fixture.git('checkout', 'candidate')
        fixture.merge('main')
        fixture.git('checkout', 'main')
        head = fixture.merge('candidate')
        result = fixture.check(first, head)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('CPA bump changes runtime code: containers/pool/runtime.py', result.stderr)


if __name__ == '__main__':
    unittest.main()
