-- Migration: Add thinking column to gemini_messages
-- Created: 2026-02-17

-- UP
ALTER TABLE gemini_messages ADD COLUMN thinking jsonb;

-- DOWN
ALTER TABLE gemini_messages DROP COLUMN IF EXISTS thinking;
