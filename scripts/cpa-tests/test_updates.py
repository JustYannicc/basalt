import importlib.util
import json
from pathlib import Path
import subprocess
import tempfile
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

if __name__ == '__main__':
    unittest.main()
