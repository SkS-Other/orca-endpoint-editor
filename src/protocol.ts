// The panel <-> worker contract, declared once: src/panel.tsx and src/worker.ts both read it.
export {}

/** One saved endpoint of one remote Orca environment, as the panel edits it. */
export type ServerEndpoint = {
  environmentId: string
  name: string
  endpointId: string
  /** The endpoint as it is stored right now, e.g. ws://203.0.113.5:40455 */
  endpoint: string
  /** Draft host the person edits. */
  host: string
  /** Draft port the person edits. */
  port: string
  /** Orca's connection dependency for this environment, e.g. ssh-tunnel. */
  dependency: string | null
}

/** The transport an address speaks; it belongs to the address, never inherited from the environment. */
export type Scheme = 'ws' | 'wss'

/** A remembered host, port and scheme for one environment, kept in the panel's own storage. */
export type Preset = {
  id: string
  name: string
  host: string
  port: string
  /** Absent on presets saved before schemes were stored; the panel fills it on load. */
  scheme?: Scheme
}

/** What a connection test learned about one address. */
export type ConnectionTest = {
  /** `ok` means a WebSocket upgrade was accepted at this host and port. */
  handshake: 'ok' | 'refused' | 'not-websocket' | 'tls-error' | 'timeout' | 'unknown'
  detail: string
  /** The Orca runtime's own answer, only asked when the endpoint is already saved. */
  orca: { ok: boolean; message: string } | null
  /** Why the Orca half was skipped, when it was. */
  skipped: string | null
}

declare module 'orca' {
  interface PluginRequests {
    /** Reads every saved environment and its endpoints from the running Orca. */
    'endpoints.list': { output: { endpoints: ServerEndpoint[]; warning: string | null } }
    /** Rewrites one endpoint's scheme, host and port in Orca's environment file. */
    'endpoints.set': {
      input: { environmentId: string; endpointId: string; host: string; port: string; scheme: string }
      output: { ok: boolean; message: string; endpoint: string; reachable: boolean | null }
    }
    /** Opens a TCP connection to each target; the answer keeps the input order. */
    'endpoints.probe': {
      input: { targets: { host: string; port: string }[] }
      output: { reachable: boolean[] }
    }
    /** WebSocket handshake on the draft address, then the real Orca runtime when it is saved. */
    'endpoints.test': {
      input: {
        environmentId: string
        endpointId: string
        name: string
        host: string
        port: string
        scheme: string
        applied: boolean
      }
      output: ConnectionTest
    }
  }
}
