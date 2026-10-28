import copy
import importlib.util
import json
from pathlib import Path
import shlex
import shutil
import subprocess
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('prepare', Path(__file__).with_name('prepare.py'))
prepare = importlib.util.module_from_spec(spec)
spec.loader.exec_module(prepare)


def fixture():
    source = {
        'gateway': {'mode': 'local', 'port': 18791, 'bind': 'loopback', 'auth': {'mode': 'token', 'token': {'source': 'env', 'provider': 'default', 'id': 'GATEWAY_TOKEN'}}},
        'plugins': {'entries': {'livex-gcp-readonly': {'config': {
            'gcloudAccount': 'old@example.test', 'project': 'test-project',
            'gcloudPath': '/old/gcloud', 'cloudSdkConfig': '/old/sdk-state',
            'allowedSenderId': 'U123', 'allowedChannelId': '*',
            'repositories': [{'id': 'backend', 'path': '/Users/operator/backend', 'commit': 'a' * 40}]}}}},
        'agents': {'entries': {'oncall': {'workspace': '/old/workspace', 'skills': ['debug'],
            'tools': {'allow': ['read']}, 'permissionModeDefault': None}}},
        'channels': {'slack': {'defaultAccount': 'default', 'allowFrom': ['U123'],
            'accounts': {'default': {'botToken': {'source': 'env', 'provider': 'default', 'id': 'SLACK_BOT_TOKEN'},
                'channels': {'*': {'users': ['U123'], 'requireMentionInBotThreads': True}}}}}},
        'secrets': {'providers': {'default': {'source': 'env', 'allowlist': ['GATEWAY_TOKEN', 'SLACK_BOT_TOKEN']}}},
        'bindings': [{'agentId': 'oncall', 'match': {'channel': 'slack', 'accountId': 'default'}}],
    }
    settings = {'attachedServiceAccount': 'reader@test-project.iam.gserviceaccount.com',
        'approvedModel': 'openai/example', 'image': 'registry/runtime@sha256:' + 'b' * 64,
        'sourceSha': 'c' * 40, 'pathMap': {'/old/gcloud': '/opt/google-cloud-sdk/bin/gcloud',
        '/old/sdk-state': '/home/node/.config/gcloud', '/old/workspace': '/home/node/.openclaw/workspace',
        '/Users/operator/backend': '/repos/backend'}}
    source['plugins']['allow'] = ['slack', 'livex-gcp-readonly', 'livex-oncall-reports']
    source['plugins']['entries']['livex-oncall-reports'] = {
        'enabled': True, 'config': {'agentProfiles': {'oncall': 'compact-v1'}}}
    source['plugins']['load'] = {'paths': [
        '/old/plugins/livex-gcp-readonly', '/old/plugins/livex-oncall-reports']}
    settings['pathMap'].update({
        '/old/plugins/livex-gcp-readonly': '/opt/oncall/plugins/livex-gcp-readonly',
        '/old/plugins/livex-oncall-reports': '/opt/oncall/plugins/livex-oncall-reports'})
    return source, settings


class PrepareTests(unittest.TestCase):
    def test_preserves_operational_fields(self):
        source, settings = fixture()
        result = prepare.transform(source, settings)
        self.assertEqual(result['channels'], source['channels'])
        self.assertEqual(result['bindings'], source['bindings'])
        agent = result['agents']['entries']['oncall']
        self.assertEqual(agent['tools'], source['agents']['entries']['oncall']['tools'])
        self.assertIsNone(agent['permissionModeDefault'])
        self.assertTrue(result['channels']['slack']['accounts']['default']['channels']['*']['requireMentionInBotThreads'])
        repo = result['plugins']['entries']['livex-gcp-readonly']['config']['repositories'][0]
        self.assertEqual(repo, {'id': 'backend', 'path': '/repos/backend', 'commit': 'a' * 40})
        self.assertEqual(source['gateway']['bind'], 'loopback')
        self.assertEqual(result['gateway']['bind'], 'lan')

    def test_report_profile_and_exact_path_map_are_preserved(self):
        source, settings = fixture()
        original = copy.deepcopy(source)
        with tempfile.TemporaryDirectory() as temp:
            output = Path(temp) / 'release'
            prepare.write_release(source, settings, output)
            result = json.loads((output / 'openclaw.json').read_text())
            release = json.loads((output / 'release.json').read_text())
        self.assertEqual(result['plugins']['allow'], source['plugins']['allow'])
        self.assertEqual(result['plugins']['entries']['livex-oncall-reports'],
                         source['plugins']['entries']['livex-oncall-reports'])
        self.assertEqual(result['plugins']['load']['paths'], [
            '/opt/oncall/plugins/livex-gcp-readonly',
            '/opt/oncall/plugins/livex-oncall-reports'])
        self.assertEqual(release['pathMap'], settings['pathMap'])
        self.assertEqual(source, original)
        # A mapping for the parent must never silently replace the exact plugin mapping.
        del settings['pathMap']['/old/plugins/livex-oncall-reports']
        settings['pathMap']['/old/plugins'] = '/opt/oncall/plugins'
        with self.assertRaisesRegex(ValueError, 'Missing exact path mapping'):
            prepare.transform(source, settings)

    def test_rejects_unsafe_inputs(self):
        for mutation in ('raw', 'store', 'mapping', 'caller', 'pin', 'model', 'repo', 'port', 'header', 'environment', 'appToken'):
            with self.subTest(mutation=mutation):
                source, settings = fixture()
                config = source['plugins']['entries']['livex-gcp-readonly']['config']
                if mutation == 'header': source['headers'] = {'Authorization': 'Bearer hidden'}
                if mutation == 'environment': source['env'] = {'vars': {'CUSTOM_AUTH': 'private'}}
                if mutation == 'appToken': source['custom'] = 'xapp-hidden'
                if mutation == 'port': source['gateway']['port'] = 18789
                if mutation == 'raw': source['gateway']['auth']['token'] = 'private'
                if mutation == 'store': source['gateway']['auth']['token']['source'] = 'file'
                if mutation == 'mapping': del settings['pathMap']['/Users/operator/backend']
                if mutation == 'caller': source['channels']['slack']['allowFrom'] = ['U999']
                if mutation == 'pin': config['repositories'][0]['commit'] = 'main'
                if mutation == 'model': source['agents']['entries']['oncall']['model'] = 'different'
                if mutation == 'repo': config['repositories'] = []
                with self.assertRaises(ValueError): prepare.transform(source, settings)

    def test_fallback_only_override_checks_inherited_primary(self):
        source, settings = fixture()
        source['agents']['entries']['oncall']['model'] = {'fallbacks': []}
        for default in ('openai/other', {'primary': 'openai/other'}):
            with self.subTest(default=default):
                source['agents']['defaults'] = {'model': default}
                with self.assertRaises(ValueError): prepare.transform(source, settings)
        source['agents']['defaults'] = {'model': settings['approvedModel']}
        result = prepare.transform(source, settings)
        self.assertEqual(result['agents']['entries']['oncall']['model'], {'fallbacks': []})
        self.assertEqual(result['agents']['defaults'], source['agents']['defaults'])
        del source['agents']['defaults']
        result = prepare.transform(source, settings)
        self.assertEqual(result['agents']['entries']['oncall']['model'], {
            'primary': settings['approvedModel'], 'fallbacks': []})

    def test_arbitrary_repository_count(self):
        source, settings = fixture()
        config = source['plugins']['entries']['livex-gcp-readonly']['config']
        for i in range(1, 24):
            config['repositories'].append({'id': f'repo{i}', 'path': f'/old/repo{i}', 'commit': 'd' * 40})
            settings['pathMap'][f'/old/repo{i}'] = f'/repos/repo{i}'
        self.assertEqual(len(prepare.transform(source, settings)['plugins']['entries']['livex-gcp-readonly']['config']['repositories']), 24)

    def test_private_output_never_overwrites(self):
        source, settings = fixture()
        with tempfile.TemporaryDirectory() as temp:
            output = Path(temp) / 'release'
            prepare.write_release(source, settings, output)
            self.assertEqual(output.stat().st_mode & 0o777, 0o700)
            with self.assertRaises(FileExistsError): prepare.write_release(source, settings, output)


class SourcePackageTests(unittest.TestCase):
    def test_plugins_configured_for_vm_are_copied_from_reviewed_source(self):
        root = Path(__file__).resolve().parents[2]
        dockerfile = (root / 'deploy/gcp-vm/Dockerfile').read_text()
        copies = {parts[2]: parts[1] for line in dockerfile.splitlines()
                  if line.startswith('COPY ') and not line.startswith('COPY --')
                  for parts in [shlex.split(line)]}
        source, settings = fixture()
        result = prepare.transform(source, settings)
        with tempfile.TemporaryDirectory() as temp:
            for destination in result['plugins']['load']['paths']:
                with self.subTest(destination=destination):
                    self.assertIn(destination, copies)
                    package = Path(temp) / destination.lstrip('/')
                    shutil.copytree(root / copies[destination], package,
                                    ignore=shutil.ignore_patterns('node_modules', '__pycache__'))
                    manifest = json.loads((package / 'package.json').read_text())
                    for entry in manifest['openclaw']['extensions']:
                        self.assertTrue((package / entry).is_file(), entry)
                    self.assertTrue((package / 'openclaw.plugin.json').is_file())

    @unittest.skipUnless(shutil.which('node'), 'Node is needed for runtime package resolution')
    def test_report_dependencies_resolve_and_mismatched_base_fails(self):
        root = Path(__file__).resolve().parents[2]
        dockerfile = (root / 'deploy/gcp-vm/Dockerfile').read_text()
        instructions = dockerfile.replace('\\\n', '').splitlines()
        commands = [line[4:] for line in instructions if line.startswith('RUN ')
                    and '/opt/oncall/plugins/livex-oncall-reports/node_modules' in line]
        self.assertEqual(len(commands), 1, 'Report dependency setup and validation must be one RUN')
        plugin_manifest = json.loads((root / 'livex-agents/plugins/livex-oncall-reports/package.json').read_text())
        base_manifest = json.loads((root / 'package.json').read_text())
        self.assertEqual(plugin_manifest['dependencies']['zod'], base_manifest['dependencies']['zod'])
        # Exercise the image's actual linkage/check command against a minimal base package,
        # without installing dependencies, running plugin code, or building an image.
        for variant in ('matching', 'wrong-zod', 'missing-sdk'):
            with self.subTest(variant=variant), tempfile.TemporaryDirectory() as temp:
                app = Path(temp) / 'app'
                package = Path(temp) / 'opt/oncall/plugins/livex-oncall-reports'
                package.mkdir(parents=True)
                (package / 'package.json').write_text(json.dumps(plugin_manifest))
                (package / 'index.ts').write_text('')
                zod = app / 'node_modules/zod'
                zod.mkdir(parents=True)
                (zod / 'index.js').write_text('module.exports = {};')
                (zod / 'package.json').write_text(json.dumps({
                    'name': 'zod', 'main': './index.js', 'version':
                    '0.0.0' if variant == 'wrong-zod' else plugin_manifest['dependencies']['zod']}))
                exports = {}
                for name in ('plugin-entry', 'security-runtime'):
                    target = app / 'dist/plugin-sdk' / (name + '.js')
                    target.parent.mkdir(parents=True, exist_ok=True)
                    if variant != 'missing-sdk' or name != 'security-runtime':
                        target.write_text('module.exports = {};')
                    exports['./plugin-sdk/' + name] = './dist/plugin-sdk/' + name + '.js'
                (app / 'package.json').write_text(json.dumps({'name': 'openclaw', 'exports': exports}))
                command = commands[0].replace('/opt/oncall', str(Path(temp) / 'opt/oncall')).replace('/app', str(app))
                run = subprocess.run(['sh', '-eu', '-c', command], text=True, capture_output=True, timeout=30)
                if variant == 'matching':
                    self.assertEqual(run.returncode, 0, run.stderr)
                    self.assertEqual((package / 'node_modules/openclaw').resolve(), app.resolve())
                    self.assertEqual((package / 'node_modules/zod').resolve(), zod.resolve())
                else:
                    self.assertNotEqual(run.returncode, 0, 'Incompatible base must fail image preparation')
                    self.assertIn('declared zod version' if variant == 'wrong-zod' else 'MODULE_NOT_FOUND', run.stderr)


if __name__ == '__main__': unittest.main()
