import { CalendarUnavailable } from "./calendar-config.js";
import { selectCalendarRoster } from "./calendar-events.js";
import { fetchCalendarEvents } from "./calendar-http.js";
import type { OncallConfig } from "./config.js";
import type { Roster } from "./types.js";

type Params = {
  config: OncallConfig;
  signal: AbortSignal;
  now(): number;
  assertCurrent(): void;
  canvas(): Promise<Roster>;
};

function current(params: Params) {
  params.signal.throwIfAborted();
  params.assertCurrent();
}

async function canvas(params: Params, warning?: string): Promise<Roster> {
  current(params);
  const roster = await params.canvas();
  current(params);
  return {
    ...roster,
    provider: "canvas",
    validUntil: params.now() + params.config.tickMs,
    warning,
  };
}

export function createCalendarRoster(params: Params): () => Promise<Roster> {
  return async () => {
    current(params);
    const config = params.config.googleCalendar;
    if (!config?.enabled) {
      return canvas(params);
    }
    try {
      const result = await fetchCalendarEvents({
        config,
        signal: params.signal,
        now: params.now,
        assertCurrent: params.assertCurrent,
      });
      current(params);
      const now = params.now();
      const roster = selectCalendarRoster(
        result.events,
        now,
        Math.min(result.queryEnd, now + params.config.tickMs),
      );
      return { ...roster, assertFresh: result.assertFresh };
    } catch (error) {
      current(params);
      const reason = error instanceof CalendarUnavailable ? error.category : "calendar_unavailable";
      return canvas(params, `Calendar roster unavailable: ${reason}; using current Canvas`);
    }
  };
}
