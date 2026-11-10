import { Pool, type PoolClient, type PoolConfig } from 'pg';
import type { QueueState } from './queue-engine.js';

export interface PersistedRestaurantConfig {
  name: string;
  averageTableTurnMinutes: number;
}

export interface EventRecord {
  id: string;
  restaurantId: string;
  tokenId?: string;
  type: string;
  payload: Record<string, unknown>;
  createdAt: Date;
}

export class PostgresEventStore {
  private readonly pool: Pool;

  constructor(config: PoolConfig = {}) {
    this.pool = new Pool({
      connectionString: process.env.DATABASE_URL ?? 'postgres://lowqueue:lowqueue_dev@127.0.0.1:5432/lowqueue',
      ...config
    });
  }

  async append(event: Omit<EventRecord, 'createdAt'>, state: QueueState): Promise<boolean> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await this.ensureRestaurant(client, event.restaurantId);
      const result = await client.query(
        `INSERT INTO events (id, restaurant_id, token_id, type, payload)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (id) DO NOTHING`,
        [event.id, event.restaurantId, event.tokenId ?? null, event.type, event.payload]
      );
      await this.saveProjection(client, event.restaurantId, state);
      await client.query('COMMIT');
      return result.rowCount === 1;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async ensureTables(restaurantId: string, tables: Array<{ id: string; capacity: number }>): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await this.ensureRestaurant(client, restaurantId);
      for (const table of tables) {
        await client.query(
          `INSERT INTO restaurant_tables (id, restaurant_id, label, capacity)
           VALUES ($1, $2, $1, $3)
           ON CONFLICT (id) DO UPDATE
           SET restaurant_id = EXCLUDED.restaurant_id,
               label = EXCLUDED.label,
               capacity = EXCLUDED.capacity`,
          [table.id, restaurantId, table.capacity]
        );
      }

      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

    async getRestaurantConfig(restaurantId: string): Promise<PersistedRestaurantConfig | undefined> {
      const result = await this.pool.query<{ name: string; config: PersistedRestaurantConfig }>(
        'SELECT name, config FROM restaurants WHERE id = $1',
        [restaurantId]
      );
      const row = result.rows[0];
      if (!row) return undefined;
      return {
        name: typeof row.config?.name === 'string' ? row.config.name : row.name,
        averageTableTurnMinutes: typeof row.config?.averageTableTurnMinutes === 'number'
          ? row.config.averageTableTurnMinutes
          : 15
      };
    }

    async saveRestaurantConfig(restaurantId: string, config: PersistedRestaurantConfig): Promise<void> {
      await this.pool.query(
        `INSERT INTO restaurants (id, name, config)
         VALUES ($1, $2, $3)
         ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, config = EXCLUDED.config`,
        [restaurantId, config.name, config]
      );
    }

    async getIdempotency(restaurantId: string, operationKey: string): Promise<unknown | undefined> {
      const result = await this.pool.query<{ response: unknown }>(
        'SELECT response FROM idempotency_keys WHERE restaurant_id = $1 AND operation_key = $2',
        [restaurantId, operationKey]
      );
      return result.rows[0]?.response;
    }

    async saveIdempotency(restaurantId: string, operationKey: string, response: unknown): Promise<void> {
      await this.pool.query(
        `INSERT INTO idempotency_keys (restaurant_id, operation_key, response)
         VALUES ($1, $2, $3)
         ON CONFLICT (restaurant_id, operation_key) DO NOTHING`,
        [restaurantId, operationKey, response]
      );
    }

  private async ensureRestaurant(client: PoolClient, restaurantId: string): Promise<void> {
    await client.query(
      `INSERT INTO restaurants (id, name)
       VALUES ($1, $1)
       ON CONFLICT (id) DO NOTHING`,
      [restaurantId]
    );
  }

  private async saveProjection(client: PoolClient, restaurantId: string, state: QueueState): Promise<void> {
    for (const table of state.tables) {
      await client.query(
        `INSERT INTO restaurant_tables (id, restaurant_id, label, capacity, status)
         VALUES ($1, $2, $1, $3, $4)
         ON CONFLICT (id) DO UPDATE
         SET restaurant_id = EXCLUDED.restaurant_id,
             label = EXCLUDED.label,
             capacity = EXCLUDED.capacity,
             status = EXCLUDED.status`,
        [table.id, restaurantId, table.capacity, table.status.toLowerCase()]
      );
    }

    for (const token of state.tokens) {
      await client.query(
        `INSERT INTO tokens (
           id, restaurant_id, phone_hash, party_size, source, status,
           bypass_count, joined_at, table_id
         )
         VALUES ($1, $2, $3, $4, $5, $6, $7, to_timestamp($8 / 1000.0), $9)
         ON CONFLICT (id) DO UPDATE
         SET restaurant_id = EXCLUDED.restaurant_id,
             phone_hash = EXCLUDED.phone_hash,
             party_size = EXCLUDED.party_size,
             status = EXCLUDED.status,
             bypass_count = EXCLUDED.bypass_count,
             joined_at = EXCLUDED.joined_at,
             table_id = EXCLUDED.table_id`,
        [
          token.id,
          restaurantId,
          token.phoneHash,
          token.partySize,
          token.source,
          token.status.toLowerCase(),
          token.bypassCount,
          token.joinedAt,
          token.tableId ?? null
        ]
      );
    }
  }

  async list(restaurantId: string): Promise<EventRecord[]> {
    const result = await this.pool.query<{
      id: string;
      restaurant_id: string;
      token_id: string | null;
      type: string;
      payload: Record<string, unknown>;
      created_at: Date;
    }>(
      `SELECT id, restaurant_id, token_id, type, payload, created_at
       FROM events
       WHERE restaurant_id = $1
       ORDER BY event_order ASC`,
      [restaurantId]
    );

    return result.rows.map((row) => ({
      id: row.id,
      restaurantId: row.restaurant_id,
      ...(row.token_id ? { tokenId: row.token_id } : {}),
      type: row.type,
      payload: row.payload,
      createdAt: row.created_at
    }));
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  async withLock<T>(restaurantId: string, work: () => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('SELECT pg_advisory_lock(hashtext($1))', [restaurantId]);
      return await work();
    } finally {
      await client.query('SELECT pg_advisory_unlock(hashtext($1))', [restaurantId]);
      client.release();
    }
  }
}
