-- Migration: Fix canvas type built_in and is_parent_type flags
-- Canvas should match knowledge and google-doc as a built-in parent type
-- Created: 2026-03-11T13:31:35.429Z

-- UP

UPDATE memory_types
SET built_in = TRUE, is_parent_type = TRUE
WHERE name = 'canvas';

-- DOWN

UPDATE memory_types
SET built_in = FALSE, is_parent_type = FALSE
WHERE name = 'canvas';
