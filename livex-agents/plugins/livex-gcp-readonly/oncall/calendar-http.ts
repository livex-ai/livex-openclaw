import { readProviderJsonResponse } from "openclaw/plugin-sdk/provider-http";
import { getPreparedPluginSecretInput } from "openclaw/plugin-sdk/secret-input-runtime";
import { fetchWithSsrFGuard } from "openclaw/plugin-sdk/ssrf-runtime";
import { z } from "zod";
import {
  CALENDAR_LIMITS,
  CALENDAR_SCOPE,
  CALENDAR_SECRET_PATHS,
  CalendarUnavailable,
  type CalendarConfig,
} from "./calendar-config.js";

type Params = { config: CalendarConfig; signal: AbortSignal; now(): number; assertCurrent(): void };
type Budget = { bytes: number; deadline: number };
const plugin = "livex-gcp-readonly";

function prepared() {
  const client = getPreparedPluginSecretInput(plugin, CALENDAR_SECRET_PATHS.clientSecret);
  const refresh = getPreparedPluginSecretInput(plugin, CALENDAR_SECRET_PATHS.refreshToken);
  if (!client.value || !refresh.value) {
    throw new CalendarUnavailable("missing_credentials");
  }
  if (client.revision !== refresh.revision) {
    throw new CalendarUnavailable("secret_changed");
  }
  return { clientSecret: client.value, refreshToken: refresh.value, revision: client.revision };
}

function revisionGuard(signal: AbortSignal, assertCurrent: () => void, revision: number) {
  return () => {
    signal.throwIfAborted();
    assertCurrent();
    if (prepared().revision !== revision) {
      throw new CalendarUnavailable("secret_changed");
    }
  };
}

function remaining(params: Params, budget: Budget) {
  const ms = budget.deadline - params.now();
  if (ms <= 0) {
    throw new CalendarUnavailable("incomplete_result");
  }
  return ms;
}

function requestGuard(params: Params, budget: Budget, assertFresh: () => void, expires?: number) {
  return () => {
    assertFresh();
    remaining(params, budget);
    if (expires !== undefined && params.now() >= expires) {
      throw new CalendarUnavailable("token_rejected");
    }
  };
}

function countedResponse(response: Response, budget: Budget) {
  if (!response.body) {
    throw new CalendarUnavailable("incomplete_result");
  }
  const count = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      budget.bytes += chunk.byteLength;
      if (budget.bytes > CALENDAR_LIMITS.totalBytes) {
        throw new CalendarUnavailable("incomplete_result");
      }
      controller.enqueue(chunk);
    },
  });
  return new Response(response.body.pipeThrough(count), {
    status: response.status,
    headers: response.headers,
  });
}

async function request(
  params: Params,
  budget: Budget,
  assertFresh: () => void,
  url: string,
  init: RequestInit,
  maxBytes: number,
  page = false,
  expires?: number,
) {
  const beforeRequest = requestGuard(params, budget, assertFresh, expires);
  beforeRequest();
  const fetched = await fetchWithSsrFGuard({
    url,
    requireHttps: true,
    policy: { hostnameAllowlist: [new URL(url).hostname] },
    maxRedirects: 0,
    signal: params.signal,
    timeoutMs: remaining(params, budget),
    beforeRequest,
    capture: false,
    init,
  });
  try {
    beforeRequest();
    if (!fetched.response.ok) {
      throw new CalendarUnavailable(page ? "calendar_unavailable" : "token_rejected");
    }
    const response = page ? countedResponse(fetched.response, budget) : fetched.response;
    const value = await readProviderJsonResponse<unknown>(response, "Calendar", {
      maxBytes,
      signal: params.signal,
      timeoutMs: () => remaining(params, budget),
      requestHeaders: init.headers,
    });
    beforeRequest();
    return value;
  } finally {
    try {
      if (!fetched.response.bodyUsed) {
        await fetched.response.body?.cancel();
      }
    } finally {
      await fetched.release();
    }
  }
}

const tokenSchema = z.object({
  access_token: z.string().min(1),
  token_type: z.string(),
  expires_in: z.number().positive().finite(),
  scope: z.string().optional(),
});
function parseToken(value: unknown, now: number) {
  const parsed = tokenSchema.safeParse(value);
  if (!parsed.success) {
    throw new CalendarUnavailable("token_rejected");
  }
  const token = parsed.data;
  if (
    token.token_type.toLowerCase() !== "bearer" ||
    (token.scope !== undefined && !token.scope.split(/\s+/).includes(CALENDAR_SCOPE))
  ) {
    throw new CalendarUnavailable("token_rejected");
  }
  const expires = now + token.expires_in * 1_000;
  if (!Number.isFinite(expires)) {
    throw new CalendarUnavailable("token_rejected");
  }
  return { value: token.access_token, expires };
}

function query(params: Params, start: number) {
  const id = params.config.calendarId;
  if (!id || id === "." || id === ".." || !params.config.oauth?.clientId) {
    throw new CalendarUnavailable("missing_credentials");
  }
  const url = new URL(
    `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(id)}/events`,
  );
  url.search = new URLSearchParams({
    singleEvents: "true",
    showDeleted: "false",
    orderBy: "startTime",
    timeMin: new Date(start).toISOString(),
    timeMax: new Date(start + CALENDAR_LIMITS.queryMs).toISOString(),
    maxResults: "100",
  }).toString();
  return url;
}

const pageSchema = z.object({
  items: z.array(z.unknown()),
  nextPageToken: z
    .string()
    .min(1)
    .max(2_048)
    .regex(/^[^\p{Cc}\s]+$/u)
    .optional(),
});
async function pages(
  params: Params,
  budget: Budget,
  assertFresh: () => void,
  url: URL,
  token: ReturnType<typeof parseToken>,
) {
  const events: unknown[] = [];
  const seen = new Set<string>();
  for (let page = 0; page < CALENDAR_LIMITS.pages; page++) {
    if (params.now() >= token.expires) {
      throw new CalendarUnavailable("token_rejected");
    }
    const body = await request(
      params,
      budget,
      assertFresh,
      url.href,
      { headers: { Authorization: `Bearer ${token.value}` } },
      CALENDAR_LIMITS.pageBytes,
      true,
      token.expires,
    );
    const parsed = pageSchema.safeParse(body);
    if (!parsed.success) {
      throw new CalendarUnavailable("incomplete_result");
    }
    events.push(...parsed.data.items);
    if (events.length > CALENDAR_LIMITS.events) {
      throw new CalendarUnavailable("incomplete_result");
    }
    const next = parsed.data.nextPageToken;
    if (!next) {
      return events;
    }
    if (seen.has(next)) {
      throw new CalendarUnavailable("incomplete_result");
    }
    seen.add(next);
    url.searchParams.set("pageToken", next);
  }
  throw new CalendarUnavailable("incomplete_result");
}

export async function fetchCalendarEvents(params: Params) {
  params.assertCurrent();
  params.signal.throwIfAborted();
  const start = Math.floor(params.now() / 1_000) * 1_000;
  const budget = { bytes: 0, deadline: params.now() + CALENDAR_LIMITS.timeoutMs };
  const url = query(params, start);
  const credentials = prepared();
  const assertFresh = revisionGuard(params.signal, params.assertCurrent, credentials.revision);
  const form = new URLSearchParams({
    grant_type: "refresh_token",
    client_id: params.config.oauth!.clientId!,
    client_secret: credentials.clientSecret,
    refresh_token: credentials.refreshToken,
  });
  const body = await request(
    params,
    budget,
    assertFresh,
    "https://oauth2.googleapis.com/token",
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: form.toString(),
    },
    CALENDAR_LIMITS.tokenBytes,
  );
  const token = parseToken(body, start);
  const events = await pages(params, budget, assertFresh, url, token);
  assertFresh();
  remaining(params, budget);
  return { events, queryEnd: start + CALENDAR_LIMITS.queryMs, assertFresh };
}
