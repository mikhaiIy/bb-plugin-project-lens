# Development-only W03 fixture entry

The file fixture-app.tsx is a separate BB app entry for controlled UI
verification. It is not referenced by the production bb.app manifest field, so
the normal Project Lens bundle does not import
src/fixtures/w03-component-flow.ts or expose a fixture query-parameter branch.

For a disposable verification copy, replace that copy's bb.app value with
./dev/fixture-app.tsx, build/install the copy under a temporary plugin
identity, and remove it after the browser probes. The shipped package keeps
the fixture module for Vitest and this isolated development entry only.
