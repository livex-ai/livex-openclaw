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
    source['plugins']['allow'] = ['slack', 'livex-gcp-readonly', 'livex-oncall-reports', 'livex-investigations']
    source['plugins']['entries']['livex-oncall-reports'] = {
        'enabled': True, 'config': {'agentProfiles': {'oncall': 'compact-v1'}}}
    source.get('plugins').get('entries')['livex-investigations'] = {
        'enabled': True, 'config': {'investigationCatalog': {'enabled': False, 'agentId': 'oncall'}}}
    source['plugins']['load'] = {'paths': [
        '/old/plugins/livex-gcp-readonly', '/old/plugins/livex-oncall-reports',
        '/old/plugins/livex-investigations']}
    settings['pathMap'].update({
        '/old/plugins/livex-gcp-readonly': '/opt/oncall/plugins/livex-gcp-readonly',
        '/old/plugins/livex-oncall-reports': '/opt/oncall/plugins/livex-oncall-reports',
        '/old/plugins/livex-investigations': '/opt/oncall/plugins/livex-investigations'})
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
            '/opt/oncall/plugins/livex-oncall-reports',
            '/opt/oncall/plugins/livex-investigations'])
        self.assertEqual(result.get('plugins').get('entries').get('livex-investigations'),
                         source.get('plugins').get('entries').get('livex-investigations'))
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


# This loader uses real repository SDK aliases, not stand-in SDK exports.
RUNTIME_CATALOG_PROBE = r"""import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { createRequire, registerHooks } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
const [root, gcp, agentDir] = process.argv.slice(2);
const rootRequire = createRequire(path.join(root, "package.json"));
const { createJiti } = rootRequire("jiti");
const { buildPluginLoaderAliasMap } = await import(
  pathToFileURL(path.join(root, "src/plugins/sdk-alias.ts")).href
);
const aliases = buildPluginLoaderAliasMap(
  path.join(root, "src/plugins/loader.ts"),
  undefined,
  undefined,
  "src",
  root,
);
const req = createRequire(path.join(gcp, "index.ts"));
const resolved = req.resolve("@livex/investigations/oncall-catalog");
assert.equal(resolved, path.join(path.dirname(gcp), "livex-investigations/oncall-catalog.ts"));
const load = createJiti(path.join(gcp, "index.ts"), {
  alias: aliases,
  fsCache: false,
  moduleCache: false,
  tryNative: true,
});
const slackImports = new Set();
const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    const resolved = nextResolve(specifier, context);
    const match = resolved.url.match(/\/slack\/(api|integration-api)\.[jt]s$/u);
    if (match) slackImports.add(match[1]);
    return resolved;
  },
});
try {
  const { registerOncall } = await load.import(path.join(gcp, "workflows/oncall/service.ts"));
  assert.equal(typeof registerOncall, "function");
  assert.deepEqual([...slackImports], ["integration-api"]);
} finally {
  hooks.deregister();
}
const { createOncallCatalogReader } = await load.import(resolved);
const { serializeCatalog, createIssueId } = await load.import(
  path.join(path.dirname(resolved), "schema.ts"),
);
const scope = {
  agentId: "oncall",
  accountId: "default",
  teamId: "T1",
  channelId: "C1",
  senderId: "U1",
};
const config = {
  agents: { entries: { oncall: { agentDir } } },
  plugins: {
    entries: {
      "livex-investigations": {
        enabled: true,
        config: { investigationCatalog: { enabled: true, agentId: "oncall" } },
      },
    },
  },
};
const signature = {
  service: "scheduler",
  environment: "prd",
  operation: "parse",
  error: "Missing field",
  resource: "job-1",
};
const reference = "https://example.slack.com/archives/C1/p1000000000000000";
const issue = {
  issueId: createIssueId({ ...signature, scope }),
  signature: { ...signature, scope },
  task: "Investigate",
  status: "Open",
  waitingOn: "",
  prs: [],
  jiraTickets: [],
  slackThreads: [reference],
  lastUpdated: "2026-11-06T10:00:00-08:00",
  whatWeDidLast: [
    {
      completedAt: "2026-11-06T10:00:00-08:00",
      summary: "Observed",
      kind: "new",
      facts: { priority: "Critical", finding: "Failure", impact: "One job", nextAction: "Review" },
      evidenceUrls: ["https://logs.example/1"],
      reportUrl: reference,
    },
  ],
};
await fs.writeFile(path.join(agentDir, "investigations.md"), serializeCatalog([issue]));
let checks = 0;
const reader = createOncallCatalogReader({
  config,
  scope,
  assertCurrent() {
    checks += 1;
  },
});
const matches = await reader.lookup([signature, { ...signature, error: "Different failure" }]);
assert.deepEqual(matches, [
  { classification: "known", issueId: issue.issueId, canonicalUrl: reference },
  { classification: "unknown" },
]);
assert.equal(checks, 2);
console.log(JSON.stringify({ resolved, matches, checks }));
"""


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
                    setup_entry = manifest.get('openclaw', {}).get('setupEntry')
                    if setup_entry:
                        self.assertTrue((package / setup_entry).is_file(), setup_entry)
                    for entry in manifest['openclaw']['extensions']:
                        self.assertTrue((package / entry).is_file(), entry)
                    self.assertTrue((package / 'openclaw.plugin.json').is_file())

    @unittest.skipUnless(shutil.which('node'), 'Node is needed for copied runtime import')
    def test_copied_coordinator_links_import_real_public_catalog_reader(self):
        root = Path(__file__).resolve().parents[2]
        dockerfile = (root / 'deploy/gcp-vm/Dockerfile').read_text()
        instructions = dockerfile.replace('\\\n', '').splitlines()
        commands = [line[4:] for line in instructions if line.startswith('RUN ')
                    and '/opt/oncall/plugins/livex-gcp-readonly/node_modules' in line]
        self.assertEqual(len(commands), 1)
        with tempfile.TemporaryDirectory() as temp:
            base = Path(temp).resolve()
            app = base / 'app'
            self.prepare_real_source_base(root, app)
            plugins = base / 'opt/oncall/plugins'
            for name in ('livex-gcp-readonly', 'livex-investigations'):
                shutil.copytree(root / 'livex-agents/plugins' / name, plugins / name,
                                ignore=shutil.ignore_patterns('node_modules', '__pycache__'))
            owner = plugins / 'livex-investigations'
            (owner / 'node_modules').mkdir()
            (owner / 'node_modules/zod').symlink_to(root / 'node_modules/zod', target_is_directory=True)
            (owner / 'node_modules/openclaw').symlink_to(app, target_is_directory=True)
            command = commands[0].replace('/opt/oncall', str(base / 'opt/oncall')).replace('/app', str(app))
            setup = subprocess.run(['sh', '-eu', '-c', command], text=True, capture_output=True, timeout=30)
            self.assertEqual(setup.returncode, 0, setup.stderr)
            package = plugins / 'livex-gcp-readonly'
            self.assertEqual((package / 'node_modules/@livex/investigations').resolve(), owner.resolve())
            self.assertEqual((package / 'node_modules/@openclaw/slack').resolve(),
                             (app / 'dist/extensions/slack').resolve())
            agent = base / 'agent'
            agent.mkdir()
            script = base / 'probe.mjs'
            script.write_text(RUNTIME_CATALOG_PROBE)
            run = subprocess.run(['node', '--import', str(root / 'scripts/tsx.mjs'), str(script),
                                  str(root), str(package), str(agent)],
                                 cwd=root, text=True, capture_output=True, timeout=180)
            self.assertEqual(run.returncode, 0, run.stderr)
            evidence = json.loads(run.stdout.splitlines()[-1])
            self.assertEqual(evidence.get('resolved'), str(owner / 'oncall-catalog.ts'))
            self.assertEqual([match.get('classification') for match in evidence.get('matches')],
                             ['known', 'unknown'])
            self.assertEqual(evidence.get('checks'), 2)

    def prepare_real_source_base(self, root, app):
        # Model the reviewed base's layout with actual installed/source artifacts.
        # Source aliases/Jiti stand in for unavailable compiled SDK output only.
        (app / 'node_modules').mkdir(parents=True)
        (app / 'node_modules/zod').symlink_to(root / 'node_modules/zod', target_is_directory=True)
        (app / 'src').symlink_to(root / 'src', target_is_directory=True)
        (app / 'dist/extensions/slack').mkdir(parents=True)
        (app / 'dist/extensions/slack/integration-api.js').symlink_to(
            root / 'extensions/slack/integration-api.ts')
        exports = {f'./plugin-sdk/{name}': f'./src/plugin-sdk/{name}.ts'
                   for name in ('plugin-entry', 'security-runtime')}
        (app / 'package.json').write_text(json.dumps({'name': 'openclaw', 'exports': exports}))

    @unittest.skipUnless(shutil.which('node'), 'Node is needed for runtime package resolution')
    def test_plugin_dependencies_resolve_and_mismatched_base_fails(self):
        root = Path(__file__).resolve().parents[2]
        dockerfile = (root / 'deploy/gcp-vm/Dockerfile').read_text()
        instructions = dockerfile.replace('\\\n', '').splitlines()
        plugins = {
            'livex-oncall-reports': ('plugin-entry', 'security-runtime'),
            'livex-investigations': ('plugin-entry', 'reply-turns', 'agent-runtime', 'report-profiles'),
        }
        for plugin, sdk_names in plugins.items():
            commands = [line[4:] for line in instructions if line.startswith('RUN ')
                        and f'/opt/oncall/plugins/{plugin}/node_modules' in line]
            self.assertEqual(len(commands), 1, 'Plugin dependency setup and validation must be one RUN')
            plugin_manifest = json.loads((root / f'livex-agents/plugins/{plugin}/package.json').read_text())
            base_manifest = json.loads((root / 'package.json').read_text())
            version = plugin_manifest.get('dependencies', {}).get('zod')
            self.assertEqual(version, base_manifest.get('dependencies', {}).get('zod'))
            # Exercise the actual image linkage/check command with a minimal base.
            # Do not install dependencies, run plugin code, or build an image.
            for variant in ('matching', 'wrong-zod', 'missing-sdk'):
                with self.subTest(plugin=plugin, variant=variant), tempfile.TemporaryDirectory() as temp:
                    app = Path(temp) / 'app'
                    package = Path(temp) / f'opt/oncall/plugins/{plugin}'
                    package.mkdir(parents=True)
                    (package / 'package.json').write_text(json.dumps(plugin_manifest))
                    (package / 'index.ts').write_text('')
                    zod = app / 'node_modules/zod'
                    zod.mkdir(parents=True)
                    (zod / 'index.js').write_text('module.exports = {};')
                    (zod / 'package.json').write_text(json.dumps({
                        'name': 'zod', 'main': './index.js', 'version':
                        '0.0.0' if variant == 'wrong-zod' else version}))
                    exports = {}
                    for name in sdk_names:
                        target = app / 'dist/plugin-sdk' / (name + '.js')
                        target.parent.mkdir(parents=True, exist_ok=True)
                        if variant != 'missing-sdk' or name != sdk_names[-1]:
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
