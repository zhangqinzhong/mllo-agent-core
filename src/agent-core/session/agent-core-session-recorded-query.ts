import { runAgentCoreQueryLoop } from '../query-loop/agent-core-query-loop'
import type {
  AgentCoreQueryEvent,
  AgentCoreQueryLoopArgs,
  AgentCoreQueryLoopResult
} from '../query-loop/agent-core-query-types'
import type { AgentCoreJsonlSessionStore } from './agent-core-jsonl-session-store'
import type { AgentCoreSessionHandle } from './agent-core-session-types'

export type AgentCoreRecordedQueryArgs = AgentCoreQueryLoopArgs & {
  session: {
    handle: AgentCoreSessionHandle
    store: AgentCoreJsonlSessionStore
  }
}

// 把 timeline event 追加到 session transcript。失败应该让调用方知道，不能静默丢记录。
async function recordTimelineEvent(
  args: AgentCoreRecordedQueryArgs,
  event: AgentCoreQueryEvent
): Promise<void> {
  await args.session.store.appendEntry(
    args.session.handle,
    args.session.store.createTimelineEventEntry({
      sessionId: args.session.handle.sessionId,
      cwd: args.session.handle.cwd,
      event
    })
  )
}

// 把 hook event 追加成专门的 hook entry。timeline 负责展示，hook entry 负责审计。
async function recordHookEvent(
  args: AgentCoreRecordedQueryArgs,
  event: Extract<AgentCoreQueryEvent, { type: 'hook-event' }>
): Promise<void> {
  await args.session.store.appendEntry(
    args.session.handle,
    args.session.store.createHookEventEntry({
      sessionId: args.session.handle.sessionId,
      cwd: args.session.handle.cwd,
      hookName: event.hookName,
      phase: event.phase,
      status: event.status,
      content: event.content
    })
  )
}

// queryLoop 完成后追加消息快照。第一版先记录完整消息，后续再做增量去重和 resume。
async function recordResultMessages(
  args: AgentCoreRecordedQueryArgs,
  result: AgentCoreQueryLoopResult
): Promise<void> {
  for (const message of result.messages) {
    await args.session.store.appendMessage(
      args.session.handle,
      args.session.store.createMessageEntry({
        sessionId: args.session.handle.sessionId,
        cwd: args.session.handle.cwd,
        message
      })
    )
  }
}

// 运行带持久化的 queryLoop。它透传所有事件，同时把事件和最终消息写入 JSONL。
export async function* runAgentCoreRecordedQueryLoop(
  args: AgentCoreRecordedQueryArgs
): AsyncGenerator<AgentCoreQueryEvent, AgentCoreQueryLoopResult> {
  const generator = runAgentCoreQueryLoop(args)

  while (true) {
    const item = await generator.next()
    if (item.done === true) {
      await recordResultMessages(args, item.value)
      return item.value
    }

    if (item.value.type === 'hook-event') {
      await recordHookEvent(args, item.value)
    }
    await recordTimelineEvent(args, item.value)
    yield item.value
  }
}
