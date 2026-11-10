import { createApp, InMemoryQueueRepository, PostgresQueueRepository } from './api.js';
import type { Table } from './queue-engine.js';

const tables: Table[] = [
  { id: 'table-2', capacity: 2, status: 'FREE' },
  { id: 'table-4', capacity: 4, status: 'FREE' },
  { id: 'table-6', capacity: 6, status: 'FREE' }
];
const repository = process.env.DATABASE_URL
  ? new PostgresQueueRepository(undefined, tables)
  : new InMemoryQueueRepository(tables);
const app = createApp(repository);

const port = Number(process.env.PORT ?? 3000);
await app.listen({ host: '127.0.0.1', port });
console.log(`LowQueue API listening on http://127.0.0.1:${port}`);
