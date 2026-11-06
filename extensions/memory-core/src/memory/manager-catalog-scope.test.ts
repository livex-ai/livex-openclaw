import fs from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import { createManagerIndexFixture } from "./manager-index.test-support.js";

const managers = await import("./index.js");
const fixture = createManagerIndexFixture(managers);

it("requires rebuilding a broad index and then searches only the explicit catalog", async () => {
  const catalog = path.join(fixture.paths.root, "investigations.md");
  await fs.writeFile(catalog, "catalogscope known variant_name investigation");
  await fs.writeFile(
    path.join(fixture.paths.workspace, "MEMORY.md"),
    "catalogscope private root note",
  );
  await fs.writeFile(path.join(fixture.paths.workspace, "USER.md"), "catalogscope private profile");
  await fs.writeFile(
    path.join(fixture.paths.memory, "private.md"),
    "catalogscope private daily note",
  );
  const cfg = fixture.createConfig({
    provider: "none",
    sources: ["memory"],
    rememberAcrossConversations: false,
    extraPaths: [catalog],
    vectorEnabled: false,
  });
  const broad = await fixture.getFreshManager(cfg, "cli");
  await broad.sync({ reason: "seed", force: true });
  expect((await broad.search("catalogscope", { minScore: 0, maxResults: 20 })).length).toBe(4);
  await broad.close();
  const scoped = {
    ...cfg,
    memory: {
      ...cfg.memory,
      search: {
        ...cfg.memory?.search,
        includeWorkspace: false,
      },
    },
  };
  const narrow = await fixture.getFreshManager(scoped, "cli");
  expect((await narrow.statusAsync()).custom?.indexIdentity).toMatchObject({
    status: "mismatched",
    code: "scope",
  });
  expect(await narrow.search("catalogscope", { minScore: 0, maxResults: 20 })).toEqual([]);
  await narrow.sync({ reason: "catalog-scope", force: true });
  const hits = await narrow.search("catalogscope", { minScore: 0, maxResults: 20 });
  expect(hits.map(({ path: file }) => file)).toEqual([
    path.relative(fixture.paths.workspace, catalog).replaceAll(path.sep, "/"),
  ]);
  expect(hits[0]?.snippet).toContain("known variant_name");
  await expect(narrow.readFile({ relPath: "MEMORY.md" })).rejects.toMatchObject({
    code: "MEMORY_PATH_NOT_ALLOWED",
  });
  await expect(narrow.readFile({ relPath: catalog })).resolves.toMatchObject({
    status: "ok",
    text: "catalogscope known variant_name investigation",
  });
});
