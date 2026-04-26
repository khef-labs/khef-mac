-- Migration: Add Inactive Status For Syncable Types
-- Created: 2026-01-29T04:38:07.245Z
-- Adds an 'inactive' status for knowledge and rule types so they can be excluded from sync

-- UP

-- Add inactive status for context (doesn't have a way to exclude from sync)
INSERT INTO memory_type_statuses (memory_type_id, status_value, display_name, description, sort_order)
SELECT mt.id, 'inactive', 'Inactive', 'Memory is inactive', 10
FROM memory_types mt
WHERE mt.name = 'context'
ON CONFLICT (memory_type_id, status_value) DO NOTHING;

-- Add inactive status for commands
INSERT INTO memory_type_statuses (memory_type_id, status_value, display_name, description, sort_order)
SELECT mt.id, 'inactive', 'Inactive', 'Memory is inactive', 10
FROM memory_types mt
WHERE mt.name = 'commands'
ON CONFLICT (memory_type_id, status_value) DO NOTHING;

-- Add inactive status for pattern
INSERT INTO memory_type_statuses (memory_type_id, status_value, display_name, description, sort_order)
SELECT mt.id, 'inactive', 'Inactive', 'Memory is inactive', 10
FROM memory_types mt
WHERE mt.name = 'pattern'
ON CONFLICT (memory_type_id, status_value) DO NOTHING;

-- Add inactive status for assistant-rule
INSERT INTO memory_type_statuses (memory_type_id, status_value, display_name, description, sort_order)
SELECT mt.id, 'inactive', 'Inactive', 'Memory is inactive', 10
FROM memory_types mt
WHERE mt.name = 'assistant-rule'
ON CONFLICT (memory_type_id, status_value) DO NOTHING;

-- DOWN
DELETE FROM memory_type_statuses WHERE status_value = 'inactive';
