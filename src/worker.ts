// The plugin's worker. Orca starts it on the panel's first request and transpiles this file when
// it loads, so there is no build step.
//
// Why a terminal: the plugin API has no filesystem and no environment methods, so the only way to
// touch Orca's saved environments is to run a small script inside a real shell.
//
// Three rules keep that channel honest:
// - one command at a time (a queue), because two sendText calls interleave and splice a line;
// - short typed lines (< ~180 chars): a long line can be truncated by the PTY, leaving the shell
//   waiting for a closing quote forever;
// - markers are printed as two literals (`printf '%s%s' 'A' 'B'`) so the terminal's echo of the
//   command never contains the marker itself and cannot be mistaken for the command's output.
import type { OrcaWorkerApi } from 'orca/worker'
import type { ConnectionTest, ServerEndpoint } from './protocol'

const TERMINAL_KEY = 'terminalId'
const WORKSPACE_KEY = 'workspaceId'
const TERMINAL_TITLE = 'server-endpoints'
const CHUNK = 120
const ATTEMPTS = 3
const LIST_TIMEOUT = 8000
const SET_TIMEOUT = 20000
const PROBE_TIMEOUT = 40000
const TEMP_PREFIX = '/tmp/orca-endpoint-editor'
const KEEP_BACKUPS = 10
const SHELL_READY_TIMEOUT = 6000
const TERMINAL_VISIBLE_TIMEOUT = 2500
const ACTIVATION_TIMEOUT = 5000
const SEND_ATTEMPTS = 3
const WORKSPACE_CANDIDATES = 2

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
const ENV_FILE = "os.path.expanduser('~/Library/Application Support/orca/orca-environments.json')"

function utf8(input: string): number[] {
  const out: number[] = []
  for (const char of input) {
    const cp = char.codePointAt(0) as number
    if (cp < 0x80) out.push(cp)
    else if (cp < 0x800) out.push(0xc0 | (cp >> 6), 0x80 | (cp & 0x3f))
    else if (cp < 0x10000) out.push(0xe0 | (cp >> 12), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f))
    else out.push(0xf0 | (cp >> 18), 0x80 | ((cp >> 12) & 0x3f), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f))
  }
  return out
}

function base64Encode(input: string): string {
  const bytes = utf8(input)
  let out = ''
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i]
    const b1 = i + 1 < bytes.length ? bytes[i + 1] : undefined
    const b2 = i + 2 < bytes.length ? bytes[i + 2] : undefined
    out += B64[b0 >> 2]
    out += B64[((b0 & 3) << 4) | ((b1 ?? 0) >> 4)]
    out += b1 === undefined ? '=' : B64[((b1 & 15) << 2) | ((b2 ?? 0) >> 6)]
    out += b2 === undefined ? '=' : B64[b2 & 63]
  }
  return out
}

function base64Decode(input: string): string {
  const clean = input.replace(/[^A-Za-z0-9+/]/g, '')
  const bytes: number[] = []
  let buffer = 0
  let bits = 0
  for (const char of clean) {
    buffer = (buffer << 6) | B64.indexOf(char)
    bits += 6
    if (bits >= 8) {
      bits -= 8
      bytes.push((buffer >> bits) & 0xff)
    }
  }
  const escaped = bytes.map((byte) => `%${byte.toString(16).padStart(2, '0')}`).join('')
  return decodeURIComponent(escaped)
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** An error whose message names what the person can do; callers surface it instead of a fallback. */
class ActionableError extends Error {}

function fail(message: string): Error {
  return new ActionableError(message)
}

function py(value: string): string {
  return JSON.stringify(value)
}

function token(): string {
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`
}

/** One shell command at a time: two typed lines in flight at once splice into one broken line. */
let queue: Promise<unknown> = Promise.resolve()

function serial<T>(task: () => Promise<T>): Promise<T> {
  const started = queue.then(task, task)
  queue = started.then(
    () => undefined,
    () => undefined
  )
  return started
}

async function terminalLines(orca: OrcaWorkerApi, terminalId: string, maxLines = 2000): Promise<string[]> {
  const read = (await orca.host.call('terminal.read', { terminalId, maxLines })) as { lines?: string[] }
  return Array.isArray(read?.lines) ? read.lines : []
}

async function localWorkspaces(orca: OrcaWorkerApi): Promise<
  { id: string; kind: string; name: string; path: string; branch: string | null; hostId: string | null }[]
> {
  const answer = (await orca.host.call('workspace.list', {})) as {
    workspaces?: { id: string; kind: string; name: string; path: string; branch: string | null; hostId: string | null }[]
  }
  const list = Array.isArray(answer?.workspaces) ? answer.workspaces : []
  return list.filter((workspace) => !workspace.hostId || workspace.hostId === 'local')
}

type LocalWorkspace = { id: string; kind: string; name: string; path: string; branch: string | null; hostId: string | null }
type ActiveContext = { branch: string; displayName: string; terminals: { id: string; title?: string }[] }

async function activeContext(orca: OrcaWorkerApi): Promise<ActiveContext | null> {
  const context = (await orca.host.call('workspace.readContext', {})) as ActiveContext | null
  return context ?? null
}

/** Whether Orca's active worktree is this workspace; a folder has no branch to compare. */
function matchesContext(workspace: LocalWorkspace, context: ActiveContext): boolean {
  return (
    workspace.name === context.displayName &&
    (workspace.branch === null || !context.branch || workspace.branch === context.branch)
  )
}

/** Set when this worker switched Orca to a local workspace, so the panel can say so once. */
let switchedTo: string | null = null

/** Reads the switch notice once: the panel shows it after the refresh that follows every operation. */
function takeSwitchNotice(): string | null {
  const name = switchedTo
  switchedTo = null
  return name ? `Orca переключилась на локальный workspace «${name}», чтобы открыть служебный шелл.` : null
}

/**
 * Switches Orca to a local workspace and waits for it to become the active worktree.
 *
 * Why: the file being edited belongs to this machine, so the helper shell has to run here, and
 * `terminal.sendText` only accepts terminals of the active worktree. A remote workspace would put
 * the shell on another host, where the same path is that host's own store.
 */
async function openLocalWorkspace(orca: OrcaWorkerApi, locals: LocalWorkspace[]): Promise<void> {
  const stored = await orca.storage.get(WORKSPACE_KEY)
  const remembered = typeof stored === 'string' ? locals.find((workspace) => workspace.id === stored) : undefined
  const chosen = remembered ?? locals.find((workspace) => workspace.kind === 'folder') ?? locals[0]
  await orca.host.call('workspace.open', { workspaceId: chosen.id })
  await orca.storage.set(WORKSPACE_KEY, chosen.id)
  const deadline = Date.now() + ACTIVATION_TIMEOUT
  while (Date.now() < deadline) {
    const context = await activeContext(orca)
    if (context && locals.some((workspace) => matchesContext(workspace, context))) {
      switchedTo = chosen.name
      return
    }
    await sleep(150)
  }
  throw fail(
    `Orca не переключилась на локальный workspace «${chosen.name}». Откройте его вручную и нажмите «Обновить».`
  )
}

/** The local workspaces to try, switching Orca to one when the active worktree is elsewhere. */
async function localWorktreeCandidates(orca: OrcaWorkerApi): Promise<LocalWorkspace[]> {
  const locals = await localWorkspaces(orca)
  if (locals.length === 0) {
    throw fail(
      'Не открыт ни один локальный workspace. Служебный шелл должен работать на этой машине, где Orca хранит файл окружений.'
    )
  }
  const context = await activeContext(orca)
  if (!context || !locals.some((workspace) => matchesContext(workspace, context))) {
    await openLocalWorkspace(orca, locals)
    return locals
  }
  const same = locals.filter((workspace) => matchesContext(workspace, context))
  return same.length > 0 ? same : locals
}

/** True when the terminal is listed in the active worktree, which is what `sendText` checks. */
async function terminalVisible(orca: OrcaWorkerApi, terminalId: string): Promise<boolean> {
  const context = await activeContext(orca)
  const terminals = Array.isArray(context?.terminals) ? context.terminals : []
  return terminals.some((terminal) => terminal.id === terminalId)
}

/** Types one line, honouring the host's `accepted` flag and naming the real cause when it refuses. */
async function typeLine(orca: OrcaWorkerApi, terminalId: string, text: string): Promise<void> {
  for (let attempt = 0; attempt < SEND_ATTEMPTS; attempt += 1) {
    let accepted = false
    try {
      const answer = (await orca.host.call('terminal.sendText', { terminalId, text, enter: true })) as {
        accepted?: boolean
      }
      accepted = answer?.accepted !== false
    } catch (thrown) {
      const message = thrown instanceof Error ? thrown.message : String(thrown)
      if (message.includes('outside the active worktree')) {
        throw fail(
          'Служебный терминал открыт не в активном workspace, поэтому Orca не принимает в него ввод. Переключитесь на локальный workspace этой машины и нажмите «Обновить».'
        )
      }
      if (message.includes('no active worktree')) {
        throw fail(
          'Orca не отдаёт активный worktree: либо активен workspace на удалённом сервере, либо ничего не открыто. Переключитесь на локальный проект этой машины и повторите.'
        )
      }
      throw thrown
    }
    if (accepted) return
    await sleep(150)
  }
  throw fail('Терминал не принял ввод: он ещё запускается или уже закрыт. Нажмите «Обновить».')
}

/** True when the shell answers a trivial command; a shell stuck in a quote continuation does not. */
async function shellReady(orca: OrcaWorkerApi, terminalId: string): Promise<boolean> {
  const mark = `ORCACHK${token()}`
  const expected = `${mark}-OK`
  await typeLine(orca, terminalId, `printf '%s%s\\n' '${mark}' '-OK'`)
  const deadline = Date.now() + SHELL_READY_TIMEOUT
  while (Date.now() < deadline) {
    await sleep(100)
    const lines = await terminalLines(orca, terminalId, 200)
    if (lines.some((line) => line.includes(expected))) return true
  }
  return false
}

/** Opens the helper terminal where Orca accepts input and proves it is listed there. */
async function createHelperTerminal(orca: OrcaWorkerApi, candidates: LocalWorkspace[]): Promise<string> {
  for (const workspace of candidates.slice(0, WORKSPACE_CANDIDATES)) {
    const created = (await orca.host.call('terminal.create', {
      workspaceId: workspace.id,
      title: TERMINAL_TITLE
    })) as { terminalId: string }
    if (!created?.terminalId) continue
    const deadline = Date.now() + TERMINAL_VISIBLE_TIMEOUT
    while (Date.now() < deadline) {
      if (await terminalVisible(orca, created.terminalId)) {
        await orca.storage.set(WORKSPACE_KEY, workspace.id)
        return created.terminalId
      }
      await sleep(120)
    }
  }
  throw fail(
    'Не удалось открыть служебный терминал в активном workspace. Переключитесь на локальный проект этой машины, а не на удалённый сервер, и повторите.'
  )
}

async function ensureTerminal(orca: OrcaWorkerApi): Promise<string> {
  const candidates = await localWorktreeCandidates(orca)
  const stored = await orca.storage.get(TERMINAL_KEY)
  // Only type into a terminal the host lists in the active worktree; an id from another workspace
  // would be refused by terminal.sendText, which is not a dead shell but the wrong terminal.
  if (typeof stored === 'string' && stored && (await terminalVisible(orca, stored))) {
    try {
      if (await shellReady(orca, stored)) return stored
    } catch (thrown) {
      // A refusal names the fix; keep it. Anything else means the terminal is gone: start a new one.
      if (thrown instanceof ActionableError) throw thrown
    }
  }
  const created = await createHelperTerminal(orca, candidates)
  await orca.storage.set(TERMINAL_KEY, created)
  if (await shellReady(orca, created)) return created
  // Keep the id: the next attempt reuses this terminal instead of opening one more.
  throw fail(
    `Служебный шелл не ответил за ${Math.round(SHELL_READY_TIMEOUT / 1000)} с. Терминал "${TERMINAL_TITLE}" оставлен открытым: если он завис, закройте его и нажмите «Обновить».`
  )
}

/**
 * Types one python script into the helper shell and returns what it printed between the markers.
 * The script travels as base64 in short chunks so no single typed line is long enough to be
 * truncated, and the shell decodes it with python itself (no base64 flavour differences).
 */
async function run(orca: OrcaWorkerApi, script: string, timeoutMs = SET_TIMEOUT): Promise<string> {
  return serial(async () => {
    const terminalId = await ensureTerminal(orca)
    const id = token()
    const begin = `ORCAENV${id}-BEGIN`
    const end = `ORCAENV${id}-END`
    const base = `${TEMP_PREFIX}-${id}`
    const encoded = base64Encode(script)

    const lines = [
      `printf '\\033]0;${TERMINAL_TITLE}\\007'`,
      `printf '%s%s\\n' 'ORCAENV${id}' '-BEGIN'`,
      `: > ${base}.b64`
    ]
    for (let i = 0; i < encoded.length; i += CHUNK) {
      lines.push(`printf '%s' '${encoded.slice(i, i + CHUNK)}' >> ${base}.b64`)
    }
    const runLines = [
      `python3 -c "import base64;open('${base}.py','wb').write(base64.b64decode(open('${base}.b64','rb').read()))"`,
      `python3 ${base}.py`,
      `rm -f ${base}.b64 ${base}.py`,
      `printf '%s%s\\n' 'ORCAENV${id}' '-END'`
    ]

    for (const line of lines) {
      await typeLine(orca, terminalId, line)
    }
    // Let the shell drain the typed-ahead lines: otherwise it renders the last echo and the
    // script's first output on one row, and a strict line parser loses the length marker.
    await sleep(80)
    for (const line of runLines) {
      await typeLine(orca, terminalId, line)
    }

    const deadline = Date.now() + timeoutMs
    let tail: string[] = []
    while (Date.now() < deadline) {
      await sleep(120)
      tail = await terminalLines(orca, terminalId)
      const text = tail.join('\n')
      const from = text.lastIndexOf(begin)
      const to = text.lastIndexOf(end)
      if (from >= 0 && to > from) return text.slice(from + begin.length, to)
    }
    await orca.storage.delete(TERMINAL_KEY)
    throw fail(
      `Служебный шелл не ответил за ${Math.round(timeoutMs / 1000)} с, поэтому его терминал сброшен. Последние строки:\n${tail
        .slice(-10)
        .join('\n')}`
    )
  })
}

const LIST_SCRIPT = [
  'import base64,json,os',
  `p=${ENV_FILE}`,
  'data=json.load(open(p))',
  'rows=[]',
  "for e in data.get('environments',[]) or []:",
  "    for ep in e.get('endpoints',[]) or []:",
  "        rows.append({'environmentId':e.get('id'),'name':e.get('name'),'endpointId':ep.get('id'),'endpoint':ep.get('endpoint'),'dependency':e.get('connectionDependency')})",
  "s=base64.b64encode(json.dumps(rows,separators=(',',':')).encode('utf-8')).decode('ascii')",
  "print('__LEN__ %d'%len(s))",
  `for i in range(0,len(s),64): print(s[i:i+64])`
].join('\n')

function decodeList(output: string): ServerEndpoint[] {
  const lengthMatch = output.match(/__LEN__\s*(\d+)/)
  if (!lengthMatch) throw fail(`Служебный шелл не напечатал маркер длины:\n${output.trim().slice(-300)}`)
  const expected = Number(lengthMatch[1])
  // Only whole base64 rows count: a row can carry a shell echo glued to the output, and echoes
  // always contain spaces, slashes, dots or hyphens that pure base64 cannot.
  const chunks = output
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => /^[A-Za-z0-9+/=]{32,}$/.test(line))
  const encoded = chunks.join('')
  if (!Number.isFinite(expected) || encoded.length !== expected) {
    throw fail(`Короткое чтение из служебного шелла: получено ${encoded.length} из ${expected} символов.`)
  }
  const rows = JSON.parse(base64Decode(encoded)) as {
    environmentId: string
    name: string
    endpointId: string
    endpoint: string
    dependency: string | null
  }[]
  const hostOf = (value: string): string => {
    try {
      return new URL(value).hostname
    } catch {
      return ''
    }
  }
  const portOf = (value: string): string => {
    try {
      const parsed = new URL(value)
      return parsed.port || (parsed.protocol === 'wss:' || parsed.protocol === 'https:' ? '443' : '80')
    } catch {
      return ''
    }
  }
  const endpoints = rows.map((row) => ({
    environmentId: String(row.environmentId ?? ''),
    name: String(row.name ?? '(unnamed)'),
    endpointId: String(row.endpointId ?? ''),
    endpoint: String(row.endpoint ?? ''),
    host: hostOf(String(row.endpoint ?? '')),
    port: portOf(String(row.endpoint ?? '')),
    dependency: row.dependency ?? null
  }))
  endpoints.sort((a, b) => a.name.localeCompare(b.name) || a.endpoint.localeCompare(b.endpoint))
  return endpoints
}

function setScript(environmentId: string, endpointId: string, host: string, port: string, scheme: string): string {
  return [
    'import glob,json,os,shutil,socket,time',
    `p=${ENV_FILE}`,
    `env_id=${py(environmentId)}`,
    `ep_id=${py(endpointId)}`,
    `host=${py(host)}`,
    `port=${py(port)}`,
    `scheme=${py(scheme)}`,
    'data=json.load(open(p))',
    'found=False',
    'old=None',
    'new=None',
    "for e in data.get('environments',[]) or []:",
    "    if e.get('id')!=env_id: continue",
    "    for ep in e.get('endpoints',[]) or []:",
    "        if ep.get('id')!=ep_id: continue",
    "        old=ep.get('endpoint') or ''",
    "        new=scheme+'://'+host+':'+port",
    "        ep['endpoint']=new",
    '        found=True',
    'if not found:',
    "    print('__ERR__ это окружение или адрес больше не сохранены')",
    'else:',
    "    shutil.copy(p,p+'.bak.%d'%int(time.time()))",
    "    open(p,'w').write(json.dumps(data,indent=2,ensure_ascii=False))",
    `    for stale in sorted(glob.glob(p+'.bak.*'))[:${-KEEP_BACKUPS}]: os.remove(stale)`,
    "    print('__OK__ '+str(old)+' -> '+str(new))",
    's=socket.socket()',
    's.settimeout(2.0)',
    'ok=False',
    'try:',
    '    s.connect((host,int(port)))',
    '    ok=True',
    'except Exception:',
    '    ok=False',
    'finally:',
    '    s.close()',
    "print('__RESULT__'+('1' if ok else '0'))"
  ].join('\n')
}

/** Opens a TCP connection to each target and prints one bit per target, in order. */
function probeScript(targets: { host: string; port: string }[]): string {
  return [
    'import json,socket',
    'from concurrent.futures import ThreadPoolExecutor',
    `targets=json.loads(${py(JSON.stringify(targets))})`,
    'def check(t):',
    '    s=socket.socket()',
    '    s.settimeout(2.0)',
    '    try:',
    "        s.connect((t['host'],int(t['port'])))",
    '        return True',
    '    except Exception:',
    '        return False',
    '    finally:',
    '        s.close()',
    'with ThreadPoolExecutor(max_workers=16) as pool:',
    '    results=list(pool.map(check,targets))',
    "print('__RESULT__'+''.join('1' if r else '0' for r in results))"
  ].join('\n')
}

function probeBits(output: string, expected: number): boolean[] | null {
  const match = output.match(/__RESULT__([01]+)/)
  if (!match || match[1].length !== expected) return null
  return match[1].split('').map((bit) => bit === '1')
}

/** Reads the JSON object that follows a marker on its line, tolerating a prompt before or after. */
function jsonAfter(output: string, marker: string): Record<string, unknown> | null {
  const at = output.indexOf(marker)
  if (at < 0) return null
  const rest = output.slice(at + marker.length)
  const newline = rest.indexOf('\n')
  const line = newline < 0 ? rest : rest.slice(0, newline)
  const start = line.indexOf('{')
  const stop = line.lastIndexOf('}')
  if (start < 0 || stop <= start) return null
  try {
    return JSON.parse(line.slice(start, stop + 1)) as Record<string, unknown>
  } catch {
    return null
  }
}

/**
 * Two questions, in order: does a WebSocket answer at this address (works on an unsaved draft),
 * and does the Orca runtime itself accept the connection (only meaningful once it is saved).
 */
function testScript(input: { name: string; host: string; port: string; scheme: string; applied: boolean }): string {
  return [
    'import base64,json,os,shlex,shutil,socket,ssl,subprocess',
    'nl=chr(13)+chr(10)',
    `host=${py(input.host)}`,
    `port=${py(input.port)}`,
    `scheme=${py(input.scheme)}`,
    `name=${py(input.name)}`,
    `applied=${input.applied ? 'True' : 'False'}`,
    "verdict='unknown'",
    "detail=''",
    's=socket.socket()',
    's.settimeout(3.0)',
    'try:',
    '    s.connect((host,int(port)))',
    "    if scheme=='wss':",
    '        s=ssl.create_default_context().wrap_socket(s,server_hostname=host)',
    "    key=base64.b64encode(os.urandom(16)).decode('ascii')",
    "    req=('GET / HTTP/1.1'+nl+'Host: '+host+':'+port+nl+'Upgrade: websocket'+nl+'Connection: Upgrade'+nl",
    "         +'Sec-WebSocket-Key: '+key+nl+'Sec-WebSocket-Version: 13'+nl+nl)",
    "    s.sendall(req.encode('ascii'))",
    "    data=s.recv(1024).decode('latin-1')",
    '    first=data.split(nl)[0].strip()',
    "    if ' 101 ' in first:",
    "        verdict='ok'",
    '        detail=first',
    '    else:',
    "        verdict='not-websocket'",
    "        detail=first or 'пустой ответ'",
    'except ssl.SSLError as e:',
    "    verdict='tls-error'",
    '    detail=str(e)[:140]',
    'except socket.timeout:',
    "    verdict='timeout'",
    "    detail='нет ответа за 3 с'",
    'except Exception as e:',
    "    verdict='refused'",
    '    detail=type(e).__name__',
    'finally:',
    '    try:',
    '        s.close()',
    '    except Exception:',
    '        pass',
    "print('__WS__'+json.dumps({'verdict':verdict,'detail':detail.replace(chr(10),' ')}))",
    'if applied:',
    "    cli=os.environ.get('ORCA_CLI_COMMAND') or shutil.which('orca') or '/Applications/Orca.app/Contents/Resources/bin/orca'",
    '    try:',
    "        args=shlex.split(cli)+['repo','list','--environment',name,'--json']",
    '        p=subprocess.run(args,capture_output=True,text=True,timeout=25)',
    "        out=(p.stdout or '').strip()",
    "        d=json.loads(out) if out.startswith('{') else {}",
    "        if d.get('ok') is False:",
    "            err=d.get('error') or {}",
    "            print('__ORCA__'+json.dumps({'ok':False,'message':(err.get('code') or 'error')+': '+(err.get('message') or '')[:160]}))",
    "        elif d.get('ok') is True:",
    "            print('__ORCA__'+json.dumps({'ok':True,'message':'рантайм ответил'}))",
    '        else:',
    "            print('__ORCA__'+json.dumps({'ok':False,'message':('нет ответа: '+(out or p.stderr or ''))[:160].replace(chr(10),' ')}))",
    '    except Exception as e:',
    "        print('__ORCA__'+json.dumps({'ok':False,'message':type(e).__name__}))",
    'else:',
    "    print('__ORCA__'+json.dumps({'ok':None,'message':'сначала примени адрес'}))"
  ].join('\n')
}

function cleanHost(value: unknown): string {
  const host = String(value ?? '').trim()
  if (!/^[A-Za-z0-9._-]+$/.test(host)) throw fail(`"${host}" не похоже на имя хоста или адрес.`)
  return host
}

function cleanScheme(value: unknown): 'ws' | 'wss' {
  return value === 'wss' ? 'wss' : 'ws'
}

function cleanPort(value: unknown): number {
  const port = String(value ?? '').trim()
  const number = Number(port)
  if (!Number.isInteger(number) || number < 1 || number > 65535) {
    throw fail(`"${port}" не порт в диапазоне 1–65535.`)
  }
  return number
}

export default function activate(orca: OrcaWorkerApi): void {
  orca.panels.handle('endpoints.list', async () => {
    let lastError: unknown = null
    for (let attempt = 0; attempt < ATTEMPTS; attempt += 1) {
      let output: string
      try {
        output = await run(orca, LIST_SCRIPT, LIST_TIMEOUT)
      } catch (thrown) {
        lastError = thrown
        await sleep(200)
        continue
      }
      try {
        return { endpoints: decodeList(output), warning: takeSwitchNotice() }
      } catch (thrown) {
        lastError = thrown
        await sleep(200)
      }
    }
    throw fail((lastError as Error)?.message ?? 'Не удалось прочитать сохранённые окружения.')
  })

  orca.panels.handle('endpoints.set', async ({ environmentId, endpointId, host, port, scheme }) => {
    const target = cleanHost(host)
    const portNumber = cleanPort(port)
    const targetScheme = cleanScheme(scheme)
    const output = await run(
      orca,
      setScript(environmentId, endpointId, target, String(portNumber), targetScheme),
      SET_TIMEOUT
    )

    const rejected = output.match(/__ERR__\s*(.*)/)
    if (rejected) throw fail(rejected[1] || 'Этот адрес больше не сохранён.')
    const applied = output.match(/__OK__\s+(\S+)\s+->\s+(\S+)/)
    if (!applied) throw fail(`Правка не напечатала ничего пригодного:\n${output.trim().slice(-300)}`)

    const bits = probeBits(output, 1)
    const reachable = bits ? bits[0] : null
    return {
      ok: true,
      message:
        `${applied[1]} -> ${applied[2]}` +
        (reachable === true ? ' (port answers)' : reachable === false ? ' (nothing answers on that port yet)' : ''),
      endpoint: applied[2],
      reachable
    }
  })

  orca.panels.handle('endpoints.test', async ({ name, host, port, scheme, applied }) => {
    const target = cleanHost(host)
    const portNumber = cleanPort(port)
    const output = await run(
      orca,
      testScript({
        name: String(name ?? ''),
        host: target,
        port: String(portNumber),
        scheme: scheme === 'wss' ? 'wss' : 'ws',
        applied: applied === true
      }),
      45000
    )

    const ws = jsonAfter(output, '__WS__')
    const rawVerdict = typeof ws?.verdict === 'string' ? ws.verdict : ''
    const verdict: ConnectionTest['handshake'] = (
      ['ok', 'refused', 'not-websocket', 'tls-error', 'timeout'] as const
    ).find((known) => known === rawVerdict) ?? 'unknown'
    const orcaPart = jsonAfter(output, '__ORCA__')
    const orcaAnswer =
      orcaPart && orcaPart.ok === true
        ? { ok: true, message: String(orcaPart.message ?? '') }
        : orcaPart && orcaPart.ok === false
          ? { ok: false, message: String(orcaPart.message ?? '') }
          : null

    return {
      handshake: verdict,
      detail: String(ws?.detail ?? ''),
      orca: orcaAnswer,
      skipped: orcaAnswer ? null : String(orcaPart?.message ?? 'проверка через Orca не запускалась')
    }
  })

  orca.panels.handle('endpoints.probe', async ({ targets }) => {
    const list = (Array.isArray(targets) ? targets : [])
      .map((entry) => ({ host: String(entry?.host ?? '').trim(), port: String(entry?.port ?? '').trim() }))
      .filter((entry) => /^[A-Za-z0-9._-]+$/.test(entry.host) && /^\d+$/.test(entry.port))
      .slice(0, 64)
    if (list.length === 0) return { reachable: [] }
    const output = await run(orca, probeScript(list), PROBE_TIMEOUT)
    const bits = probeBits(output, list.length)
    if (!bits) throw fail(`Проверка портов не дала пригодного результата:\n${output.trim().slice(-200)}`)
    return { reachable: bits }
  })
}
