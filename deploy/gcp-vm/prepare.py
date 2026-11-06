#!/usr/bin/env python3
"""Offline preparation from an explicitly reviewed, credential-free JSON snapshot."""
import argparse
import copy
import hashlib
import json
import os
from pathlib import Path
import re

DIGEST = re.compile(r'^\S+@sha256:[a-f0-9]{64}$')
SHA = re.compile(r'^[a-f0-9]{40}$')
CREDENTIAL = re.compile(r'^(token|botToken|appToken|password|apiKey|accessToken|refreshToken|idToken|cookie|privateKey|clientSecret|signingSecret|userToken|authorization|credentials)$', re.I)


def check_secrets(value):
    if isinstance(value, dict):
        if 'source' in value and ('provider' in value or 'id' in value):
            if (value.get('source') != 'env' or set(value) != {'source', 'provider', 'id'}
                    or value.get('provider') != 'default'
                    or not re.fullmatch(r'[A-Z_][A-Z0-9_]*', str(value.get('id', '')))):
                raise ValueError('Only default env SecretRefs are accepted')
        for key, child in value.items():
            if key.lower() == 'headers' and (not isinstance(child, dict) or any(
                    not isinstance(v, dict) or v.get('source') != 'env' for v in child.values())):
                raise ValueError('Headers must use env SecretRefs')
            if CREDENTIAL.fullmatch(key.replace('_', '').replace('-', '')):
                if not (isinstance(child, dict) and child.get('source') == 'env'):
                    raise ValueError('Credential fields must already be env SecretRefs')
            check_secrets(child)
    elif isinstance(value, list):
        for child in value: check_secrets(child)
    elif isinstance(value, str):
        if re.search(r'(xox[baprs]-|xapp-|-----BEGIN .*PRIVATE KEY|ya29\.|sk-[A-Za-z0-9]{16})', value):
            raise ValueError('Raw credential material is not accepted')


def transform(source, settings):
    if source.get('env'):
        raise ValueError('Do not export host environment maps')
    check_secrets(source)
    providers = source.get('secrets', {}).get('providers', {})
    if any(name != 'default' or entry.get('source') != 'env' for name, entry in providers.items()):
        raise ValueError('Host secret providers are not accepted')
    if not DIGEST.fullmatch(settings['image']) or not SHA.fullmatch(settings['sourceSha']):
        raise ValueError('Release requires immutable image digest and reviewed source SHA')
    account = settings['attachedServiceAccount']
    if not re.fullmatch(r'[a-zA-Z0-9._-]+@[a-zA-Z0-9.-]+\.iam\.gserviceaccount\.com', account):
        raise ValueError('Supply the attached service account email')
    approved = settings['approvedModel']
    if not isinstance(approved, str) or '/' not in approved or not approved.strip():
        raise ValueError('Explicit approved provider/model required')
    mapping = settings['pathMap']
    if not isinstance(mapping, dict) or any(
        not isinstance(k, str) or not isinstance(v, str) or not k.startswith('/')
        or not v.startswith('/') or '/Users/' in v or '/Volumes/' in v
        or '..' in v.split('/') or any(c in k + v for c in '\r\n\0')
        for k, v in mapping.items()
    ):
        raise ValueError('pathMap must contain exact absolute source-to-container paths')

    def remap(value):
        if isinstance(value, dict): return {k: remap(v) for k, v in value.items()}
        if isinstance(value, list): return [remap(v) for v in value]
        if isinstance(value, str):
            if value.startswith('/'):
                if value not in mapping: raise ValueError('Missing exact path mapping')
                return mapping[value]
            if '/Users/' in value or '/Volumes/' in value or value.startswith('~/'):
                raise ValueError('Unresolved host path')
        return value

    result = remap(copy.deepcopy(source))
    config = result['plugins']['entries']['livex-gcp-readonly']['config']
    repositories = config.get('repositories')
    if not isinstance(repositories, list) or not repositories:
        raise ValueError('Explicit repository bindings required')
    ids, paths = set(), set()
    for repo in repositories:
        if (not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_-]{0,79}', repo['id'])
                or repo['id'] in ids or repo['path'] in paths
                or not repo['path'].startswith('/repos/') or not SHA.fullmatch(repo['commit'])):
            raise ValueError('Invalid, duplicate, unmapped repository binding or pin')
        ids.add(repo['id']); paths.add(repo['path'])
    sender = config['allowedSenderId']
    slack = result['channels']['slack']
    bindings = [b for b in result['bindings'] if b.get('agentId') == 'oncall'
                and b.get('match', {}).get('channel') == 'slack']
    if not bindings: raise ValueError('Oncall Slack routing required')
    for binding in bindings:
        account_id = binding['match'].get('accountId', slack.get('defaultAccount', 'default'))
        accounts = slack.get('accounts', {})
        if accounts and account_id not in accounts: raise ValueError('Unknown routed Slack account')
        effective = {**slack, **accounts.get(account_id, {})}
        if effective.get('allowFrom') != [sender]: raise ValueError('Slack/plugin caller identity mismatch')
        for layer in (slack, accounts.get(account_id, {})):
            if 'allowFrom' in layer and layer['allowFrom'] != [sender]:
                raise ValueError('Conflicting Slack caller gates')
        channels = effective.get('channels', {})
        if not channels or any(c.get('users') != [sender] for c in channels.values()):
            raise ValueError('Slack channel/plugin caller identity mismatch')
        if config['allowedChannelId'] != '*' and set(channels) != {config['allowedChannelId']}:
            raise ValueError('Slack/plugin channel gate mismatch')
    gateway = result['gateway']
    if gateway.get('mode') != 'local' or gateway.get('auth', {}).get('mode') != 'token':
        raise ValueError('Explicit local Gateway mode and env-referenced token auth required')
    if not isinstance(gateway['auth'].get('token'), dict):
        raise ValueError('Gateway token must be an env SecretRef')
    if gateway.get('port') != 18791: raise ValueError('Reviewed Gateway port must be 18791')
    if gateway.get('bind') not in ('loopback', 'lan'): raise ValueError('Unexpected Gateway transport')
    gateway['bind'] = 'lan'
    config['gcloudAccount'] = account
    agent = result['agents']['entries']['oncall']
    existing = agent.get('model')
    def primary_value(model):
        value = model.get('primary') if isinstance(model, dict) else model
        return value.strip() or None if isinstance(value, str) else None
    primary = primary_value(existing) or primary_value(result['agents'].get('defaults', {}).get('model'))
    if primary is not None and primary != approved: raise ValueError('Existing model differs from approved model')
    if primary is None:
        agent['model'] = {**existing, 'primary': approved} if isinstance(existing, dict) else approved
    return result


def write_release(source, settings, output):
    result = transform(source, settings)
    # Validate completely before creating any output; mkdir fails if it exists.
    output.mkdir(mode=0o700)
    for name, value in [('openclaw.json', result), ('release.json', {
        'image': settings['image'], 'sourceSha': settings['sourceSha'],
        'sourceConfigSha256': hashlib.sha256(json.dumps(source, sort_keys=True).encode()).hexdigest(),
        'pathMap': settings['pathMap'], 'attachedServiceAccount': settings['attachedServiceAccount'],
    })]:
        with (output / name).open('x', encoding='utf-8') as handle:
            os.chmod(handle.name, 0o600)
            json.dump(value, handle, indent=2); handle.write('\n')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source', required=True, type=Path)
    parser.add_argument('--settings', required=True, type=Path)
    parser.add_argument('--output', required=True, type=Path)
    args = parser.parse_args()
    try:
        write_release(json.loads(args.source.read_text()), json.loads(args.settings.read_text()), args.output)
    except (ValueError, KeyError, TypeError, OSError):
        parser.exit(1, 'Preparation failed: check reviewed inputs, exact paths, caller gates, credentials, and output location.\n')
