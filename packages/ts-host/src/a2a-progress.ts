import { TaskState } from '@a2a-js/sdk'
import { AgentEvent as SdkEvent, type ExecutionEventBus } from '@a2a-js/sdk/server'
import { textPart } from './parts'
import type { AgentEvent } from './types'

/** Артефакт стримового текста хода: `answer-<taskId>`. */
export function answerArtifactId(taskId: string): string {
  return `answer-${taskId}`
}

/**
 * Сколько ход может молчать, прежде чем хост сам отправит keepalive — `status-update` со
 * `state: working` без сообщения и metadata. Таймер простоя relay оркестратора (60 с) на нём
 * сбрасывается, а рендерить такое событие нечего. Меньше таймаутов ingress агента с запасом.
 */
export const A2A_KEEPALIVE_MS = 20_000

/** One execution's native A2A progress and append-only answer artifact. */
export class A2aProgress {
  private working = false
  private textStarted = false
  private readonly artifactId: string
  private keepaliveMs: number | undefined
  private keepaliveTimer: ReturnType<typeof setTimeout> | undefined

  constructor(
    private readonly taskId: string,
    private readonly contextId: string,
    private readonly bus: ExecutionEventBus,
  ) {
    this.artifactId = answerArtifactId(taskId)
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
    this.publishWorking(event.type === 'node' ? { 'ai37/node': event.node } : { 'ai37/reasoning': event.delta })
  }

  /**
   * Включить keepalive: если за `intervalMs` ход ничего не опубликовал, уходит `status-update working`.
   * Любая публикация переносит срок. Первый keepalive публикует и `task` — как первый прогресс.
   */
  startKeepalive(intervalMs: number = A2A_KEEPALIVE_MS): void {
    this.keepaliveMs = intervalMs
    this.armKeepalive()
  }

  finish(): void {
    this.stopKeepalive()
    if (this.textStarted) this.publishText('', true, true)
  }

  /** Снять keepalive. Идемпотентно; `finish()` зовёт его сам. */
  stopKeepalive(): void {
    this.keepaliveMs = undefined
    if (this.keepaliveTimer) clearTimeout(this.keepaliveTimer)
    this.keepaliveTimer = undefined
  }

  /** Опубликован ли уже `task` (первый прогресс): тогда финал хода — только status/artifact-update. */
  get started(): boolean {
    return this.working
  }

  /** Стримил ли ход текст в `answer-<taskId>` (тогда артефакт этого хода уже заменил прошлый). */
  get textStreamed(): boolean {
    return this.textStarted
  }

  private armKeepalive(): void {
    if (this.keepaliveTimer) clearTimeout(this.keepaliveTimer)
    if (this.keepaliveMs === undefined) return
    this.keepaliveTimer = setTimeout(() => {
      this.keepaliveTimer = undefined
      this.startWorking()
      this.publishWorking(undefined)
    }, this.keepaliveMs)
  }

  /** Все публикации хода идут здесь: каждая переносит срок keepalive. */
  private publish(event: Parameters<ExecutionEventBus['publish']>[0]): void {
    this.bus.publish(event)
    this.armKeepalive()
  }

  private publishWorking(metadata: Record<string, unknown> | undefined): void {
    this.publish(
      SdkEvent.statusUpdate({
        taskId: this.taskId,
        contextId: this.contextId,
        status: { state: TaskState.TASK_STATE_WORKING, message: undefined, timestamp: new Date().toISOString() },
        metadata,
      }),
    )
  }

  private startWorking(): void {
    if (this.working) return
    this.working = true
    // Первое событие исполнения в 1.x обязано быть task или message (иначе сервер рвёт стрим).
    this.publish(
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
    this.publish(
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
