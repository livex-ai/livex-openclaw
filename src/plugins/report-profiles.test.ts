import { describe, expect, it } from "vitest";
import { createCapturedPluginRegistration } from "./captured-registration.js";
import { createOwnershipRecord } from "./registry-ownership.test-support.js";
import { createTestPluginRegistry } from "./registry-runtime.test-helpers.js";

function profile(id: string, agentId: string) {
  return {
    id,
    agentIds: [agentId],
    channels: ["slack"],
    inputSchema: { type: "object", properties: { [id]: { type: "string" } } },
    instructions: `Use ${id}`,
    prepare: () => ({ profileId: id, text: `${id} report`, channelData: {}, state: {} }),
    appendNotice: (prepared: { text: string }, notice: string) => ({
      profileId: id,
      text: `${prepared.text}: ${notice}`,
      channelData: {},
      state: {},
    }),
  };
}

function harness(id = "report-owner") {
  const builder = createTestPluginRegistry();
  const record = createOwnershipRecord(id);
  record.status = "loaded";
  builder.registry.plugins.push(record);
  return { builder, record, api: builder.createApi(record, { config: {} }) };
}

describe("agent report profiles", () => {
  it("resolves independent schemas and output by trusted agent/channel, leaving other agents alone", async () => {
    const { builder, api } = harness();
    api.registerReportProfile(profile("compact", "oncall"));
    api.registerReportProfile(profile("qa", "qa"));
    const { resolveReportProfileFromRegistry } = await import("./report-profiles.runtime.js");
    const oncall = resolveReportProfileFromRegistry(builder.registry, "oncall", "slack");
    const qa = resolveReportProfileFromRegistry(builder.registry, "qa", "slack");
    expect(oncall?.inputSchema).toEqual(profile("compact", "oncall").inputSchema);
    expect(qa?.inputSchema).toEqual(profile("qa", "qa").inputSchema);
    expect(oncall?.prepare({}, {})).toMatchObject({ text: "compact report" });
    expect(qa?.prepare({}, {})).toMatchObject({ text: "qa report" });
    expect(resolveReportProfileFromRegistry(builder.registry, "other", "slack")).toBeUndefined();
    expect(
      resolveReportProfileFromRegistry(builder.registry, "oncall", "telegram"),
    ).toBeUndefined();
  });

  it.each([false, true])(
    "rejects conflicting owners in either registration order (%s)",
    async (reverse) => {
      const { builder, api } = harness();
      const other = createOwnershipRecord("other-owner");
      other.status = "loaded";
      builder.registry.plugins.push(other);
      const otherApi = builder.createApi(other, { config: {} });
      const owners = reverse ? [otherApi, api] : [api, otherApi];
      owners[0]!.registerReportProfile(profile("first", "oncall"));
      owners[1]!.registerReportProfile(profile("second", "oncall"));
      const { resolveReportProfileFromRegistry } = await import("./report-profiles.runtime.js");
      expect(resolveReportProfileFromRegistry(builder.registry, "oncall", "slack")).toBeUndefined();
      expect(builder.registry.diagnostics).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            level: "error",
            message: expect.stringContaining("already registered"),
          }),
        ]),
      );
    },
  );

  it("does not resolve contributions of a disabled owner", async () => {
    const { builder, api, record } = harness();
    api.registerReportProfile(profile("compact", "oncall"));
    record.enabled = false;
    record.status = "disabled";
    const { resolveReportProfileFromRegistry } = await import("./report-profiles.runtime.js");
    expect(resolveReportProfileFromRegistry(builder.registry, "oncall", "slack")).toBeUndefined();
  });

  it("captures the same additive capability during inspection", () => {
    const captured = createCapturedPluginRegistration();
    const value = profile("compact", "oncall");
    captured.api.registerReportProfile(value);
    expect(captured.reportProfiles).toEqual([value]);
  });
});
