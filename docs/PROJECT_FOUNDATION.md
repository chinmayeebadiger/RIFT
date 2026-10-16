# Rift project foundation

## Product outcome

Rift reduces time to safe recovery for software incidents. It must produce a
reproducible chain from an observed failure to a proposed change and then to
verification evidence. A plausible patch without evidence is not a successful
Rift result.

### Primary users

1. **Incident responders** need a fast, explainable investigation and safe
   candidate fixes.
2. **Service owners** need confidence that a proposed fix addresses the failure
   without hiding regressions.
3. **Platform/security owners** need policy controls, isolation, and an audit
   trail for every action.

## Initial scope

The first release will support one repository, one incident at a time, and a
well-defined adapter for logs and test execution. It will:

- ingest a bounded incident bundle;
- normalize logs, stack traces, commits, and environment metadata;
- generate ranked causal hypotheses with citations to evidence;
- generate one or more candidate patches;
- apply each patch in a disposable, isolated verification workspace;
- run configured tests and targeted reproductions;
- compare baseline and patched results;
- publish a report with evidence, uncertainty, and required human approval.

Out of scope for the first release: autonomous production deployment, secrets
discovery, unrestricted internet access from sandboxes, multi-repository repair,
and silently modifying a user's working tree.

## Non-negotiable principles

- **Evidence first:** every assertion links to an immutable evidence item or is
  explicitly labelled as an inference.
- **Least privilege:** source, logs, network, credentials, and execution
  capabilities are granted per incident and per phase.
- **Isolation by default:** candidate patches run in disposable environments;
  the verifier cannot write to the host repository or production systems.
- **Human control:** Rift may investigate and verify, but production changes
  require explicit human approval in the first release.
- **Reproducibility:** an incident manifest, tool versions, patch, commands,
  and results are sufficient to repeat verification.
- **Fail closed:** missing evidence, policy violations, or inconclusive tests
  yield an inconclusive result, never a success claim.

## Decisions still open before implementation

- supported repository languages and test runners;
- sandbox backend (Docker first, with a runner interface for stronger isolation);
- model/provider selection and data-retention policy;
- persistence technology and retention period;
- whether the first interface is CLI, local service, or both.

These are intentionally recorded as decisions, not hidden assumptions. The
first implementation slice should use local files and a deterministic fake
model so it remains testable offline.

## Acceptance gate for implementation

Implementation begins after the architecture contracts are reviewed and the
team can answer: what evidence may enter the system, what actions are allowed,
how a sandbox is isolated, what constitutes a verified fix, and where a human
must approve.
