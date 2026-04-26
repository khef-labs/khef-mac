#!/usr/bin/env node
/*
  One-off cleanup: remove duplicate assistant-rule memories from all projects except 'user'.

  Usage:
    node db/tasks/rules/dedup.js           # dry-run (no deletes)
    node db/tasks/rules/dedup.js --execute # perform deletes

  Reads DATABASE_URL from environment.
*/

const dotenv = require('dotenv');
const { expand } = require('dotenv-expand');
expand(dotenv.config());

const { Client } = require('pg');

async function main() {
  const execute = process.argv.includes('--execute');
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();

  try {
    // Get assistant-rule memory_type id
    const mt = await client.query('SELECT id FROM memory_types WHERE name = $1', ['assistant-rule']);
    if (mt.rows.length === 0) throw new Error("'assistant-rule' memory type not found");
    const agentRuleTypeId = mt.rows[0].id;

    const projects = await client.query(
      'SELECT id, handle, name FROM projects WHERE handle <> $1 ORDER BY created_at ASC',
      ['user']
    );

    let total = 0;
    for (const p of projects.rows) {
      const countRes = await client.query(
        'SELECT COUNT(*)::int AS count FROM memories WHERE project_id = $1 AND memory_type_id = $2',
        [p.id, agentRuleTypeId]
      );
      const count = countRes.rows[0].count;
      if (count > 0) {
        console.log(`${p.handle || p.name}: ${count} assistant-rule memorie(s)`);
        total += count;
      }
    }

    if (!execute) {
      console.log(`\nDry run: would delete ${total} assistant-rule memorie(s) outside 'user' project.`);
      return;
    }

    console.log('\nDeleting...');
    await client.query('BEGIN');
    try {
      const delRes = await client.query(
        "DELETE FROM memories WHERE memory_type_id = $1 AND project_id IN (SELECT id FROM projects WHERE handle <> 'user') RETURNING id",
        [agentRuleTypeId]
      );
      await client.query('COMMIT');
      console.log(`Deleted ${delRes.rowCount} assistant-rule memorie(s) outside 'user' project.`);
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    }
  } finally {
    await client.end();
  }
}

if (require.main === module) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
