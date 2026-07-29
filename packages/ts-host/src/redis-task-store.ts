import Redis from 'ioredis'
import {
  Task,
  TaskState,
  type ListTasksRequest,
  type ListTasksResponse,
} from '@a2a-js/sdk'
import {
  resolveUserScope,
  type ServerCallContext,
  type TaskStore,
} from '@a2a-js/sdk/server'

export interface RedisTaskStoreOptions {
  url: string
  keyPrefix?: string
  ttlSeconds?: number
  client?: Redis
}

/**
 * A2A v1.0 Redis task store with tenant and authenticated-user isolation.
 * The key layout is deliberately owned by agent-host so all platform agents
 * use the same persistence semantics and TaskStore contract.
 */
export class RedisTaskStore implements TaskStore {
  private readonly client: Redis
  private readonly keyPrefix: string
  private readonly ttlSeconds?: number

  constructor(options: RedisTaskStoreOptions) {
    this.client = options.client ?? new Redis(options.url)
    this.keyPrefix = options.keyPrefix ?? 'a2a:task:'
    this.ttlSeconds = options.ttlSeconds
  }

  private scope(context: ServerCallContext): string {
    const tenant = encodeURIComponent(context.tenant ?? '')
    const owner = encodeURIComponent(resolveUserScope(context))
    return `${tenant}:${owner}:`
  }

  private key(taskId: string, context: ServerCallContext): string {
    return `${this.keyPrefix}${this.scope(context)}${encodeURIComponent(taskId)}`
  }

  async save(task: Task, context: ServerCallContext): Promise<void> {
    const payload = JSON.stringify(Task.toJSON(task))
    if (this.ttlSeconds && this.ttlSeconds > 0) {
      await this.client.set(
        this.key(task.id, context),
        payload,
        'EX',
        this.ttlSeconds,
      )
      return
    }
    await this.client.set(this.key(task.id, context), payload)
  }

  async load(
    taskId: string,
    context: ServerCallContext,
  ): Promise<Task | undefined> {
    const payload = await this.client.get(this.key(taskId, context))
    if (!payload) return undefined
    return Task.fromJSON(JSON.parse(payload))
  }

  async list(
    params: ListTasksRequest,
    context: ServerCallContext,
  ): Promise<ListTasksResponse> {
    const keys: string[] = []
    let cursor = '0'
    const pattern = `${this.keyPrefix}${this.scope(context)}*`
    do {
      const page = await this.client.scan(
        cursor,
        'MATCH',
        pattern,
        'COUNT',
        100,
      )
      cursor = page[0]
      keys.push(...page[1])
    } while (cursor !== '0')

    const payloads = keys.length > 0 ? await this.client.mget(...keys) : []
    let tasks = payloads
      .filter((value): value is string => value !== null)
      .map((value) => Task.fromJSON(JSON.parse(value)))
      .filter(
        (task) =>
          (!params.contextId || task.contextId === params.contextId) &&
          (params.status === TaskState.TASK_STATE_UNSPECIFIED ||
            task.status?.state === params.status) &&
          (!params.statusTimestampAfter ||
            (task.status?.timestamp ?? '') >= params.statusTimestampAfter),
      )
      .sort((left, right) =>
        (right.status?.timestamp ?? '').localeCompare(
          left.status?.timestamp ?? '',
        ),
      )

    const totalSize = tasks.length
    const offset = Number.parseInt(params.pageToken || '0', 10)
    const safeOffset = Number.isFinite(offset) && offset >= 0 ? offset : 0
    const pageSize = Math.min(Math.max(params.pageSize ?? 50, 1), 100)
    tasks = tasks.slice(safeOffset, safeOffset + pageSize).map((task) => ({
      ...task,
      artifacts: params.includeArtifacts ? task.artifacts : [],
      history:
        params.historyLength === undefined
          ? task.history
          : params.historyLength === 0
            ? []
            : task.history.slice(-params.historyLength),
    }))

    const nextOffset = safeOffset + tasks.length
    return {
      tasks,
      nextPageToken: nextOffset < totalSize ? String(nextOffset) : '',
      pageSize,
      totalSize,
    }
  }

  async close(): Promise<void> {
    await this.client.quit()
  }
}
