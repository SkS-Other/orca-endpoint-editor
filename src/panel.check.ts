import { defineCheck } from 'orca/testing'

const environments = {
  endpoints: [
    {
      environmentId: 'env-dev',
      name: 'Dev/Linux',
      endpointId: 'ws-env-dev',
      endpoint: 'ws://192.0.2.10:40455',
      host: '192.0.2.10',
      port: '40455',
      dependency: null
    },
    {
      environmentId: 'env-win',
      name: 'Dev/Win',
      endpointId: 'ws-env-win',
      endpoint: 'ws://127.0.0.1:54144/',
      host: '127.0.0.1',
      port: '54144',
      dependency: 'ssh-tunnel'
    }
  ],
  warning: null
}

export default defineCheck({
  empty: {},
  unreachable: {
    requests: {
      'endpoints.list': environments,
      'endpoints.probe': { reachable: [false, false] }
    }
  },
  presets: {
    requests: {
      'endpoints.list': environments,
      'endpoints.probe': { reachable: [true, false] }
    },
    storage: {
      presets: {
        'env-dev': [
          { id: 'p1', name: 'LAN', host: '192.0.2.10', port: '40455' },
          { id: 'p2', name: 'VPN', host: '198.51.100.20', port: '40455' }
        ]
      }
    }
  },
  managed: {
    persisted: { plugin: { selected: 'env-win' } },
    requests: {
      'endpoints.list': environments,
      'endpoints.probe': { reachable: [true, true] }
    }
  }
})
