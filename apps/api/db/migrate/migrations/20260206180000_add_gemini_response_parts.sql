-- Migration: Add response_parts JSONB column for multimodal Gemini responses
-- Stores structured parts (text, file references) when response contains images/audio

-- UP
ALTER TABLE gemini_messages ADD COLUMN response_parts JSONB;

-- DOWN
ALTER TABLE gemini_messages DROP COLUMN IF EXISTS response_parts;
