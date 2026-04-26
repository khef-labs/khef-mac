-- Migration: Optimize collection_stats view
-- Replace multi-join view with scalar subqueries to eliminate cartesian product
-- between tracked_files, chunks, repos, and snapshot_files.
-- The old view caused row explosion: files x chunks x repos x snapshots,
-- making the query multi-second on collections with many files.

-- UP

DROP VIEW IF EXISTS kvec.collection_stats;

CREATE VIEW kvec.collection_stats AS
SELECT col.*,
    (SELECT COUNT(*)
     FROM kvec.tracked_files f
     WHERE f.collection_id = col.id
    ) AS file_count,

    (SELECT COUNT(*)
     FROM kvec.chunks ch
     JOIN kvec.tracked_files f ON f.id = ch.file_id
     WHERE f.collection_id = col.id
    ) AS total_chunks,

    (SELECT COALESCE(SUM(f.file_size), 0)
     FROM kvec.tracked_files f
     WHERE f.collection_id = col.id
    ) AS total_bytes,

    (SELECT COUNT(*)
     FROM kvec.repos r
     WHERE r.collection_id = col.id
    ) AS repo_count,

    (SELECT COUNT(DISTINCT s.branch)
     FROM kvec.snapshot_files sf
     JOIN kvec.tracked_files f ON f.id = sf.file_id
     JOIN kvec.snapshots s ON s.id = sf.snapshot_id
     WHERE f.collection_id = col.id
    ) AS branch_count,

    (SELECT MAX(f.updated_at)
     FROM kvec.tracked_files f
     WHERE f.collection_id = col.id
    ) AS last_upload
FROM kvec.collections col;

-- DOWN

DROP VIEW IF EXISTS kvec.collection_stats;

CREATE VIEW kvec.collection_stats AS
SELECT col.*,
    COUNT(DISTINCT f.id) AS file_count,
    COUNT(ch.id) AS total_chunks,
    COALESCE(SUM(DISTINCT f.file_size), 0) AS total_bytes,
    COUNT(DISTINCT r.id) AS repo_count,
    COUNT(DISTINCT s.branch) AS branch_count,
    MAX(f.updated_at) AS last_upload
FROM kvec.collections col
LEFT JOIN kvec.tracked_files f ON f.collection_id = col.id
LEFT JOIN kvec.chunks ch ON ch.file_id = f.id
LEFT JOIN kvec.repos r ON r.collection_id = col.id
LEFT JOIN kvec.snapshot_files sf ON sf.file_id = f.id
LEFT JOIN kvec.snapshots s ON s.id = sf.snapshot_id
GROUP BY col.id;
