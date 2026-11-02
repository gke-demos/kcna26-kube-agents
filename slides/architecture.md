# Slide: how it's built

Simplified from kube-agents' `docs/site/src/content/docs/overview/architecture.mdx` for a single
slide. Render with `npx -p @mermaid-js/mermaid-cli mmdc -i architecture.md -o architecture.svg`.

```mermaid
flowchart LR
    subgraph People
        SL[Slack]
        DEV[Reviewer on GitHub]
    end

    subgraph Hub["kube-agents-hub"]
        GW["A2A gateway<br/>no model, no cluster access"]
        BUS[("bus<br/>every client checked by<br/>Kubernetes TokenReview")]
        subgraph Agents["agent pod"]
            PL[Planning Agent]
            PA[Platform Agent]
            CA["Cluster Agents<br/>read-only, one per cluster"]
        end
        EW[event watcher]
        BRK["token broker<br/>short-lived, scoped"]
    end

    subgraph Fleet
        BQ[boutique-prod]
        BK[bank-prod]
        CP[compute cluster]
    end

    REPO[(fleet GitOps repo)]

    SL --> GW --> BUS --> PL
    PL -->|delegates| PA
    PA -->|delegates| CA
    CA -.->|read| Fleet
    EW -.->|Warning events| Fleet
    EW -->|alert| PL
    PA -->|opens PR| BRK --> REPO
    DEV -->|merges| REPO
    REPO -->|Config Sync| Fleet
```

## Talking points

- The front door has no model and no credentials. Chat becomes a task on a bus, and every bus
  client proves its Kubernetes identity first.
- One planner delegates. Specialists do the work, and each cluster gets its own read-only agent.
- The agents read everything and write nothing to a cluster. Every change is a pull request, and
  a person merges it.
- GitHub credentials are minted per task, scoped to one repository, and expire.
