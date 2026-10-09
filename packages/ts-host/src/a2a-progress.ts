import { TaskState } from '@a2a-js/sdk'
import { AgentEvent as SdkEvent, type ExecutionEventBus } from '@a2a-js/sdk/server'
import { textPart } from './parts'
import type { AgentEvent } from './types'

/** One execution's native A2A progress and append-only answer artifact. */
export class A2aProgress {
  private working = false
  private textStarted = false
  private readonly artifactId: string

  constructor(
    private readonly taskId: string,
    private readonly contextId: string,
    private readonly bus: ExecutionEventBus,
  ) {
    this.artifactId = `answer-${taskId}`
  }

  emit = (event: AgentEvent): void => {
    if (event.type === 'text') {
      if (!event.delta) return
      this.startWorking()
      this.appendText(event.delta)
      return
    }
    if (event.type !== 'node' && event.type !== 'reasoning') return
    this.startWorking()
    this.bus.publish(
      SdkEvent.statusUpdate({
        taskId: this.taskId,
        contextId: this.contextId,
        status: { state: TaskState.TASK_STATE_WORKING, message: undefined, timestamp: new Date().toISOString() },
        metadata: event.type === 'node'
          ? { 'ai37/node': event.node }
          : { 'ai37/reasoning': event.delta },
      }),
    )
  }

  finish(): void {
    if (this.textStarted) this.publishText('', true, true)
  }

  /** Опубликован ли уже `task` (первый прогресс): тогда финал хода — только status/artifact-update. */
  get started(): boolean {
    return this.working
  }

  private startWorking(): void {
    if (this.working) return
    this.working = true
    // Первое событие исполнения в 1.x обязано быть task или message (иначе сервер рвёт стрим).
    this.bus.publish(
      SdkEvent.task({
        id: this.taskId,
        contextId: this.contextId,
        status: { state: TaskState.TASK_STATE_WORKING, message: undefined, timestamp: new Date().toISOString() },
        artifacts: [],
        history: [],
        metadata: {},
      }),
    )
  }

  private appendText(delta: string): void {
    if (!this.textStarted) {
      // Establish the artifact first; all nonempty parts are real append deltas.
      // Relay consumers must not mistake a replacement snapshot for a delta.
      this.textStarted = true
      this.publishText('', false, false)
    }
    this.publishText(delta, true, false)
  }

  private publishText(text: string, append: boolean, lastChunk: boolean): void {
    this.bus.publish(
      SdkEvent.artifactUpdate({
        taskId: this.taskId,
        contextId: this.contextId,
        artifact: {
          artifactId: this.artifactId,
          name: 'answer',
          description: '',
          parts: text ? [textPart(text)] : [],
          metadata: undefined,
          extensions: [],
        },
        append,
        lastChunk,
        metadata: undefined,
      }),
    )
  }
}
