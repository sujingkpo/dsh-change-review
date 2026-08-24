/**
 * diff-review host half: observes write/edit tool executions and serves the
 * modification-review payloads over plain HTTP routes for the browser UI.
 * Records are bucketed by the owning agent/session so each session reviews
 * only its own changes. Loaded as a static row in the web profile composition.
 *
 * Revert support: every op records the full before/after file content that the
 * write/edit tool reports, so the UI can either undo ONE specific op (keeping
 * later, non-overlapping changes via a 3-way line merge) or revert the WHOLE
 * file (restore the pre-session snapshot, or delete a file created in-session).
 *
 * @author chenzhenyao / cirelir
 * @date 2026-08-21
 * @modify 2026-08-21 edit 预览行号修复：diff 改用工具返回的完整前后快照
 *                    （before/after）计算，行号即真实文件行号；入参片段
 *                    old_string/new_string 仅作升级前旧记录的回退。
 * @modify 2026-08-21 文件修改记录倒序：buildSections 输出前 reverse，
 *                    最后修改的记录显示在最上方（file / turn 接口统一生效）。
 * @modify 2026-08-21 全文件 diff 折叠：新增 compactHunks，仅保留变更行前后
 *                    各 2 行上下文，其余无变化行折叠为「省略 N 行」标记，
 *                    避免大文件小改动时整文件堆满视野（纯新增/删除不折叠）。
 * @modify 2026-08-21 write 覆盖已有文件时也展示前后 diff：抽出 buildSnapshotHunks
 *                    供 edit / write 共用，快照非空即折叠未修改行并给出真实行号；
 *                    仅新建（before===null）或旧记录（无快照）整体展开内容。
 * @modify 2026-08-21 修复「纯新增不折叠」误伤：compactHunks 原先对只有 add 无 del
 *                    的编辑（如文件末尾追加行）误判为整文件新增而不折叠，导致显示
 *                    全部内容；现改为仅当 diff 无任何 ctx 行（整文件重写）才不折叠，
 *                    整文件新增/删除由调用方提前分流。
 * @modify 2026-08-21 新增版本对比：/diff-review/against 路由支持
 *                    mode=initial（会话最初版本 op[0].before）与 mode=git
 *                    （git show HEAD 版本），与工作区当前磁盘内容做折叠 diff。
 * @modify 2026-08-21 修复对比/快照 diff 全不匹配：buildSnapshotHunks 先统一
 *                    换行符（CRLF→LF），避免磁盘文件（CRLF）与快照（LF）
 *                    逐行比较全部失败，导致 diff 退化为整段删除+整段新增。
 * @modify 2026-08-21 修改记录展示轮次与问题：buildSections 对每个 section
 *                    附加 turn 与 question（questionOf 扫描会话日志取该轮
 *                    首个 user/message 文本，进程内缓存）；file/turn 路由传 rootId。
 * @modify 2026-08-21 修复问题不显示：user/message 的 data.content 是 ContentBlock
 *                    数组而非字符串，增加 textOfContent 提取；仅取 source.kind
 *                    === 'user' 的真实提问，跳过插件/压缩注入消息。
 * @modify 2026-08-21 修复 turn 接口问题为空：buildTurn 构建 sections 时补传
 *                    rootId（此前漏传导致 questionOf 查空会话日志）。
 * @modify 2026-08-21 turn 接口文件项补充 turns 字段（该文件涉及的轮次），
 *                    修复审查列表文件行「第 N 轮」徽章不显示。
 */
import { readFile, unlink, writeFile } from 'node:fs/promises'
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { execSync, execFileSync } from 'node:child_process'
import { dirname, join, resolve as resolvePath } from 'node:path'
import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'

const MAX_CHARS = 120000
const MAX_OPS = 100
const MAX_LINES = 1500
const MAX_MERGE_LINES = 2000

const name = 'diff-review'
const inject = ['webServer', 'agents']

function cap(s) {
  if (typeof s !== 'string') s = s == null ? '' : String(s)
  return s.slice(0, MAX_CHARS)
}

function splitLines(s) {
  if (s === '') return []
  return s.split('\n')
}

/** Simple LCS line diff -> [{ type: 'ctx'|'del'|'add', a, b, text }] */
function diffLines(a, b) {
  const n = a.length
  const m = b.length
  const w = m + 1
  const dp = new Int32Array((n + 1) * w)
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      const eq = a[i] === b[j]
      dp[i * w + j] = eq
        ? dp[(i + 1) * w + j + 1] + 1
        : Math.max(dp[(i + 1) * w + j], dp[i * w + j + 1])
    }
  }
  const out = []
  let pending = []
  function flush() {
    for (const h of pending) out.push(h)
    pending = []
  }
  let i = 0
  let j = 0
  let aNo = 1
  let bNo = 1
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      pending.push({ type: 'ctx', a: aNo, b: bNo, text: a[i] })
      i++; j++; aNo++; bNo++
    } else if (dp[(i + 1) * w + j] >= dp[i * w + j + 1]) {
      flush()
      out.push({ type: 'del', a: aNo, b: null, text: a[i] })
      i++; aNo++
    } else {
      flush()
      out.push({ type: 'add', a: null, b: bNo, text: b[j] })
      j++; bNo++
    }
  }
  flush()
  while (i < n) { out.push({ type: 'del', a: aNo, b: null, text: a[i] }); i++; aNo++ }
  while (j < m) { out.push({ type: 'add', a: null, b: bNo, text: b[j] }); j++; bNo++ }
  return out
}

/** 每个变更块前后保留的上下文行数 */
const DIFF_CTX = 2

/**
 * 压缩全文件 diff：只保留变更行及其前后各 DIFF_CTX 行上下文，
 * 其余大量无变化行折叠为一个「省略 N 行」标记，避免整文件堆满视野。
 * 整文件全重写（LCS 无匹配、无任何 ctx 行）时不折叠 —— 所有行都是改动；
 * 整文件新增 / 整文件删除由调用方在构建时提前分流，不会进入这里。
 */
function compactHunks(rows) {
  const hasCtx = rows.some((r) => r.type === 'ctx')
  if (!hasCtx) return rows
  const keep = new Array(rows.length).fill(false)
  for (let i = 0; i < rows.length; i++) {
    if (rows[i].type === 'ctx') continue
    for (let k = Math.max(0, i - DIFF_CTX); k <= Math.min(rows.length - 1, i + DIFF_CTX); k++) keep[k] = true
  }
  const out = []
  let prev = -1
  for (let i = 0; i < rows.length; i++) {
    if (!keep[i]) continue
    if (prev >= 0 && i - prev > 1) {
      out.push({ type: 'skip', count: i - prev - 1 })
    } else if (prev < 0 && i > 0) {
      // 文件头部被跳过的无变化行也给出省略提示
      out.push({ type: 'skip', count: i })
    }
    out.push(rows[i])
    prev = i
  }
  // 文件尾部被跳过的无变化行
  if (prev >= 0 && rows.length - 1 - prev > 0) out.push({ type: 'skip', count: rows.length - 1 - prev })
  return out
}

/**
 * 基于完整前后快照构建 diff 行：截断超长内容、折叠无变化上下文。
 * before === null 表示会话中新建文件（视为空旧内容，输出全量新增）。
 */
function buildSnapshotHunks(before, after) {
  // 统一换行符：工具返回的快照通常 LF，而磁盘文件可能是 CRLF；
  // 不归一化会导致逐行比较全部不匹配（无上下文行可折叠，diff 退化为整段删除+整段新增）。
  const norm = (s) => String(s).replace(/\r\n?/g, '\n')
  let oldL = splitLines(norm(before === null ? '' : before))
  let newL = splitLines(norm(after))
  let truncated = false
  if (oldL.length > MAX_LINES || newL.length > MAX_LINES) {
    truncated = true
    oldL = oldL.slice(0, MAX_LINES)
    newL = newL.slice(0, MAX_LINES)
  }
  let hunks
  if (oldL.length === 0) hunks = newL.map((t, k) => ({ type: 'add', a: null, b: k + 1, text: t }))
  else if (newL.length === 0) hunks = oldL.map((t, k) => ({ type: 'del', a: k + 1, b: null, text: t }))
  else hunks = compactHunks(diffLines(oldL, newL))
  return { hunks, truncated }
}

/**
 * Line diff returning hunks [{a0,a1,b0,b1}]: lines a[a0..a1) are replaced by
 * b[b0..b1). Consecutive del/add runs are grouped into a single hunk.
 */
function diffHunks(a, b) {
  const n = a.length
  const m = b.length
  const w = m + 1
  const dp = new Int32Array((n + 1) * w)
  for (let i = n - 1; i >= 0; i--) {
    const row = i * w
    const next = (i + 1) * w
    for (let j = m - 1; j >= 0; j--) {
      dp[row + j] = a[i] === b[j] ? dp[next + j + 1] + 1 : Math.max(dp[next + j], dp[row + j + 1])
    }
  }
  const hunks = []
  let i = 0
  let j = 0
  let a0 = -1
  let a1 = -1
  let b0 = -1
  let b1 = -1
  const close = () => {
    if (a0 >= 0) hunks.push({ a0, a1, b0, b1 })
    a0 = -1
  }
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      close(); i++; j++
    } else if (dp[(i + 1) * w + j] >= dp[i * w + j + 1]) {
      if (a0 < 0) { a0 = i; b0 = j }
      a1 = i + 1
      b1 = j
      i++
    } else {
      if (a0 < 0) { a0 = i; b0 = j }
      a1 = i
      b1 = j + 1
      j++
    }
  }
  close()
  if (i < n) {
    const prev = hunks[hunks.length - 1]
    if (prev && prev.a1 === i && prev.b1 === m) prev.a1 = n
    else hunks.push({ a0: i, a1: n, b0: m, b1: m })
  } else if (j < m) {
    const prev = hunks[hunks.length - 1]
    if (prev && prev.a1 === n && prev.b1 === j) prev.b1 = m
    else hunks.push({ a0: n, a1: n, b0: j, b1: m })
  }
  return hunks
}

/**
 * 3-way line merge: start from `base`, keep `ours`' changes, apply
 * `theirs`' changes. Throws when both touch the same base lines.
 */
function merge3(base, ours, theirs) {
  const ho = diffHunks(base, ours)
  const ht = diffHunks(base, theirs)
  for (const o of ho) {
    for (const t of ht) {
      if (o.a0 < t.a1 && t.a0 < o.a1) {
        throw new Error('该项修改与之后的修改有重叠，无法单独撤回；可尝试撤回整个文件，或从最后一项开始逐项撤回')
      }
    }
  }
  const items = []
  for (const h of ho) items.push({ h, src: ours })
  for (const h of ht) items.push({ h, src: theirs })
  items.sort((x, y) => x.h.a0 - y.h.a0)
  const out = []
  let pos = 0
  for (const it of items) {
    const h = it.h
    for (let k = pos; k < h.a0; k++) out.push(base[k])
    for (let k = h.b0; k < h.b1; k++) out.push(it.src[k])
    pos = h.a1
  }
  for (let k = pos; k < base.length; k++) out.push(base[k])
  return out
}

/** Collect a JSON request body (capped at 1MB). */
function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let data = ''
    let tooBig = false
    req.on('data', (chunk) => {
      if (tooBig) return
      data += chunk
      if (data.length > 1e6) {
        tooBig = true
        reject(new Error('请求体过大'))
      }
    })
    req.on('end', () => {
      if (tooBig) return
      if (!data) return resolve({})
      try {
        resolve(JSON.parse(data))
      } catch (e) {
        reject(new Error('请求体不是有效的 JSON'))
      }
    })
    req.on('error', reject)
  })
}

/** Restore a file: null content deletes it (was created in-session), string rewrites it. */
async function applyRestore(absPath, content) {
  if (content === null) {
    try {
      await unlink(absPath)
    } catch (e) {
      if (!(e && e.code === 'ENOENT')) throw e
    }
  } else {
    await writeFile(absPath, content, 'utf8')
  }
}

function sendJson(res, status, body) {
  res.statusCode = status
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.end(JSON.stringify(body))
}

// ── persistence: review records survive dsh web restarts ──────────────
// State lives next to the profile config (ctx.baseUrl), e.g.
// ~/.dsh/profiles/web/diff-review-state.json; fall back to ~/.dsh.
const STATE_FILE_NAME = 'diff-review-state.json'

function stateFilePath(ctx) {
  try {
    if (ctx && ctx.baseUrl) return fileURLToPath(new URL(STATE_FILE_NAME, ctx.baseUrl))
  } catch (e) {}
  return join(homedir(), '.dsh', STATE_FILE_NAME)
}

function serializeSessions(sessions) {
  const out = { version: 1, savedAt: Date.now(), sessions: {} }
  for (const [sid, files] of sessions) {
    if (!files || files.size === 0) continue
    const fileOut = {}
    for (const [path, rec] of files) {
      if (!rec || !Array.isArray(rec.ops) || rec.ops.length === 0) continue
      fileOut[path] = { path: rec.path, cwd: rec.cwd, ops: rec.ops }
    }
    if (Object.keys(fileOut).length > 0) out.sessions[sid] = { files: fileOut }
  }
  return out
}

function loadSessions(sessions, file) {
  let raw
  try {
    raw = readFileSync(file, 'utf8')
  } catch (e) {
    return
  }
  try {
    const data = JSON.parse(raw)
    if (!data || data.version !== 1 || !data.sessions || typeof data.sessions !== 'object') return
    for (const [sid, s] of Object.entries(data.sessions)) {
      if (!s || !s.files || typeof s.files !== 'object') continue
      const files = new Map()
      for (const [path, rec] of Object.entries(s.files)) {
        if (!rec || !Array.isArray(rec.ops)) continue
        const ops = rec.ops.filter((op) => op && (op.kind === 'edit' || op.kind === 'write'))
        if (ops.length === 0) continue
        files.set(path, { path: rec.path || path, cwd: typeof rec.cwd === 'string' ? rec.cwd : undefined, ops })
      }
      if (files.size > 0) sessions.set(sid, files)
    }
  } catch (e) {
    // corrupt state file: ignore and start fresh
  }
}

function persistState(sessions, file) {
  try {
    mkdirSync(dirname(file), { recursive: true })
    writeFile(file, JSON.stringify(serializeSessions(sessions)), 'utf8').catch(() => {})
  } catch (e) {}
}

function flushStateSync(sessions, file) {
  try {
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, JSON.stringify(serializeSessions(sessions)), 'utf8')
  } catch (e) {}
}

function apply(ctx) {
  // agent/session id -> path -> { path, cwd, ops }
  const sessions = new Map()
  const clients = new Set()
  // Persistence: load any previous process's records and keep them written so
  // the review survives dsh web restarts.
  const stateFile = stateFilePath(ctx)
  loadSessions(sessions, stateFile)
  let saveTimer = null
  function scheduleSave() {
    if (saveTimer) clearTimeout(saveTimer)
    saveTimer = setTimeout(() => {
      saveTimer = null
      persistState(sessions, stateFile)
    }, 800)
  }
  ctx.effect(() => () => {
    if (saveTimer) {
      clearTimeout(saveTimer)
      saveTimer = null
    }
    flushStateSync(sessions, stateFile)
  }, 'diff-review: persist flush')
  // session id -> { turn, scanSeq }; ops are tagged with the ROOT session's
  // current turn so the client can show per-turn reviews. The turn is derived
  // by scanning the session log tail (position-cached), which is self-consistent
  // and covers resumed sessions whose restored turn/start events never dispatch.
  const turnCursor = new Map()
  function currentTurnOf(rootId) {
    let cur = turnCursor.get(rootId)
    if (!cur) {
      cur = { turn: null, scanSeq: 0 }
      turnCursor.set(rootId, cur)
    }
    try {
      const entry = ctx.agents && ctx.agents.store && ctx.agents.store.get(rootId)
      const session = entry && entry.agent && entry.agent.session
      const events = session && session.events
      if (events && Array.isArray(events) && events.length > cur.scanSeq) {
        const from = cur.scanSeq
        cur.scanSeq = events.length
        for (let i = events.length - 1; i >= from; i--) {
          const e = events[i]
          if (e.type === 'turn/start') { cur.turn = e.data && e.data.turn; break }
          if (e.type === 'turn/end') { cur.turn = null; break }
        }
      }
    } catch (e) {}
    return cur.turn === null ? 0 : cur.turn
  }

  // 每轮用户问题：从会话日志扫出该轮（turn/start 到 turn/end 间）第一条
  // 真实用户 user/message 的文本，供修改记录展示；带进程内缓存。
  const turnQuestionCache = new Map()
  // user/message 的 data.content 可能是字符串，也可能是 ContentBlock 数组（text 块）
  function textOfContent(c) {
    if (typeof c === 'string') return c
    if (Array.isArray(c)) {
      return c.map((b) => (typeof b === 'string' ? b : (b && typeof b.text === 'string' ? b.text : ''))).join('')
    }
    if (c && typeof c.text === 'string') return c.text
    return ''
  }
  function questionOf(rootId, turnNo) {
    const key = rootId + ':' + turnNo
    if (turnQuestionCache.has(key)) return turnQuestionCache.get(key)
    let q = ''
    try {
      const entry = ctx.agents && ctx.agents.store && ctx.agents.store.get(rootId)
      const session = entry && entry.agent && entry.agent.session
      const events = session && session.events
      if (Array.isArray(events)) {
        let inTurn = false
        for (let i = 0; i < events.length; i++) {
          const e = events[i]
          if (e.type === 'turn/start') { inTurn = (e.data && e.data.turn) === turnNo }
          else if (e.type === 'turn/end') { if (inTurn) break }
          else if (inTurn && e.type === 'user/message') {
            const d = e.data || {}
            // 只要用户真实提问，跳过插件/压缩/目标等注入的 user/message
            if (d.source && d.source.kind && d.source.kind !== 'user') continue
            const t = textOfContent(d.content || (d.message && d.message.content)) || ''
            if (t.trim()) { q = t.trim().slice(0, 120); break }
          }
        }
      }
    } catch (e) {}
    turnQuestionCache.set(key, q)
    return q
  }

  function filesOf(agentId) {
    let files = sessions.get(agentId)
    if (!files) { files = new Map(); sessions.set(agentId, files) }
    return files
  }

  function broadcast(agentId) {
    const payload = 'data: ' + JSON.stringify({ session: agentId }) + '\n\n'
    for (const res of clients) {
      try { res.write(payload) } catch (e) { clients.delete(res) }
    }
  }

  // Walk the live owner chain up to the root session so subagent changes
  // aggregate into the top-level parent session the user views.
  function resolveRootId(agentId) {
    const store = ctx.agents && ctx.agents.store
    if (!store) return agentId
    let current = store.get(agentId)
    if (!current) return agentId
    const seen = new Set()
    while (current.owner) {
      const oid = current.owner.id
      if (!oid || seen.has(oid)) break
      seen.add(oid)
      const next = store.get(oid)
      if (!next) break
      current = next
    }
    return current.agent ? current.agent.id : agentId
  }

  ctx.on('tools/result', (exec, result) => {
    try {
      if (!exec) return
      const toolName = exec.tool || exec.name
      if (toolName !== 'write' && toolName !== 'edit') return
      const input = exec.input || exec.arguments || exec.args
      if (!input || typeof input !== 'object') return
      const file = input.file_path || input.file || input.path
      if (!file) return
      const agentId = exec.agent && exec.agent.id
      if (!agentId) return
      const failed = result && (result.isError || result.error || result.ok === false || result.failed)
      if (failed) return
      const rootId = resolveRootId(agentId)
      const at = Date.now()
      const turn = currentTurnOf(rootId)
      const files = filesOf(rootId)
      let rec = files.get(file)
      if (!rec) {
        const cwd = exec.agent && exec.agent.session && exec.agent.session.header && exec.agent.session.header.cwd
        rec = { path: file, cwd, ops: [] }
        files.set(file, rec)
      }
      if (rec.ops.length >= MAX_OPS) rec.ops.shift()
      // The write/edit success payload carries the full before/after content,
      // which is exactly what revert needs. before === null -> file created.
      const value = result && !result.isError && result.value && typeof result.value === 'object' ? result.value : null
      const hasBefore = value !== null && 'before' in value
      const hasAfter = value !== null && 'after' in value
      const before = hasBefore ? (value.before === null ? null : cap(value.before)) : undefined
      const after = hasAfter ? cap(value.after) : undefined
      if (toolName === 'edit') {
        rec.ops.push({ kind: 'edit', at, turn, before, after, oldString: cap(input.old_string), newString: cap(input.new_string) })
      } else {
        rec.ops.push({ kind: 'write', at, turn, before, after, content: cap(input.content) })
      }
      broadcast(rootId)
      scheduleSave()
    } catch (e) {
      console.error('diff-review track failed', e)
    }
  })

  function buildSummary(files) {
    const items = []
    for (const rec of files.values()) {
      let added = 0
      let removed = 0
      let writes = 0
      let edits = 0
      for (const op of rec.ops) {
        if (op.kind === 'edit') {
          edits++
          added += splitLines(op.newString).length
          removed += splitLines(op.oldString).length
        } else {
          writes++
          added += splitLines(op.content).length
        }
      }
      const last = rec.ops[rec.ops.length - 1]
      // 该文件是否支持「撤回全部改回首次修改前」：首个 op 记录了修改前快照
      const first = rec.ops[0]
      // 收集该文件被修改的轮次（turn>0 去重排序），供 UI 标注“第几轮变更”
      const turns = []
      for (const op of rec.ops) {
        if (typeof op.turn === 'number' && op.turn > 0 && !turns.includes(op.turn)) turns.push(op.turn)
      }
      turns.sort((x, y) => x - y)
      items.push({
        path: rec.path,
        name: String(rec.path).split('/').pop(),
        cwd: rec.cwd,
        ops: rec.ops.length,
        writes,
        edits,
        added,
        removed,
        turn: last && typeof last.turn === 'number' ? last.turn : 0,
        turns,
        revertible: !!(first && first.before !== undefined),
        lastTime: last ? last.at : 0
      })
    }
    items.sort((x, y) => y.lastTime - x.lastTime)
    let latestTurn = 0
    for (const rec of files.values()) {
      for (const op of rec.ops) {
        if (typeof op.turn === 'number' && op.turn > latestTurn) latestTurn = op.turn
      }
    }
    return { files: items, latestTurn }
  }

  // Build one section per op; 'indices' selects which ops (opIndex is the index
  // into the FULL ops array so /diff-review/revert stays valid).
  function buildSections(ops, indices, rootId) {
    const sections = []
    for (const i of indices) {
      const op = ops[i]
      let section
      if (op.kind === 'edit') {
        // 优先使用工具返回值携带的完整前后快照（before/after）计算 diff：
        // 这样 gutter 行号就是真实文件行号；入参 old_string/new_string 只是
        // 被替换的片段，用它算出的行号与文件实际位置不符。before === null
        // 表示会话中新建文件；快照缺失（升级前的旧记录）回退到入参片段。
        let built
        if (op.before !== undefined && op.after !== undefined) {
          built = buildSnapshotHunks(op.before, op.after)
        } else {
          const oldL = splitLines(op.oldString)
          const newL = splitLines(op.newString)
          let truncated = false
          if (oldL.length > MAX_LINES || newL.length > MAX_LINES) truncated = true
          const o = oldL.slice(0, MAX_LINES)
          const n = newL.slice(0, MAX_LINES)
          let hunks
          if (o.length === 0) hunks = n.map((t, k) => ({ type: 'add', a: null, b: k + 1, text: t }))
          else if (n.length === 0) hunks = o.map((t, k) => ({ type: 'del', a: k + 1, b: null, text: t }))
          else hunks = diffLines(o, n)
          built = { hunks, truncated }
        }
        section = { kind: 'edit', at: op.at, hunks: built.hunks, truncated: built.truncated }
      } else {
        // write 覆盖已有文件（快照非空）时同样展示前后 diff（自动折叠）：
        // 一眼看到实际改动并隐藏未修改行；仅新建文件（before === null）
        // 或升级前旧记录（无快照）才整体展开内容。
        if (op.before !== undefined && op.before !== null) {
          const built = buildSnapshotHunks(op.before, op.after)
          section = { kind: 'write', at: op.at, wholeFile: true, truncated: built.truncated, hunks: built.hunks }
        } else {
          const all = splitLines(op.content)
          let lines = all
          let truncated = false
          if (all.length > MAX_LINES) { truncated = true; lines = all.slice(0, MAX_LINES) }
          section = {
            kind: 'write', at: op.at, wholeFile: true, truncated,
            hunks: lines.map((t, k) => ({ type: 'add', a: null, b: k + 1, text: t }))
          }
        }
      }
      const revertible = op.before !== undefined && op.after !== undefined
      section.opIndex = i
      section.revertible = revertible
      section.canUndo = revertible && (op.before !== null || i === ops.length - 1)
      // 所属轮次与该轮用户问题（供 diff 头部展示）
      section.turn = typeof op.turn === 'number' ? op.turn : 0
      section.question = section.turn > 0 ? questionOf(rootId || '', section.turn) : ''
      sections.push(section)
    }
    // 记录按时间先后入列，统一倒序输出：最后修改的记录排列在最上方
    return sections.reverse()
  }

  function statsOf(ops) {
    let added = 0
    let removed = 0
    let writes = 0
    let edits = 0
    for (const op of ops) {
      if (op.kind === 'edit') {
        edits++
        added += splitLines(op.newString).length
        removed += splitLines(op.oldString).length
      } else {
        writes++
        added += splitLines(op.content).length
      }
    }
    return { added, removed, writes, edits }
  }

  function buildDetail(files, file, rootId) {
    const rec = files.get(file)
    if (!rec) return { path: file, sections: [] }
    const ops = rec.ops
    const first = ops[0]
    return {
      path: file,
      sections: buildSections(ops, ops.map((_, i) => i), rootId),
      revertible: !!(first && first.before !== undefined)
    }
  }

  // ── 版本对比基准：会话最初版本 / Git HEAD 版本 ──────────────────────
  // 会话最初版本 = 会话首次修改前的内容快照（op[0].before）；null 表示会话中新建。
  function initialBaseOf(ops) {
    const first = ops && ops[0]
    if (!first || first.before === undefined) return { ok: false, reason: '该记录无初始版本快照（升级前的旧记录）' }
    return { ok: true, content: first.before === null ? '' : first.before, created: first.before === null }
  }
  // Git HEAD 版本内容：git show HEAD:<repo 相对路径>；失败（未跟踪/未提交等）返回原因。
  function gitHeadBase(absPath, cwd) {
    try {
      const root = execFileSync('git', ['-C', cwd || process.cwd(), 'rev-parse', '--show-toplevel'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
      if (!root) return { ok: false, reason: '文件不在 Git 仓库中' }
      const relAbs = resolvePath(absPath)
      const rel = relAbs.startsWith(resolvePath(root)) ? relAbs.slice(root.length).replace(/^[\\/]/, '') : absPath
      const out = execFileSync('git', ['-C', root, 'show', 'HEAD:' + rel.split('\\').join('/')], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
      return { ok: true, content: out }
    } catch (e) {
      return { ok: false, reason: '无法读取 Git 版本（文件未跟踪 / 尚未提交 / 不在仓库）' }
    }
  }

  // 与外部版本（会话最初 / Git HEAD）对比：基准内容 vs 当前磁盘内容，走同一套折叠 diff。
  async function handleAgainst(req, res) {
    try {
      const u = new URL(req.url, 'http://localhost')
      const session = u.searchParams.get('session') || ''
      const path = u.searchParams.get('path') || ''
      const mode = u.searchParams.get('mode') || 'initial'
      let files = sessions.get(session)
      if (!files) {
        const rootId = resolveRootId(session)
        if (rootId !== session && rootId) files = sessions.get(rootId)
      }
      const rec = files instanceof Map && path ? files.get(path) : null
      if (!rec) return sendJson(res, 200, { path, mode, sections: [], error: '未找到该文件的修改记录' })
      const absPath = resolvePath(rec.cwd || process.cwd(), path)
      let base = ''
      let baseLabel = ''
      if (mode === 'git') {
        const g = gitHeadBase(absPath, rec.cwd)
        if (!g.ok) return sendJson(res, 200, { path, mode, sections: [], error: g.reason })
        base = g.content
        baseLabel = 'Git HEAD 版本 ←→ 工作区当前内容'
      } else {
        const init = initialBaseOf(rec.ops)
        if (!init.ok) return sendJson(res, 200, { path, mode, sections: [], error: init.reason })
        base = init.content
        baseLabel = init.created ? '会话最初（会话中新建）←→ 当前内容' : '会话最初版本 ←→ 当前内容'
      }
      let current = ''
      try { current = await readFile(absPath, 'utf8') } catch (e) { current = '' }
      const built = buildSnapshotHunks(base, current)
      sendJson(res, 200, { path, mode, baseLabel, sections: [{ kind: 'edit', at: Date.now(), hunks: built.hunks, truncated: built.truncated }], revertible: false })
    } catch (e) {
      sendJson(res, 200, { path: '', mode: '', sections: [], error: '对比失败：' + String((e && e.message) || e) })
    }
  }

  // Per-turn payload: files with at least one op tagged to 'turn', with only
  // that turn's ops in the sections (opIndex still indexes the full ops array).
  function buildTurn(files, turn, rootId) {
    const items = []
    for (const rec of files.values()) {
      const indices = []
      for (let i = 0; i < rec.ops.length; i++) {
        if (rec.ops[i].turn === turn) indices.push(i)
      }
      if (indices.length === 0) continue
      const ops = indices.map((i) => rec.ops[i])
      const stats = statsOf(ops)
      const last = ops[ops.length - 1]
      // 该文件涉及的轮次（去重），供文件行「第 N 轮」徽章展示
      const turns = []
      for (const o of ops) { if (typeof o.turn === 'number' && o.turn > 0 && !turns.includes(o.turn)) turns.push(o.turn) }
      items.push({
        path: rec.path,
        name: String(rec.path).split('/').pop(),
        cwd: rec.cwd,
        ops: ops.length,
        writes: stats.writes,
        edits: stats.edits,
        added: stats.added,
        removed: stats.removed,
        lastTime: last ? last.at : 0,
        turns: turns,
        revertible: !!(rec.ops[0] && rec.ops[0].before !== undefined),
        sections: buildSections(rec.ops, indices, rootId)
      })
    }
    items.sort((x, y) => y.lastTime - x.lastTime)
    return { turn, files: items }
  }

  function queryParam(req, key) {
    return new URL(req.url, 'http://localhost').searchParams.get(key) || ''
  }

  async function handleRevert(req, res) {
    try {
      const u = new URL(req.url, 'http://localhost')
      const agentId = u.searchParams.get('session') || ''
      const files = sessions.get(agentId)
      const body = await readJsonBody(req)
      const path = body && typeof body.path === 'string' ? body.path : ''
      const opArg = body && body.op !== undefined && body.op !== null ? body.op : null
      if (!files || !files.has(path)) {
        return sendJson(res, 400, { ok: false, error: '未找到该文件的修改记录' })
      }
      const rec = files.get(path)
      const absPath = resolvePath(rec.cwd || process.cwd(), path)
      if (opArg === null) {
        // Whole-file revert: restore the state before the first recorded op.
        const first = rec.ops[0]
        if (!first) return sendJson(res, 400, { ok: false, error: '该文件没有可撤回的修改' })
        if (first.before === undefined) {
          return sendJson(res, 400, { ok: false, error: '该文件的首次修改未记录修改前内容（升级前产生的记录），无法撤回' })
        }
        await applyRestore(absPath, first.before)
        files.delete(path)
        broadcast(agentId)
        scheduleSave()
        return sendJson(res, 200, {
          ok: true, mode: 'file',
          message: first.before === null ? '已删除本次会话中新建的文件' : '已撤回该文件的全部修改'
        })
      }
      const op = Number(opArg)
      if (!Number.isInteger(op) || op < 0 || op >= rec.ops.length) {
        return sendJson(res, 400, { ok: false, error: '修改项索引无效' })
      }
      const target = rec.ops[op]
      if (target.before === undefined || target.after === undefined) {
        return sendJson(res, 400, { ok: false, error: '该项修改未记录内容快照（升级前产生的记录），无法撤回' })
      }
      if (op === rec.ops.length - 1) {
        // Undo the last op: exact snapshot restore (or delete a created file).
        await applyRestore(absPath, target.before)
      } else {
        // Undo a middle op: 3-way merge of current content with the op's inverse.
        if (target.before === null) {
          return sendJson(res, 400, { ok: false, error: '该项修改新建了文件且之后还有修改，无法单独撤回' })
        }
        const base = splitLines(target.after)
        const ours = splitLines(await readFile(absPath, 'utf8'))
        const theirs = splitLines(target.before)
        if (base.length > MAX_MERGE_LINES || ours.length > MAX_MERGE_LINES || theirs.length > MAX_MERGE_LINES) {
          return sendJson(res, 400, { ok: false, error: '文件过大，无法单独撤回该项' })
        }
        await writeFile(absPath, merge3(base, ours, theirs).join('\n'), 'utf8')
      }
      // The reverted op and everything after it no longer represent pending changes.
      rec.ops = rec.ops.slice(0, op)
      if (rec.ops.length === 0) files.delete(path)
      broadcast(agentId)
      scheduleSave()
      return sendJson(res, 200, { ok: true, mode: 'op', message: '已撤回该项修改（其后无冲突的修改已保留）' })
    } catch (e) {
      return sendJson(res, 400, { ok: false, error: String((e && e.message) || e) })
    }
  }

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/diff-review/events',
    handler: (req, res) => {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive'
      })
      res.write('retry: 3000\n\n')
      clients.add(res)
      req.on('close', () => clients.delete(res))
    }
  }), 'diff-review: events route')
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/diff-review/summary',
    handler: (req, res) => {
      const session = queryParam(req, 'session')
      let files = sessions.get(session)
      if (!files) {
        const rootId = resolveRootId(session)
        if (rootId !== session) files = sessions.get(rootId)
      }
      sendJson(res, 200, buildSummary(files || new Map()))
    }
  }), 'diff-review: summary route')
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/diff-review/file',
    handler: (req, res) => {
      const u = new URL(req.url, 'http://localhost')
      const session = u.searchParams.get('session') || ''
      const rootId = resolveRootId(session) || session
      let files = sessions.get(session)
      if (!files && rootId !== session) files = sessions.get(rootId)
      sendJson(res, 200, buildDetail(files || new Map(), u.searchParams.get('path') || '', rootId))
    }
  }), 'diff-review: file route')
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/diff-review/against',
    handler: handleAgainst
  }), 'diff-review: against route')
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/diff-review/turn',
    handler: (req, res) => {
      const u = new URL(req.url, 'http://localhost')
      const session = u.searchParams.get('session') || ''
      let files = sessions.get(session)
      if (!files) {
        const rootId = resolveRootId(session)
        if (rootId !== session) files = sessions.get(rootId)
      }
      const turn = Number(u.searchParams.get('turn'))
      sendJson(res, 200, buildTurn(files || new Map(), Number.isFinite(turn) ? turn : -1, resolveRootId(session) || session))
    }
  }), 'diff-review: turn route')
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/diff-review/clear',
    handler: (req, res) => {
      const agentId = queryParam(req, 'session')
      sessions.delete(agentId)
      broadcast(agentId)
      scheduleSave()
      sendJson(res, 200, { ok: true })
    }
  }), 'diff-review: clear route')
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/diff-review/revert',
    handler: handleRevert
  }), 'diff-review: revert route')

  // ── editor detection: list installed code editors for the file-open chooser ──
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/diff-review/editors',
    handler: (req, res) => {
      const editors = detectEditors()
      sendJson(res, 200, { editors })
    }
  }), 'diff-review: editors route')
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/diff-review/open-with-editor',
    handler: async (req, res) => {
      try {
        const body = await readJsonBody(req)
        const { editor, path: filePath, line, col } = body
        if (!editor || !filePath) {
          return sendJson(res, 400, { ok: false, error: '缺少 editor 或 path 参数' })
        }
        const eds = detectEditors()
        const ed = eds.find((e) => e.id === editor)
        if (!ed || !ed.detected) {
          return sendJson(res, 400, { ok: false, error: '编辑器 ' + editor + ' 未安装或未检测到' })
        }
        // Use the app-bundle executable path when the CLI is not in PATH,
        // so editors installed as .app still open via the real binary.
        let cmdBin = ed.command
        if (ed.execPaths) {
          const p = ed.execPaths.find((p) => existsSync(p))
          if (p) cmdBin = escapeShellArg(p)
        }
        let cmd = cmdBin
        if (ed.openTemplate) {
          const absPath = resolvePath(filePath)
          const quoted = escapeShellArg(absPath)
          cmd = ed.openTemplate
            .replace('{cmd}', cmdBin)
            .replace('{file}', quoted)
            .replace('{line}', line != null ? String(line) : '1')
            .replace('{col}', col != null ? String(col) : '1')
        } else {
          cmd += ' ' + escapeShellArg(filePath)
        }
        try {
          execSync(cmd, { timeout: 10000, stdio: 'ignore' })
          sendJson(res, 200, { ok: true })
        } catch (e) {
          sendJson(res, 500, { ok: false, error: '打开编辑器失败: ' + String((e && e.message) || e) })
        }
      } catch (e) {
        sendJson(res, 500, { ok: false, error: String((e && e.message) || e) })
      }
    }
  }), 'diff-review: open-with-editor route')
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/diff-review/reveal',
    handler: async (req, res) => {
      try {
        const body = await readJsonBody(req)
        const filePath = body && body.path
        if (!filePath) return sendJson(res, 400, { ok: false, error: '缺少 path 参数' })
        const abs = resolvePath(filePath)
        const platform = process.platform
        let cmd
        if (platform === 'darwin') cmd = 'open -R ' + escapeShellArg(abs)
        else if (platform === 'win32') cmd = 'explorer.exe /select,' + escapeShellArg(abs)
        else cmd = 'xdg-open ' + escapeShellArg(dirname(abs))
        execSync(cmd, { timeout: 10000, stdio: 'ignore' })
        sendJson(res, 200, { ok: true })
      } catch (e) {
        sendJson(res, 500, { ok: false, error: String((e && e.message) || e) })
      }
    }
  }), 'diff-review: reveal route')
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/diff-review/editor-icon/:id',
    handler: (req, res) => {
      try {
        const id = req.params && req.params.id
        if (!id) { res.statusCode = 400; res.end('missing id'); return; }
        const iconPath = getEditorIconPath(id)
        if (!iconPath) { res.statusCode = 404; res.end('not found'); return; }
        const iconPng = execSync('sips -s format png "' + iconPath.replace(/"/g, '\"') + '" --stdout 2>/dev/null', { timeout: 10000, stdio: ['pipe', 'pipe', 'pipe'] })
        res.statusCode = 200
        res.setHeader('Content-Type', 'image/png')
        res.setHeader('Cache-Control', 'max-age=86400')
        res.end(iconPng)
      } catch (e) {
        res.statusCode = 500
        res.end(String((e && e.message) || e))
      }
    }
  }), 'diff-review: editor-icon route')
}
/** helpers: check if a command is available or an app path exists */
function which(cmd) {
  try { execSync('which ' + cmd, { stdio: 'pipe' }); return true } catch (e) { return false }
}
function existsAny(paths) { return paths.some((p) => existsSync(p)) }

/** Detect installed code editors on this machine. */
function detectEditors() {
  const candidates = [
    // VS Code / forks
    { id: 'vscode', name: 'Visual Studio Code', command: 'code', openTemplate: '{cmd} --goto {file}:{line}:{col}', appPaths: ['/Applications/Visual Studio Code.app'], execPaths: ['/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code'], detected: which('code') || existsAny(['/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code']) },
    { id: 'vscode-insiders', name: 'VS Code Insiders', command: 'code-insiders', openTemplate: '{cmd} --goto {file}:{line}:{col}', appPaths: ['/Applications/Visual Studio Code - Insiders.app'], execPaths: ['/Applications/Visual Studio Code - Insiders.app/Contents/Resources/app/bin/code-insiders'], detected: which('code-insiders') || existsAny(['/Applications/Visual Studio Code - Insiders.app/Contents/Resources/app/bin/code-insiders']) },
    { id: 'vscodium', name: 'VSCodium', command: 'codium', openTemplate: '{cmd} --goto {file}:{line}:{col}', appPaths: ['/Applications/VSCodium.app'], execPaths: ['/Applications/VSCodium.app/Contents/Resources/app/bin/codium'], detected: which('codium') || existsAny(['/Applications/VSCodium.app/Contents/Resources/app/bin/codium']) },
    { id: 'cursor', name: 'Cursor', command: 'cursor', openTemplate: '{cmd} --goto {file}:{line}:{col}', appPaths: ['/Applications/Cursor.app'], execPaths: ['/Applications/Cursor.app/Contents/MacOS/Cursor'], detected: which('cursor') || existsAny(['/Applications/Cursor.app/Contents/MacOS/Cursor']) },
    { id: 'windsurf', name: 'Windsurf', command: 'windsurf', openTemplate: '{cmd} {file}', appPaths: ['/Applications/Windsurf.app'], execPaths: ['/Applications/Windsurf.app/Contents/MacOS/windsurf'], detected: which('windsurf') || existsAny(['/Applications/Windsurf.app/Contents/MacOS/windsurf']) },
    { id: 'zed', name: 'Zed', command: 'zed', openTemplate: '{cmd} {file}:{line}:{col}', appPaths: ['/Applications/Zed.app'], execPaths: ['/Applications/Zed.app/Contents/MacOS/zed'], detected: which('zed') || existsAny(['/Applications/Zed.app/Contents/MacOS/zed']) },
    // JetBrains
    { id: 'idea', name: 'IntelliJ IDEA Ultimate', command: 'idea', openTemplate: '{cmd} --line {line} {file}', appPaths: ['/Applications/IntelliJ IDEA.app'], execPaths: ['/Applications/IntelliJ IDEA.app/Contents/MacOS/idea'], detected: which('idea') || existsAny(['/Applications/IntelliJ IDEA.app/Contents/MacOS/idea']) },
    { id: 'idea-community', name: 'IntelliJ IDEA Community', command: 'idea', openTemplate: '{cmd} --line {line} {file}', appPaths: ['/Applications/IntelliJ IDEA CE.app'], execPaths: ['/Applications/IntelliJ IDEA CE.app/Contents/MacOS/idea'], detected: existsAny(['/Applications/IntelliJ IDEA CE.app/Contents/MacOS/idea']) },
    { id: 'pycharm', name: 'PyCharm Professional', command: 'pycharm', openTemplate: '{cmd} --line {line} {file}', appPaths: ['/Applications/PyCharm.app'], execPaths: ['/Applications/PyCharm.app/Contents/MacOS/pycharm'], detected: which('pycharm') || existsAny(['/Applications/PyCharm.app/Contents/MacOS/pycharm']) },
    { id: 'pycharm-ce', name: 'PyCharm Community', command: 'pycharm', openTemplate: '{cmd} --line {line} {file}', appPaths: ['/Applications/PyCharm CE.app'], execPaths: ['/Applications/PyCharm CE.app/Contents/MacOS/pycharm'], detected: existsAny(['/Applications/PyCharm CE.app/Contents/MacOS/pycharm']) },
    { id: 'webstorm', name: 'WebStorm', command: 'webstorm', openTemplate: '{cmd} --line {line} {file}', appPaths: ['/Applications/WebStorm.app'], execPaths: ['/Applications/WebStorm.app/Contents/MacOS/webstorm'], detected: which('webstorm') || existsAny(['/Applications/WebStorm.app/Contents/MacOS/webstorm']) },
    { id: 'goland', name: 'GoLand', command: 'goland', openTemplate: '{cmd} --line {line} {file}', appPaths: ['/Applications/GoLand.app'], execPaths: ['/Applications/GoLand.app/Contents/MacOS/goland'], detected: which('goland') || existsAny(['/Applications/GoLand.app/Contents/MacOS/goland']) },
    { id: 'datagrip', name: 'DataGrip', command: 'datagrip', openTemplate: '{cmd} --line {line} {file}', appPaths: ['/Applications/DataGrip.app'], execPaths: ['/Applications/DataGrip.app/Contents/MacOS/datagrip'], detected: which('datagrip') || existsAny(['/Applications/DataGrip.app/Contents/MacOS/datagrip']) },
    { id: 'phpstorm', name: 'PhpStorm', command: 'phpstorm', openTemplate: '{cmd} --line {line} {file}', appPaths: ['/Applications/PhpStorm.app'], execPaths: ['/Applications/PhpStorm.app/Contents/MacOS/phpstorm'], detected: which('phpstorm') || existsAny(['/Applications/PhpStorm.app/Contents/MacOS/phpstorm']) },
    { id: 'rubymine', name: 'RubyMine', command: 'rubymine', openTemplate: '{cmd} --line {line} {file}', appPaths: ['/Applications/RubyMine.app'], execPaths: ['/Applications/RubyMine.app/Contents/MacOS/rubymine'], detected: which('rubymine') || existsAny(['/Applications/RubyMine.app/Contents/MacOS/rubymine']) },
    { id: 'clion', name: 'CLion', command: 'clion', openTemplate: '{cmd} --line {line} {file}', appPaths: ['/Applications/CLion.app'], execPaths: ['/Applications/CLion.app/Contents/MacOS/clion'], detected: which('clion') || existsAny(['/Applications/CLion.app/Contents/MacOS/clion']) },
    { id: 'rustrover', name: 'RustRover', command: 'rustrover', openTemplate: '{cmd} --line {line} {file}', appPaths: ['/Applications/RustRover.app'], execPaths: ['/Applications/RustRover.app/Contents/MacOS/rustrover'], detected: which('rustrover') || existsAny(['/Applications/RustRover.app/Contents/MacOS/rustrover']) },
    // Android Studio
    { id: 'android-studio', name: 'Android Studio', command: 'studio', openTemplate: '{cmd} --line {line} {file}', appPaths: ['/Applications/Android Studio.app'], execPaths: ['/Applications/Android Studio.app/Contents/MacOS/studio'], detected: which('studio') || existsAny(['/Applications/Android Studio.app/Contents/MacOS/studio']) },
    { id: 'fleet', name: 'Fleet', command: 'fleet', openTemplate: '{cmd} {file}', appPaths: ['/Applications/Fleet.app'], execPaths: ['/Applications/Fleet.app/Contents/MacOS/fleet'], detected: which('fleet') || existsAny(['/Applications/Fleet.app/Contents/MacOS/fleet']) },
    // Apple
    { id: 'xcode', name: 'Xcode', command: 'xed', openTemplate: '{cmd} --line {line} {file}', appPaths: ['/Applications/Xcode.app'], execPaths: ['/Applications/Xcode.app/Contents/Developer/usr/bin/xed'], detected: which('xed') || existsAny(['/Applications/Xcode.app/Contents/Developer/usr/bin/xed']) },
    // Other macOS editors
    { id: 'sublime', name: 'Sublime Text', command: 'subl', openTemplate: '{cmd} {file}:{line}:{col}', appPaths: ['/Applications/Sublime Text.app'], execPaths: ['/Applications/Sublime Text.app/Contents/SharedSupport/bin/subl'], detected: which('subl') || existsAny(['/Applications/Sublime Text.app/Contents/SharedSupport/bin/subl']) },
    { id: 'bbedit', name: 'BBEdit', command: 'bbedit', openTemplate: '{cmd} {file}', appPaths: ['/Applications/BBEdit.app'], execPaths: ['/Applications/BBEdit.app/Contents/Helpers/bbedit_tool'], detected: which('bbedit') || existsAny(['/Applications/BBEdit.app/Contents/Helpers/bbedit_tool']) },
    { id: 'mate', name: 'TextMate', command: 'mate', openTemplate: '{cmd} {file}', appPaths: ['/Applications/TextMate.app'], execPaths: ['/Applications/TextMate.app/Contents/Resources/mate'], detected: which('mate') || existsAny(['/Applications/TextMate.app/Contents/Resources/mate']) },
    { id: 'nova', name: 'Nova', command: 'nova', openTemplate: '{cmd} {file}:{line}:{col}', appPaths: ['/Applications/Nova.app'], execPaths: ['/Applications/Nova.app/Contents/MacOS/nova'], detected: which('nova') || existsAny(['/Applications/Nova.app/Contents/MacOS/nova']) },
    { id: 'coteditor', name: 'CotEditor', command: 'cot', openTemplate: '{cmd} {file}', appPaths: ['/Applications/CotEditor.app'], execPaths: ['/Applications/CotEditor.app/Contents/MacOS/cot'], detected: which('cot') || existsAny(['/Applications/CotEditor.app/Contents/MacOS/cot']) },
    // Terminal editors
    { id: 'vim', name: 'Vim', command: 'vim', openTemplate: '{cmd} {file}', appPaths: [], execPaths: [], detected: which('vim') },
    { id: 'nvim', name: 'Neovim', command: 'nvim', openTemplate: '{cmd} {file}', appPaths: [], execPaths: [], detected: which('nvim') },
    { id: 'emacs', name: 'Emacs', command: 'emacs', openTemplate: '{cmd} {file}', appPaths: ['/Applications/Emacs.app'], execPaths: ['/Applications/Emacs.app/Contents/MacOS/emacs'], detected: which('emacs') || existsAny(['/Applications/Emacs.app/Contents/MacOS/emacs']) },
    { id: 'nano', name: 'nano', command: 'nano', openTemplate: '{cmd} {file}', appPaths: [], execPaths: [], detected: which('nano') },
    // macOS fallback
    { id: 'textedit', name: 'TextEdit', command: 'open', openTemplate: '{cmd} -a TextEdit {file}', appPaths: ['/System/Applications/TextEdit.app'], execPaths: [], detected: process.platform === 'darwin' },
  ]
  return candidates
}/** Find the first existing .icns icon file for an editor app bundle. */
function getEditorIconPath(editorId) {
  const eds = detectEditors()
  const ed = eds.find((e) => e.id === editorId)
  if (!ed || !ed.detected || !ed.appPaths || ed.appPaths.length === 0) return null
  for (const appPath of ed.appPaths) {
    if (!existsSync(appPath)) continue
    const resources = appPath + '/Contents/Resources'
    if (!existsSync(resources)) continue
    // Try Info.plist first
    const plist = appPath + '/Contents/Info.plist'
    try {
      const plistText = readFileSync(plist, 'utf8')
      const iconMatch = plistText.match(/<key>CFBundleIconFile<\/key>\s*<string>([^<]+)<\/string>/)
      if (iconMatch) {
        const iconName = iconMatch[1].replace(/\.icns$/i, '')
        const iconPath = resources + '/' + iconName + '.icns'
        if (existsSync(iconPath)) return iconPath
      }
    } catch (e) {}
    // Fallback: scan for .icns files
    try {
      const files = readdirSync(resources)
      const icns = files.find((f) => f.endsWith('.icns'))
      if (icns) return resources + '/' + icns
    } catch (e) {}
  }
  return null
}

function escapeShellArg(s) {
  return "'" + String(s).replace(/'/g, "'\\''") + "'"
}

export { apply, cap, diffHunks, diffLines, inject, loadSessions, merge3, name, serializeSessions, splitLines, stateFilePath }