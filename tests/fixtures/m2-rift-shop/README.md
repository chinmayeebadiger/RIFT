# M2 Rift Shop fixture

This fixture pins the deliberately broken Rift Shop to repository revision
`89bea49f373a23bda2666808976e2e15d707b6e7`. It contains the snapshot checksums,
the four seeded defects, synthetic runtime and regression logs, the intake
manifest, and the expected investigation observations.

The unpatched baseline is reproduced with the manifest command:

```sh
npm --prefix demo test -- --run src/domain/shop.regression.test.ts
```

The command must exit with status `1` and report four failed tests. The M2 API
integration test loads the manifest, runs this command without changing
`demo/`, appends the reproduction and source/log artifacts to the local
evidence store, and validates that each fixture hypothesis cites stored
evidence.

The hypothesis output in that test uses a local deterministic test seam. The
production repository adapter, runner, and hypothesis engine are still M2
implementation gaps and are intentionally not changed by this fixture.
