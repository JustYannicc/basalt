import importlib.util
import json
from pathlib import Path
import subprocess
import tempfile
import textwrap
import unittest

ROOT = Path(__file__).resolve().parents[2]

def load(name, file):
    spec = importlib.util.spec_from_file_location(name, ROOT / 'scripts' / file)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module

update = load('update', 'cpa-update.py')
guard = load('guard', 'cpa-pipeline-guard.py')

class UpdateTests(unittest.TestCase):
    def next_tag(self):
        current = json.loads((ROOT / 'containers/pool/releases.json').read_text())['artifacts']['node']['tag']
        major, minor, patch = map(int, current[1:].split('.'))
        return f'v{major}.{minor}.{patch + 1}'

    def fixture(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        root = Path(temporary.name)
        for path in ['upstream.json', 'containers/pool/releases.json', 'containers/pool/sources.json', 'containers/pool/typesafe/go.mod', 'containers/pool/typesafe/go.sum', 'scripts/releases/patches.json', 'architecture/model/basalt.c4']:
            target = root / path
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text((ROOT / path).read_text())
        sources = json.loads((root / 'containers/pool/sources.json').read_text())
        for carry in sources['artifacts']['node']['patches']:
            path = Path('containers/pool/patches') / carry['file']
            (root / path).parent.mkdir(parents=True, exist_ok=True)
            (root / path).write_bytes((ROOT / path).read_bytes())
        return root

    def candidate(self):
        tag = self.next_tag()
        return {'tag_name': tag, 'draft': False, 'prerelease': False,
                'assets': [{'name': f'CLIProxyAPI_{tag[1:]}_linux_{arch}_no-plugin.tar.gz', 'digest': 'sha256:' + 'a' * 64} for arch in ['amd64', 'aarch64']]}

    def sums(self):
        return '\n'.join(f'github.com/router-for-me/CLIProxyAPI/v8 {self.next_tag()}{suffix} h1:' + 'a' * 43 + '=' for suffix in ['', '/go.mod'])

    def test_complete_update_keeps_existing_carries(self):
        root = self.fixture()
        files = update.plan(root, self.candidate(), 'b' * 40, 'c' * 64, self.sums())
        for name, content in files.items():
            path = root / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(content)
        source = json.loads(files['containers/pool/sources.json'])
        self.assertEqual(source['artifacts']['node']['commit'], 'b' * 40)
        self.assertIn(self.next_tag(), files['containers/pool/typesafe/go.mod'])
        self.assertIn(self.next_tag(), files['containers/pool/typesafe/go.sum'])
        self.assertEqual(source['artifacts']['node']['patches'], json.loads((ROOT / 'containers/pool/sources.json').read_text())['artifacts']['node']['patches'])

    def test_rejects_incomplete_assets_prerelease_and_tampered_carry(self):
        root = self.fixture()
        release = self.candidate()
        release['assets'] = []
        with self.assertRaises(ValueError):
            update.plan(root, release, 'b' * 40, 'c' * 64, self.sums())
        release = self.candidate()
        release['prerelease'] = True
        with self.assertRaises(ValueError):
            update.plan(root, release, 'b' * 40, 'c' * 64, self.sums())
        sources = json.loads((root / 'containers/pool/sources.json').read_text())
        (root / 'containers/pool/patches' / sources['artifacts']['node']['patches'][0]['file']).write_text('tampered')
        with self.assertRaisesRegex(ValueError, 'checksum mismatch'):
            update.plan(root, self.candidate(), 'b' * 40, 'c' * 64, self.sums())

    def test_pipeline_guard_allows_only_context_refresh(self):
        self.assertEqual(guard.carry_edits('@@ -1 +1 @@\n old context\n-old\n+new'), guard.carry_edits('@@ -2 +2 @@\n changed context\n-old\n+new'))
        self.assertNotEqual(guard.carry_edits('-old\n+new'), guard.carry_edits('-old\n+rewrite payload'))

    def test_pipeline_guard_checks_bump_against_actual_git_base(self):
        root = self.fixture()
        runtime = root / 'containers/pool/native/executor.go'
        runtime.parent.mkdir(parents=True)
        runtime.write_text('upstream request path\n')
        subprocess.run(['git', 'init', '-q', str(root)], check=True)
        subprocess.run(['git', 'add', '.'], cwd=root, check=True)
        subprocess.run(['git', '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'baseline'], cwd=root, check=True)
        files = update.plan(root, self.candidate(), 'b' * 40, 'c' * 64, self.sums())
        for name, content in files.items():
            path = root / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(content)
        guard.check(root, 'HEAD')
        runtime.write_text('rewritten request path\n')
        with self.assertRaisesRegex(ValueError, 'changes runtime code'):
            guard.check(root, 'HEAD')
        runtime.write_text('upstream request path\n')
        sources = json.loads((root / 'containers/pool/sources.json').read_text())
        patch = root / 'containers/pool/patches' / sources['artifacts']['node']['patches'][0]['file']
        patch.write_text(patch.read_text() + '\n+rewrite request\n')
        with self.assertRaisesRegex(ValueError, 'carry changes'):
            guard.check(root, 'HEAD')

    def git(self, root, *args):
        return subprocess.check_output(['git', *args], cwd=root, text=True).strip()

    def commit(self, root):
        self.git(root, 'add', '.')
        self.git(root, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid',
                 'commit', '-qm', 'fixture')
        return self.git(root, 'rev-parse', 'HEAD')

    def batch_fixture(self):
        root = self.fixture()
        self.git(root, 'init', '-q')
        self.git(root, 'branch', '-m', 'batch')
        base = self.commit(root)
        self.git(root, 'checkout', '-qb', 'bump')
        for name, content in update.plan(root, self.candidate(), 'b' * 40, 'c' * 64, self.sums()).items():
            (root / name).parent.mkdir(parents=True, exist_ok=True)
            (root / name).write_text(content)
        self.commit(root)
        return root, base

    def add_carry(self, root):
        path = root / 'containers/pool/sources.json'
        sources = json.loads(path.read_text())
        carry = dict(sources['artifacts']['node']['patches'][0])
        carry.update(file='reviewed.patch', identity='reviewed-member', sha256='d' * 64)
        sources['artifacts']['node']['patches'].append(carry)
        path.write_text(json.dumps(sources))
        (root / 'containers/pool/patches/reviewed.patch').write_text('+reviewed behavior\n')
        return self.commit(root)

    def test_bump_member_carry_edits_reject_even_in_a_separate_commit(self):
        root, base = self.batch_fixture()
        sources = json.loads((root / 'containers/pool/sources.json').read_text())
        path = root / 'containers/pool/patches' / sources['artifacts']['node']['patches'][0]['file']
        path.write_text(path.read_text() + '\n+changed request behavior\n')
        bump_head = self.commit(root)
        with self.assertRaisesRegex(ValueError, 'carry changes'):
            guard.check(root, base, bump_head)
        self.git(root, 'checkout', 'batch')
        self.git(root, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid',
                 'merge', '--no-ff', '-qm', 'member', bump_head)
        with self.assertRaisesRegex(ValueError, 'CPA member .*carry changes'):
            guard.check_batch(root, base, 'HEAD')

    def test_reviewed_member_adds_carry_alongside_bump(self):
        root, base = self.batch_fixture()
        bump_head = self.git(root, 'rev-parse', 'HEAD')
        self.git(root, 'checkout', 'batch')
        self.git(root, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid',
                 'merge', '--no-ff', '-qm', 'bump member', bump_head)
        self.git(root, 'checkout', '-qb', 'reviewed')
        member_head = self.add_carry(root)
        self.git(root, 'checkout', 'batch')
        self.git(root, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid',
                 'merge', '--no-ff', '-qm', 'reviewed member', member_head)
        guard.check_batch(root, base, 'HEAD')
        with self.assertRaisesRegex(ValueError, 'carries changed'):
            guard.check(root, base, 'HEAD')

    def test_bump_member_cannot_add_a_carry(self):
        root, base = self.batch_fixture()
        self.add_carry(root)
        with self.assertRaisesRegex(ValueError, 'carries changed'):
            guard.check(root, base, 'HEAD')

    def test_pr_comparison_uses_source_head_after_target_advances(self):
        root, base = self.batch_fixture()
        bump_head = self.git(root, 'rev-parse', 'HEAD')
        self.git(root, 'checkout', '-qb', 'main', base)
        (root / 'target-only.txt').write_text('target advanced\n')
        target = self.commit(root)
        self.git(root, 'checkout', '-qb', 'synthetic')
        self.git(root, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid',
                 'merge', '--no-ff', '-qm', 'synthetic PR merge', bump_head)
        self.assertEqual(self.git(root, 'merge-base', 'HEAD', 'main'), target)
        self.git(root, 'remote', 'add', 'origin', str(root))
        workflow = (ROOT / '.github/workflows/ci.yml').read_text()
        step = workflow.split('      - name: Resolve the guard comparison commit\n', 1)[1]
        script = textwrap.dedent(step.split('        run: |\n', 1)[1].split('      - name:', 1)[0])
        output = root / 'comparison-output'
        subprocess.run(['bash', '-e', '-c', script], cwd=root, check=True, env={
            'PATH': '/usr/bin:/bin', 'PULL_REQUEST': 'true', 'BASE_REF': 'main',
            'BATCH_PUSH': 'false', 'BASE_SHA': target, 'HEAD_SHA': bump_head,
            'GITHUB_OUTPUT': str(output),
        })
        self.assertEqual(output.read_text().strip(), f'base_sha={base}')
        guard.check_batch(root, base, bump_head)

if __name__ == '__main__':
    unittest.main()
