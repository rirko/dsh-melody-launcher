/**
 * Minimal JSONL client for the Codex App Server.
 *
 * Codex's app-server deliberately uses JSON-RPC-shaped messages without a
 * `jsonrpc` member.  Keeping this transport separate from the ACP client is
 * useful because the two protocols have different method names, approval
 * responses, and event payloads.  The module has no dependency on Electron
 * or the Copilot session manager and can therefore be exercised with an
 * in-memory transport in tests.
 */

import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { killChildProcessTree } from './process'

export type CodexRequestId = number | string

export interface CodexAppServerMessage {
  id?: CodexRequestId
  method?: string
  params?: unknown
  result?: unknown
  error?: { code?: number; message?: string; data?: unknown }
  [key: string]: unknown
}

export interface CodexAppServerTransport {
  /** Send one JSON object. Implementations must append the line terminator. */
  send(message: CodexAppServerMessage): void
  /** Register a callback for each parsed JSONL message. */
  onMessage(handler: (message: CodexAppServerMessage) => void): void
  /** Register a callback for process/stream closure. */
  onClose(handler: (error?: Error) => void): void
  /** Close the underlying streams. */
  close(): void
}

/** Compatibility shape used by the Copilot manager for raw notifications. */
export interface CodexServerEvent {
  method: string
  params: Record<string, unknown>
}

/** Raw server-to-client request (usually a command/file approval request). */
export interface CodexServerRequest extends CodexServerEvent {
  id: CodexRequestId
}

/**
 * Server-to-client request families currently exposed by Codex App Server.
 *
 * Keep this list separate from `CodexApprovalRequest.kind`: only the first
 * three families are approvals.  The remaining requests are still part of
 * the protocol and must receive a response, otherwise the active turn can
 * remain waiting forever (which looks like a turn that stopped after its
 * first tool call).
 */
export type CodexServerRequestKind =
  | 'command'
  | 'file-change'
  | 'permissions'
  | 'user-input'
  | 'elicitation'
  | 'dynamic-tool'
  | 'auth-refresh'
  | 'attestation'
  | 'current-time'
  | 'unknown'

/** Compatibility transport used by the launcher's existing ACP process wrapper. */
export interface LegacyLineTransport {
  send(line: string): void
  onLine(handler: (line: string) => void): void
  onClose(handler: (error?: Error) => void): void
  close(): void
}

/** Transport accepted by the client, including the launcher's legacy line adapter. */
export type CodexAppServerTransportLike = CodexAppServerTransport | LegacyLineTransport

interface PendingServerRequest {
  method: string
  kind: CodexApprovalRequest['kind']
  params: Record<string, unknown>
}

export interface CodexAppServerTransportOptions {
  onStderr?: (text: string) => void
  onParseError?: (line: string, error: Error) => void
  onProtocolError?: (error: Error) => void
}

/**
 * Adapt a spawned Codex process to the JSONL transport expected by the
 * client.  Stdout is protocol traffic; stderr is never parsed as protocol.
 */
export function createCodexAppServerTransport(
  child: ChildProcessWithoutNullStreams,
  options: CodexAppServerTransportOptions = {},
): CodexAppServerTransport {
  const messageHandlers: Array<(message: CodexAppServerMessage) => void> = []
  const closeHandlers: Array<(error?: Error) => void> = []
  const reader = createInterface({ input: child.stdout })
  let closed = false
  let closeError: Error | undefined
  let childTermination: Promise<void> | null = null
  let eofCloseTimer: NodeJS.Immediate | null = null

  const terminateChild = (): void => {
    if (childTermination) return
    childTermination = killChildProcessTree(child).catch(() => undefined)
  }

  const reportCallbackError = (error: unknown): void => {
    try {
      options.onProtocolError?.(error instanceof Error ? error : new Error(String(error)))
    } catch {
      // Diagnostics are best effort and must not escape an EventEmitter.
    }
  }

  reader.on('line', line => {
    const trimmed = line.trim()
    if (!trimmed) return
    try {
      const parsed: unknown = JSON.parse(trimmed)
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('Codex App Server 返回的 JSON 不是对象。')
      }
      // Isolate consumers so a throwing event callback cannot prevent later
      // protocol consumers from receiving the same frame.
      for (const handler of [...messageHandlers]) {
        try {
          handler(parsed as CodexAppServerMessage)
        } catch (error) {
          reportCallbackError(error)
        }
      }
    } catch (error) {
      try {
        options.onParseError?.(trimmed, error instanceof Error ? error : new Error(String(error)))
      } catch {
        // Parsing diagnostics must not terminate the transport.
      }
    }
  })
  child.stderr.on('data', chunk => {
    try { options.onStderr?.(chunk.toString('utf8')) } catch { /* logging is best effort */ }
  })

  const emitClose = (error?: Error) => {
    if (closed) return
    closed = true
    closeError = error
    if (eofCloseTimer) {
      clearImmediate(eofCloseTimer)
      eofCloseTimer = null
    }
    reader.close()
    for (const handler of closeHandlers.splice(0)) {
      try { handler(error) } catch { /* one observer must not block others */ }
    }
  }
  // On Windows the child process can close its stdin before the `exit` event
  // is delivered.  A subsequent write would otherwise emit an unhandled
  // `EPIPE`/`ERR_STREAM_DESTROYED` and make the host appear to stop after its
  // first tool request.  Treat stream errors as a transport close so pending
  // requests and approval waiters are released deterministically.
  const closeUnexpectedly = (error?: Error): void => {
    emitClose(error)
    terminateChild()
  }
  const scheduleEofClose = (): void => {
    if (eofCloseTimer || closed) return
    // Give a same-turn `exit` event a chance to preserve its concrete code.
    eofCloseTimer = setImmediate(() => {
      eofCloseTimer = null
      closeUnexpectedly(new Error('Codex App Server 连接已关闭：stdout 已关闭。'))
    })
  }
  child.stdin.on('error', error => closeUnexpectedly(error instanceof Error ? error : new Error(String(error))))
  child.stdout.on('error', error => closeUnexpectedly(error instanceof Error ? error : new Error(String(error))))
  // EOF can arrive before the child emits `exit` (for example when a wrapper
  // closes stdout but keeps a helper process alive).  Treat it as a terminal
  // transport event so pending requests do not wait forever.
  child.stdout.once('end', scheduleEofClose)
  child.stdout.once('close', scheduleEofClose)
  child.stderr.on('error', error => closeUnexpectedly(error instanceof Error ? error : new Error(String(error))))
  child.once('error', error => closeUnexpectedly(error))
  child.once('exit', code => {
    if (eofCloseTimer) {
      clearImmediate(eofCloseTimer)
      eofCloseTimer = null
    }
    const error = code === 0 ? undefined : new Error(`Codex App Server 退出（code ${code ?? '未知'}）。`)
    emitClose(error)
    if (error) terminateChild()
  })

  return {
    send(message) {
      if (closed) throw closeError ?? new Error('Codex App Server 连接已关闭。')
      try {
        child.stdin.write(`${JSON.stringify(message)}\n`)
      } catch (error) {
        closeUnexpectedly(error instanceof Error ? error : new Error(String(error)))
        throw error
      }
    },
    onMessage(handler) {
      messageHandlers.push(handler)
    },
    onClose(handler) {
      if (closed) {
        // The process can exit between transport construction and client
        // registration.  Invoke late subscribers immediately so a client
        // cannot remain apparently alive with requests that will never be
        // answered.
        try { handler(closeError) } catch { /* late observers are best effort */ }
      } else {
        closeHandlers.push(handler)
      }
    },
    close() {
      if (closed) return
      // Mark the transport closed before ending stdin.  Some child processes
      // keep running after EOF; waiting for their exit would leave callers
      // able to write into a half-closed stream and would delay pending
      // request cleanup indefinitely.
      emitClose()
      try {
        child.stdin.end()
      } catch {
        // The child may already have closed its stdin.
      }
      terminateChild()
    },
  }
}

export interface SpawnCodexAppServerOptions {
  executable?: string
  args?: string[]
  cwd?: string
  env?: NodeJS.ProcessEnv
  /** Set false when the caller wants a visible console on Windows. */
  windowsHide?: boolean
  onStderr?: (text: string) => void
  onParseError?: (line: string, error: Error) => void
  onProtocolError?: (error: Error) => void
}

/** Spawn a Codex executable in app-server mode and return its JSONL transport. */
export function spawnCodexAppServer(options: SpawnCodexAppServerOptions = {}): {
  child: ChildProcessWithoutNullStreams
  transport: CodexAppServerTransport
} {
  const executable = options.executable ?? 'codex'
  const args = options.args ?? ['app-server', '--listen', 'stdio://']
  const child = spawn(executable, args, {
    cwd: options.cwd,
    env: options.env ?? process.env,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: options.windowsHide ?? true,
    // .cmd wrappers need a shell on Windows; native binaries do not.
    shell: process.platform === 'win32' && /\.cmd$/i.test(executable),
  })
  const transport = createCodexAppServerTransport(child, {
    onStderr: options.onStderr,
    onParseError: options.onParseError,
    onProtocolError: options.onProtocolError,
  })
  return { child, transport }
}

export interface CodexInitializeResult {
  userAgent?: string
  codexHome?: string
  platformFamily?: string
  platformOs?: string
  [key: string]: unknown
}

export type CodexApprovalDecision = 'accept' | 'decline' | 'cancel'

/** Schema used by Codex's built-in `request_permissions` tool. */
export interface CodexAdditionalNetworkPermissions {
  enabled: boolean | null
}

export interface CodexAdditionalFileSystemPermissions {
  read: string[] | null
  write: string[] | null
  globScanMaxDepth?: number
  entries?: unknown[]
}

export interface CodexRequestPermissionProfile {
  network: CodexAdditionalNetworkPermissions | null
  fileSystem: CodexAdditionalFileSystemPermissions | null
}

export interface CodexGrantedPermissionProfile {
  network?: CodexAdditionalNetworkPermissions
  fileSystem?: CodexAdditionalFileSystemPermissions
}

export interface CodexPermissionsRequestApprovalParams {
  threadId: string
  turnId: string
  itemId: string
  environmentId: string | null
  startedAtMs: number
  cwd: string
  reason: string | null
  permissions: CodexRequestPermissionProfile
}

export interface CodexPermissionsRequestApprovalResponse {
  permissions: CodexGrantedPermissionProfile
  scope: 'turn' | 'session'
  strictAutoReview?: boolean
}

export interface CodexApprovalRequest {
  id: CodexRequestId
  method: string
  /** `command`, `file-change`, or `permissions` when recognized. */
  kind: 'command' | 'file-change' | 'permissions' | 'unknown'
  threadId?: string
  turnId?: string
  itemId?: string
  /** Present for `item/permissions/requestApproval`. */
  requestedPermissions?: CodexRequestPermissionProfile
  params: unknown
}

export interface CodexItemEvent {
  threadId?: string
  turnId?: string
  itemId?: string
  item?: unknown
  params: unknown
}

export interface CodexTextEvent extends CodexItemEvent {
  text: string
}

export type CodexAppServerEvent =
  | { kind: 'thread-started'; threadId?: string; params: unknown }
  | { kind: 'turn-started'; threadId?: string; turnId?: string; params: unknown }
  | { kind: 'turn-completed'; threadId?: string; turnId?: string; params: unknown }
  | { kind: 'agent-message'; threadId?: string; turnId?: string; itemId?: string; text: string; params: unknown }
  | { kind: 'reasoning'; threadId?: string; turnId?: string; itemId?: string; text: string; params: unknown }
  | { kind: 'command-output'; threadId?: string; turnId?: string; itemId?: string; text: string; params: unknown }
  | { kind: 'file-change'; threadId?: string; turnId?: string; itemId?: string; item?: unknown; params: unknown }
  | { kind: 'item-started'; threadId?: string; turnId?: string; itemId?: string; item?: unknown; params: unknown }
  | { kind: 'item-completed'; threadId?: string; turnId?: string; itemId?: string; item?: unknown; params: unknown }
  | { kind: 'notification'; method: string; params: unknown }

export interface CodexThreadStartOptions {
  approvalPolicy?: string
  sandbox?: string
  model?: string
  modelProvider?: string
  ephemeral?: boolean
  /** Roots exposed to Codex's workspace sandbox (supported app-server field). */
  runtimeWorkspaceRoots?: string[]
  /** @deprecated Kept for callers written against the first launcher build. */
  additionalDirectories?: string[]
  developerInstructions?: string
  config?: Record<string, unknown>
  [key: string]: unknown
}

export interface CodexThreadStartResult {
  thread?: { id?: string; [key: string]: unknown }
  [key: string]: unknown
}

export interface CodexTurnStartOptions {
  input?: unknown[]
  approvalPolicy?: string
  sandboxPolicy?: Record<string, unknown>
  model?: string
  effort?: string
  serviceTier?: string
  summary?: string
  cwd?: string
  /** Roots exposed to Codex's workspace sandbox (supported app-server field). */
  runtimeWorkspaceRoots?: string[]
  /** @deprecated Kept for callers written against the first launcher build. */
  additionalDirectories?: string[]
  [key: string]: unknown
}

export interface CodexTurnStartResult {
  turn?: { id?: string; [key: string]: unknown }
  [key: string]: unknown
}

export interface CodexAppServerClientOptions {
  /** The native JSON transport, or the launcher's existing line transport. */
  transport: CodexAppServerTransportLike
  requestTimeoutMs?: number
  clientInfo?: { name: string; version: string; title?: string }
  /** Called for every raw notification, including unrecognized ones. */
  onEvent?: (event: CodexServerEvent) => void
  onThreadStarted?: (event: CodexAppServerEvent & { kind: 'thread-started' }) => void
  onTurnStarted?: (event: CodexAppServerEvent & { kind: 'turn-started' }) => void
  onTurnCompleted?: (event: CodexAppServerEvent & { kind: 'turn-completed' }) => void
  onAgentMessage?: (event: CodexTextEvent) => void
  onReasoning?: (event: CodexTextEvent) => void
  onCommandOutput?: (event: CodexTextEvent) => void
  onFileChange?: (event: CodexItemEvent) => void
  onItemStarted?: (event: CodexItemEvent) => void
  onItemCompleted?: (event: CodexItemEvent) => void
  /** Return a decision for command/file/permission requests. Missing callbacks reject. */
  onApprovalRequest?: (request: CodexApprovalRequest) => CodexApprovalDecision | Promise<CodexApprovalDecision>
  /** Raw server request hook. When supplied, the caller owns the response. */
  onRequest?: (request: CodexServerRequest) => void | Promise<void>
  onClose?: (error?: Error) => void
  onProtocolError?: (error: Error) => void
}

export interface CodexAppServerClient {
  initialize(): Promise<CodexInitializeResult>
  /** Send the required post-handshake notification. */
  initialized(): Promise<void>
  threadStart(cwd: string, options?: CodexThreadStartOptions): Promise<CodexThreadStartResult>
  turnStart(threadId: string, text: string, options?: CodexTurnStartOptions): Promise<CodexTurnStartResult>
  turnInterrupt(threadId: string, turnId: string): Promise<unknown>
  interrupt(threadId: string, turnId: string): Promise<unknown>
  /** Respond to a server request. Permission responses are normalized fail-closed. */
  respond(requestId: CodexRequestId, result: unknown): void
  respondError(requestId: CodexRequestId, code: number, message: string, data?: unknown): void
  /** Shape and send a command/file/permission approval response. */
  respondToApproval(requestId: CodexRequestId, kind: CodexApprovalRequest['kind'], decision: CodexApprovalDecision): void
  /** Send an arbitrary app-server request for features added later. */
  request<T = unknown>(method: string, params?: unknown, timeoutMs?: number): Promise<T>
  close(): void
}

interface PendingRequest {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  timer?: ReturnType<typeof setTimeout>
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function textField(record: Record<string, unknown>, ...keys: string[]): string {
  for (const key of keys) {
    const value = record[key]
    if (typeof value === 'string') return value
    if (value !== undefined && value !== null && (typeof value === 'number' || typeof value === 'boolean')) return String(value)
  }
  return ''
}

function idField(record: Record<string, unknown>, ...keys: string[]): string | undefined {
  const value = textField(record, ...keys)
  return value || undefined
}

/** Preserve numeric JSON-RPC ids when handling serverRequest/resolved. */
function requestIdField(record: Record<string, unknown>, ...keys: string[]): CodexRequestId | undefined {
  for (const key of keys) {
    const value = record[key]
    if (typeof value === 'string' || typeof value === 'number') return value
  }
  return undefined
}

function itemRecord(params: unknown): Record<string, unknown> {
  const record = asRecord(params)
  const item = record.item
  return item && typeof item === 'object' && !Array.isArray(item) ? item as Record<string, unknown> : record
}

function eventIds(params: unknown, item = itemRecord(params)): Pick<CodexItemEvent, 'threadId' | 'turnId' | 'itemId'> {
  const record = asRecord(params)
  const thread = asRecord(record.thread)
  const turn = asRecord(record.turn)
  return {
    threadId: idField(record, 'threadId', 'thread_id', 'conversationId', 'conversation_id')
      ?? idField(item, 'threadId', 'thread_id', 'conversationId', 'conversation_id')
      ?? idField(thread, 'id', 'threadId', 'thread_id'),
    turnId: idField(record, 'turnId', 'turn_id')
      ?? idField(item, 'turnId', 'turn_id')
      ?? idField(turn, 'id', 'turnId', 'turn_id'),
    itemId: idField(record, 'itemId', 'item_id', 'callId', 'call_id', 'id')
      ?? idField(item, 'itemId', 'item_id', 'callId', 'call_id', 'id'),
  }
}

/** Normalize method names for compatibility with older app-server builds. */
export function normalizedCodexMethod(method: string): string {
  return method.toLowerCase().replace(/[^a-z]/g, '')
}

/**
 * Classify every server-initiated request currently defined by App Server.
 * `CodexApprovalRequest.kind` intentionally remains a narrower type for the
 * existing approval UI; callers that need to route all requests should use
 * this classifier instead.
 */
export function codexServerRequestKind(method: string): CodexServerRequestKind {
  const normalized = normalizedCodexMethod(method)
  if ((normalized.includes('commandexecution') || normalized === 'execcommandapproval') && normalized.includes('approval')) return 'command'
  if ((normalized.includes('filechange') || normalized === 'applypatchapproval') && normalized.includes('approval')) return 'file-change'
  if (normalized.includes('permissions') && normalized.includes('approval')) return 'permissions'
  // The docs used both `tool/requestUserInput` and the current
  // `item/tool/requestUserInput`; normalize both forms here.
  if (normalized.endsWith('toolrequestuserinput') || normalized === 'requestuserinput') return 'user-input'
  if (normalized === 'mcpserverelicitationrequest' || normalized.endsWith('elicitationrequest')) return 'elicitation'
  if (normalized === 'itemtoolcall' || normalized === 'toolcall' || normalized.endsWith('dynamictoolcall')) return 'dynamic-tool'
  if (normalized === 'accountchatgptauthtokensrefresh' || normalized.endsWith('authtokensrefresh')) return 'auth-refresh'
  if (normalized === 'attestationgenerate' || normalized.endsWith('attestationgenerate')) return 'attestation'
  if (normalized === 'currenttimeread' || normalized.endsWith('timeread')) return 'current-time'
  return 'unknown'
}

/** Classify both current item/* approval methods and legacy aliases. */
export function codexApprovalKind(method: string): CodexApprovalRequest['kind'] {
  const kind = codexServerRequestKind(method)
  return kind === 'command' || kind === 'file-change' || kind === 'permissions' ? kind : 'unknown'
}

function isLegacyApprovalMethod(method: string): boolean {
  const normalized = method.toLowerCase().replace(/[^a-z]/g, '')
  return normalized === 'execcommandapproval' || normalized === 'applypatchapproval'
}

/**
 * Legacy `execCommandApproval`/`applyPatchApproval` use the older review
 * decision enum (`approved`, `abort`, or `{ denied: ... }`).  Keep the modern
 * item/* response untouched while adapting the launcher's common decision
 * shape for those methods.
 */
function normalizeLegacyApprovalResponse(method: string, result: unknown): unknown {
  if (!isLegacyApprovalMethod(method)) return result
  const input = asRecord(result)
  const decision = input.decision
  if (decision && typeof decision === 'object' && !Array.isArray(decision)) return result
  if (decision === 'accept' || decision === 'approved') return { decision: 'approved' }
  if (decision === 'cancel' || decision === 'abort') return { decision: 'abort' }
  return { decision: { denied: { rejection: 'DSH Launcher 拒绝了该操作。' } } }
}

function permissionProfile(value: unknown): CodexRequestPermissionProfile | undefined {
  const record = asRecord(value)
  if (!('network' in record) && !('fileSystem' in record) && !('filesystem' in record)) return undefined
  const networkValue = record.network
  const network = networkValue && typeof networkValue === 'object' && !Array.isArray(networkValue)
    ? { enabled: typeof (networkValue as Record<string, unknown>).enabled === 'boolean' || (networkValue as Record<string, unknown>).enabled === null
      ? (networkValue as Record<string, unknown>).enabled as boolean | null
      : null }
    : null
  const fileSystemValue = record.fileSystem ?? record.filesystem
  let fileSystem: CodexAdditionalFileSystemPermissions | null = null
  if (fileSystemValue && typeof fileSystemValue === 'object' && !Array.isArray(fileSystemValue)) {
    const fs = fileSystemValue as Record<string, unknown>
    fileSystem = {
      read: Array.isArray(fs.read) ? fs.read.filter((entry): entry is string => typeof entry === 'string') : null,
      write: Array.isArray(fs.write) ? fs.write.filter((entry): entry is string => typeof entry === 'string') : null,
      ...(typeof fs.globScanMaxDepth === 'number' && Number.isFinite(fs.globScanMaxDepth) ? { globScanMaxDepth: fs.globScanMaxDepth } : {}),
      ...(Array.isArray(fs.entries) ? { entries: fs.entries } : {}),
    }
  }
  return { network, fileSystem }
}

function requestedPermissionProfile(params: Record<string, unknown>): CodexRequestPermissionProfile | undefined {
  return permissionProfile(params.permissions)
}

function sameJsonValue(left: unknown, right: unknown): boolean {
  try { return JSON.stringify(left) === JSON.stringify(right) } catch { return false }
}

function clampStringSubset(value: unknown, requested: string[] | null | undefined): string[] | null | undefined {
  if (requested === undefined) return undefined
  if (requested === null) return null
  if (!Array.isArray(value)) return []
  const allowed = new Set(requested)
  return value.filter((entry): entry is string => typeof entry === 'string' && allowed.has(entry))
}

function clampEntrySubset(value: unknown, requested: unknown[] | undefined): unknown[] | undefined {
  if (requested === undefined) return undefined
  if (!Array.isArray(value)) return []
  return value.filter(entry => requested.some(candidate => sameJsonValue(entry, candidate)))
}

/**
 * Shape a permissions approval result according to the app-server schema.
 * A legacy `{ decision: 'accept' }` result grants exactly the requested
 * profile, while explicit permission objects are conservatively clamped to
 * the subset sent by Codex. Unknown fields and unrequested permissions are
 * dropped so a renderer cannot accidentally over-grant access.
 */
function normalizePermissionsResponse(
  result: unknown,
  requested: CodexRequestPermissionProfile | undefined,
): CodexPermissionsRequestApprovalResponse {
  const input = asRecord(result)
  const decision = input.decision
  const accepted = decision === 'accept'
  const legacyDecision = accepted || decision === 'decline' || decision === 'cancel'
  const hasExplicitPermissions = Object.prototype.hasOwnProperty.call(input, 'permissions')
  const source = permissionProfile(input.permissions)
  const requestedNetwork = requested?.network
  const requestedFileSystem = requested?.fileSystem
  if (accepted && !hasExplicitPermissions) {
    return {
      permissions: {
        ...(requestedNetwork ? { network: { enabled: requestedNetwork.enabled } } : {}),
        ...(requestedFileSystem ? {
          fileSystem: {
            read: requestedFileSystem.read,
            write: requestedFileSystem.write,
            ...(requestedFileSystem.globScanMaxDepth === undefined ? {} : { globScanMaxDepth: requestedFileSystem.globScanMaxDepth }),
            ...(requestedFileSystem.entries === undefined ? {} : { entries: requestedFileSystem.entries }),
          },
        } : {}),
      },
      scope: input.scope === 'session' ? 'session' : 'turn',
      ...(typeof input.strictAutoReview === 'boolean'
        ? { strictAutoReview: input.strictAutoReview }
        : { strictAutoReview: requested === undefined }),
    }
  }
  const grantedNetwork = source?.network && requestedNetwork
    ? { enabled: source.network.enabled === null ? null : Boolean(source.network.enabled) && requestedNetwork.enabled === true ? true : null }
    : undefined
  const clampedEntries = source?.fileSystem && requestedFileSystem
    ? clampEntrySubset(source.fileSystem.entries, requestedFileSystem.entries)
    : undefined
  const grantedFileSystem = source?.fileSystem && requestedFileSystem
    ? {
      read: clampStringSubset(source.fileSystem.read, requestedFileSystem.read) ?? null,
      write: clampStringSubset(source.fileSystem.write, requestedFileSystem.write) ?? null,
      ...(source.fileSystem.globScanMaxDepth !== undefined && requestedFileSystem.globScanMaxDepth !== undefined
        ? { globScanMaxDepth: Math.min(source.fileSystem.globScanMaxDepth, requestedFileSystem.globScanMaxDepth) }
        : {}),
      ...(clampedEntries === undefined ? {} : { entries: clampedEntries }),
    }
    : undefined
  return {
    permissions: {
      ...(grantedNetwork ? { network: grantedNetwork } : {}),
      ...(grantedFileSystem ? { fileSystem: grantedFileSystem } : {}),
    },
    scope: input.scope === 'session' ? 'session' : 'turn',
    ...(typeof input.strictAutoReview === 'boolean'
      ? { strictAutoReview: input.strictAutoReview }
      : legacyDecision ? { strictAutoReview: true } : {}),
  }
}

export interface CodexFallbackServerResponse {
  /** A protocol-valid result which lets App Server finish the pending item. */
  result?: unknown
  /** An explicit, non-`method not found` error for requests we cannot serve. */
  error?: { code: number; message: string; data?: unknown }
  /** Human-readable reason suitable for the launcher log. */
  message: string
}

/**
 * Return a conservative response for a legal server request when the host
 * does not provide the corresponding optional capability.
 *
 * This is deliberately a *response*, rather than throwing `-32601`: App
 * Server treats an unanswered server request as a blocked turn.  Returning a
 * valid declined/failed item lets the model receive the failure and continue
 * or explain it, while keeping the transport alive for subsequent tool calls.
 * Security-sensitive command/file/permission requests are excluded; those
 * continue through the launcher's approval queue.
 */
export function codexFallbackServerResponse(
  method: string,
  _params?: unknown,
): CodexFallbackServerResponse | null {
  switch (codexServerRequestKind(method)) {
    case 'user-input':
      return {
        // Missing answers are allowed by the App Server schema.  This is the
        // neutral response for a host without a form UI; it avoids inventing
        // a user's choice and gives the model a chance to continue.
        result: { answers: {} },
        message: 'Codex 请求用户输入；当前启动器没有交互式表单，已返回空答案。',
      }
    case 'elicitation':
      return {
        result: { action: 'decline', content: null, _meta: null },
        message: 'MCP 请求用户确认；当前启动器没有表单界面，已安全拒绝。',
      }
    case 'dynamic-tool':
      return {
        result: {
          success: false,
          contentItems: [{ type: 'inputText', text: 'DSH Launcher 未配置此动态工具。' }],
        },
        message: 'Codex 请求调用未配置的动态工具，已返回失败结果。',
      }
    case 'auth-refresh':
      return {
        error: {
          // A distinct application error is easier to diagnose than
          // `-32601`, and does not imply that the protocol method is unknown.
          code: -32010,
          message: 'Codex 外部 ChatGPT 令牌刷新未配置。',
        },
        message: 'Codex 请求刷新外部 ChatGPT 令牌，但启动器未托管该登录状态。',
      }
    case 'attestation':
      return {
        error: {
          code: -32011,
          message: 'Codex 客户端证明未配置。',
        },
        message: 'Codex 请求客户端证明；启动器未声明该能力，已返回明确错误。',
      }
    case 'current-time':
      return {
        // `currentTime/read` is a host capability used by some Codex builds
        // while constructing a turn.  Returning whole Unix seconds matches
        // the generated app-server schema and avoids stalling the turn when
        // the launcher is not otherwise involved in time handling.
        result: { currentTimeAt: Math.floor(Date.now() / 1000) },
        message: 'Codex 请求当前时间，已返回本机 Unix 时间。',
      }
    default:
      return null
  }
}

function eventFromNotification(method: string, params: unknown): CodexAppServerEvent {
  const record = asRecord(params)
  const item = itemRecord(params)
  const ids = eventIds(params, item)
  const normalized = method.toLowerCase().replace(/[^a-z]/g, '')
  if (normalized === 'threadstarted') return { kind: 'thread-started', threadId: ids.threadId ?? idField(asRecord(record.thread), 'id'), params }
  if (normalized === 'turnstarted') return { kind: 'turn-started', ...ids, params }
  if (normalized === 'turncompleted') return { kind: 'turn-completed', ...ids, params }

  const text = textField(record, 'delta', 'text', 'output', 'message', 'content', 'stdin', 'patch')
    || textField(asRecord(record.content), 'text', 'delta')
  if (normalized.includes('agentmessage') && normalized.includes('delta')) {
    return { kind: 'agent-message', ...ids, text, params }
  }
  if (normalized.includes('reasoning') && (normalized.includes('delta') || normalized.includes('summary'))) {
    return { kind: 'reasoning', ...ids, text, params }
  }
  if ((normalized.includes('commandexecution') || normalized.includes('commandexec') || normalized.includes('processoutput'))
    && (normalized.includes('delta') || normalized.includes('output') || normalized.includes('terminalinteraction'))) {
    return { kind: 'command-output', ...ids, text, params }
  }
  if (normalized === 'itemstarted' || normalized.endsWith('itemstarted')) {
    return { kind: 'item-started', ...ids, item: record.item ?? params, params }
  }
  if (normalized === 'itemcompleted' || normalized.endsWith('itemcompleted')) {
    return { kind: 'item-completed', ...ids, item: record.item ?? params, params }
  }
  if (normalized.includes('filechange')) return { kind: 'file-change', ...ids, item: record.item ?? params, params }
  return { kind: 'notification', method, params }
}

export function createCodexAppServerClient(options: CodexAppServerClientOptions): CodexAppServerClient {
  const requestTimeoutMs = options.requestTimeoutMs ?? 30_000
  const pending = new Map<CodexRequestId, PendingRequest>()
  const serverRequests = new Map<CodexRequestId, PendingServerRequest>()
  let nextId = 1
  let closed = false
  let closedError: Error | undefined
  let initializedSent = false
  let initializationPromise: Promise<CodexInitializeResult> | null = null

  const failPending = (error: Error) => {
    if (closed) return
    closed = true
    closedError = error
    for (const entry of pending.values()) {
      if (entry.timer) clearTimeout(entry.timer)
      entry.reject(error)
    }
    pending.clear()
    serverRequests.clear()
  }

  const emitEvent = (event: CodexAppServerEvent) => {
    try {
      switch (event.kind) {
        case 'thread-started': options.onThreadStarted?.(event); break
        case 'turn-started': options.onTurnStarted?.(event); break
        case 'turn-completed': options.onTurnCompleted?.(event); break
        case 'agent-message': options.onAgentMessage?.(event); break
        case 'reasoning': options.onReasoning?.(event); break
        case 'command-output': options.onCommandOutput?.(event); break
        case 'file-change': options.onFileChange?.(event); break
        case 'item-started': options.onItemStarted?.(event); break
        case 'item-completed': options.onItemCompleted?.(event); break
      }
    } catch (error) {
      options.onProtocolError?.(error instanceof Error ? error : new Error(String(error)))
    }
  }

  // The launcher historically exposes an ACP-style line transport. Adapt it
  // here so the Codex client can be introduced without changing that layer.
  const transport = options.transport as CodexAppServerTransportLike
  const onMessage = (handler: (message: CodexAppServerMessage) => void): void => {
    if ('onMessage' in transport) {
      transport.onMessage(handler)
      return
    }
    transport.onLine(line => {
      try {
        const parsed: unknown = JSON.parse(line)
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) handler(parsed as CodexAppServerMessage)
      } catch (error) {
        options.onProtocolError?.(error instanceof Error ? error : new Error(String(error)))
      }
    })
  }
  const onClose = (handler: (error?: Error) => void): void => transport.onClose(handler)

  const send = (message: CodexAppServerMessage) => {
    if (closed) throw closedError ?? new Error('Codex App Server 连接已关闭。')
    try {
      if ('onMessage' in options.transport) options.transport.send(message)
      else options.transport.send(JSON.stringify(message))
    } catch (error) {
      // A Writable stream can fail synchronously (for example after the
      // child closes stdin) before its `error` event reaches the transport.
      // Mark this client closed immediately so later turns cannot enqueue
      // requests on a dead app-server and all waiters are released.
      const normalized = error instanceof Error ? error : new Error(String(error))
      failPending(normalized)
      throw normalized
    }
  }

  const request = <T>(method: string, params?: unknown, timeoutMs = requestTimeoutMs): Promise<T> => {
    if (closed) return Promise.reject(closedError ?? new Error('Codex App Server 连接已关闭。'))
    const id = nextId++
    return new Promise<T>((resolve, reject) => {
      const timer = timeoutMs === 0 ? undefined : setTimeout(() => {
        pending.delete(id)
        reject(new Error(`Codex App Server 请求超时：${method}`))
      }, timeoutMs)
      pending.set(id, { resolve: value => resolve(value as T), reject, timer })
      try {
        send({ id, method, ...(params === undefined ? {} : { params }) })
      } catch (error) {
        if (timer) clearTimeout(timer)
        pending.delete(id)
        reject(error instanceof Error ? error : new Error(String(error)))
      }
    })
  }

  const respond = (requestId: CodexRequestId, result: unknown): void => {
    const serverRequest = serverRequests.get(requestId)
    // Responses are one-shot.  This also covers approvals that resolve after
    // a transport close, where `failPending` has already removed the request.
    if (!serverRequest || closed) return
    serverRequests.delete(requestId)
    if (serverRequest?.kind === 'permissions') {
      send({ id: requestId, result: normalizePermissionsResponse(result, requestedPermissionProfile(serverRequest.params)) })
      return
    }
    send({ id: requestId, result: serverRequest ? normalizeLegacyApprovalResponse(serverRequest.method, result) : result })
  }

  const handleApproval = async (message: CodexAppServerMessage): Promise<void> => {
    const method = String(message.method ?? '')
    const kind = codexApprovalKind(method)
    const params = asRecord(message.params)
    const ids = eventIds(params)
    const request: CodexApprovalRequest = {
      id: message.id as CodexRequestId,
      method,
      kind,
      threadId: ids.threadId,
      turnId: ids.turnId,
      itemId: ids.itemId,
      requestedPermissions: kind === 'permissions' ? requestedPermissionProfile(params) : undefined,
      params: message.params,
    }
    let decision: CodexApprovalDecision = 'decline'
    if (options.onApprovalRequest) {
      try {
        const candidate = await options.onApprovalRequest(request)
        // Keep runtime values fail-closed even when a JavaScript caller does
        // not honor the TypeScript union.
        decision = candidate === 'accept' || candidate === 'decline' || candidate === 'cancel'
          ? candidate
          : 'decline'
      } catch (error) {
        options.onProtocolError?.(error instanceof Error ? error : new Error(String(error)))
      }
    }
    try {
      respond(request.id, { decision })
    } catch (error) {
      options.onProtocolError?.(error instanceof Error ? error : new Error(String(error)))
    }
  }

  onMessage(message => {
    if (closed) return
    if (message.id !== undefined && (message.result !== undefined || message.error !== undefined)) {
      const entry = pending.get(message.id)
      if (!entry) return
      pending.delete(message.id)
      if (entry.timer) clearTimeout(entry.timer)
      if (message.error) {
        const error = new Error(message.error.message ?? `Codex App Server 请求失败（code ${message.error.code ?? '未知'}）。`)
        ;(error as Error & { code?: number; data?: unknown }).code = message.error.code
        ;(error as Error & { code?: number; data?: unknown }).data = message.error.data
        entry.reject(error)
      } else entry.resolve(message.result)
      return
    }
    if (message.id !== undefined && message.method) {
      // A malformed/duplicated server request must not start two handlers for
      // one protocol id.  The first response owns that id.
      if (serverRequests.has(message.id)) return
      const rawRequest: CodexServerRequest = {
        id: message.id,
        method: message.method,
        params: asRecord(message.params),
      }
      serverRequests.set(message.id, { method: message.method, kind: codexApprovalKind(message.method), params: rawRequest.params })
      if (options.onRequest) {
        // Start with a resolved promise so a synchronous throw from the
        // callback is captured as well (calling Promise.resolve(callback())
        // would throw before Promise.resolve gets a chance to handle it).
        void Promise.resolve().then(() => options.onRequest!(rawRequest)).catch(error => {
          options.onProtocolError?.(error instanceof Error ? error : new Error(String(error)))
          // A custom request handler owns successful responses, but a thrown
          // handler must not leave Codex waiting forever.  Avoid sending a
          // duplicate response when the handler already answered the request.
          if (serverRequests.has(message.id!)) {
            try {
              respondError(message.id!, -32603, error instanceof Error ? error.message : String(error))
            } catch (responseError) {
              options.onProtocolError?.(responseError instanceof Error ? responseError : new Error(String(responseError)))
            }
          }
        })
        return
      }
      const kind = codexApprovalKind(message.method)
      if (kind !== 'unknown') void handleApproval(message)
      else {
        const fallback = codexFallbackServerResponse(message.method, message.params)
        try {
          if (fallback?.result !== undefined) respond(message.id, fallback.result)
          else if (fallback?.error) respondError(message.id, fallback.error.code, fallback.error.message, fallback.error.data)
          else respondError(message.id, -32601, `Method not found: ${message.method}`)
        } catch (error) {
          options.onProtocolError?.(error instanceof Error ? error : new Error(String(error)))
        }
      }
      return
    }
    if (message.method) {
      // App Server emits this notification when it clears an unanswered
      // server request (for example on turn completion/interruption).  Drop
      // the local entry so a late approval callback cannot send a stale
      // response for a request the server has already forgotten.
      if (normalizedCodexMethod(message.method) === 'serverrequestresolved') {
        const resolvedId = requestIdField(asRecord(message.params), 'requestId', 'request_id')
        if (resolvedId !== undefined) serverRequests.delete(resolvedId)
      }
      const rawEvent: CodexServerEvent = { method: message.method, params: asRecord(message.params) }
      try { options.onEvent?.(rawEvent) } catch (error) {
        options.onProtocolError?.(error instanceof Error ? error : new Error(String(error)))
      }
      emitEvent(eventFromNotification(message.method, message.params))
    }
  })
  onClose(error => {
    failPending(error ?? new Error('Codex App Server 连接已关闭。'))
    options.onClose?.(error)
  })

  function respondError(requestId: CodexRequestId, code: number, message: string, data?: unknown): void {
    if (!serverRequests.has(requestId) || closed) return
    serverRequests.delete(requestId)
    send({ id: requestId, error: { code, message, ...(data === undefined ? {} : { data }) } })
  }

  const sendInitialized = (): Promise<void> => {
    if (initializedSent) return Promise.resolve()
    try {
      send({ method: 'initialized', params: {} })
      initializedSent = true
    } catch (error) {
      // `send` can fail synchronously when the child exits between the
      // initialize response and this notification.  Permit a caller to retry
      // after replacing the transport instead of permanently short-circuiting
      // `initialized()`.
      initializedSent = false
      throw error
    }
    return Promise.resolve()
  }

  const initialize = (): Promise<CodexInitializeResult> => {
    if (initializationPromise) return initializationPromise
    initializationPromise = request<CodexInitializeResult>('initialize', {
      clientInfo: options.clientInfo ?? { name: 'dsh-melody-launcher', version: '0.0.0', title: 'DSH Copilot' },
      capabilities: { experimentalApi: true, requestAttestation: false },
    }).then(async result => {
      await sendInitialized()
      return result
    }).catch(error => {
      initializationPromise = null
      throw error
    })
    return initializationPromise
  }

  return {
    initialize,
    initialized: sendInitialized,
    threadStart(cwd, threadOptions = {}) {
      const { additionalDirectories, runtimeWorkspaceRoots, ...rest } = threadOptions
      // `additionalDirectories` was used by an early prototype, but Codex's
      // app-server silently ignores it.  Translate it to the supported
      // runtimeWorkspaceRoots field while retaining the caller's cwd.
      const requestedRoots = runtimeWorkspaceRoots ?? additionalDirectories ?? []
      const roots = cwd
        ? [cwd, ...requestedRoots.filter(root => root !== cwd)]
        : [...requestedRoots]
      return request<CodexThreadStartResult>('thread/start', {
        ...rest,
        // Keep the positional cwd authoritative even when an older caller
        // passes it through the extensible options object.
        cwd,
        approvalPolicy: rest.approvalPolicy ?? 'on-request',
        // Keep the default conservative.  A workspace-write thread can apply
        // file changes without asking the host UI; read-only causes Codex to
        // route writes through item/fileChange/requestApproval instead.
        sandbox: rest.sandbox ?? 'read-only',
        ...(roots.length ? { runtimeWorkspaceRoots: roots } : {}),
      })
    },
    turnStart(threadId, text, turnOptions = {}) {
      const { input, additionalDirectories, runtimeWorkspaceRoots, ...rest } = turnOptions
      const requestedRoots = runtimeWorkspaceRoots ?? additionalDirectories ?? []
      const roots = turnOptions.cwd
        ? [turnOptions.cwd, ...requestedRoots.filter(root => root !== turnOptions.cwd)]
        : [...requestedRoots]
      // Current app-server schemas require `text_elements` on every text
      // input.  Older clients omitted it, but recent Codex builds reject the
      // whole turn when the field is absent, which can look like a stop after
      // the first tool call.  Callers may still provide richer input items;
      // only synthesize the required field for our string convenience API.
      const normalizedInput = input ?? [{ type: 'text', text, text_elements: [] }]
      return request<CodexTurnStartResult>('turn/start', {
        ...rest,
        // The method arguments are authoritative; do not let an unknown
        // extension field replace the target thread or prompt input.
        threadId,
        input: normalizedInput,
        approvalPolicy: rest.approvalPolicy ?? 'on-request',
        // Match the thread default so every write is visible to the host and
        // can be approved through the Copilot panel.
        sandboxPolicy: rest.sandboxPolicy ?? { type: 'readOnly', networkAccess: false },
        ...(roots.length ? { runtimeWorkspaceRoots: roots } : {}),
      })
    },
    turnInterrupt(threadId, turnId) {
      return request('turn/interrupt', { threadId, turnId })
    },
    interrupt(threadId, turnId) {
      return request('turn/interrupt', { threadId, turnId })
    },
    respond,
    respondError,
      respondToApproval(requestId, kind, decision) {
      // `respond` uses the original server request to shape permission
      // approvals; the `kind` argument remains for callers that track UI
      // state and for compatibility with the previous API.
      if (!serverRequests.has(requestId)) return
      respond(requestId, { decision })
    },
    request,
    close() {
      if (closed) return
      failPending(new Error('Codex App Server 连接已关闭。'))
      transport.close()
    },
  }
}
