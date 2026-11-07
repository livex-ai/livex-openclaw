import { expect, it } from "vitest";
import { parseOncallConfig } from "./config.js";
import { config } from "./test-support.js";

it("projects Calendar public identity without credential values or reference payloads", () => {
  const result = parseOncallConfig({
    ...config,
    googleCalendar: {
      enabled: true,
      calendarId: "rotation@example.test",
      oauth: {
        clientId: "public-client",
        clientSecret: "secret-canary",
        refreshToken: { source: "env", provider: "default", id: "REF_CANARY" },
      },
    },
  });
  expect(result).toMatchObject({
    googleCalendar: {
      enabled: true,
      calendarId: "rotation@example.test",
      oauth: { clientId: "public-client" },
    },
  });
  expect(JSON.stringify(result)).not.toMatch(/secret-canary|REF_CANARY|clientSecret|refreshToken/);
});

it("keeps missing Calendar identity available for visible fallback instead of rejecting Oncall", () => {
  expect(parseOncallConfig({ ...config, googleCalendar: { enabled: true } })).toMatchObject({
    googleCalendar: { enabled: true },
  });
});
