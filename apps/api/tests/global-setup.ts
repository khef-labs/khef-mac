import { setupTestDb, TEST_DATABASE_URL } from './setup';

export async function setup() {
  process.env.DATABASE_URL = TEST_DATABASE_URL;
  await setupTestDb();
}

export async function teardown() {
  // Optional cleanup
}
