const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { initialize } = require("./init_catalog.cjs");

test("initialize only an opted-in oncall catalog, then preserve all existing bytes", (t) => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "oncall-state-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const dir = path.join(root, "custom-agent");
  fs.mkdirSync(dir);
  const owner = { enabled: true, agentId: "oncall" };
  const config = {
    plugins: { entries: { "livex-investigations": { config: { investigationCatalog: owner } } } },
  };
  const seed = () =>
    initialize(config, root, (_, id) => {
      assert.equal(id, "oncall");
      return dir;
    });
  const file = path.join(dir, "investigations.md");
  owner.enabled = false;
  assert.equal(seed(), "disabled");
  owner.enabled = true;
  owner.agentId = "other";
  assert.equal(seed(), "disabled");
  assert.equal(fs.existsSync(file), false);
  owner.agentId = "oncall";
  assert.equal(seed(), "initialized");
  assert.match(
    fs.readFileSync(file, "utf8"),
    /<!-- openclaw-investigations:v1 -->\n\n## Investigations\n$/,
  );
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  const bytes = Buffer.from("existing operator records\r\n");
  fs.writeFileSync(file, bytes);
  const inode = fs.statSync(file).ino;
  assert.equal(seed(), "preserved");
  assert.deepEqual(fs.readFileSync(file), bytes);
  assert.equal(fs.statSync(file).ino, inode);
  fs.unlinkSync(file);
  fs.symlinkSync(path.join(root, "somewhere-else"), file);
  assert.throws(seed, /regular investigation catalog/);
});
