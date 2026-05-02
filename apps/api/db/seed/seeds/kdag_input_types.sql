-- Idempotent seed for kdag.input_types — public types referenced by definitions
-- that ship to khef-mac. Built-in types (prompt, chunk_prompt, system_prompt,
-- transcript, existing_summary) are also seeded by an early migration; this
-- file upserts them for completeness and adds the custom types used by the
-- shipping definitions (bulk-import-md, describe-session, etc.).

INSERT INTO kdag.input_types (key, description, format) VALUES
  ('prompt',            'Prompt text sent to the model',                                       'text'),
  ('chunk_prompt',      'Prompt for summarizing individual chunks in map-reduce',              'text'),
  ('system_prompt',     'System prompt override',                                              'text'),
  ('transcript',        'Session transcript content',                                          'text'),
  ('existing_summary',  'Previous summary to update incrementally',                            'text'),
  ('source_dir',        'Absolute path to directory containing files to process',              'text'),
  ('project_handle',    'Target khef project handle',                                          'text'),
  ('memory_type',       'Memory type for imported content (e.g., user-note, context, decision)', 'text'),
  ('collection_handle', 'Collection handle to add imported memories to',                       'text'),
  ('session_id',        'Session UUID (file UUID or DB row ID) identifying a synced session',  'text')
ON CONFLICT (key) DO UPDATE SET
  description = EXCLUDED.description,
  format      = EXCLUDED.format;
