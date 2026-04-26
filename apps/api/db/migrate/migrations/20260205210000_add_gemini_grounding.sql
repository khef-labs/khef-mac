-- Migration: Add grounding support to Gemini messages
-- Created: 2026-02-05
-- Store Google Search grounding metadata

-- UP

-- Add grounding column to store search queries and sources
ALTER TABLE gemini_messages ADD COLUMN grounding JSONB;

-- Example grounding structure:
-- {
--   "searchQueries": ["query 1", "query 2"],
--   "sources": [
--     {"uri": "https://...", "title": "Source Title"}
--   ]
-- }

-- DOWN
ALTER TABLE gemini_messages DROP COLUMN IF EXISTS grounding;
