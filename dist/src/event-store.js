import { Pool } from 'pg';
export class PostgresEventStore {
    pool;
    constructor(config = {}) {
        this.pool = new Pool({
            connectionString: process.env.DATABASE_URL ?? 'postgres://lowqueue:lowqueue_dev@127.0.0.1:5432/lowqueue',
            ...config
        });
    }
    async append(event, state) {
        const client = await this.pool.connect();
        try {
            await client.query('BEGIN');
            await this.ensureRestaurant(client, event.restaurantId);
            const result = await client.query(`INSERT INTO events (id, restaurant_id, token_id, type, payload)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (id) DO NOTHING`, [event.id, event.restaurantId, event.tokenId ?? null, event.type, event.payload]);
            await this.saveProjection(client, event.restaurantId, state);
            await client.query('COMMIT');
            return result.rowCount === 1;
        }
        catch (error) {
            await client.query('ROLLBACK');
            throw error;
        }
        finally {
            client.release();
        }
    }
    async ensureTables(restaurantId, tables) {
        const client = await this.pool.connect();
        try {
            await client.query('BEGIN');
            await this.ensureRestaurant(client, restaurantId);
            for (const table of tables) {
                await client.query(`INSERT INTO restaurant_tables (id, restaurant_id, label, capacity)
           VALUES ($1, $2, $1, $3)
           ON CONFLICT (id) DO UPDATE
           SET restaurant_id = EXCLUDED.restaurant_id,
               label = EXCLUDED.label,
               capacity = EXCLUDED.capacity`, [table.id, restaurantId, table.capacity]);
            }
            await client.query('COMMIT');
        }
        catch (error) {
            await client.query('ROLLBACK');
            throw error;
        }
        finally {
            client.release();
        }
    }
    async ensureRestaurant(client, restaurantId) {
        await client.query(`INSERT INTO restaurants (id, name)
       VALUES ($1, $1)
       ON CONFLICT (id) DO NOTHING`, [restaurantId]);
    }
    async saveProjection(client, restaurantId, state) {
        for (const table of state.tables) {
            await client.query(`INSERT INTO restaurant_tables (id, restaurant_id, label, capacity, status)
         VALUES ($1, $2, $1, $3, $4)
         ON CONFLICT (id) DO UPDATE
         SET restaurant_id = EXCLUDED.restaurant_id,
             label = EXCLUDED.label,
             capacity = EXCLUDED.capacity,
             status = EXCLUDED.status`, [table.id, restaurantId, table.capacity, table.status.toLowerCase()]);
        }
        for (const token of state.tokens) {
            await client.query(`INSERT INTO tokens (
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
             table_id = EXCLUDED.table_id`, [
                token.id,
                restaurantId,
                token.phoneHash,
                token.partySize,
                token.source,
                token.status.toLowerCase(),
                token.bypassCount,
                token.joinedAt,
                token.tableId ?? null
            ]);
        }
    }
    async list(restaurantId) {
        const result = await this.pool.query(`SELECT id, restaurant_id, token_id, type, payload, created_at
       FROM events
       WHERE restaurant_id = $1
       ORDER BY event_order ASC`, [restaurantId]);
        return result.rows.map((row) => ({
            id: row.id,
            restaurantId: row.restaurant_id,
            ...(row.token_id ? { tokenId: row.token_id } : {}),
            type: row.type,
            payload: row.payload,
            createdAt: row.created_at
        }));
    }
    async close() {
        await this.pool.end();
    }
    async withLock(restaurantId, work) {
        const client = await this.pool.connect();
        try {
            await client.query('SELECT pg_advisory_lock(hashtext($1))', [restaurantId]);
            return await work();
        }
        finally {
            await client.query('SELECT pg_advisory_unlock(hashtext($1))', [restaurantId]);
            client.release();
        }
    }
}
