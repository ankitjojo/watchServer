import type { Paginated } from '../../types/paginated.js';
import type { Clock } from '../../types/clock.js';
import { toCheckDoc } from './checks.mapper.js';
import type { ChecksRepository } from './checks.repository.js';
import type { Check, CheckListFilter, RecordCheckInput, SeriesPoint } from './checks.types.js';

export const MAX_SERIES_POINTS = 500;
export const DEFAULT_PAGE_SIZE = 50;
export const MAX_PAGE_SIZE = 200;

export interface ChecksService {
  /** Stores one check (FR-H1). Always called BEFORE any alert is created (store first, FR-A1). */
  record(input: RecordCheckInput): Promise<Check>;
  listForMonitor(
    filter: CheckListFilter,
    page?: { cursor?: string; limit?: number },
  ): Promise<Paginated<Check>>;
  series(input: {
    monitorId: string;
    monitorType: 'WEBHOOK' | 'ENDPOINT';
    from: Date;
    to: Date;
  }): Promise<SeriesPoint[]>;
}

export function createChecksService(deps: { repo: ChecksRepository; clock: Clock }): ChecksService {
  const { repo, clock } = deps;
  return {
    record: (input) => repo.insert(toCheckDoc(input, { now: clock.now() })),
    listForMonitor(filter, page = {}) {
      const limit = Math.min(Math.max(page.limit ?? DEFAULT_PAGE_SIZE, 1), MAX_PAGE_SIZE);
      return repo.listForMonitor(filter, { ...(page.cursor ? { cursor: page.cursor } : {}), limit });
    },
    series: (input) => repo.series({ ...input, maxPoints: MAX_SERIES_POINTS }),
  };
}
