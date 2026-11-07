import {
  atom,
  Badge,
  Button,
  Callout,
  Card,
  EmptyState,
  Heading,
  IconButton,
  Input,
  plugin,
  read,
  Row,
  Separator,
  set,
  Spinner,
  Stack,
  storage,
  Tab,
  Tabs,
  Text,
  update,
  type PanelContext
} from 'orca'
import type { ConnectionTest, Preset, Scheme, ServerEndpoint } from './protocol'

/** null until the worker answers; [] when it answered with nothing. */
const rows = atom<ServerEndpoint[] | null>(null)
/** Which environment's tab is open; survives a panel restart. */
const selected = atom('selected', '', { persist: 'plugin' })
/** Presets per environment id, mirrored into the plugin's own storage. */
const presets = atom<Record<string, Preset[]>>({})
const PRESETS_KEY = 'presets'
/** Unsaved Host/Port/Scheme edits, so a Refresh or Probe does not throw away typing. */
const drafts = atom<Record<string, { host: string; port: string; scheme: Scheme }>>({})
/** Last probe result per "host:port". */
const reach = atom<Record<string, boolean>>({})
const presetName = atom('')
/** The preset being renamed, with its in-progress name. */
const renaming = atom<{ id: string; name: string } | null>(null)
const error = atom<string | null>(null)
const note = atom<string | null>(null)
/** Set when the worker had to switch Orca to a local workspace to reach the helper shell. */
const switched = atom<string | null>(null)
const busy = atom<string | null>(null)
const probing = atom(false)
/** The environment whose connection is being tested right now. */
const testingEnv = atom<string | null>(null)
/** The last connection test, with the environment it belongs to. */
const tested = atom<{ environmentId: string; result: ConnectionTest } | null>(null)

const MAX_TARGETS = 64

function reason(thrown: unknown): string {
  if (thrown instanceof Error) return thrown.message
  return String(thrown)
}

function keyOf(host: string, port: string): string {
  return `${host.trim()}:${port.trim()}`
}

function split(endpoint: string): { host: string; port: string; scheme: Scheme } {
  try {
    const parsed = new URL(endpoint)
    return {
      host: parsed.hostname,
      port: parsed.port || (parsed.protocol === 'wss:' || parsed.protocol === 'https:' ? '443' : '80'),
      scheme: parsed.protocol === 'wss:' || parsed.protocol === 'https:' ? 'wss' : 'ws'
    }
  } catch {
    return { host: '', port: '', scheme: 'ws' }
  }
}

/**
 * The scheme an address most likely speaks, for presets saved before schemes were stored.
 * TLS is what a public name on a TLS port has; a private or overlay address is plaintext.
 */
function defaultScheme(host: string, port: string): Scheme {
  const clean = host.trim()
  if (port.trim() === '443' || port.trim() === '8443') return 'wss'
  if (/^(?:10\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.|100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.|127\.)/.test(clean)) {
    return 'ws'
  }
  if (['localhost', '::1'].includes(clean)) return 'ws'
  if (/\.(?:local|internal|lan|ts\.net)$/i.test(clean)) return 'ws'
  return 'wss'
}

/** True when the saved endpoint already points at this scheme, host and port. */
function savedAs(endpoint: string, host: string, port: string, scheme: Scheme): boolean {
  const parts = split(endpoint)
  return parts.host === host.trim() && parts.port === port.trim() && parts.scheme === scheme
}

/** Endpoints Orca rewrites on its own (an SSH tunnel it owns); editing them is pointless. */
function managed(row: ServerEndpoint): boolean {
  if (row.dependency === 'ssh-tunnel') return true
  return row.host === '127.0.0.1' || row.host === 'localhost' || row.host === '::1'
}

function draftOf(row: ServerEndpoint): { host: string; port: string; scheme: Scheme } {
  return read(drafts)[row.endpointId] ?? { host: row.host, port: row.port, scheme: split(row.endpoint).scheme }
}

function setDraft(row: ServerEndpoint, change: Partial<{ host: string; port: string; scheme: Scheme }>): void {
  const base = draftOf(row)
  update(drafts, (all) => ({ ...all, [row.endpointId]: { ...base, ...change } }))
}

function dirtyOf(row: ServerEndpoint): boolean {
  const draft = draftOf(row)
  return (
    draft.host.trim() !== row.host || draft.port.trim() !== row.port || draft.scheme !== split(row.endpoint).scheme
  )
}

function clearDraft(endpointId: string): void {
  update(drafts, (all) => {
    const next = { ...all }
    delete next[endpointId]
    return next
  })
}

/** What the two-step test proved, in words. */
function describeTest(result: ConnectionTest): { tone: 'success' | 'warning' | 'danger'; title: string; body: string } {
  const handshake: Record<string, string> = {
    ok: 'WebSocket-рукопожатие принято (101)',
    refused: 'на этом адресе никто не отвечает',
    'not-websocket': 'что-то отвечает, но это не WebSocket',
    'tls-error': 'TLS не прошёл',
    timeout: 'нет ответа за 3 секунды',
    unknown: 'проверка не дала ответа'
  }
  const head = handshake[result.handshake] ?? result.handshake
  const detail = result.detail ? ` (${result.detail})` : ''
  if (result.handshake !== 'ok') {
    return { tone: 'danger', title: 'Подключения нет', body: `${head}${detail}.` }
  }
  if (result.orca?.ok) {
    return { tone: 'success', title: 'Подключение работает', body: `${head}; рантайм Orca ответил.` }
  }
  if (result.orca) {
    return {
      tone: 'warning',
      title: 'WebSocket отвечает, Orca — нет',
      body: `${head}, но Orca этим воспользоваться не смогла: ${result.orca.message}`
    }
  }
  return {
    tone: 'warning',
    title: 'WebSocket отвечает',
    body: `${head}. ${result.skipped ?? 'Примени адрес, чтобы Orca попробовала соединиться.'}`
  }
}

async function testConnection(row: ServerEndpoint): Promise<void> {
  const draft = draftOf(row)
  set(testingEnv, row.environmentId)
  set(error, null)
  set(tested, null)
  try {
    const result = await plugin.request(
      'endpoints.test',
      {
        environmentId: row.environmentId,
        endpointId: row.endpointId,
        name: row.name,
        host: draft.host.trim(),
        port: draft.port.trim(),
        scheme: draft.scheme,
        applied: !dirtyOf(row)
      },
      { timeoutMs: 90000 }
    )
    set(tested, { environmentId: row.environmentId, result })
  } catch (thrown) {
    set(error, reason(thrown))
  } finally {
    set(testingEnv, null)
  }
}

function reachBadge(host: string, port: string, isProbing: boolean) {
  const value = read(reach)[keyOf(host, port)]
  if (value === true) return <Badge tone="success">отвечает</Badge>
  if (value === false) return <Badge tone="danger">не отвечает</Badge>
  if (isProbing) return <Badge tone="neutral">проверяю…</Badge>
  return <Badge tone="neutral">не проверено</Badge>
}

async function probeAll(): Promise<void> {
  if (read(probing)) return
  const list = read(rows) ?? []
  const all = read(presets)
  const targets: { host: string; port: string }[] = []
  const seen = new Set<string>()
  const push = (host: string, port: string) => {
    const cleanHost = host.trim()
    const cleanPort = port.trim()
    const key = keyOf(cleanHost, cleanPort)
    if (!cleanHost || !cleanPort || seen.has(key) || targets.length >= MAX_TARGETS) return
    seen.add(key)
    targets.push({ host: cleanHost, port: cleanPort })
  }
  for (const row of list) {
    push(row.host, row.port)
    for (const preset of all[row.environmentId] ?? []) push(preset.host, preset.port)
  }
  if (targets.length === 0) return
  set(probing, true)
  try {
    const answer = await plugin.request('endpoints.probe', { targets }, { timeoutMs: 60000 })
    const map: Record<string, boolean> = {}
    targets.forEach((target, index) => {
      map[keyOf(target.host, target.port)] = answer.reachable[index] === true
    })
    set(reach, map)
  } catch (thrown) {
    set(error, `Probe failed: ${reason(thrown)}`)
  } finally {
    set(probing, false)
  }
}

/** Drops presets of environments Orca no longer has; they can never be applied again. */
function prunePresets(environmentIds: string[]): void {
  const all = read(presets)
  const kept: Record<string, Preset[]> = {}
  let changed = false
  for (const [id, list] of Object.entries(all)) {
    if (environmentIds.includes(id)) kept[id] = list
    else changed = true
  }
  if (changed) persistPresets(kept)
}

async function refresh(): Promise<void> {
  try {
    const answer = await plugin.request('endpoints.list')
    set(rows, answer.endpoints)
    set(switched, answer.warning ?? null)
    prunePresets(answer.endpoints.map((row) => row.environmentId))
    const current = read(selected)
    if (!answer.endpoints.some((row) => row.environmentId === current)) {
      set(selected, answer.endpoints[0]?.environmentId ?? '')
    }
    void probeAll()
  } catch (thrown) {
    set(rows, [])
    set(error, reason(thrown))
  }
}

async function write(row: ServerEndpoint, host: string, port: string, scheme: Scheme): Promise<void> {
  set(busy, row.environmentId)
  set(error, null)
  set(note, null)
  let failure: string | null = null
  try {
    const answer = await plugin.request('endpoints.set', {
      environmentId: row.environmentId,
      endpointId: row.endpointId,
      host: host.trim(),
      port: port.trim(),
      scheme
    })
    set(note, `${row.name}: ${answer.message}`)
    clearDraft(row.endpointId)
  } catch (thrown) {
    failure = reason(thrown)
  } finally {
    set(busy, null)
  }
  // Always re-read: a failed probe still means the file may already be rewritten.
  await refresh()
  if (failure) set(error, failure)
}

function persistPresets(next: Record<string, Preset[]>): void {
  set(presets, next)
  void storage.set(PRESETS_KEY, next).catch((thrown) => {
    set(error, `Presets were not saved: ${reason(thrown)}`)
  })
}

async function loadPresets(): Promise<void> {
  try {
    const stored = await storage.get(PRESETS_KEY)
    if (stored && typeof stored === 'object' && !Array.isArray(stored)) {
      const raw = stored as Record<string, Preset[]>
      const filled: Record<string, Preset[]> = {}
      for (const [environmentId, list] of Object.entries(raw)) {
        filled[environmentId] = (Array.isArray(list) ? list : []).map((preset) => ({
          ...preset,
          scheme: preset.scheme === 'wss' || preset.scheme === 'ws' ? preset.scheme : defaultScheme(preset.host, preset.port)
        }))
      }
      set(presets, filled)
    }
  } catch (thrown) {
    set(error, `Presets were not loaded: ${reason(thrown)}`)
  }
}

function savePreset(row: ServerEndpoint): void {
  const draft = draftOf(row)
  const host = draft.host.trim()
  const port = draft.port.trim()
  if (!host || !port) return
  const name = read(presetName).trim() || `${host}:${port}`
  const next: Preset = {
    id: `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
    name,
    host,
    port,
    scheme: draft.scheme
  }
  const all = read(presets)
  const kept = (all[row.environmentId] ?? []).filter((preset) => !(preset.host === host && preset.port === port))
  persistPresets({ ...all, [row.environmentId]: [...kept, next] })
  set(presetName, '')
  void probeAll()
}

function removePreset(environmentId: string, id: string): void {
  const all = read(presets)
  persistPresets({ ...all, [environmentId]: (all[environmentId] ?? []).filter((preset) => preset.id !== id) })
  if (read(renaming)?.id === id) set(renaming, null)
}

function renamePreset(environmentId: string, id: string, name: string): void {
  const trimmed = name.trim()
  if (!trimmed) return
  const all = read(presets)
  persistPresets({
    ...all,
    [environmentId]: (all[environmentId] ?? []).map((preset) =>
      preset.id === id ? { ...preset, name: trimmed } : preset
    )
  })
  set(renaming, null)
}

export function setup(_ctx: PanelContext): void {
  // Load first: the first refresh prunes presets of environments Orca no longer has.
  void loadPresets().then(() => refresh())
}

export default function Panel() {
  const list = read(rows)
  const selectedId = read(selected)
  const allPresets = read(presets)
  const pending = read(busy)
  const isProbing = read(probing)
  const testing = read(testingEnv)
  const testResult = read(tested)
  const nameDraft = read(presetName)
  const rename = read(renaming)
  const failure = read(error)
  const done = read(note)
  const switchNote = read(switched)

  const row = (list ?? []).find((item) => item.environmentId === selectedId) ?? (list ?? [])[0] ?? null
  const envPresets = row ? allPresets[row.environmentId] ?? [] : []
  const blocked = row ? managed(row) : true
  const draft = row ? draftOf(row) : { host: '', port: '', scheme: 'wss' as Scheme }
  const dirty = row ? dirtyOf(row) : false
  const testInfo =
    row && testResult && testResult.environmentId === row.environmentId ? describeTest(testResult.result) : null
  const isTesting = row ? testing === row.environmentId : false

  return (
    <Stack gap="md">
      <Row justify="between" align="center">
        <Heading>Адреса серверов</Heading>
        <Row gap="xs" align="center">
          {isProbing ? <Spinner label="Проверяю порты" labelHidden /> : null}
          <Button
            size="sm"
            variant="ghost"
            icon="refresh"
            disabled={list === null || isProbing}
            onPress={() => {
              set(error, null)
              set(note, null)
              void refresh()
            }}
          >
            Обновить
          </Button>
        </Row>
      </Row>

      {failure ? (
        <Callout tone="danger" title="Ошибка">
          {failure}
        </Callout>
      ) : null}
      {done ? (
        <Callout tone="success" title="Готово">
          {done}
        </Callout>
      ) : null}
      {switchNote ? (
        <Text muted size="xs">
          {switchNote}
        </Text>
      ) : null}

      {list === null ? <Spinner label="Читаю сохранённые окружения" /> : null}
      {list !== null && list.length === 0 && !failure ? (
        <EmptyState
          title="Нет сохранённых окружений"
          description="Сначала спарь удалённый рантайм Orca — его адрес появится здесь."
          icon="globe"
        />
      ) : null}

      {list !== null && list.length > 1 ? (
        <Tabs label="Окружения" value={row?.environmentId ?? ''} onChange={(value) => set(selected, value)}>
          {list.map((item) => (
            <Tab value={item.environmentId} label={item.name} />
          ))}
        </Tabs>
      ) : null}

      {row ? (
        <Card title={row.name} description={row.endpoint}>
          <Stack gap="sm">
            <Row gap="xs" align="center">
              {reachBadge(draft.host, draft.port, isProbing)}
              {dirty ? <Badge tone="warning">изменено</Badge> : null}
              {blocked ? <Badge tone="neutral">управляется Orca</Badge> : null}
              {pending === row.environmentId ? <Spinner label="Применяю" labelHidden /> : null}
            </Row>

            <Row gap="sm" align="end" wrap>
              <Input
                label="Хост"
                value={draft.host}
                disabled={blocked}
                onChange={(value) => setDraft(row, { host: value })}
              />
              <Input
                label="Порт"
                value={draft.port}
                maxLength={5}
                disabled={blocked}
                onChange={(value) => setDraft(row, { port: value })}
              />
              <Row gap="xs" align="center">
                {(['ws', 'wss'] as const).map((option) => (
                  <Button
                    key={option}
                    size="sm"
                    variant={draft.scheme === option ? 'solid' : 'outline'}
                    disabled={blocked}
                    onPress={() => setDraft(row, { scheme: option })}
                  >
                    {`${option}://`}
                  </Button>
                ))}
              </Row>
              <Button
                size="sm"
                disabled={pending !== null || blocked || !dirty}
                onPress={() => void write(row, draft.host, draft.port, draft.scheme)}
              >
                Применить
              </Button>
            </Row>
            <Text muted size="xs">
              Схема относится к адресу, а не к окружению: wss:// годится только там, где на этом порту
              действительно TLS.
            </Text>

            <Row gap="xs" align="center">
              <Button
                size="sm"
                variant="ghost"
                icon="link"
                disabled={isTesting || !draft.host.trim() || !draft.port.trim()}
                onPress={() => void testConnection(row)}
              >
                Проверить подключение
              </Button>
              {isTesting ? <Spinner label="Проверяю подключение" labelHidden /> : null}
            </Row>
            <Text muted size="xs">
              {dirty ? 'Проверяется введённый адрес' : 'Проверяется сохранённый адрес'}
            </Text>

            {testInfo ? (
              <Callout tone={testInfo.tone} title={testInfo.title}>
                {testInfo.body}
              </Callout>
            ) : null}

            <Separator />

            <Row justify="between" align="center">
              <Text muted size="xs">
                {envPresets.length > 0 ? `Пресеты (${envPresets.length})` : 'Пресеты'}
              </Text>
              <Button
                size="sm"
                variant="ghost"
                icon="zap"
                disabled={isProbing || list === null}
                onPress={() => void probeAll()}
              >
                Проверить порты
              </Button>
            </Row>

            {envPresets.length === 0 ? (
              <Text muted size="xs">
                Пока пусто: введи имя ниже и сохрани текущие хост и порт — дальше переключение одним нажатием.
              </Text>
            ) : null}

            {envPresets.map((preset) => {
              const presetScheme = preset.scheme ?? defaultScheme(preset.host, preset.port)
              const active = savedAs(row.endpoint, preset.host, preset.port, presetScheme)
              const value = read(reach)[keyOf(preset.host, preset.port)]
              const editingName = rename && rename.id === preset.id ? rename.name : null
              if (editingName !== null) {
                return (
                  <Row gap="sm" align="end" wrap>
                    <Input
                      label="Новое имя"
                      value={editingName}
                      onChange={(next) => set(renaming, { id: preset.id, name: next })}
                      onSubmit={() => renamePreset(row.environmentId, preset.id, editingName)}
                    />
                    <Button
                      size="sm"
                      onPress={() => renamePreset(row.environmentId, preset.id, editingName)}
                    >
                      Сохранить
                    </Button>
                    <Button size="sm" variant="ghost" onPress={() => set(renaming, null)}>
                      Отмена
                    </Button>
                  </Row>
                )
              }
              return (
                <Row gap="xs" align="center" justify="between" wrap>
                  <Button
                    size="sm"
                    variant={active ? 'solid' : 'outline'}
                    tone={value === false ? 'danger' : 'neutral'}
                    icon={value === false ? 'warning' : 'check'}
                    disabled={pending !== null || blocked}
                    onPress={() => void write(row, preset.host, preset.port, presetScheme)}
                  >
                    {preset.name}
                  </Button>
                  <Row gap="xs" align="center">
                    <Text muted size="xs">
                      {`${presetScheme}://${preset.host}:${preset.port}`}
                    </Text>
                    <IconButton
                      icon="edit"
                      label={`Переименовать пресет ${preset.name}`}
                      size="sm"
                      variant="ghost"
                      onPress={() => set(renaming, { id: preset.id, name: preset.name })}
                    />
                    <IconButton
                      icon="delete"
                      label={`Удалить пресет ${preset.name}`}
                      size="sm"
                      variant="ghost"
                      onPress={() => removePreset(row.environmentId, preset.id)}
                    />
                  </Row>
                </Row>
              )
            })}

            <Row gap="sm" align="end" wrap>
              <Input
                label="Имя пресета"
                placeholder={draft.host ? `${draft.host}:${draft.port}` : 'Домашняя сеть'}
                value={nameDraft}
                disabled={blocked}
                onChange={(value) => set(presetName, value)}
                onSubmit={() => savePreset(row)}
              />
              <Button size="sm" variant="ghost" icon="add" disabled={blocked} onPress={() => savePreset(row)}>
                Сохранить как пресет
              </Button>
            </Row>

            {blocked ? (
              <Text muted size="xs">
                {row.dependency ?? 'туннель'} — Orca переписывает этот адрес сама, поэтому править его нужно
                перепариванием сервера.
              </Text>
            ) : null}
          </Stack>
        </Card>
      ) : null}

      <Text muted size="xs">
        Пишет схему, host и port в orca-environments.json через служебный шелл (терминал
        "server-endpoints"), оставляя 10 последних бэкапов с меткой времени. Пресеты живут в
        storage плагина. Orca подхватывает изменение без перезапуска; токены не трогаются.
      </Text>
    </Stack>
  )
}
