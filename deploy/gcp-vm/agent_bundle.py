"""Build immutable agent artifacts from native config; preserve VM-owned settings."""

import argparse
import copy
import hashlib
import importlib.util
import json
import pathlib
import re
import subprocess
import tempfile

BUNDLED = '/opt/oncall/agents.json'
STATE = '/home/node/.openclaw'
# Existing VM choices are operational overrides, not repository defaults.
VM_FIELDS = ('model', 'models', 'modelPolicy', 'runtime', 'tools', 'sandbox',
             'permissionModeDefault', 'agentDir', 'memory', 'nativeRuntimeConsent')


def sha(content):
    return hashlib.sha256(content).hexdigest()


def workspace(agent_id):
    return STATE + ('/workspace' if agent_id == 'oncall' else '/workspaces/' + agent_id)


def validate_bundle(bundle):
    if not isinstance(bundle, dict) or bundle.get('version') != 1:
        raise ValueError('Invalid agent bundle version')
    agents = bundle.get('agents')
    if not isinstance(agents, dict) or 'oncall' not in agents:
        raise ValueError('Deployment must retain the Oncall agent')
    for agent_id, item in agents.items():
        if not re.fullmatch(r'[a-z0-9_][a-z0-9_-]{0,63}', agent_id):
            raise ValueError('Invalid managed agent ID')
        config = item.get('config', {})
        if config.get('workspace') != workspace(agent_id):
            raise ValueError('Managed workspace must be inside the persistent state mount')
        prompt = item.get('prompt')
        if not isinstance(prompt, str) or not prompt.strip() or len(prompt.encode()) > 128 * 1024:
            raise ValueError('Agent must have a nonempty bounded AGENTS.md')
        if sha(prompt.encode()) != item.get('sha256'):
            raise ValueError('Agent prompt hash mismatch')
        skills = config.get('skills')
        if not isinstance(skills, list) or any(not isinstance(s, str) for s in skills):
            raise ValueError('Managed agents must explicitly select skills (or [])')
    selected = sorted({s for item in agents.values() for s in item.get('config').get('skills')})
    if selected != bundle.get('skills'):
        raise ValueError('Bundled skills must match native agent selections')
    return bundle


def build_bundle(root):
    root = pathlib.Path(root)
    profile = json.loads((root / 'livex-agents/config/openclaw.template.json').read_bytes())
    agents = profile.get('agents', {}).get('entries', {})
    result = {}
    for agent_id, definition in agents.items():
        if not re.fullmatch(r'[a-z0-9_][a-z0-9_-]{0,63}', agent_id):
            raise ValueError('Invalid managed agent ID')
        path = definition.get('workspace', '')
        prefix = '${PACKAGE_ROOT}/workspaces/'
        if not path.startswith(prefix):
            raise ValueError('Agent workspace must select a repository workspace')
        relative = pathlib.PurePosixPath(path[len(prefix):])
        if len(relative.parts) != 1 or relative.name in ('.', '..'):
            raise ValueError('Agent workspace must select one workspace directory')
        directory = root / 'livex-agents/workspaces' / relative.name
        prompt_path = directory / 'AGENTS.md'
        if directory.is_symlink() or prompt_path.is_symlink():
            raise ValueError('Workspace instructions cannot be symlinks')
        prompt = prompt_path.read_bytes()
        if agent_id == 'oncall':
            # Preserve the separately reviewed VM policy and its existing hash contract.
            with tempfile.TemporaryDirectory() as tmp:
                target = pathlib.Path(tmp) / 'AGENTS.md'
                target.write_bytes(prompt)
                subprocess.run(['git', 'apply', '--whitespace=error', str(
                    (root / 'deploy/gcp-vm/oncall-vm-policy.patch').resolve())], cwd=tmp, check=True)
                prompt = target.read_bytes()
            expected = (root / 'deploy/gcp-vm/oncall-vm-prompt.sha256').read_text().split()[0]
            if sha(prompt) != expected:
                raise ValueError('Oncall VM policy hash mismatch')
        config = copy.deepcopy(definition)
        config['workspace'] = workspace(agent_id)
        result[agent_id] = {'config': config, 'prompt': prompt.decode(), 'sha256': sha(prompt)}
    selected = sorted({s for item in result.values() for s in item.get('config').get('skills', [])})
    return validate_bundle({'version': 1, 'agents': result, 'skills': selected})


def with_agents(content, bundle, previous_ids):
    validate_bundle(bundle)
    config = json.loads(content)
    entries = config.setdefault('agents', {}).setdefault('entries', {})
    for agent_id, item in bundle.get('agents').items():
        old = entries.get(agent_id)
        if old is not None and agent_id not in previous_ids:
            raise ValueError('Refusing to adopt an unmanaged agent: ' + agent_id)
        desired = copy.deepcopy(item.get('config'))
        if old is None:
            tools = desired.get('tools', {})
            if desired.get('permissionModeDefault') != 'read-only' or not tools.get('allow'):
                raise ValueError('New agents need explicit read-only default and tool allowlist')
        else:
            current_workspace = old.get('workspace')
            if current_workspace is not None and current_workspace != desired.get('workspace'):
                raise ValueError('Existing managed workspace differs; reconcile before deployment')
            # Preserve unspecified native options and explicit VM operational overrides.
            desired = {**old, **desired}
            for field in VM_FIELDS:
                if field in old:
                    desired[field] = copy.deepcopy(old.get(field))
        entries[agent_id] = desired
    load = config.setdefault('skills', {}).setdefault('load', {})
    roots = load.setdefault('extraDirs', [])
    if '/opt/oncall-skills/skills' not in roots:
        roots.append('/opt/oncall-skills/skills')
    return (json.dumps(config, indent=2, ensure_ascii=False, allow_nan=False) + '\n').encode()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root', type=pathlib.Path, required=True)
    parser.add_argument('--output', type=pathlib.Path, required=True)
    parser.add_argument('--skills-target', type=pathlib.Path, required=True)
    args = parser.parse_args()
    bundle = build_bundle(args.root)
    spec = importlib.util.spec_from_file_location('skill_library', args.root / 'agent-skills/scripts/library.py')
    library = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(library)
    library.export_selection(args.root / 'agent-skills', bundle.get('skills'), args.skills_target)
    (args.skills_target / 'skills').mkdir(exist_ok=True)
    args.output.write_text(json.dumps(bundle, indent=2, ensure_ascii=False) + '\n')
    # Existing release tooling consumes this path; derive it from the same bundle.
    legacy = args.output.parent / 'workspace'
    legacy.mkdir()
    (legacy / 'AGENTS.md').write_text(bundle.get('agents').get('oncall').get('prompt'))


if __name__ == '__main__':
    main()
