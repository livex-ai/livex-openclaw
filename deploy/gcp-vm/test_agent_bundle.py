import json
import pathlib
import unittest

import agent_bundle

ROOT = pathlib.Path(__file__).resolve().parents[2]


class AgentBundleTests(unittest.TestCase):
    def test_build_uses_registered_agents_not_example_folders(self):
        bundle = agent_bundle.build_bundle(ROOT)
        agents = bundle.get('agents')
        self.assertEqual(set(agents), {'oncall', 'oncall-coordinator'})
        debugger = agents.get('oncall')
        self.assertEqual(debugger.get('config').get('workspace'),
                         '/home/node/.openclaw/workspace')
        self.assertIn('reactions=off', debugger.get('prompt'))
        expected = (ROOT / 'deploy/gcp-vm/oncall-vm-prompt.sha256').read_text().split()[0]
        self.assertEqual(debugger.get('sha256'), expected)
        self.assertEqual(set(bundle.get('skills')), set(debugger.get('config').get('skills')))
        coordinator = agents.get('oncall-coordinator')
        definition = coordinator.get('config')
        self.assertEqual(definition.get('workspace'),
                         '/home/node/.openclaw/workspaces/oncall-coordinator')
        self.assertEqual(definition.get('permissionModeDefault'), 'read-only')
        self.assertEqual(definition.get('skills'), [])
        self.assertEqual(definition.get('tools'), {
            'profile': 'full', 'exec': {'mode': 'deny'},
            'elevated': {'enabled': False}, 'fs': {'workspaceOnly': True},
            'allow': ['read', 'livex_oncall_tick']})
        source = (ROOT / 'livex-agents/workspaces/oncall-coordinator/AGENTS.md').read_text()
        self.assertEqual(coordinator.get('prompt'), source)
        installed = {'agents': {'entries': {'oncall': {'tools': {'allow': ['vm-only']}}}}}
        result = json.loads(agent_bundle.with_agents(json.dumps(installed).encode(), bundle, {'oncall'}))
        entries = result.get('agents').get('entries')
        self.assertEqual(entries.get('oncall').get('tools'), {'allow': ['vm-only']})
        self.assertEqual(entries.get('oncall-coordinator'), definition)

    def test_add_agent_preserves_vm_overrides_and_unrelated_agents(self):
        bundle = agent_bundle.build_bundle(ROOT)
        entry = dict(bundle['agents']['oncall'])
        entry['config'] = {'workspace': '/home/node/.openclaw/workspaces/debugger',
                           'name': 'Debugger', 'skills': ['debug'],
                           'permissionModeDefault': 'read-only',
                           'tools': {'allow': ['read', 'skills_read']}}
        bundle['agents']['debugger'] = entry
        original = {'agents': {'entries': {'oncall': {'model': 'existing/model',
                    'tools': {'allow': ['vm-only']}, 'permissionModeDefault': 'read-only'},
                    'unrelated': {'name': 'Untouched'}}}, 'gateway': {'port': 18791},
                    'channels': {'slack': {'token': 'synthetic'}}}
        result = json.loads(agent_bundle.with_agents(json.dumps(original).encode(), bundle, {'oncall'}))
        self.assertEqual(result['agents']['entries']['oncall']['model'], 'existing/model')
        self.assertEqual(result['agents']['entries']['oncall']['tools'], {'allow': ['vm-only']})
        self.assertEqual(result['agents']['entries']['unrelated'], {'name': 'Untouched'})
        self.assertEqual(result['channels'], original['channels'])
        self.assertEqual(result['agents']['entries']['debugger']['name'], 'Debugger')
        with self.assertRaisesRegex(ValueError, 'unmanaged'):
            agent_bundle.with_agents(json.dumps(result).encode(), bundle, {'oncall'})

    def test_bundle_rejects_tampering_and_workspace_escape(self):
        bundle = agent_bundle.build_bundle(ROOT)
        bundle['agents']['oncall']['prompt'] += 'tampered'
        with self.assertRaisesRegex(ValueError, 'hash'):
            agent_bundle.validate_bundle(bundle)
        bundle = agent_bundle.build_bundle(ROOT)
        bundle['agents']['oncall']['config']['workspace'] = '/etc'
        with self.assertRaises(ValueError):
            agent_bundle.validate_bundle(bundle)

    def test_new_agent_requires_explicit_tools_and_readonly_default(self):
        bundle = agent_bundle.build_bundle(ROOT)
        definition = {'workspace': '/home/node/.openclaw/workspaces/new', 'skills': []}
        bundle['agents']['new'] = {'config': definition,
                                  'prompt': 'test', 'sha256': agent_bundle.sha(b'test')}
        installed = b'{"agents":{"entries":{"oncall":{}}}}'
        for policy in ({'tools': {'allow': ['read']}},
                       {'permissionModeDefault': 'read-only'},
                       {'permissionModeDefault': 'read-only', 'tools': {'allow': []}}):
            with self.subTest(policy=policy):
                bundle['agents']['new']['config'] = {**definition, **policy}
                with self.assertRaisesRegex(ValueError, 'New agents need explicit read-only'):
                    agent_bundle.with_agents(installed, bundle, {'oncall'})


if __name__ == '__main__':
    unittest.main()
