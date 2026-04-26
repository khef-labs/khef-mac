-- Rebrand dev-mem references to khef
-- Run with: psql $DATABASE_URL -f scripts/rebrand-devmem-to-khef.sql

BEGIN;

-- Update tag names
UPDATE tags
SET name = REPLACE(name, 'dev-mem', 'khef')
WHERE name LIKE '%dev-mem%';

UPDATE tags
SET name = REPLACE(name, 'devmem', 'khef')
WHERE name LIKE '%devmem%';

-- Update memory titles
UPDATE memories
SET title = REPLACE(title, 'dev-mem', 'khef')
WHERE title LIKE '%dev-mem%';

UPDATE memories
SET title = REPLACE(title, 'Dev-Mem', 'Khef')
WHERE title LIKE '%Dev-Mem%';

UPDATE memories
SET title = REPLACE(title, 'Dev Mem', 'Khef')
WHERE title LIKE '%Dev Mem%';

UPDATE memories
SET title = REPLACE(title, 'DevMem', 'Khef')
WHERE title LIKE '%DevMem%';

UPDATE memories
SET title = REPLACE(title, 'devmem', 'khef')
WHERE title LIKE '%devmem%';

-- Update memory content
UPDATE memories
SET content = REPLACE(content, 'dev-mem', 'khef')
WHERE content LIKE '%dev-mem%';

UPDATE memories
SET content = REPLACE(content, 'Dev-Mem', 'Khef')
WHERE content LIKE '%Dev-Mem%';

UPDATE memories
SET content = REPLACE(content, 'Dev Mem', 'Khef')
WHERE content LIKE '%Dev Mem%';

UPDATE memories
SET content = REPLACE(content, 'DevMem', 'Khef')
WHERE content LIKE '%DevMem%';

UPDATE memories
SET content = REPLACE(content, 'devmem', 'khef')
WHERE content LIKE '%devmem%';

-- Update memory handles
UPDATE memories
SET handle = REPLACE(handle, 'dev-mem', 'khef')
WHERE handle LIKE '%dev-mem%';

-- Update memory chunks (content is split across chunks)
UPDATE memory_chunks
SET content = REPLACE(content, 'dev-mem', 'khef')
WHERE content LIKE '%dev-mem%';

UPDATE memory_chunks
SET content = REPLACE(content, 'Dev-Mem', 'Khef')
WHERE content LIKE '%Dev-Mem%';

UPDATE memory_chunks
SET content = REPLACE(content, 'Dev Mem', 'Khef')
WHERE content LIKE '%Dev Mem%';

UPDATE memory_chunks
SET content = REPLACE(content, 'DevMem', 'Khef')
WHERE content LIKE '%DevMem%';

UPDATE memory_chunks
SET content = REPLACE(content, 'devmem', 'khef')
WHERE content LIKE '%devmem%';

-- Update project names
UPDATE projects
SET name = REPLACE(name, 'dev-mem', 'khef')
WHERE name LIKE '%dev-mem%';

UPDATE projects
SET name = REPLACE(name, 'Dev-Mem', 'Khef')
WHERE name LIKE '%Dev-Mem%';

UPDATE projects
SET name = REPLACE(name, 'Dev Mem', 'Khef')
WHERE name LIKE '%Dev Mem%';

UPDATE projects
SET name = REPLACE(name, 'DevMem', 'Khef')
WHERE name LIKE '%DevMem%';

-- Update project handles
UPDATE projects
SET handle = REPLACE(handle, 'dev-mem', 'khef')
WHERE handle LIKE '%dev-mem%';

-- Update project descriptions
UPDATE projects
SET description = REPLACE(description, 'dev-mem', 'khef')
WHERE description LIKE '%dev-mem%';

UPDATE projects
SET description = REPLACE(description, 'Dev-Mem', 'Khef')
WHERE description LIKE '%Dev-Mem%';

UPDATE projects
SET description = REPLACE(description, 'Dev Mem', 'Khef')
WHERE description LIKE '%Dev Mem%';

UPDATE projects
SET description = REPLACE(description, 'DevMem', 'Khef')
WHERE description LIKE '%DevMem%';

-- Update tag names (more variations)
UPDATE tags
SET name = REPLACE(name, 'Dev-Mem', 'Khef')
WHERE name LIKE '%Dev-Mem%';

UPDATE tags
SET name = REPLACE(name, 'Dev Mem', 'Khef')
WHERE name LIKE '%Dev Mem%';

UPDATE tags
SET name = REPLACE(name, 'DevMem', 'Khef')
WHERE name LIKE '%DevMem%';

-- Check for any remaining dev-mem references
SELECT 'REMAINING: Tags with dev-mem' as warning, name FROM tags WHERE name ILIKE '%dev%mem%' LIMIT 5;
SELECT 'REMAINING: Projects with dev-mem' as warning, name, handle FROM projects WHERE name ILIKE '%dev%mem%' OR handle ILIKE '%dev%mem%' OR description ILIKE '%dev%mem%' LIMIT 5;
SELECT 'REMAINING: Memories with dev-mem in title' as warning, title FROM memories WHERE title ILIKE '%dev%mem%' LIMIT 5;
SELECT 'REMAINING: Memories with dev-mem in content' as warning, LEFT(content, 100) FROM memories WHERE content ILIKE '%dev%mem%' LIMIT 5;

-- Show summary
SELECT 'Updated - tags with khef/khef' as type, COUNT(*) as count FROM tags WHERE name ILIKE '%mem%zen%'
UNION ALL
SELECT 'Updated - memories with Khef in title', COUNT(*) FROM memories WHERE title ILIKE '%mem%zen%'
UNION ALL
SELECT 'Updated - memories with Khef in content', COUNT(*) FROM memories WHERE content ILIKE '%mem%zen%';

COMMIT;
