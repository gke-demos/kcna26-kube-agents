# Slide: where it's going

Roadmap only. None of this is shown live, and none of it should be described as shipping.

- **Agent profiles instead of a shared task board.** Each specialist runs as its own worker with
  its own identity and per-task credentials, dispatched over the bus.
- **One generic cluster agent** in place of a profile per cluster.
- **Bring your own IDE.** An MCP server so a coding agent can talk to the fleet's agents.
- **Capability envelopes** that bound what each delegated task may do, end to end.

Check each line against kube-agents `main` the day before the talk (`docs/designs/spec-profiles-dispatch.md`,
`docs/designs/spec-subagent-profiles.md`, `docs/architecture/09-capability-envelope.md`) and drop
anything that has shipped or been cut.
