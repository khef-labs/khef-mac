import { query, querySingle, getClient } from '../db/client';

export interface SessionTeam {
  id: string;
  name: string;
  description: string | null;
  project_id: string | null;
  project_handle?: string | null;
  project_name?: string | null;
  created_at: string;
  updated_at: string;
  member_count?: number;
  active_count?: number;
}

export interface SessionTeamMember {
  session_id: string;
  db_id: string | null;
  nickname: string | null;
  status: string | null;
  summary: string | null;
  message_count: number | null;
  started_at: string | null;
  ended_at: string | null;
  model: string | null;
  context_window_tokens: number | null;
  last_seen_at: string | null;
  project_handle: string | null;
  added_at: string;
  resumable: boolean;
  file_path: string | null;
}

export async function listTeams(projectId?: string): Promise<SessionTeam[]> {
  let sql = `
    SELECT
      t.id, t.name, t.description, t.project_id,
      p.handle as project_handle, p.display_name as project_name,
      t.created_at, t.updated_at,
      COUNT(m.session_id)::int as member_count,
      COUNT(CASE WHEN s.status = 'active' THEN 1 END)::int as active_count
    FROM session_teams t
    LEFT JOIN projects p ON t.project_id = p.id
    LEFT JOIN session_team_members m ON m.team_id = t.id
    LEFT JOIN sessions s ON s.session_id = m.session_id
  `;
  const params: any[] = [];

  if (projectId) {
    params.push(projectId);
    sql += ` WHERE t.project_id = $1 OR p.handle = $1`;
  }

  sql += ` GROUP BY t.id, p.handle, p.display_name ORDER BY t.updated_at DESC`;

  return query<SessionTeam>(sql, params);
}

export async function getTeam(teamId: string): Promise<SessionTeam | null> {
  return querySingle<SessionTeam>(
    `SELECT
      t.id, t.name, t.description, t.project_id,
      p.handle as project_handle, p.display_name as project_name,
      t.created_at, t.updated_at,
      COUNT(m.session_id)::int as member_count,
      COUNT(CASE WHEN s.status = 'active' THEN 1 END)::int as active_count
    FROM session_teams t
    LEFT JOIN projects p ON t.project_id = p.id
    LEFT JOIN session_team_members m ON m.team_id = t.id
    LEFT JOIN sessions s ON s.session_id = m.session_id
    WHERE t.id = $1
    GROUP BY t.id, p.handle, p.display_name`,
    [teamId]
  );
}

export async function getTeamMembers(teamId: string): Promise<SessionTeamMember[]> {
  return query<SessionTeamMember>(
    `SELECT
      m.session_id,
      s.id as db_id,
      s.nickname,
      s.status,
      s.summary,
      s.message_count,
      s.started_at,
      s.ended_at,
      s.model,
      s.context_window_tokens,
      s.last_seen_at,
      s.file_path,
      p.handle as project_handle,
      m.added_at,
      CASE WHEN s.file_path IS NOT NULL AND s.session_id IS NOT NULL THEN true ELSE false END as resumable
    FROM session_team_members m
    LEFT JOIN sessions s ON s.session_id = m.session_id
    LEFT JOIN projects p ON s.project_id = p.id
    WHERE m.team_id = $1
    ORDER BY m.sort_order, m.added_at`,
    [teamId]
  );
}

export async function createTeam(name: string, description?: string, projectId?: string): Promise<SessionTeam> {
  const resolvedProjectId = projectId
    ? (await querySingle<{ id: string }>(`SELECT id FROM projects WHERE id::text = $1 OR handle = $1`, [projectId]))?.id || null
    : null;

  const team = await querySingle<SessionTeam>(
    `INSERT INTO session_teams (name, description, project_id)
     VALUES ($1, $2, $3)
     RETURNING id, name, description, project_id, created_at, updated_at`,
    [name, description || null, resolvedProjectId]
  );

  return team!;
}

export async function updateTeam(teamId: string, data: { name?: string; description?: string }): Promise<SessionTeam | null> {
  const sets: string[] = [];
  const params: any[] = [];
  let idx = 1;

  if (data.name !== undefined) {
    sets.push(`name = $${idx++}`);
    params.push(data.name);
  }
  if (data.description !== undefined) {
    sets.push(`description = $${idx++}`);
    params.push(data.description);
  }

  if (sets.length === 0) return getTeam(teamId);

  params.push(teamId);
  return querySingle<SessionTeam>(
    `UPDATE session_teams SET ${sets.join(', ')} WHERE id = $${idx}
     RETURNING id, name, description, project_id, created_at, updated_at`,
    params
  );
}

export async function deleteTeam(teamId: string): Promise<boolean> {
  const result = await query(`DELETE FROM session_teams WHERE id = $1`, [teamId]);
  return (result as any).length !== undefined || true;
}

export async function addMembers(teamId: string, sessionIds: string[]): Promise<number> {
  if (sessionIds.length === 0) return 0;

  // Get current max sort_order for this team
  const maxRow = await querySingle<{ max_order: number }>(
    `SELECT COALESCE(MAX(sort_order), -1) as max_order FROM session_team_members WHERE team_id = $1`,
    [teamId]
  );
  const startOrder = (maxRow?.max_order ?? -1) + 1;

  const values = sessionIds.map((_, i) => `($1, $${i + 2}, ${startOrder + i})`).join(', ');
  const params = [teamId, ...sessionIds];

  await query(
    `INSERT INTO session_team_members (team_id, session_id, sort_order)
     VALUES ${values}
     ON CONFLICT DO NOTHING`,
    params
  );

  return sessionIds.length;
}

export async function reorderMembers(teamId: string, sessionIds: string[]): Promise<void> {
  // Update sort_order for each session in the given order
  const cases = sessionIds.map((id, i) => `WHEN session_id = '${id}' THEN ${i}`).join(' ');
  await query(
    `UPDATE session_team_members SET sort_order = CASE ${cases} END WHERE team_id = $1 AND session_id = ANY($2)`,
    [teamId, sessionIds]
  );
}

export async function removeMember(teamId: string, sessionId: string): Promise<boolean> {
  await query(
    `DELETE FROM session_team_members WHERE team_id = $1 AND session_id = $2`,
    [teamId, sessionId]
  );
  return true;
}

export async function broadcastToTeam(
  teamId: string,
  fromSessionId: string,
  content: string
): Promise<string[]> {
  // Get active member session IDs
  const members = await query<{ session_id: string }>(
    `SELECT m.session_id
     FROM session_team_members m
     JOIN sessions s ON s.session_id = m.session_id
     WHERE m.team_id = $1 AND s.status = 'active' AND m.session_id != $2`,
    [teamId, fromSessionId]
  );

  return members.map(m => m.session_id);
}
