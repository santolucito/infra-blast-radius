# Web UI — a live front-end for `blast-compare`

A local, browser-based front-end that visualizes the examples interactively. It is
**just a UI**: every score it shows comes from running the real CLI
(`dist/cli.js --json`) on demand — no precomputed results.

```bash
npm run compile     # build dist/cli.js
pipx install cloudsplaining checkov
npm run web         # -> http://localhost:4173
```

Then open http://localhost:4173. Requires `cloudsplaining` (and `checkov` for the
tradeoff example) on `PATH` / in the usual pipx location, plus `git`.

## What you get

- **Example tabs** — the three committed examples (`examples/*`), each with an
  authored infra graph.
- **Infra visualizer** (center) — an access graph: principals → policy/role →
  resources + network, colored by risk. Toggle `fix-A` / `fix-B` (and `baseline`)
  to see the topology change. The shared-role / principal-reach examples draw all
  the principals fanning into a shared policy, so the blast radius is visible.
- **Comparison panel** (right) — live scores for both fixes, the delta vs baseline,
  the driver chips (new actions, risk categories, `unused grants`, `shared-role
  reach ×N`), and the verdict — all from the CLI run.
- **Threat-model slider** (tradeoff only) — re-weights the network channel
  instantly (client-side re-scoring of the returned per-category breakdown) so you
  can watch the verdict move as network sensitivity changes.
- **Deep links** — `#<example>` or `#<example>/<fix>`, e.g.
  `http://localhost:4173/#shared-reach/fix-B`.

## How it works

```
browser  ──GET /api/examples──▶  server (web/server.js)   authored infra graphs
         ──POST /api/compare──▶  builds the example's git repo (examples/*/build-repo.sh)
                                 runs `node dist/cli.js --repo … --json`
         ◀──── Comparison JSON ──  (the real, live tool output)
```

The infra **topology** is authored per example in `web/server.js` (auto-layout of
arbitrary IaC is future work); the **numbers** are always live. Zero external npm
dependencies — Node's `http` + `child_process` only.
