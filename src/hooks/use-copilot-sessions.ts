import { useCallback, useEffect, useMemo, useState } from 'react'
import { useLauncherApi } from '../api/client'
import type { AiSession, AiSessionCreateInput, AiSessionEvent, CopilotModelOption } from '../types'

function replaceSession(current: AiSession[], next: AiSession): AiSession[] {
  const index = current.findIndex(item => item.id === next.id)
  if (index < 0) return [next, ...current]
  return current.map(item => item.id === next.id ? next : item)
}

function orderedMessages(messages: AiSession['messages']): AiSession['messages'] {
  return [...messages].sort((left, right) => left.createdAt.localeCompare(right.createdAt))
}

export function useCopilotSessions() {
  const api = useLauncherApi()
  const [sessions, setSessions] = useState<AiSession[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [models, setModels] = useState<CopilotModelOption[]>([])

  useEffect(() => {
    let mounted = true
    void api.listAiSessions().then(items => {
      if (!mounted) return
      setSessions(items.map(session => ({ ...session, messages: orderedMessages(session.messages) })))
      setSelectedId(current => current ?? items[0]?.id ?? null)
    }).finally(() => { if (mounted) setLoading(false) })
    const unsubscribe = api.onAiSessionEvent((event: AiSessionEvent) => {
      if (event.kind === 'session-created') {
        setSessions(current => replaceSession(current, event.session))
        setSelectedId(event.session.id)
      } else if (event.kind === 'session-updated') {
        setSessions(current => replaceSession(current, event.session))
      } else if (event.kind === 'message') {
        setSessions(current => current.map(session => {
          if (session.id !== event.sessionId) return session
          const index = session.messages.findIndex(message => message.id === event.message.id)
          // Codex starts streaming its assistant message before command-output
          // tool messages finish.  Newly arrived tool records therefore belong
          // before that in-flight answer even though IPC delivered them later.
          const firstAssistant = session.messages.findIndex(message => message.role === 'assistant')
          const insertAt = event.message.role === 'assistant' || event.message.role === 'user' || firstAssistant < 0
            ? session.messages.length
            : firstAssistant
          const messages = index < 0
            ? [...session.messages.slice(0, insertAt), event.message, ...session.messages.slice(insertAt)]
            : session.messages.map(message => message.id === event.message.id ? event.message : message)
          const nextMessages = orderedMessages(messages)
          return { ...session, messages: nextMessages, messageCount: nextMessages.length, updatedAt: event.message.createdAt }
        }))
      } else if (event.kind === 'approval') {
        setSessions(current => current.map(session => session.id === event.sessionId ? { ...session, pendingApproval: event.request } : session))
      } else if (event.kind === 'snapshot') {
        setSessions(current => current.map(session => session.id === event.sessionId ? { ...session, hasSnapshot: true } : session))
      } else if (event.kind === 'deleted') {
        setSessions(current => current.filter(session => session.id !== event.sessionId))
        setSelectedId(current => current === event.sessionId ? null : current)
      }
    })
    return () => { mounted = false; unsubscribe() }
  }, [api])

  // 模型候选可能随 API 配置变化（新增自定义 API、补密钥），由面板打开时触发重新拉取。
  const reloadModels = useCallback(() => {
    void api.listCopilotModels().then(setModels).catch(() => { /* 主进程配置缺失时保留上次列表 */ })
  }, [api])

  useEffect(() => { reloadModels() }, [reloadModels])

  const selected = useMemo(() => sessions.find(session => session.id === selectedId) ?? sessions[0] ?? null, [sessions, selectedId])

  const create = useCallback(async (input?: AiSessionCreateInput) => {
    const session = await api.createAiSession(input)
    setSelectedId(session.id)
    return session
  }, [api])

  const send = useCallback(async (text: string) => {
    if (!selected) return null
    return api.sendAiSessionMessage(selected.id, text, selected.model ?? null)
  }, [api, selected])

  const setModel = useCallback(async (modelKey: string | null) => {
    if (!selected) return
    const next = modelKey || null
    const previous = selected.model ?? null
    setSessions(current => current.map(session => session.id === selected.id ? { ...session, model: next } : session))
    try {
      await api.setAiSessionModel(selected.id, next)
    } catch (error) {
      // 主进程未接受：回滚乐观更新，让界面回到权威状态。
      setSessions(current => current.map(session => session.id === selected.id ? { ...session, model: previous } : session))
      throw error
    }
  }, [api, selected])

  const cancel = useCallback(() => selected ? api.cancelAiSession(selected.id) : Promise.resolve(), [api, selected])
  const approve = useCallback((requestId: string, allow: boolean) => selected ? api.approveAiSession(selected.id, requestId, allow) : Promise.resolve(false), [api, selected])
  const rollback = useCallback(() => selected ? api.rollbackAiSession(selected.id) : Promise.reject(new Error('没有选中的会话。')), [api, selected])
  const remove = useCallback(async (sessionId: string) => {
    await api.deleteAiSession(sessionId)
    setSelectedId(current => current === sessionId ? null : current)
  }, [api])

  return { sessions, selected, selectedId, setSelectedId, loading, models, reloadModels, setModel, create, send, cancel, approve, rollback, remove }
}

export type CopilotSessionState = ReturnType<typeof useCopilotSessions>
