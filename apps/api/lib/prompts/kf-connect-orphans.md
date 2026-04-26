# Connect Orphan Memories

Check for orphan memories (memories with no relations) and connect them to build a more useful knowledge graph.

## Instructions

1. **Find orphans**: Use `get_graph_health` to identify orphan memories
2. **Review each orphan**: Read the memory content and determine what it relates to
3. **Create relations**: Use `create_relation` to connect orphans to relevant memories

## Relation Type Guide

| Relation | Use When | Direction |
|----------|----------|-----------|
| `supports` | Evidence backs a claim | Evidence → Claim |
| `contradicts` | Info conflicts | Newer → Older |
| `depends_on` | Requires another | Dependent → Dependency |
| `follows_from` | Caused by/derived from | Effect → Cause |
| `references` | Cites/mentions | Referrer → Referenced |
| `relates_to` | Loosely connected | Either direction |

## Example Workflow

```
1. get_graph_health(project_id: "my-project")
   → See orphan_memories list

2. For each orphan, search for related memories:
   search_memories(project_id: "...", search: "<keywords from orphan>")

3. Create appropriate relations:
   create_relation(
     source_memory_id: "<orphan-id>",
     target_memory_id: "<related-memory-id>",
     relation_type: "supports"  // or appropriate type
   )
```

## Tips

- Not every memory needs relations - some standalone notes are fine
- Aim for 2-4 relations per memory; don't over-link
- Decisions should usually link to supporting context/patterns
- Patterns should reference the decisions that introduced them
