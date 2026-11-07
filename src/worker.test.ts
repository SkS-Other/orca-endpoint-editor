import { assert, mockHost, mountWorker, test } from 'orca/testing'
import * as workerModule from './worker'

type Workspace = { id: string; kind: string; name: string; path: string; branch: string | null; hostId: string | null }

type HarnessOptions = {
  ws?: string
  orca?: string
  lines?: string[]
  workspaces?: Workspace[]
  context?: { branch: string | null; displayName: string; terminals: { id: string }[] } | null
  sendText?: (params: { terminalId: string; text: string }) => { accepted: boolean }
  storage?: Record<string, unknown>
}

function harness(options: HarnessOptions = {}) {
  const sent: string[] = []
  const created: { workspaceId: string; title?: string }[] = []
  const opened: string[] = []
  const wsLine = options.ws ?? '__WS__{"verdict":"ok","detail":"HTTP/1.1 101 Switching Protocols"}'
  const orcaLine = options.orca ?? '__ORCA__{"ok":true,"message":"рантайм ответил"}'
  const payload = Buffer.from(
    JSON.stringify([
      {
        environmentId: 'env-dev',
        name: 'Dev/Linux',
        endpointId: 'ws-env-dev',
        endpoint: 'ws://192.0.2.10:40455',
        dependency: null
      }
    ])
  ).toString('base64')
  const chunks = payload.match(/.{1,64}/g) ?? []
  const workspaces: Workspace[] = options.workspaces ?? [
    { id: 'w1', kind: 'folder', name: 'ws', path: '/tmp/ws', branch: null, hostId: null }
  ]
  const context =
    options.context === undefined
      ? { branch: 'main', displayName: 'ws', terminals: [{ id: 'term-1' }] }
      : options.context
  let active = context
  const host = mockHost({
    capabilities: ['workspace:read', 'workspace:write', 'terminal:send', 'terminal:read', 'storage:own'],
    ...(options.storage ? { storage: options.storage } : {}),
    results: {
      'workspace.list': { workspaces, truncated: false },
      'workspace.readContext': () => active,
      'workspace.open': (params: { workspaceId: string }) => {
        opened.push(params.workspaceId)
        const target = workspaces.find((workspace) => workspace.id === params.workspaceId)
        active = {
          branch: target?.branch ?? 'main',
          displayName: target?.name ?? 'ws',
          terminals: [{ id: 'term-1' }]
        }
        return { opened: true }
      },
      'terminal.create': (params: { workspaceId: string; title?: string }) => {
        created.push(params)
        return { terminalId: 'term-1' }
      },
      'terminal.sendText':
        options.sendText ??
        ((params: { text: string }) => {
          sent.push(params.text)
          return { accepted: true }
        }),
      'terminal.read': () => {
        const last = sent[sent.length - 1] ?? ''
        const check = last.match(/'(ORCACHK[a-z0-9]+)'\s+'-OK'/)
        if (check) return { lines: [`${check[1]}-OK`], truncated: false }
        const end = last.match(/'(ORCAENV[a-z0-9]+)'\s+'-END'/)
        if (end) {
          return {
            lines: [
              `${end[1]}-BEGIN`,
              ...(options.lines ?? [`__LEN__ ${payload.length}`, ...chunks, wsLine, orcaLine]),
              `${end[1]}-END`
            ],
            truncated: false
          }
        }
        return { lines: [], truncated: false }
      }
    }
  })
  return { host, sent, created, opened }
}

/** The python script the worker typed, decoded back out of its base64 chunks. */
function scriptFrom(sent: string[]): string {
  const chunks = sent
    .map((line) => line.match(/^printf '%s' '([A-Za-z0-9+/=]+)' >> /))
    .filter((match): match is RegExpMatchArray => match !== null)
    .map((match) => match[1])
  return Buffer.from(chunks.join(''), 'base64').toString('utf-8')
}

function markerOf(line: string): string | null {
  const match = line.match(/'(ORCAENV[a-z0-9]+)'/)
  return match ? match[1] : null
}

test('never interleaves two commands in the helper shell', async () => {
  const { host, sent } = harness()
  const worker = await mountWorker(workerModule, { host })

  const [first, second] = await Promise.all([worker.request('endpoints.list'), worker.request('endpoints.list')])
  assert.equal(first.endpoints.length, 1)
  assert.equal(first.endpoints[0].endpoint, 'ws://192.0.2.10:40455')
  assert.equal(second.endpoints.length, 1)

  const blocks: string[] = []
  for (const line of sent) {
    const marker = markerOf(line)
    if (marker && blocks[blocks.length - 1] !== marker) blocks.push(marker)
  }
  assert.equal(new Set(blocks).size, 2, `two commands ran: ${blocks.join(',')}`)
  assert.equal(blocks.length, 2, `each command typed its lines as one unbroken block: ${blocks.join(',')}`)
})

test('keeps every typed line short enough for a terminal', async () => {
  const { host, sent } = harness()
  const worker = await mountWorker(workerModule, { host })
  await worker.request('endpoints.list')
  const longest = sent.reduce((max, line) => Math.max(max, line.length), 0)
  assert.ok(longest > 0 && longest < 200, `the longest typed line is ${longest} characters`)
})

test('refuses a host that could break out of the shell', async () => {
  const { host, sent } = harness()
  const worker = await mountWorker(workerModule, { host })
  await assert.rejects(
    worker.request('endpoints.set', {
      environmentId: 'e',
      endpointId: 'p',
      host: '1.2.3.4; rm -rf /',
      port: '40455'
    })
  )
  assert.equal(sent.length, 0, 'nothing reached a shell')
})

test('refuses a port that is not a port', async () => {
  const { host, sent } = harness()
  const worker = await mountWorker(workerModule, { host })
  await assert.rejects(
    worker.request('endpoints.set', { environmentId: 'e', endpointId: 'p', host: '192.0.2.10', port: '70000' })
  )
  assert.equal(sent.length, 0)
})

test('answers an empty probe without a shell', async () => {
  const { host, sent } = harness()
  const worker = await mountWorker(workerModule, { host })
  assert.deepEqual(await worker.request('endpoints.probe', { targets: [] }), { reachable: [] })
  assert.equal(sent.length, 0)
})

test('reports a working connection when the runtime answers', async () => {
  const { host } = harness()
  const worker = await mountWorker(workerModule, { host })
  const result = await worker.request('endpoints.test', {
    environmentId: 'env-dev',
    endpointId: 'ws-env-dev',
    name: 'Dev/Linux',
    host: '192.0.2.10',
    port: '40455',
    scheme: 'ws',
    applied: true
  })
  assert.equal(result.handshake, 'ok')
  assert.match(result.detail, /101/)
  assert.deepEqual(result.orca, { ok: true, message: 'рантайм ответил' })
  assert.equal(result.skipped, null)
})

test('says why the Orca half was skipped for an unsaved address', async () => {
  const { host } = harness({ orca: '__ORCA__{"ok":null,"message":"сначала примени адрес"}' })
  const worker = await mountWorker(workerModule, { host })
  const result = await worker.request('endpoints.test', {
    environmentId: 'env-dev',
    endpointId: 'ws-env-dev',
    name: 'Dev/Linux',
    host: '198.51.100.20',
    port: '40455',
    scheme: 'ws',
    applied: false
  })
  assert.equal(result.handshake, 'ok')
  assert.equal(result.orca, null)
  assert.equal(result.skipped, 'сначала примени адрес')
})

test('reports something that is not a WebSocket', async () => {
  const { host } = harness({
    ws: '__WS__{"verdict":"not-websocket","detail":"HTTP/1.1 404 Not Found"}',
    orca: '__ORCA__{"ok":false,"message":"remote_runtime_unavailable: Could not connect"}'
  })
  const worker = await mountWorker(workerModule, { host })
  const result = await worker.request('endpoints.test', {
    environmentId: 'env-dev',
    endpointId: 'ws-env-dev',
    name: 'Dev/Linux',
    host: '127.0.0.1',
    port: '5433',
    scheme: 'ws',
    applied: true
  })
  assert.equal(result.handshake, 'not-websocket')
  assert.match(result.detail, /404/)
  assert.equal(result.orca?.ok, false)
})

test('writes the scheme it was given instead of inheriting the saved one', async () => {
  const { host, sent } = harness({
    lines: ['__OK__ wss://orca.example.com:443 -> ws://198.51.100.21:40455', '__RESULT__1']
  })
  const worker = await mountWorker(workerModule, { host })

  const answer = await worker.request('endpoints.set', {
    environmentId: 'env-mac',
    endpointId: 'ws-env-mac',
    host: '198.51.100.21',
    port: '40455',
    scheme: 'ws'
  })

  assert.equal(answer.endpoint, 'ws://198.51.100.21:40455')
  const script = scriptFrom(sent)
  assert.match(script, /scheme="ws"/, 'the script takes the requested scheme')
  assert.match(script, /new=scheme\+':\/\/'/, 'the address is built from that scheme')
  assert.doesNotMatch(script, /old\.split/, 'the saved endpoint scheme is no longer inherited')
})

test('opens the helper shell in the active workspace, not the first local one', async () => {
  const { host, created, opened } = harness({
    workspaces: [
      { id: 'w-tonix', kind: 'worktree', name: 'Tonix', path: '/tmp/tonix', branch: 'main', hostId: null },
      { id: 'w-home', kind: 'folder', name: 'home', path: '/home/dev', branch: null, hostId: null }
    ],
    context: { branch: 'main', displayName: 'home', terminals: [{ id: 'term-1' }] }
  })
  const worker = await mountWorker(workerModule, { host })

  await worker.request('endpoints.list')
  assert.deepEqual(
    created.map((entry) => entry.workspaceId),
    ['w-home'],
    'the terminal is created where terminal.sendText accepts input'
  )
  assert.deepEqual(opened, [], 'an already local worktree is left alone')
})

test('names the local workspace requirement when only a remote one is open', async () => {
  const { host, created } = harness({
    workspaces: [
      { id: 'w-remote', kind: 'worktree', name: 'BuildHost', path: '/srv', branch: 'main', hostId: 'runtime:9338652f' }
    ],
    context: { branch: 'main', displayName: 'BuildHost', terminals: [] }
  })
  const worker = await mountWorker(workerModule, { host })

  const failure = await worker.request('endpoints.list').then(
    () => null,
    (thrown: Error) => thrown.message
  )
  assert.match(String(failure), /локальный workspace/)
  assert.equal(created.length, 0, 'no terminal is opened on a remote workspace')
})

test('switches away from a remote workspace before typing', async () => {
  const { host, created, opened } = harness({
    workspaces: [
      { id: 'w-tonix', kind: 'worktree', name: 'Tonix', path: '/tmp/tonix', branch: 'main', hostId: null }
    ],
    context: { branch: 'main', displayName: 'sim', terminals: [] }
  })
  const worker = await mountWorker(workerModule, { host })

  const answer = await worker.request('endpoints.list')
  assert.equal(answer.endpoints.length, 1)
  assert.deepEqual(opened, ['w-tonix'], 'a local workspace is activated')
  assert.deepEqual(created.map((entry) => entry.workspaceId), ['w-tonix'])
  assert.match(String(answer.warning), /переключилась/, 'the panel is told about the switch')
})

test('switches to a local workspace when Orca reports no active worktree', async () => {
  const { host, created, opened } = harness({ context: null })
  const worker = await mountWorker(workerModule, { host })

  const answer = await worker.request('endpoints.list')
  assert.equal(answer.endpoints.length, 1)
  assert.deepEqual(opened, ['w1'])
  assert.deepEqual(created.map((entry) => entry.workspaceId), ['w1'])
})

test('says a shell refused the input instead of blaming the terminal', async () => {
  const { host } = harness({ sendText: () => ({ accepted: false }) })
  const worker = await mountWorker(workerModule, { host })

  const failure = await worker.request('endpoints.list').then(
    () => null,
    (thrown: Error) => thrown.message
  )
  assert.match(String(failure), /не принял ввод/)
})

test('replaces a stored terminal that belongs to another worktree', async () => {
  const { host, created } = harness({ storage: { terminalId: 'term-old' } })
  const worker = await mountWorker(workerModule, { host })

  const answer = await worker.request('endpoints.list')
  assert.equal(answer.endpoints.length, 1)
  assert.deepEqual(created.map((entry) => entry.workspaceId), ['w1'], 'a fresh terminal is opened')
})
