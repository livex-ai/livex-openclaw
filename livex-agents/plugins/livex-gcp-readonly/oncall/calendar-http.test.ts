import { beforeEach, expect, it, vi } from "vitest";
import { CALENDAR_SCOPE } from "./calendar-config.js";
import { fetchCalendarEvents } from "./calendar-http.js";
import { now } from "./test-support.js";

const boundary = vi.hoisted(() => ({ fetch: vi.fn(), secret: vi.fn(), revision: 1 }));
vi.mock("openclaw/plugin-sdk/ssrf-runtime", () => ({ fetchWithSsrFGuard: boundary.fetch }));
vi.mock("openclaw/plugin-sdk/secret-input-runtime", () => ({
  getPreparedPluginSecretInput: boundary.secret,
}));
const token = () => ({
  access_token: "synthetic-access",
  token_type: "Bearer",
  expires_in: 3600,
  scope: CALENDAR_SCOPE,
});
const params = () => ({
  config: { enabled: true, calendarId: "team/#?", oauth: { clientId: "public-client" } },
  signal: new AbortController().signal,
  now: () => now,
  assertCurrent() {},
});
function response(body: unknown, status = 200) {
  const release = vi.fn(async () => {});
  return { response: new Response(JSON.stringify(body), { status }), release };
}
beforeEach(() => {
  boundary.revision = 1;
  boundary.secret.mockImplementation((_plugin, path) => ({
    value: path.endsWith("clientSecret") ? "synthetic-secret" : "synthetic-refresh",
    revision: boundary.revision,
  }));
  boundary.fetch.mockReset();
});
it("refreshes once with fixed guarded origins and follows empty recurring result pages", async () => {
  const replies = [
    response(token()),
    response({ items: [], nextPageToken: "second" }),
    response({ items: [] }),
  ];
  boundary.fetch.mockImplementation(async (options) => {
    options.beforeRequest();
    return replies[boundary.fetch.mock.calls.length - 1];
  });
  const result = await fetchCalendarEvents(params());
  expect(result.events).toEqual([]);
  const options = boundary.fetch.mock.calls.map(([value]) => value);
  expect(options[0]).toMatchObject({
    url: "https://oauth2.googleapis.com/token",
    requireHttps: true,
    maxRedirects: 0,
    capture: false,
    policy: { hostnameAllowlist: ["oauth2.googleapis.com"] },
  });
  expect(new URLSearchParams(options[0].init.body).get("refresh_token")).toBe("synthetic-refresh");
  const first = new URL(options[1].url);
  expect(first.pathname).toBe("/calendar/v3/calendars/team%2F%23%3F/events");
  expect(first.searchParams.get("singleEvents")).toBe("true");
  expect(first.searchParams.get("timeMax")).toBe(new Date(now + 60_000).toISOString());
  expect(new URL(options[2].url).searchParams.get("pageToken")).toBe("second");
  expect(options[1].policy).toEqual({ hostnameAllowlist: ["www.googleapis.com"] });
  for (const reply of replies) {
    expect(reply.release).toHaveBeenCalledOnce();
  }
});
it.each([
  { ...token(), expires_in: undefined },
  { ...token(), expires_in: 0 },
  { ...token(), token_type: "DPoP" },
  { ...token(), scope: "other" },
  { ...token(), access_token: "" },
])("rejects unsupported token response %#", async (body) => {
  boundary.fetch.mockResolvedValue(response(body));
  await expect(fetchCalendarEvents(params())).rejects.toThrow("token_rejected");
  expect(boundary.fetch).toHaveBeenCalledOnce();
});
it("never uses ambient credentials when prepared values are unavailable", async () => {
  boundary.secret.mockReturnValue({ revision: 1 });
  await expect(fetchCalendarEvents(params())).rejects.toThrow("missing_credentials");
  expect(boundary.fetch).not.toHaveBeenCalled();
});
it("discards a response after prepared revision changes", async () => {
  boundary.fetch.mockImplementation(async () => {
    boundary.revision++;
    return response(token());
  });
  await expect(fetchCalendarEvents(params())).rejects.toThrow("secret_changed");
});
it("counts actual whitespace bytes across pages and releases rejected responses", async () => {
  const replies = [
    response(token()),
    ...Array.from({ length: 9 }, (_, index) => ({
      response: new Response(
        " ".repeat(250_000) + JSON.stringify({ items: [], nextPageToken: String(index) }),
      ),
      release: vi.fn(async () => {}),
    })),
  ];
  const all = [...replies];
  boundary.fetch.mockImplementation(async () => replies.shift());
  await expect(fetchCalendarEvents(params())).rejects.toThrow("incomplete_result");
  for (const reply of all.slice(0, boundary.fetch.mock.calls.length)) {
    expect(reply.release).toHaveBeenCalledOnce();
  }
});

it.each([401, 403, 429, 500, 503])(
  "does not retry HTTP %s or expose upstream bodies",
  async (status) => {
    const failed = response({ error: "upstream-secret-canary" }, status);
    boundary.fetch.mockResolvedValueOnce(response(token())).mockResolvedValueOnce(failed);
    await expect(fetchCalendarEvents(params())).rejects.toThrow("calendar_unavailable");
    expect(boundary.fetch).toHaveBeenCalledTimes(2);
    expect(failed.release).toHaveBeenCalledOnce();
    expect(failed.response.bodyUsed).toBe(true);
  },
);
it.each([
  { items: [], nextPageToken: "" },
  { items: [], nextPageToken: " " },
  { items: [], nextPageToken: "token\u0000" },
  { items: [], nextPageToken: 123 },
  { items: "wrong" },
  {},
  { items: Array.from({ length: 1001 }, () => ({})) },
])("rejects incomplete or excessive page %#", async (body) => {
  const page = response(body);
  boundary.fetch.mockResolvedValueOnce(response(token())).mockResolvedValueOnce(page);
  await expect(fetchCalendarEvents(params())).rejects.toThrow("incomplete_result");
  expect(page.release).toHaveBeenCalledOnce();
});
it("rejects repeated cursors and never accepts a truncated ten-page result", async () => {
  boundary.fetch
    .mockResolvedValueOnce(response(token()))
    .mockImplementation(async () => response({ items: [], nextPageToken: "repeat" }));
  await expect(fetchCalendarEvents(params())).rejects.toThrow("incomplete_result");
  expect(boundary.fetch).toHaveBeenCalledTimes(3);
  boundary.fetch.mockReset();
  const replies = [
    response(token()),
    ...Array.from({ length: 10 }, (_, index) =>
      response({ items: [], nextPageToken: String(index) }),
    ),
  ];
  boundary.fetch.mockImplementation(async () => replies[boundary.fetch.mock.calls.length - 1]);
  await expect(fetchCalendarEvents(params())).rejects.toThrow("incomplete_result");
  expect(boundary.fetch).toHaveBeenCalledTimes(11);
  for (const reply of replies) {
    expect(reply.release).toHaveBeenCalledOnce();
  }
});
it.each(["token-cap", "page-cap", "token-json", "page-json", "utf8"])(
  "rejects %s bodies under the public bounded reader",
  async (kind) => {
    const bodies: Record<string, Response> = {
      "token-cap": new Response(" ".repeat(65_537)),
      "page-cap": new Response(" ".repeat(262_145)),
      "token-json": new Response("not JSON"),
      "page-json": new Response("not JSON"),
      utf8: new Response(new Uint8Array([255])),
    };
    const failed = { response: bodies[kind]!, release: vi.fn(async () => {}) };
    const page = kind.startsWith("page");
    if (page) {
      boundary.fetch.mockResolvedValueOnce(response(token()));
    }
    boundary.fetch.mockResolvedValueOnce(failed);
    await expect(fetchCalendarEvents(params())).rejects.toThrow();
    expect(failed.release).toHaveBeenCalledOnce();
    expect(boundary.fetch).toHaveBeenCalledTimes(page ? 2 : 1);
  },
);
it("rechecks token expiry before every page without a hidden refresh loop", async () => {
  let clock = now;
  boundary.fetch.mockResolvedValueOnce(response({ ...token(), expires_in: 1 }));
  const page = response({ items: [], nextPageToken: "next" });
  boundary.fetch.mockImplementationOnce(async () => {
    clock += 2_000;
    return page;
  });
  await expect(fetchCalendarEvents({ ...params(), now: () => clock })).rejects.toThrow(
    "token_rejected",
  );
  expect(boundary.fetch).toHaveBeenCalledTimes(2);
  expect(page.release).toHaveBeenCalledOnce();
});
it.each(["deadline", "cancellation", "revocation"])(
  "rechecks %s after awaited transport and releases its response",
  async (kind) => {
    let clock = now;
    let current = true;
    const abort = new AbortController();
    const reply = response(token());
    boundary.fetch.mockImplementation(async () => {
      if (kind === "deadline") {
        clock += 30_001;
      }
      if (kind === "cancellation") {
        abort.abort();
      }
      if (kind === "revocation") {
        current = false;
      }
      return reply;
    });
    await expect(
      fetchCalendarEvents({
        ...params(),
        signal: abort.signal,
        now: () => clock,
        assertCurrent() {
          if (!current) {
            throw new Error("retired");
          }
        },
      }),
    ).rejects.toThrow();
    expect(boundary.fetch).toHaveBeenCalledOnce();
    expect(reply.release).toHaveBeenCalledOnce();
  },
);

it.each(["deadline", "token-expiry"])(
  "refuses final HTTP handoff after delayed %s",
  async (kind) => {
    let clock = now;
    let requests = 0;
    boundary.fetch.mockImplementation(async (options) => {
      if (kind === "token-expiry" && requests === 0) {
        options.beforeRequest();
        requests++;
        return response({ ...token(), expires_in: 1 });
      }
      clock += kind === "deadline" ? 30_001 : 1_001;
      options.beforeRequest();
      requests++;
      return response({ items: [] });
    });
    await expect(fetchCalendarEvents({ ...params(), now: () => clock })).rejects.toThrow(
      kind === "deadline" ? "incomplete_result" : "token_rejected",
    );
    expect(requests).toBe(kind === "deadline" ? 0 : 1);
  },
);

it("rejects a completed page when its awaited release exceeds the whole lookup deadline", async () => {
  let clock = now;
  const page = response({ items: [] });
  page.release.mockImplementation(async () => {
    clock += 30_001;
  });
  boundary.fetch.mockResolvedValueOnce(response(token())).mockResolvedValueOnce(page);
  await expect(fetchCalendarEvents({ ...params(), now: () => clock })).rejects.toThrow(
    "incomplete_result",
  );
  expect(page.release).toHaveBeenCalledOnce();
  expect(boundary.fetch).toHaveBeenCalledTimes(2);
});
