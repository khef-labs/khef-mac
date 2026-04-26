-- Seed relations between sample memories
-- Relations are created by looking up memory IDs by handle within the samples project

DO $$
DECLARE
  samples_project_id UUID;
  auth_flow_id UUID;
  api_sequence_id UUID;
  system_arch_id UUID;
  ecommerce_erd_id UUID;
  jwt_decision_id UUID;
  repo_pattern_id UUID;
  sorting_viz_id UUID;
  tree_viz_id UUID;
  big_o_quiz_id UUID;
  wave_anim_id UUID;
  video_mcp_id UUID;
  video_best_practices_id UUID;
BEGIN
  -- Get the samples project ID
  SELECT id INTO samples_project_id FROM projects WHERE handle = 'samples';

  IF samples_project_id IS NULL THEN
    RAISE NOTICE 'Samples project not found, skipping relations seed';
    RETURN;
  END IF;

  -- Get memory IDs by handle
  SELECT id INTO auth_flow_id FROM memories WHERE project_id = samples_project_id AND handle = 'auth-flow-diagram';
  SELECT id INTO api_sequence_id FROM memories WHERE project_id = samples_project_id AND handle = 'api-request-sequence';
  SELECT id INTO system_arch_id FROM memories WHERE project_id = samples_project_id AND handle = 'system-architecture';
  SELECT id INTO ecommerce_erd_id FROM memories WHERE project_id = samples_project_id AND handle = 'ecommerce-erd';
  SELECT id INTO jwt_decision_id FROM memories WHERE project_id = samples_project_id AND handle = 'jwt-auth-decision';
  SELECT id INTO repo_pattern_id FROM memories WHERE project_id = samples_project_id AND handle = 'repository-pattern';
  SELECT id INTO sorting_viz_id FROM memories WHERE project_id = samples_project_id AND handle = 'sorting-visualizer';
  SELECT id INTO tree_viz_id FROM memories WHERE project_id = samples_project_id AND handle = 'binary-tree-visualizer';
  SELECT id INTO big_o_quiz_id FROM memories WHERE project_id = samples_project_id AND handle = 'big-o-quiz';
  SELECT id INTO wave_anim_id FROM memories WHERE project_id = samples_project_id AND handle = 'css-wave-animation';
  SELECT id INTO video_mcp_id FROM memories WHERE project_id = samples_project_id AND handle = 'video-anthropic-mcp-overview';
  SELECT id INTO video_best_practices_id FROM memories WHERE project_id = samples_project_id AND handle = 'video-claude-code-best-practices';

  -- Create relations (ON CONFLICT DO NOTHING to make idempotent)

  -- JWT decision supports the auth flow diagram
  IF jwt_decision_id IS NOT NULL AND auth_flow_id IS NOT NULL THEN
    INSERT INTO memory_relations (source_memory_id, target_memory_id, relation_type)
    VALUES (jwt_decision_id, auth_flow_id, 'supports')
    ON CONFLICT DO NOTHING;
  END IF;

  -- System architecture references the ERD
  IF system_arch_id IS NOT NULL AND ecommerce_erd_id IS NOT NULL THEN
    INSERT INTO memory_relations (source_memory_id, target_memory_id, relation_type)
    VALUES (system_arch_id, ecommerce_erd_id, 'references')
    ON CONFLICT DO NOTHING;
  END IF;

  -- System architecture references the API sequence
  IF system_arch_id IS NOT NULL AND api_sequence_id IS NOT NULL THEN
    INSERT INTO memory_relations (source_memory_id, target_memory_id, relation_type)
    VALUES (system_arch_id, api_sequence_id, 'references')
    ON CONFLICT DO NOTHING;
  END IF;

  -- Repository pattern supports the system architecture
  IF repo_pattern_id IS NOT NULL AND system_arch_id IS NOT NULL THEN
    INSERT INTO memory_relations (source_memory_id, target_memory_id, relation_type)
    VALUES (repo_pattern_id, system_arch_id, 'supports')
    ON CONFLICT DO NOTHING;
  END IF;

  -- JWT decision relates to API sequence (auth affects API requests)
  IF jwt_decision_id IS NOT NULL AND api_sequence_id IS NOT NULL THEN
    INSERT INTO memory_relations (source_memory_id, target_memory_id, relation_type)
    VALUES (jwt_decision_id, api_sequence_id, 'relates_to')
    ON CONFLICT DO NOTHING;
  END IF;

  -- Auth flow follows from JWT decision
  IF auth_flow_id IS NOT NULL AND jwt_decision_id IS NOT NULL THEN
    INSERT INTO memory_relations (source_memory_id, target_memory_id, relation_type)
    VALUES (auth_flow_id, jwt_decision_id, 'follows_from')
    ON CONFLICT DO NOTHING;
  END IF;

  -- Big-O quiz depends on sorting visualizer (understanding complexity requires seeing algorithms)
  IF big_o_quiz_id IS NOT NULL AND sorting_viz_id IS NOT NULL THEN
    INSERT INTO memory_relations (source_memory_id, target_memory_id, relation_type)
    VALUES (big_o_quiz_id, sorting_viz_id, 'depends_on')
    ON CONFLICT DO NOTHING;
  END IF;

  -- Tree visualizer extends sorting visualizer (both are algorithm visualizations)
  IF tree_viz_id IS NOT NULL AND sorting_viz_id IS NOT NULL THEN
    INSERT INTO memory_relations (source_memory_id, target_memory_id, relation_type)
    VALUES (tree_viz_id, sorting_viz_id, 'extends')
    ON CONFLICT DO NOTHING;
  END IF;

  -- Repository pattern implements the system architecture
  IF repo_pattern_id IS NOT NULL AND system_arch_id IS NOT NULL THEN
    INSERT INTO memory_relations (source_memory_id, target_memory_id, relation_type)
    VALUES (repo_pattern_id, system_arch_id, 'implements')
    ON CONFLICT DO NOTHING;
  END IF;

  -- ERD supports the repository pattern (schema informs data access)
  IF ecommerce_erd_id IS NOT NULL AND repo_pattern_id IS NOT NULL THEN
    INSERT INTO memory_relations (source_memory_id, target_memory_id, relation_type)
    VALUES (ecommerce_erd_id, repo_pattern_id, 'supports')
    ON CONFLICT DO NOTHING;
  END IF;

  -- MCP video references system architecture
  IF video_mcp_id IS NOT NULL AND system_arch_id IS NOT NULL THEN
    INSERT INTO memory_relations (source_memory_id, target_memory_id, relation_type)
    VALUES (video_mcp_id, system_arch_id, 'references')
    ON CONFLICT DO NOTHING;
  END IF;

  -- MCP video relates to best practices video
  IF video_mcp_id IS NOT NULL AND video_best_practices_id IS NOT NULL THEN
    INSERT INTO memory_relations (source_memory_id, target_memory_id, relation_type)
    VALUES (video_mcp_id, video_best_practices_id, 'relates_to')
    ON CONFLICT DO NOTHING;
  END IF;

  RAISE NOTICE 'Sample relations seeded successfully';
END $$;
