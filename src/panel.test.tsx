import { afterEach, assert, mockHost, mount, test, type TestPanel } from 'orca/testing'
import * as panelModule from './panel'

let panel: TestPanel | undefined
afterEach(() => panel?.unmount())

const dev = {
  environmentId: 'env-dev',
  name: 'Dev/Linux',
  endpointId: 'ws-env-dev',
  endpoint: 'ws://192.0.2.10:40455',
  host: '192.0.2.10',
  port: '40455',
  dependency: null
}

const win = {
  environmentId: 'env-win',
  name: 'Dev/Win',
  endpointId: 'ws-env-win',
  endpoint: 'ws://127.0.0.1:54144/',
  host: '127.0.0.1',
  port: '54144',
  dependency: 'ssh-tunnel'
}

const mac = {
  environmentId: 'env-mac',
  name: 'BuildHost',
  endpointId: 'ws-env-mac',
  endpoint: 'wss://orca.example.com:443',
  host: 'orca.example.com',
  port: '443',
  dependency: null
}

type Write = Record<string, unknown>

function hostWith(writes: Write[], endpoints: unknown[] = [dev]) {
  return mockHost({
    capabilities: ['workspace:read', 'terminal:send', 'terminal:read', 'storage:own'],
    requests: {
      'endpoints.list': { endpoints, warning: null },
      'endpoints.probe': { reachable: endpoints.map(() => true) },
      'endpoints.test': {
        handshake: 'ok',
        detail: 'HTTP/1.1 101 Switching Protocols',
        orca: { ok: true, message: 'runtime answered' },
        skipped: null
      },
      'endpoints.set': (input: Write) => {
        writes.push(input)
        return {
          ok: true,
          message: `${dev.endpoint} -> ws://${input.host}:${input.port}`,
          endpoint: `ws://${input.host}:${input.port}`,
          reachable: true
        }
      }
    }
  })
}

test('saves the draft as a preset and switches with one press', async () => {
  const writes: Write[] = []
  const host = hostWith(writes)
  panel = await mount(panelModule, { host })

  await panel.type({ label: 'Имя пресета' }, 'LAN')
  await panel.press(panel.find({ role: 'button', text: 'Сохранить как пресет' }))

  const preset = panel.find({ role: 'button', text: 'LAN' })
  assert.ok(preset, 'the preset is drawn as a button')
  assert.match(JSON.stringify(host.data().storage), /LAN/, 'the preset is written to plugin storage')

  await panel.press(preset)
  assert.deepEqual(writes[0], {
    environmentId: 'env-dev',
    endpointId: 'ws-env-dev',
    host: '192.0.2.10',
    port: '40455',
    scheme: 'ws'
  })
  assert.deepEqual(panel.errors, [])
  assert.deepEqual(panel.warnings, [])
})

test('keeps the success message after the refresh it triggers', async () => {
  const writes: Write[] = []
  panel = await mount(panelModule, { host: hostWith(writes) })

  await panel.type({ label: 'Имя пресета' }, 'LAN')
  await panel.press(panel.find({ role: 'button', text: 'Сохранить как пресет' }))
  await panel.press(panel.find({ role: 'button', text: 'LAN' }))

  assert.ok(
    panel.summary().some((line) => line.includes('Callout success "Готово"')),
    `the applied callout is still drawn: ${panel.summary().join(' | ')}`
  )
})

test('keeps a typed host through a refresh', async () => {
  const writes: Write[] = []
  panel = await mount(panelModule, { host: hostWith(writes) })

  await panel.type({ label: 'Хост' }, '198.51.100.20', { replace: true })
  assert.equal(panel.valueOf({ label: 'Хост' }), '198.51.100.20')

  await panel.press(panel.find({ role: 'button', text: 'Обновить' }))
  assert.equal(panel.valueOf({ label: 'Хост' }), '198.51.100.20', 'the draft survives a reload of the list')
  assert.equal(writes.length, 0, 'a refresh never writes')
})

test('blocks an endpoint Orca manages itself', async () => {
  const writes: Write[] = []
  panel = await mount(panelModule, { host: hostWith(writes, [dev, win]) })

  await panel.select({ label: 'Окружения' }, 'env-win')
  assert.ok(panel.summary().some((line) => line.includes('Dev/Win')), panel.summary().join(' | '))

  const apply = panel.find({ role: 'button', text: 'Применить' })
  const save = panel.find({ role: 'button', text: 'Сохранить как пресет' })
  assert.equal(apply?.disabled, true, 'Apply is disabled for an SSH tunnel endpoint')
  assert.equal(save?.disabled, true, 'a preset cannot be saved for it')
})

test('renames a preset in place', async () => {
  const writes: Write[] = []
  const host = hostWith(writes)
  panel = await mount(panelModule, { host })

  await panel.type({ label: 'Имя пресета' }, 'LAN')
  await panel.press(panel.find({ role: 'button', text: 'Сохранить как пресет' }))

  const edit = panel.find({ label: 'Переименовать пресет LAN' })
  assert.ok(edit, 'the rename control is drawn')
  await panel.press(edit)

  assert.equal(panel.valueOf({ label: 'Новое имя' }), 'LAN', 'the field starts from the current name')
  await panel.type({ label: 'Новое имя' }, 'Home LAN', { replace: true })
  await panel.press(panel.find({ role: 'button', text: 'Сохранить' }))

  assert.equal(panel.find({ role: 'button', text: 'LAN' }), null, 'the old name is gone')
  const renamed = panel.find({ role: 'button', text: 'Home LAN' })
  assert.ok(renamed, 'the preset is drawn under the new name')
  assert.equal(writes.length, 0, 'renaming never touches Orca state')

  const stored = (host.data().storage as Record<string, any>).presets['env-dev']
  assert.equal(stored[0].name, 'Home LAN')
  assert.equal(stored[0].host, '192.0.2.10', 'the address is untouched')
})

test('drops a rename without touching the preset', async () => {
  const writes: Write[] = []
  const host = hostWith(writes)
  panel = await mount(panelModule, { host })

  await panel.type({ label: 'Имя пресета' }, 'LAN')
  await panel.press(panel.find({ role: 'button', text: 'Сохранить как пресет' }))
  await panel.press(panel.find({ label: 'Переименовать пресет LAN' }))
  await panel.type({ label: 'Новое имя' }, 'oops', { replace: true })
  await panel.press(panel.find({ role: 'button', text: 'Отмена' }))

  assert.ok(panel.find({ role: 'button', text: 'LAN' }))
  const stored = (host.data().storage as Record<string, any>).presets['env-dev']
  assert.equal(stored[0].name, 'LAN')
})

test('removes a preset', async () => {
  const writes: Write[] = []
  const host = hostWith(writes)
  panel = await mount(panelModule, { host })

  await panel.type({ label: 'Имя пресета' }, 'LAN')
  await panel.press(panel.find({ role: 'button', text: 'Сохранить как пресет' }))
  assert.ok(panel.find({ role: 'button', text: 'LAN' }))

  const remove = panel.find({ label: 'Удалить пресет LAN' })
  assert.ok(remove, 'the remove control is drawn')
  await panel.press(remove)
  assert.equal(panel.find({ role: 'button', text: 'LAN' }), null)
  assert.equal(writes.length, 0, 'removing a preset never touches Orca state')
  assert.deepEqual((host.data().storage as Record<string, unknown>).presets, { 'env-dev': [] })
})

test('shows why the list failed', async () => {
  const host = mockHost({
    capabilities: ['workspace:read', 'terminal:send', 'terminal:read', 'storage:own'],
    requests: {
      'endpoints.list': () => {
        throw new Error('The helper shell did not answer')
      },
      'endpoints.probe': { reachable: [] }
    }
  })
  panel = await mount(panelModule, { host })
  assert.ok(
    panel.summary().some((line) => line.includes('Callout danger "Ошибка"')),
    panel.summary().join(' | ')
  )
})

test('tests the connection and says it works', async () => {
  const writes: Write[] = []
  panel = await mount(panelModule, { host: hostWith(writes) })
  // The first act waits for the list request that setup fired; mount alone does not.
  await panel.type({ label: 'Имя пресета' }, 'x')

  await panel.press(panel.find({ role: 'button', text: 'Проверить подключение' }))
  await panel.type({ label: 'Имя пресета' }, 'y', { replace: true })
  assert.ok(
    panel.summary().some((line) => line.includes('Callout success "Подключение работает"')),
    panel.summary().join(' | ')
  )
  assert.equal(writes.length, 0, 'testing never writes the config')
})

test('says what failed when the address does not answer', async () => {
  const host = mockHost({
    capabilities: ['workspace:read', 'terminal:send', 'terminal:read', 'storage:own'],
    requests: {
      'endpoints.list': { endpoints: [dev], warning: null },
      'endpoints.probe': { reachable: [false] },
      'endpoints.test': {
        handshake: 'refused',
        detail: 'ConnectionRefusedError',
        orca: null,
        skipped: 'the Orca check did not run'
      }
    }
  })
  panel = await mount(panelModule, { host })
  await panel.type({ label: 'Имя пресета' }, 'x')
  await panel.press(panel.find({ role: 'button', text: 'Проверить подключение' }))
  assert.ok(
    panel.summary().some((line) => line.includes('Callout danger "Подключения нет"')),
    panel.summary().join(' | ')
  )
  assert.ok(
    panel.find({ text: /на этом адресе никто не отвечает/ }),
    'the callout says what failed'
  )
})

test('applies a scheme change even when host and port stay the same', async () => {
  const writes: Write[] = []
  panel = await mount(panelModule, { host: hostWith(writes, [mac]) })
  await panel.type({ label: 'Имя пресета' }, 'x')

  const apply = () => panel?.find({ role: 'button', text: 'Применить' })
  assert.equal(apply()?.disabled, true, 'nothing to apply yet')

  await panel.press(panel.find({ role: 'button', text: 'wss://' }))
  assert.equal(apply()?.disabled, true, 'the saved scheme is already wss')

  await panel.press(panel.find({ role: 'button', text: 'ws://' }))
  assert.equal(apply()?.disabled, false, 'a scheme change counts as a change')

  await panel.press(apply())
  assert.equal(writes[0].scheme, 'ws')
  assert.equal(writes[0].host, 'orca.example.com')
  assert.equal(writes[0].port, '443')
})

test('applies a preset with its own scheme instead of the saved one', async () => {
  const writes: Write[] = []
  const host = mockHost({
    capabilities: ['workspace:read', 'terminal:send', 'terminal:read', 'storage:own'],
    storage: {
      presets: {
        'env-mac': [{ id: 'p1', name: 'ZeroTier', host: '198.51.100.21', port: '40455', scheme: 'ws' }]
      }
    },
    requests: {
      'endpoints.list': { endpoints: [mac], warning: null },
      'endpoints.probe': { reachable: [true] },
      'endpoints.set': (input: Write) => {
        writes.push(input)
        return { ok: true, message: 'applied', endpoint: 'ws://198.51.100.21:40455', reachable: true }
      }
    }
  })
  panel = await mount(panelModule, { host })
  await panel.type({ label: 'Имя пресета' }, 'x')

  const preset = panel.find({ role: 'button', text: 'ZeroTier' })
  assert.ok(preset, 'the preset is drawn')
  await panel.press(preset)

  assert.equal(writes.length, 1, 'one write reached the worker')
  assert.equal(writes[0].scheme, 'ws', 'a plaintext overlay address keeps ws://, not the saved wss://')
  assert.equal(writes[0].host, '198.51.100.21')
  assert.equal(writes[0].port, '40455')
})

test('drops presets of environments Orca no longer has', async () => {
  const host = mockHost({
    capabilities: ['workspace:read', 'terminal:send', 'terminal:read', 'storage:own'],
    storage: {
      presets: { 'env-gone': [{ id: 'g1', name: 'Old', host: '203.0.113.1', port: '40455' }] }
    },
    requests: {
      'endpoints.list': { endpoints: [dev], warning: null },
      'endpoints.probe': { reachable: [true] }
    }
  })
  panel = await mount(panelModule, { host })
  await panel.type({ label: 'Имя пресета' }, 'x')

  const stored = (host.data().storage as Record<string, unknown>).presets as Record<string, unknown>
  assert.deepEqual(Object.keys(stored), [], 'the preset of a removed environment is gone')
})
