-- Migration: Session Search View
-- Created: 2026-04-11T13:32:56.923Z
-- Cross-schema view joining kvec session chunks with public.sessions for nickname/db_id lookup

-- UP

CREATE OR REPLACE VIEW public.session_search_details AS
SELECT
  s.id          AS db_id,
  s.session_id,
  s.nickname,
  s.name        AS session_name,
  s.summary,
  s.status,
  s.started_at,
  s.model,
  a.handle      AS assistant_handle,
  p.id          AS project_id,
  p.handle      AS project_handle,
  p.display_name AS project_name
FROM public.sessions s
JOIN public.assistants a ON a.id = s.assistant_id
LEFT JOIN public.projects p ON p.id = s.project_id;

-- DOWN

DROP VIEW IF EXISTS public.session_search_details;
