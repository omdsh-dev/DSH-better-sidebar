/** One optional, bounded contact lookup per page batch; missing permission leaves IDs intact. */
import { ClueError, type CluePerson, type ClueOperationContext, type ClueResourceInfo } from '../../types.ts'
import type { ClueRuntime } from '../../runtime/types.ts'
import { isRecord, stringOf } from './format.ts'
import { runLark, larkWorkingDirectory } from './lark.ts'

export function feishuPersonOf(value: unknown): CluePerson | undefined {
  if (typeof value === 'string') return value.trim() === '' ? undefined : { id: value }
  if (!isRecord(value)) return undefined
  const id = stringOf(value.id) ?? stringOf(value.open_id) ?? stringOf(value.user_id) ?? stringOf(value.union_id)
  const name = stringOf(value.name)
  return id === undefined && name === undefined ? undefined : { ...(id === undefined ? {} : { id }), ...(name === undefined ? {} : { name }) }
}

export async function feishuPeopleNames(runtime: ClueRuntime, people: readonly (CluePerson | undefined)[], context: ClueOperationContext): Promise<ReadonlyMap<string, string>> {
  const names = new Map<string, string>()
  // A name already present on this page can satisfy another occurrence without a contact call.
  for (const person of people) if (person?.id !== undefined && person.name !== undefined) names.set(person.id, person.name)
  const ids = [...new Set(people.filter(person => person?.name === undefined).map(person => person?.id).filter((id): id is string => id !== undefined && !names.has(id)))]
  for (const type of ['open_id', 'union_id', 'user_id'] as const) {
    const group = ids.filter(id => (id.startsWith('ou_') ? 'open_id' : id.startsWith('on_') ? 'union_id' : 'user_id') === type)
    for (let offset = 0; offset < group.length; offset += 50) {
      const batch = group.slice(offset, offset + 50)
      try {
        // No connection observation: failure of this optional lookup says nothing about document/task authorization.
        const result = await runLark({ runtime,
          args: ['contact', 'users', 'batch', '--params', '-', '--as', 'user', '--format', 'json'],
          stdin: JSON.stringify({ user_ids: batch, user_id_type: type }),
          cwd: larkWorkingDirectory(context.workspacePath), ...(context.signal === undefined ? {} : { signal: context.signal }),
        })
        for (const raw of Array.isArray(result.data.items) ? result.data.items : []) {
          if (!isRecord(raw)) continue
          const id = stringOf(raw[type])
          const name = stringOf(raw.name)
          if (id !== undefined && batch.includes(id) && name !== undefined) names.set(id, name)
        }
      } catch (error) {
        if (error instanceof ClueError && error.category === 'cancelled') throw error
        // Optional contacts must not fail readable content, invent a name, or retry person by person.
        return names
      }
    }
  }
  return names
}

export function namedFeishuPerson(person: CluePerson | undefined, names: ReadonlyMap<string, string>): CluePerson | undefined {
  const name = person?.id === undefined ? undefined : names.get(person.id)
  return person === undefined || person.name !== undefined || name === undefined ? person : { ...person, name }
}

export async function nameFeishuInfos(runtime: ClueRuntime, infos: readonly (ClueResourceInfo | undefined)[], context: ClueOperationContext): Promise<(ClueResourceInfo | undefined)[]> {
  const names = await feishuPeopleNames(runtime, infos.flatMap(info => [info?.author, ...(info?.assignees ?? []), ...(info?.followers ?? [])]), context)
  return infos.map(info => info === undefined ? undefined : {
    ...info,
    ...(info.author === undefined ? {} : { author: namedFeishuPerson(info.author, names) }),
    ...(info.assignees === undefined ? {} : { assignees: info.assignees.map(person => namedFeishuPerson(person, names)!) }),
    ...(info.followers === undefined ? {} : { followers: info.followers.map(person => namedFeishuPerson(person, names)!) }),
  })
}
