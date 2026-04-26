import { useState, useEffect, useCallback, useMemo } from 'preact/hooks'
import { getCommands } from '../../lib/api'
import type { Command } from '../../types'
import { FilterInput, ResourceCard, ResourceGrid } from '../../components/assistant'
import styles from '../AssistantPage.module.css'

interface Props {
  handle: string
}

export function SkillsSection({ handle }: Props) {
  const [skills, setSkills] = useState<Command[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [filter, setFilter] = useState('')

  const loadSkills = useCallback(async () => {
    setIsLoading(true)
    try {
      const res = await getCommands(handle, { scope: 'user' })
      setSkills(res.commands.filter((c) => c.type === 'skill'))
    } catch {
      // Silently fail
    } finally {
      setIsLoading(false)
    }
  }, [handle])

  useEffect(() => {
    loadSkills()
  }, [loadSkills])

  const filteredSkills = useMemo(() => {
    const q = filter.trim().toLowerCase()
    if (!q) return skills
    return skills.filter((s) =>
      [s.name, s.description, s.file_path].some((v) => v?.toLowerCase().includes(q))
    )
  }, [skills, filter])

  if (isLoading) return <div class={styles.loading}>Loading...</div>

  return (
    <>
      <div class={styles.sectionHeader}>
        <FilterInput
          value={filter}
          onChange={setFilter}
          placeholder="Filter skills..."
          testId="skills-filter"
        />
        <span />
      </div>
      {skills.length === 0 ? (
        <div class={styles.empty}>No skills configured.</div>
      ) : filteredSkills.length === 0 ? (
        <div class={styles.empty}>No skills match the filter.</div>
      ) : (
        <ResourceGrid>
          {filteredSkills.map((skill) => (
            <ResourceCard
              key={`${skill.scope}-${skill.name}`}
              kind="skill"
              name={skill.name}
              description={skill.description}
              scope={skill.scope}
              path={skill.file_path}
              href={`/assistants/${handle}/skills/${encodeURIComponent(skill.name)}?scope=${skill.scope}&type=skill&from=${encodeURIComponent(`/assistants/${handle}`)}`}
            />
          ))}
        </ResourceGrid>
      )}
    </>
  )
}
