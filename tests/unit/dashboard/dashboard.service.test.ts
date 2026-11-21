import { buildCards, createDashboardService } from '../../../src/modules/dashboard/dashboard.service.js';
import type { EndpointMonitor } from '../../../src/modules/endpointMonitors/endpointMonitors.types.js';
import type { WebhookMonitor } from '../../../src/modules/webhookMonitors/webhookMonitors.types.js';
import type { MonitorState } from '../../../src/types/monitorState.js';

const emptyState: MonitorState = {
  lastResult: null,
  currentStatus: null,
  lastCheckAt: null,
  nextCheckAt: null,
  lastCheckId: null,
  openIncidentId: null,
  lastAgeMs: null,
  lastResponseTimeMs: null,
  consecutiveFailures: 0,
};
const at = new Date('2026-11-18T10:00:00Z');
const base = {
  checkInterval: { value: 10, unit: 'MINUTE' as const, ms: 600_000 },
  alertMode: 'ONCE_WITH_RECOVERY' as const,
  createdBy: 'u',
  updatedBy: 'u',
  createdAt: at,
  updatedAt: at,
  deletedAt: null,
};

const webhook = (
  id: string,
  over: Omit<Partial<WebhookMonitor>, 'state'> & { state?: Partial<MonitorState> } = {},
): WebhookMonitor => ({
  ...base,
  id,
  name: `Webhook ${id}`,
  gatewayName: 'G',
  sourceCollection: 'c',
  timestampKey: 'dCreatedAt',
  threshold: { value: 2, unit: 'HOUR', ms: 7_200_000 },
  isEnabled: true,
  hasTimestampIndexAtSave: true,
  ...over,
  state: { ...emptyState, ...over.state },
});
const endpoint = (
  id: string,
  over: Omit<Partial<EndpointMonitor>, 'state'> & { state?: Partial<MonitorState> } = {},
): EndpointMonitor => ({
  ...base,
  id,
  serverName: `Server ${id}`,
  url: 'https://x.test',
  retryCount: 2,
  isEnabled: true,
  ...over,
  state: { ...emptyState, ...over.state },
});

describe('buildCards (FR-D1)', () => {
  it('counts total, ok, failing, paused and passes the two external numbers through', () => {
    const rows = (
      ['OK', 'OK', 'STALE', 'NO_DATA', 'DOWN', 'ERROR', 'PAUSED', 'PENDING_FIRST_CHECK'] as const
    ).map((status) => ({ status }));
    expect(buildCards(rows, { openIncidents: 3, emailsFailed: 2 })).toEqual({
      total: 8,
      ok: 2,
      failing: 4,
      paused: 1,
      openIncidents: 3,
      emailsFailed: 2,
    });
  });
  it('is all zeros for no monitors', () => {
    expect(buildCards([], { openIncidents: 0, emailsFailed: 0 })).toEqual({
      total: 0,
      ok: 0,
      failing: 0,
      paused: 0,
      openIncidents: 0,
      emailsFailed: 0,
    });
  });
});

describe('overview', () => {
  function service(opts: {
    webhooks: WebhookMonitor[];
    endpoints: EndpointMonitor[];
    outage?: { openedAt: Date; affectedMonitorIds: string[] } | null;
  }) {
    return createDashboardService({
      webhookMonitors: { list: () => Promise.resolve(opts.webhooks) },
      endpointMonitors: { list: () => Promise.resolve(opts.endpoints) },
      incidents: {
        countOpen: () => Promise.resolve(2),
        findOpenSourceError: () => Promise.resolve((opts.outage ?? null) as never),
      },
      alerts: { countFailed: () => Promise.resolve(5) },
      timeZone: 'UTC',
    });
  }

  it('shows PAUSED for disabled monitors, ERROR during an outage, and "not checked yet" before the first check', async () => {
    const overview = await service({
      webhooks: [
        webhook('a', {
          state: {
            lastResult: 'OK',
            currentStatus: 'OK',
            lastCheckAt: at,
            nextCheckAt: new Date('2026-11-18T10:10:00Z'),
            lastAgeMs: 3 * 3_600_000 + 12 * 60_000,
          },
        }),
        webhook('b', { isEnabled: false, state: { lastResult: 'STALE' } }),
        webhook('c', { state: { lastResult: 'ERROR', currentStatus: 'STALE' } }),
        webhook('d'),
      ],
      endpoints: [endpoint('e', { state: { lastResult: 'DOWN', lastResponseTimeMs: 250, lastCheckAt: at } })],
    }).overview();

    expect(Object.fromEntries(overview.rows.map((r) => [r.id, r.status]))).toEqual({
      a: 'OK',
      b: 'PAUSED',
      c: 'ERROR',
      d: 'PENDING_FIRST_CHECK',
      e: 'DOWN',
    });
    expect(overview.cards).toEqual({
      total: 5,
      ok: 1,
      failing: 2,
      paused: 1,
      openIncidents: 2,
      emailsFailed: 5,
    });
    const a = overview.rows.find((r) => r.id === 'a');
    expect(a).toMatchObject({
      typeLabel: 'Webhook',
      href: '/webhook-monitors/a',
      lastCheck: '2026-11-18 10:00:00 UTC',
      nextCheck: '2026-11-18 10:10:00 UTC',
      metric: '3 h 12 min',
    });
    const e = overview.rows.find((r) => r.id === 'e');
    expect(e).toMatchObject({
      typeLabel: 'Endpoint',
      href: '/endpoint-monitors/e',
      metric: '250 ms',
      nextCheck: '—',
    });
    expect(overview.rows.find((r) => r.id === 'b')?.nextCheck).toBe('—');
  });

  it('shows the source outage banner data only while one is open', async () => {
    const none = await service({ webhooks: [], endpoints: [] }).overview();
    expect(none.sourceOutage).toBeNull();
    const open = await service({
      webhooks: [],
      endpoints: [],
      outage: { openedAt: at, affectedMonitorIds: ['a', 'b'] },
    }).overview();
    expect(open.sourceOutage).toEqual({ openedAt: '2026-11-18 10:00:00 UTC', affectedCount: 2 });
  });
});
