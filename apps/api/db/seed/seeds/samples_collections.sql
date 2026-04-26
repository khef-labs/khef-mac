-- Seed collections for the samples project
-- Creates a parent collection with two sub-collections, each with sample memories

DO $$
DECLARE
  samples_project_id UUID;
  parent_col_id UUID;
  arch_col_id UUID;
  viz_col_id UUID;
  -- memory IDs
  jwt_decision_id UUID;
  system_arch_id UUID;
  repo_pattern_id UUID;
  ecommerce_erd_id UUID;
  auth_flow_id UUID;
  api_sequence_id UUID;
  sorting_viz_id UUID;
  tree_viz_id UUID;
  big_o_quiz_id UUID;
  wave_anim_id UUID;
BEGIN
  SELECT id INTO samples_project_id FROM projects WHERE handle = 'samples';

  IF samples_project_id IS NULL THEN
    RAISE NOTICE 'Samples project not found, skipping collections seed';
    RETURN;
  END IF;

  -- Create parent collection: "E-Commerce Platform"
  INSERT INTO collections (project_id, handle, name, description, view_mode)
  VALUES (
    samples_project_id,
    'ecommerce-platform',
    'E-Commerce Platform',
    'Architecture decisions, patterns, and diagrams for the e-commerce platform project',
    'list'
  )
  ON CONFLICT (project_id, handle) DO UPDATE SET
    name = EXCLUDED.name,
    description = EXCLUDED.description
  RETURNING id INTO parent_col_id;

  -- Sub-collection 1: "Architecture & Decisions" (board view)
  INSERT INTO collections (project_id, handle, name, description, parent_id, view_mode, board_config)
  VALUES (
    samples_project_id,
    'architecture-decisions',
    'Architecture & Decisions',
    'Key architectural decisions and patterns for the platform',
    parent_col_id,
    'board',
    '{"columns": [{"label": "Proposed", "status": "proposed"}, {"label": "Accepted", "status": "accepted"}, {"label": "Active", "status": "active"}]}'::jsonb
  )
  ON CONFLICT (project_id, handle) DO UPDATE SET
    name = EXCLUDED.name,
    description = EXCLUDED.description,
    parent_id = EXCLUDED.parent_id,
    view_mode = EXCLUDED.view_mode,
    board_config = EXCLUDED.board_config
  RETURNING id INTO arch_col_id;

  -- Sub-collection 2: "Interactive Visualizations"
  INSERT INTO collections (project_id, handle, name, description, parent_id, view_mode)
  VALUES (
    samples_project_id,
    'interactive-visualizations',
    'Interactive Visualizations',
    'Canvas widgets, animations, and quizzes for learning',
    parent_col_id,
    'list'
  )
  ON CONFLICT (project_id, handle) DO UPDATE SET
    name = EXCLUDED.name,
    description = EXCLUDED.description,
    parent_id = EXCLUDED.parent_id
  RETURNING id INTO viz_col_id;

  -- Look up memory IDs
  SELECT id INTO jwt_decision_id FROM memories WHERE project_id = samples_project_id AND handle = 'jwt-auth-decision';
  SELECT id INTO system_arch_id FROM memories WHERE project_id = samples_project_id AND handle = 'system-architecture';
  SELECT id INTO repo_pattern_id FROM memories WHERE project_id = samples_project_id AND handle = 'repository-pattern';
  SELECT id INTO ecommerce_erd_id FROM memories WHERE project_id = samples_project_id AND handle = 'ecommerce-erd';
  SELECT id INTO auth_flow_id FROM memories WHERE project_id = samples_project_id AND handle = 'auth-flow-diagram';
  SELECT id INTO api_sequence_id FROM memories WHERE project_id = samples_project_id AND handle = 'api-request-sequence';
  SELECT id INTO sorting_viz_id FROM memories WHERE project_id = samples_project_id AND handle = 'sorting-visualizer';
  SELECT id INTO tree_viz_id FROM memories WHERE project_id = samples_project_id AND handle = 'binary-tree-visualizer';
  SELECT id INTO big_o_quiz_id FROM memories WHERE project_id = samples_project_id AND handle = 'big-o-quiz';
  SELECT id INTO wave_anim_id FROM memories WHERE project_id = samples_project_id AND handle = 'css-wave-animation';

  -- Add memories to "Architecture & Decisions"
  IF jwt_decision_id IS NOT NULL THEN
    INSERT INTO collection_memories (collection_id, memory_id, position) VALUES (arch_col_id, jwt_decision_id, 0) ON CONFLICT DO NOTHING;
  END IF;
  IF system_arch_id IS NOT NULL THEN
    INSERT INTO collection_memories (collection_id, memory_id, position) VALUES (arch_col_id, system_arch_id, 1) ON CONFLICT DO NOTHING;
  END IF;
  IF repo_pattern_id IS NOT NULL THEN
    INSERT INTO collection_memories (collection_id, memory_id, position) VALUES (arch_col_id, repo_pattern_id, 2) ON CONFLICT DO NOTHING;
  END IF;
  IF ecommerce_erd_id IS NOT NULL THEN
    INSERT INTO collection_memories (collection_id, memory_id, position) VALUES (arch_col_id, ecommerce_erd_id, 3) ON CONFLICT DO NOTHING;
  END IF;
  IF auth_flow_id IS NOT NULL THEN
    INSERT INTO collection_memories (collection_id, memory_id, position) VALUES (arch_col_id, auth_flow_id, 4) ON CONFLICT DO NOTHING;
  END IF;
  IF api_sequence_id IS NOT NULL THEN
    INSERT INTO collection_memories (collection_id, memory_id, position) VALUES (arch_col_id, api_sequence_id, 5) ON CONFLICT DO NOTHING;
  END IF;

  -- Add memories to "Interactive Visualizations"
  IF sorting_viz_id IS NOT NULL THEN
    INSERT INTO collection_memories (collection_id, memory_id, position) VALUES (viz_col_id, sorting_viz_id, 0) ON CONFLICT DO NOTHING;
  END IF;
  IF tree_viz_id IS NOT NULL THEN
    INSERT INTO collection_memories (collection_id, memory_id, position) VALUES (viz_col_id, tree_viz_id, 1) ON CONFLICT DO NOTHING;
  END IF;
  IF big_o_quiz_id IS NOT NULL THEN
    INSERT INTO collection_memories (collection_id, memory_id, position) VALUES (viz_col_id, big_o_quiz_id, 2) ON CONFLICT DO NOTHING;
  END IF;
  IF wave_anim_id IS NOT NULL THEN
    INSERT INTO collection_memories (collection_id, memory_id, position) VALUES (viz_col_id, wave_anim_id, 3) ON CONFLICT DO NOTHING;
  END IF;

  RAISE NOTICE 'Sample collections seeded: parent "E-Commerce Platform" with sub-collections "Architecture & Decisions" (board) and "Interactive Visualizations" (list)';
END $$;
