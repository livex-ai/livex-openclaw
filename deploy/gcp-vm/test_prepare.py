import copy
import importlib.util
from pathlib import Path
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


if __name__ == '__main__': unittest.main()
