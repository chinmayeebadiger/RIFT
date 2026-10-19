# Documentation plan

Documentation is part of the product's safety surface. Keep it versioned with
the code and update it in the same change as a contract or policy change.

## Required documents

- **README:** setup, exact commands, project status, and a quick local flow.
- **Architecture:** components, data flow, trust boundaries, and contracts.
- **ADR directory:** one record per consequential decision, especially sandbox,
  persistence, model provider, and approval policy.
- **Operator runbook:** [`operator-runbook.md`](operator-runbook.md) covers
  incident intake, cancellation, cleanup, retention, failure modes, rollback,
  and escalation.
- **Security model:** [`security-model.md`](security-model.md) covers the threat
  model, secret handling, permissions, isolation, scans, sign-off, and residual
  risks.
- **M6 pilot plan:** [`pilot-plan.md`](pilot-plan.md) defines pilot scope,
  entry/exit criteria, scenarios, metrics, and security sign-off.
- **API/schema reference:** versioned manifests, results, and compatibility
  policy with examples containing synthetic data only.
- **Contributor guide:** runtime pin, lockfile workflow, `make test`, fixture
  rules, and review checklist.
- **Recovery report guide:** how to read evidence, confidence, unknowns, and
  verification classifications.

## Documentation acceptance checklist

Every feature review asks:

- Can a new contributor reproduce it from a clean checkout?
- Are inputs, outputs, permissions, and failure modes documented?
- Does the report explain what was observed versus inferred?
- Are commands and versions exact and tested?
- Are secrets and real incident data excluded from examples?
- Is the rollback or cancellation path documented?

## Ownership and cadence

The implementation owner updates the relevant contract and user documentation;
the reviewer checks safety and reproducibility. At each milestone exit, update
the roadmap and record open risks. The M6 pilot must convert observed gaps into
tracked issues or ADRs.
