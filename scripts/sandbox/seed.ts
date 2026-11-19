import { MongoClient } from 'mongodb';

const HOUR = 3_600_000;
const MIN = 60_000;

interface SeedCollection {
  name: string;
  /** Age of each document in ms. Empty array = empty collection. */
  ages: number[];
  /** Whether to create a `dCreatedAt: -1` index (the source backend's own script does for 3 of the 5). */
  indexed: boolean;
  /** Overrides the timestamp value (to test FR-W2 rejection). */
  badValue?: string;
}

// The five launch collections (requirements section 6) plus two for testing the FR-W2 edge cases.
const COLLECTIONS: SeedCollection[] = [
  { name: 'razor_pay_webhook_data', ages: [1 * MIN, 25 * MIN, 2 * HOUR], indexed: true },
  { name: 'apple_pay_webhook_data', ages: [3 * HOUR, 5 * HOUR], indexed: true },
  { name: 'google_play_billing_webhook_logs', ages: [5 * MIN, 40 * MIN], indexed: true },
  // No index on these two: the dashboard shows the index warning (requirements section 5).
  { name: 'amazon_pay_webhook_data', ages: [30 * MIN, 2 * HOUR], indexed: false },
  { name: 'me_pass_webhooks', ages: [10 * MIN], indexed: false },
  { name: 'empty_webhooks', ages: [], indexed: false },
  { name: 'bad_ts_webhooks', ages: [0], indexed: false, badValue: 'not-a-date' },
];

/**
 * Fills the SANDBOX source database with fake webhook-like documents. This script only ever connects to
 * the in-memory server the sandbox started itself; it is never given SOURCE_MONGO_URI from .env, and it
 * lives in scripts/ so the production code in modules/sourceData stays strictly read-only.
 */
export async function seedSource(uri: string, dbName: string): Promise<void> {
  const client = await MongoClient.connect(uri);
  try {
    const db = client.db(dbName);
    const now = Date.now();
    for (const spec of COLLECTIONS) {
      const collection = db.collection(spec.name);
      if (spec.ages.length === 0) {
        await db.createCollection(spec.name);
        continue;
      }
      await collection.insertMany(
        spec.ages.map((age, i) => ({
          dCreatedAt: spec.badValue ?? new Date(now - age),
          sSandbox: true,
          // Payment-like noise that payMonitor must never read.
          oPayload: { sCardLast4: '4242', nAmount: 100 + i },
        })),
      );
      if (spec.indexed) await collection.createIndex({ dCreatedAt: -1 });
    }
  } finally {
    await client.close();
  }
}

export const SEEDED_COLLECTIONS = COLLECTIONS.map((c) => c.name);
