"""Native module regeneration retains new public dependencies without checksum bypasses."""

import importlib.util
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location('native_update', ROOT / 'scripts/cpa-update.py')
assert spec is not None and spec.loader is not None
update = importlib.util.module_from_spec(spec)
spec.loader.exec_module(update)


class NativeModuleTests(unittest.TestCase):
    def fixture(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        root = Path(temporary.name)
        module = root / 'containers/pool/typesafe'
        module.mkdir(parents=True)
        (module / 'go.mod').write_text('module fixture\n\nrequire ' + update.MODULE + ' v8.0.69\n')
        (module / 'go.sum').write_text('old sums\n')
        (module / 'main.go').write_text('package main\n')
        return root, module

    def test_refreshes_transitive_metadata_in_isolation_with_checksum_verification(self):
        root, original = self.fixture()
        before = {name: (original / name).read_bytes() for name in ('go.mod', 'go.sum')}
        commands = []

        def go(command, *, cwd, env, check, text):
            commands.append(command)
            self.assertNotEqual(cwd, original)
            self.assertEqual((cwd / 'main.go').read_text(), 'package main\n')
            self.assertEqual(env['GOSUMDB'], 'sum.golang.org')
            self.assertEqual(env['GOENV'], 'off')
            self.assertEqual(env['GO111MODULE'], 'on')
            self.assertEqual(env['GOWORK'], 'off')
            for name in ('GOFLAGS', 'GONOSUMDB', 'GOPRIVATE', 'GOINSECURE'):
                self.assertEqual(env[name], '')
            self.assertNotIn('GONOSUMCHECK', env)
            self.assertTrue(check and text)
            if command[2] == 'edit':
                self.assertEqual(command[3], '-require=' + update.MODULE + '@v8.0.71')
                (cwd / 'go.mod').write_text((cwd / 'go.mod').read_text().replace('v8.0.69', 'v8.0.71'))
            else:
                self.assertEqual(command, ['go', 'mod', 'tidy'])
                self.assertIn('v8.0.71', (cwd / 'go.mod').read_text())
                with (cwd / 'go.mod').open('a') as output:
                    output.write('require github.com/MoeForge/moego v0.1.0 // indirect\n')
                (cwd / 'go.sum').write_text('github.com/MoeForge/moego v0.1.0 h1:verified\n')

        hostile = {'GOSUMDB': 'off', 'GONOSUMDB': '*', 'GOPRIVATE': '*',
                   'GOINSECURE': '*', 'GONOSUMCHECK': '*', 'GOFLAGS': '-mod=mod',
                   'GOENV': '/foreign/config', 'GO111MODULE': 'off', 'GOWORK': '/foreign'}
        with patch.dict(os.environ, hostile), patch.object(update.subprocess, 'run', side_effect=go):
            files = update.native_module_metadata(root, 'v8.0.71')
        self.assertEqual(len(commands), 2)
        self.assertIn('github.com/MoeForge/moego', files['go.mod'])
        self.assertIn('github.com/MoeForge/moego', files['go.sum'])
        self.assertEqual({name: (original / name).read_bytes() for name in before}, before)

    def test_checksum_or_resolution_failure_cannot_modify_the_original_module(self):
        root, original = self.fixture()
        before = {name: (original / name).read_bytes() for name in ('go.mod', 'go.sum')}
        failure = subprocess.CalledProcessError(1, ['go', 'mod', 'tidy'], stderr='checksum mismatch')
        with patch.object(update.subprocess, 'run', side_effect=[None, failure]):
            with self.assertRaises(subprocess.CalledProcessError):
                update.native_module_metadata(root, 'v8.0.71')
        self.assertEqual({name: (original / name).read_bytes() for name in before}, before)


if __name__ == '__main__':
    unittest.main()
