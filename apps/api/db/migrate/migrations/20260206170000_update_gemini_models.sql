-- Migration: Update Gemini models to current Vertex AI lineup
-- Replaces outdated 1.5/2.0 models with 2.5/3.0 production, preview, and deprecated tiers

-- UP
UPDATE settings
SET value = 'gemini-2.5-flash'
WHERE key = 'gemini.defaultModel' AND value = 'gemini-2.0-flash-001';

UPDATE settings
SET value = '[{"id":"gemini-2.5-flash","label":"Gemini 2.5 Flash","group":"Production"},{"id":"gemini-2.5-flash-lite","label":"Gemini 2.5 Flash Lite","group":"Production"},{"id":"gemini-2.5-pro","label":"Gemini 2.5 Pro","group":"Production"},{"id":"gemini-3-pro-preview","label":"Gemini 3 Pro Preview","group":"Preview"},{"id":"gemini-3-flash-preview","label":"Gemini 3 Flash Preview","group":"Preview"},{"id":"gemini-2.5-flash-preview-09-2025","label":"Gemini 2.5 Flash Preview (09-2025)","group":"Preview"},{"id":"gemini-2.5-flash-preview-image","label":"Gemini 2.5 Flash Image","group":"Preview"},{"id":"gemini-2.5-flash-preview-tts","label":"Gemini 2.5 Flash TTS","group":"Preview"},{"id":"gemini-2.5-pro-preview-tts","label":"Gemini 2.5 Pro TTS","group":"Preview"},{"id":"gemini-2.0-flash","label":"Gemini 2.0 Flash (deprecated)","group":"Deprecated"},{"id":"gemini-2.0-flash-001","label":"Gemini 2.0 Flash 001 (deprecated)","group":"Deprecated"},{"id":"gemini-2.0-flash-exp","label":"Gemini 2.0 Flash Exp (deprecated)","group":"Deprecated"},{"id":"gemini-2.0-flash-lite-001","label":"Gemini 2.0 Flash Lite 001 (deprecated)","group":"Deprecated"},{"id":"gemini-2.0-flash-lite","label":"Gemini 2.0 Flash Lite (deprecated)","group":"Deprecated"}]'
WHERE key = 'gemini.models';

-- DOWN
UPDATE settings
SET value = 'gemini-2.0-flash-001'
WHERE key = 'gemini.defaultModel' AND value = 'gemini-2.5-flash';

UPDATE settings
SET value = '[{"id":"gemini-2.0-flash-001","label":"Gemini 2.0 Flash"},{"id":"gemini-1.5-pro-002","label":"Gemini 1.5 Pro"},{"id":"gemini-1.5-flash-002","label":"Gemini 1.5 Flash"}]'
WHERE key = 'gemini.models';
