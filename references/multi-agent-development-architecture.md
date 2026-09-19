# Multi-Agent Development Architecture — Proposed Solution

> **Historical proposal, not the current contract or usage guide.** The [V1 target specification](v1-specification.md) supersedes this proposal; [README](../README.md) describes supported behavior. In particular, V1 uses Pi session IDs and anonymous registration, not the illustrative bootstrap flags below. Intercom communicates while Pi assigns work; durable journals, automatic lifecycle transitions and peer-introduction requirements below are not implemented V1 requirements. Completion means report and wait, not autonomous exit. Stop/close are currently disabled.

## Goal

Build a lightweight coordination layer for multiple Pi coding-agent instances so they can work together across research, implementation, testing, review, and multi-project changes without depending on terminal history or a specific terminal multiplexer.

The central idea is:

> **Pi instances communicate through a small coordination extension, while Herder remains optional UI/process tooling rather than part of the architecture.**

---

## 1. Core Architecture

There are two primary agent roles:

- **Coordinator**
  - Owns the overall objective.
  - Decides what work should be delegated.
  - Spawns worker agents when needed.
  - Keeps the authoritative feature/task state.
  - Routes relevant context between agents.
  - Collects results, decisions, handoffs, and status updates.

- **Workers**
  - Receive a focused objective from the coordinator.
  - Work independently with a deliberately limited context.
  - Can perform research, implementation, testing, review, debugging, or other specialist work.
  - Report findings and results back to the coordinator.
  - May optionally communicate directly with other workers when explicitly introduced.

The coordinator should be thought of primarily as a **context router and orchestration layer**, not necessarily as the agent doing all implementation itself.

---

## 2. Pi Coordination / Communication Extension

Create a new Pi extension specifically for coordination and agent-to-agent communication.

Each Pi instance running the extension exposes a small local endpoint, for example over localhost HTTP, WebSocket, Unix socket, or another lightweight transport.

The extension should handle:

- Agent identity
- Registration
- Discovery
- Messaging
- Status
- Task assignment
- Handoffs
- Result reporting
- Durable event/message history

The extension should not depend on Herder.

---

## 3. Coordinator Startup

A Pi instance can be started in **coordinator mode**.

On startup, it:

1. Starts its local communication endpoint.
2. Creates or opens the coordination state for the current feature/task.
3. Becomes the authoritative registry for participating agents.
4. Can spawn new Pi worker processes.

Conceptually:

```text
Coordinator
    |
    +-- local endpoint: localhost:<port>
    |
    +-- agent registry
    +-- task state
    +-- decisions
    +-- messages / journal
```

---

## 4. Spawning a Worker

When the coordinator needs another agent, it launches a new Pi instance and passes enough bootstrap information for it to join the current coordination session.

For example:

```text
pi
  --agent-id frontend-01
  --coordinator http://127.0.0.1:43100
  --role implementation
  --objective "Implement the frontend changes for feature X"
```

The exact mechanism can be environment variables, command-line arguments, a bootstrap file, or similar.

The important point is that the worker knows:

- Its own identity
- The coordinator's address
- Its initial role
- Its initial objective

---

## 5. Worker Registration / Handshake

The first thing a worker does after starting is:

1. Start its own local communication endpoint.
2. Contact the coordinator.
3. Register itself.

Example registration payload:

```json
{
  "agentId": "frontend-01",
  "role": "implementation",
  "capabilities": [
    "frontend",
    "typescript",
    "testing"
  ],
  "status": "ready",
  "endpoint": "http://127.0.0.1:43127"
}
```

The coordinator now knows:

```text
frontend-01
    role: implementation
    status: ready
    endpoint: localhost:43127
```

This creates simple runtime service discovery without requiring a central external service.

---

## 6. Communication Model

Communication should use explicit structured messages rather than free-form terminal interaction.

A small initial message vocabulary could be:

```text
request
result
handoff
change-request
status
question
decision
cancel
```

Example request:

```json
{
  "type": "request",
  "id": "msg-184",
  "from": "coordinator",
  "to": "api-01",
  "objective": "Add the mobile-order status endpoint",
  "context": {
    "contract": "artifacts/mobile-order-api.md"
  }
}
```

Example result:

```json
{
  "type": "result",
  "replyTo": "msg-184",
  "from": "api-01",
  "status": "completed",
  "summary": "Added GET /orders/{id}/status",
  "artifacts": [
    "src/Orders/OrderStatusEndpoint.cs"
  ],
  "notes": [
    "Frontend can now consume the endpoint."
  ]
}
```

The protocol should be intentionally small at first.

---

## 7. Coordinator-to-Worker and Worker-to-Coordinator

The normal flow is:

```text
Coordinator
     |
     | objective / request
     v
Worker
     |
     | result / question / status
     v
Coordinator
```

Workers should not have to continuously poll the coordinator if direct push communication is available.

Likewise, the coordinator should be able to push additional context, decisions, or revised objectives to an active worker.

---

## 8. Optional Worker-to-Worker Communication

Direct worker-to-worker communication can be supported, but it should not be the default coordination mechanism.

For example, the coordinator could introduce two agents:

```text
Coordinator:

api-01:
    frontend-01 is available at localhost:43127

frontend-01:
    api-01 is available at localhost:43131
```

After that, the frontend agent could ask the API agent directly about a contract detail.

However, important outcomes should still be reported into the shared coordination state so the coordinator does not lose visibility.

In other words:

> Peer-to-peer communication is useful for efficiency, but authoritative state should remain centralized.

---

## 9. Durable Coordination State

Do not rely on terminal history or conversational memory as the source of truth.

Maintain a durable journal/state store.

A simple first version could use SQLite or files.

It should contain things such as:

```text
Feature
Agents
Assignments
Messages
Decisions
Artifacts
Handoffs
Status
Dependencies
```

For example:

```text
feature/
    state.json
    decisions.md
    contracts/
    reports/
    messages/
```

or a SQLite schema with corresponding tables.

This makes agents replaceable.

If an agent crashes or its context becomes polluted, the coordinator can launch a new one and reconstruct the relevant context from durable state.

---

## 10. Context Management

One of the main purposes of the architecture is to keep agent context:

- Small
- Relevant
- Current
- Explicit

Instead of giving every agent the entire project history, the coordinator provides only the information needed for the current task.

For example:

```text
Frontend worker receives:

- feature objective
- API contract
- frontend repository
- relevant design decisions
- acceptance criteria
```

It does **not** need:

```text
- all API implementation discussion
- unrelated research
- every message between other agents
- old discarded approaches
```

This is a major reason to use multiple agents in the first place.

---

## 11. Multi-Project Features

For a solution such as a mobile ordering platform with:

- Configuration portal
- Backend API
- Device/mobile app

the coordinator represents the **overall feature**, while implementation workers can represent the individual projects.

Example:

```text
                     Coordinator
                          |
          +---------------+---------------+
          |               |               |
       Portal           API             App
       Agent            Agent           Agent
```

The coordinator owns cross-project concerns such as:

- Contracts
- API shapes
- Shared decisions
- Dependencies
- Delivery order
- Acceptance criteria

Each implementation worker owns its project-specific work.

A useful default is:

> **One implementation agent per actively modified project/repository.**

That is a default, not a hard architectural restriction.

---

## 12. Specialist Agents

Workers do not have to map to repositories.

The coordinator can also launch short-lived specialist agents.

Examples:

```text
research-agent
architecture-agent
test-agent
review-agent
debug-agent
security-agent
migration-agent
```

Typical flow:

```text
Coordinator
    |
    +-- Research agent
    |       -> investigates options
    |       -> returns report
    |
    +-- API implementation agent
    |
    +-- Frontend implementation agent
    |
    +-- Test agent
    |       -> validates combined change
    |
    +-- Review agent
            -> reviews implementation
```

These agents can be discarded after returning their result.

This helps prevent long-lived contexts from becoming overloaded.

---

## 13. Handoffs

A handoff should be explicit rather than merely telling another agent to "go look at what changed."

For example:

```json
{
  "type": "handoff",
  "from": "api-01",
  "to": "frontend-01",
  "summary": "Order status endpoint is implemented.",
  "contract": "contracts/order-status-v2.md",
  "commit": "abc123",
  "action": "Update frontend polling logic to use the new response format."
}
```

This makes the transfer:

- Discoverable
- Reproducible
- Machine-readable
- Auditable

---

## 14. Agent Lifecycle

A worker lifecycle could be:

```text
spawned
   |
   v
starting
   |
   v
registered
   |
   v
ready
   |
   v
working
   |
   +----> blocked
   |         |
   |         v
   |      working
   |
   v
completed
   |
   v
stopped
```

Possible statuses:

```text
starting
ready
working
waiting
blocked
completed
failed
stopped
```

The coordinator can use this to understand the state of the whole team.

---

## 15. Launcher Abstraction

Process launching should be separate from communication.

Define a launcher abstraction such as:

```text
AgentLauncher
    launch(...)
    stop(...)
    inspect(...)
```

Possible implementations:

```text
SubprocessLauncher
HerderLauncher
DockerLauncher
RemoteLauncher
SSHLauncher
```

This separation is important.

The coordination protocol should not care how the Pi process appeared.

---

## 16. Role of Herder

Herder should be **optional**.

It can be useful for:

- Opening a new tab/pane for each agent
- Giving the developer visual access to running agents
- Showing logs
- Switching between agents
- Manually interacting with an agent

But Herder should **not** be responsible for:

- Agent identity
- Messaging protocol
- Coordination state
- Discovery
- Handoffs
- Agent lifecycle semantics
- Feature state

Architecturally:

```text
             Coordination Layer
                    |
          +---------+---------+
          |                   |
       Pi Agents          State Store
          |
      Launch Layer
          |
    +-----+------+
    |            |
Subprocess     Herder
```

Herder becomes one possible view/launcher for the system rather than a dependency.

---

## 17. Minimal Version 1

The first implementation should stay deliberately small.

A useful V1 might support only:

### Coordinator

```text
start-coordinator
spawn-agent
list-agents
send
stop-agent
```

### Worker

```text
register
status
send
complete
```

### Messages

```text
request
result
handoff
status
question
```

### State

```text
agents
messages
assignments
decisions
```

That is enough to test whether the interaction model actually improves development workflow before building a larger orchestration platform.

---

## 18. Example End-to-End Flow

A feature needs changes to the API and mobile app.

### Step 1 — Coordinator starts

```text
Feature:
"Support scheduled mobile orders"
```

### Step 2 — Coordinator launches research agent

```text
Objective:
Investigate implications for current order lifecycle.
```

Research agent returns:

```text
- required states
- existing constraints
- recommended API changes
```

### Step 3 — Coordinator records decisions

```text
scheduledAt is UTC
orders can be scheduled up to 7 days ahead
API contract v2 selected
```

### Step 4 — Coordinator launches API agent

```text
Implement contract v2.
```

### Step 5 — Coordinator launches app agent

```text
Implement scheduled-order UI against contract v2.
```

Both work in parallel.

### Step 6 — API agent completes

It sends:

```text
result
commit
contract confirmation
handoff to app agent
```

### Step 7 — App agent consumes handoff

The coordinator forwards only the relevant new information.

### Step 8 — Test agent starts

It receives:

```text
feature definition
acceptance criteria
API change
app change
```

and validates the combined behavior.

### Step 9 — Review agent starts

It reviews the resulting feature as a whole.

### Step 10 — Coordinator summarizes

```text
Feature complete
API: complete
App: complete
Tests: passing
Review: complete
Outstanding issues: none
```

---

## 19. Design Principles

The architecture should follow a few strong principles.

### Keep agents replaceable

Important state belongs outside the agent conversation.

### Communicate objectives, not huge prompts

Give workers focused briefs.

### Prefer artifacts over conversational memory

Contracts, decisions, reports, and handoffs should be persisted.

### Separate transport from semantics

HTTP, sockets, or Herder are implementation details.

The important layer is:

```text
request
result
handoff
decision
status
```

### Separate launching from coordination

How a process is started must not define how agents communicate.

### Centralize authority, not necessarily communication

The coordinator owns authoritative feature state, but workers may communicate directly when useful.

### Spawn specialists temporarily

Research, testing, review, and debugging agents can exist only for the time needed.

### Start small

Do not build a large distributed-agent platform before proving that a minimal protocol improves the workflow.

---

## 20. Longer-Term Possibilities

Once the basic model works, it could evolve toward:

- Remote workers
- Workers on other machines
- Containerized agents
- Agent capability discovery
- Dependency graphs
- Automatic retries
- Agent replacement after failure
- Dynamic specialist selection
- Shared artifact storage
- Event subscriptions
- Agent inboxes
- Priority queues
- Approval gates
- Automated review loops
- Automatic test-agent spawning
- Coordinator recovery
- Multiple coordinators
- Cross-feature agent pools

But none of these are necessary for the first version.

---

## Proposed Mental Model

The simplest mental model is:

```text
                 FEATURE COORDINATOR

             "What are we trying to achieve?"
                         |
         +---------------+---------------+
         |               |               |
      Research       Implementation     Review
                         |
                  +------+------+
                  |             |
                 API           App
```

Every box can be a separate Pi instance.

Each Pi instance runs the same communication extension.

The coordinator decides what context each agent needs and collects the resulting knowledge back into durable feature state.

Herder may display those processes, but the system works exactly the same without Herder.

---

## Final Architecture in One Sentence

> **Build a lightweight agent network around Pi where a coordinator can spawn focused worker instances, workers register their own local endpoints, agents exchange structured messages through a small coordination protocol, important state is persisted centrally, and Herder remains an optional launcher/visualization layer rather than part of the protocol itself.**
