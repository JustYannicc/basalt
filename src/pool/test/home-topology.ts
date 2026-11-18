/**
 * `GET /v8/management/topology` as documented by the upstream Home management reference:
 * docs/management/api.md lines 505-580 at v1.1.6, with every key and value unchanged. The
 * documented cluster has one Home, and that Home is the master serving the read.
 */
export const documentedTopology = {
  summary: {
    home_count: 1,
    healthy_home_count: 1,
    stale_home_count: 0,
    unknown_home_count: 0,
    cpa_count: 1,
    healthy_cpa_count: 1,
    stale_cpa_count: 0,
    unknown_cpa_count: 0,
    plugin_attention_count: 0,
    attention_count: 0,
    missing_master: false,
    stale_after_seconds: 20,
    retention_after_seconds: 120,
  },
  management: {
    home_id: "10.0.0.10:8327",
    home_ip: "10.0.0.10",
    home_port: 8327,
  },
  master: {
    id: "10.0.0.10:8327",
    ip: "10.0.0.10",
    port: 8327,
    role: "master",
    is_master: true,
    reported_master: true,
    health: "healthy",
    healthy: true,
    client_count: 1,
    started_at: "2026-05-27T10:00:00Z",
    last_seen_at: "2026-05-27T10:30:02Z",
    cpa_count: 1,
    healthy_cpa_count: 1,
    stale_cpa_count: 0,
    unknown_cpa_count: 0,
  },
  homes: [
    {
      id: "10.0.0.10:8327",
      ip: "10.0.0.10",
      port: 8327,
      role: "master",
      is_master: true,
      reported_master: true,
      health: "healthy",
      healthy: true,
      client_count: 1,
      started_at: "2026-05-27T10:00:00Z",
      last_seen_at: "2026-05-27T10:30:02Z",
      cpa_count: 1,
      healthy_cpa_count: 1,
      stale_cpa_count: 0,
      unknown_cpa_count: 0,
    },
  ],
  cpas: [
    {
      node_id: "node-1",
      node_name: "primary-cpa",
      ip: "192.0.2.10",
      connected_time: "2026-05-27T10:05:00Z",
      last_seen_at: "2026-05-27T10:30:02Z",
      client_count: 1,
      state: "active",
      health: "healthy",
      healthy: true,
      home_id: "10.0.0.10:8327",
      home_ip: "10.0.0.10",
      home_port: 8327,
      plugin_report_state: "reported_ok",
      plugin_report_statuses: [],
    },
  ],
};

/** The documented Home entry reshaped into a second Home that serves the read as a follower. */
export function followerTopology() {
  const master = documentedTopology.homes[0]!;
  const follower = {
    ...master,
    id: "10.0.0.11:8328",
    ip: "10.0.0.11",
    port: 8328,
    role: "follower",
    is_master: false,
    reported_master: false,
    started_at: "2026-05-27T10:10:00Z",
    client_count: 0,
    cpa_count: 0,
    healthy_cpa_count: 0,
  };
  return {
    ...documentedTopology,
    summary: { ...documentedTopology.summary, home_count: 2, healthy_home_count: 2 },
    management: { home_id: follower.id, home_ip: follower.ip, home_port: follower.port },
    homes: [master, follower],
  };
}

/** No healthy Home: upstream then elects nobody, reports every role unknown and nulls the master. */
export function masterlessTopology() {
  const topology = followerTopology();
  return {
    ...topology,
    summary: {
      ...topology.summary,
      healthy_home_count: 0,
      stale_home_count: 2,
      attention_count: 3,
      missing_master: true,
    },
    master: null,
    homes: topology.homes.map((home) => ({
      ...home,
      role: "unknown",
      is_master: false,
      health: "stale",
      healthy: false,
    })),
  };
}
