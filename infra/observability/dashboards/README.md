# The three dashboards of SD §QD-5 — AUTHORED AND VALIDATED, NEVER DEPLOYED

SD §QD-5 names three boards:

> a T&S-visible "golden signals per safety endpoint" board (SA §TS-10) on the
> live-session screen; an engineering SLO board; a finance reconciliation board.

They are **definitions**, and they have exactly the status Terraform has in this
build (`DOCKER.md` §10, PROTOCOL §9.12): authored, held against a real
constraint by a gate, and **never applied**. There is no Grafana, no Grafana
Cloud account, and no route off the host to reach one — `kinvara-int` is
`internal: true` (`DOCKER.md` §7). SA §TS-10's destination is Grafana Cloud;
reaching it is **blocked and escalated, not improvised** (PROTOCOL §9.9).

## What the gate proves, and what it cannot

`pnpm gate:otel-contract` check **R4** parses each file here and refuses:

- a metric name that this pipeline does not produce — the expected set is
  derived from `docker/otel-collector.yaml`'s `spanmetrics` connector
  (`namespace` + the histogram it declares) and from
  `packages/observability/src/provider-health.ts`'s gauge name;
- a label name that is not a dimension of that connector, a default dimension
  of it, or an attribute of the `provider_health` gauge;
- **a label VALUE that is not in the closed set that label draws from** — a
  `route=` literal that is not a key of `ROUTE_REGISTRY`, a `module=` outside
  SA §SA-2's set, a `data_class=` outside SA §SEC-3's four plus the
  `UNCLASSIFIED` refusal marker, a `provider=` or `state=` outside their enums.

That last one is the check worth having: it is what stops a board quietly
naming a route nobody serves, which is the "green check, a line in the DPIA and
zero coverage" failure SD §Revision Log G1 levels at the Revision-1 detector
list.

**What it does NOT prove**, and cannot from here:

- that Grafana would accept the JSON. This is a structural check against the
  subset of the dashboard schema these files use, not the published schema —
  validating against that needs a network fetch at gate time or a vendored
  schema, which is a supply-chain decision (OD-51), and it is named as a bound
  rather than filled with an assumption. The same words are true of
  `gate:workflow` and `.github/workflows/pr.yml` (`T-005` § contract §7).
- that any query returns data. Several panels are scoped to modules whose
  routes are not served yet (`payment`, `session`); they would render empty
  today. Each such panel says so in its own `description`.
- that the PromQL is correct PromQL. Nothing here parses PromQL; the gate reads
  metric names, label names and label values out of the expression text.

## The safety-endpoint board is scoped by MODULE, not by route, and that is why

SA §TS-10 rule 4 asks for golden signals **per safety endpoint**. The safety
endpoints — `POST /arrival`, the SOS route, and everything in `safety-gw` — are
not served yet (`T-012` is the `safety-gw` skeleton; the session routes are
EP-5's). A board naming them would be refused by R4 for naming a route that is
not in the registry, which is the check doing its job. So the board is scoped by
`module` where the routes do not exist yet, and **the per-endpoint breakdown is
owed by whichever ticket first serves a safety endpoint.**
