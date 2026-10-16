# Documentation plan

Documentation is part of the product's safety surface. Keep it versioned with
the code and update it in the same change as a contract or policy change.

## Required documents

- **README:** setup, exact commands, project status, and a quick local flow.
- **Architecture:** components, data flow, trust boundaries, and contracts.
- **ADR directory:** one record per consequential decision, especially sandbox,
  persistence, model provider, and approval policy.
- **Operator runbook:** incident intake, cancellation, cleanup, retention,
  failure modes, and escalation.
- **Security model:** threat model, secret handling, permissions, isolation,
  audit, and residual risks.
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
