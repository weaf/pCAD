# BRep Phase 5 execution contract

## Status

Phase 5 — project-object contract and Rhino interoperability — is active.

Accepted Phase 5A checkpoint:

```text
601a51ee811d2bbaae236a797b7e0cecd81075eb
Merge pull request #30 from weaf/feature/brep-project-object-contract
Phase 5A: BRep project-object contract
```

Active Phase 5B branch:

```text
feature/brep-project-object-evaluation
```

The current implementation is the source of truth. `docs/brep_kernel_plan.md` provides the roadmap goal, while completed Phase 1–4 execution/status documents are historical evidence.

## Reconciled Phase 5 starting point

The accepted BRep stack provides the canonical project-object concepts:

- `resultNodeId` is the canonical primary BRep feature;
- `placement` is the kernel-neutral local/insertion coordinate system intended to map to a future Grasshopper Plane;
- `metadata` carries explicit object type, classification and bounded custom string properties;
- optional `projectObject` declares footprint, clearance-envelope and maintenance-envelope feature roles plus stable local connection/mounting/cable points.

Before 5B, the native evaluator:

- evaluates only the canonical `resultNodeId`;
- returns one primary body with bounds/viewer mesh;
- exports exact STEP for that primary result;
- does not yet evaluate semantic auxiliary geometry outputs or return resolved project-object semantics.

No `rhino3dm`, openNURBS, RhinoCommon, Rhino.Compute or Grasshopper runtime dependency exists in the application today.

## Phase 5 architecture locks

1. `BrepProject` remains Brepia's only canonical editable BRep source model.
2. Rhino/3DM/Grasshopper artifacts are interoperability outputs, never a second source of truth.
3. The existing isolated build123d/OCCT runtime remains authoritative for native BRep evaluation.
4. `resultNodeId` remains the primary BRep authority; Phase 5 must not invent a competing primary-result field.
5. Existing `placement` remains the local/insertion coordinate contract and must not silently become a local-preview transform.
6. Existing project/node/parameter identities remain stable.
7. Existing OpenSCAD workflows remain independent and unchanged.
8. Phase 5 must not require Rhino to author, edit, evaluate or STEP-export ordinary BRep projects.
9. Rhino.Compute and Grasshopper runtime/component work remain later phases unless explicitly pulled forward by a proven Phase 5 interoperability requirement.
10. Native auxiliary outputs must remain bounded and deterministic.

## Additive v1 source compatibility

Phase 5A added an optional project-object output definition to the existing schema-version-1 project contract.

This remains deliberately additive:

- existing valid v1 projects without project-object outputs remain valid and normalize exactly as before;
- no existing field changes meaning;
- no existing ID is regenerated;
- canonical package import/export transports the complete normalized project snapshot;
- AI complete-snapshot schemas accept and preserve the optional field.

A future breaking source-format change may introduce a new schema version, but optional Phase 5 semantic output declarations do not require one.

## 5A — Canonical project-object contract — complete

### Canonical role mapping

```text
primary BRep               -> resultNodeId
local/insertion plane      -> placement
object metadata            -> metadata
auxiliary semantic outputs -> projectObject
```

`projectObject` may declare:

- `footprintNodeId`;
- `clearanceEnvelopeNodeId`;
- `maintenanceEnvelopeNodeId`;
- bounded stable semantic local `points`.

Each point has stable ID, kind `connection | mounting | cable`, local mm position, optional unitless direction and optional label. Compatible published-parameter references are supported. The geometry roles are semantic node roles rather than kernel-topology IDs.

5A also protects referenced parameters and role-assigned nodes from destructive Phase 4 authoring operations without hidden cascading rewrites.

## 5B — Native project-object evaluation — active

### Result contract

A successful native evaluation gains one required kernel-neutral `projectObject` result alongside the existing primary result fields:

```text
status / provider / projectId / resultNodeId
bodies / bounds                 <- primary result remains authoritative
projectObject
  placement                     <- resolved insertion/local plane
  metadata                      <- canonical object metadata when present
  geometry
    footprint                   <- evaluated role body when declared
    clearanceEnvelope           <- evaluated role body when declared
    maintenanceEnvelope         <- evaluated role body when declared
  points[]                      <- resolved semantic local points
warnings / exactExport
```

The separation is intentional:

- `bodies` and top-level `bounds` retain their accepted Phase 1–4 meaning for the primary `resultNodeId`;
- auxiliary role geometry does not get appended to `bodies` and therefore cannot silently change the current browser viewer;
- exact STEP remains the primary `resultNodeId` shape only;
- future 3DM/Grasshopper interoperability consumes `projectObject` explicitly.

### Resolved semantic data

`projectObject.placement` contains resolved numeric `origin`, `xAxis`, `yAxis` and derived `zAxis` under the exact parameter values used for the geometry evaluation.

Semantic point positions/directions are resolved under the same parameter-value map. Metadata is the canonical source metadata and remains kernel neutral.

A project without any declared `projectObject` roles/points still receives a project-object evaluation envelope containing resolved placement, optional metadata, empty `geometry`, and empty `points`. This gives downstream interoperability one stable result shape without changing the source schema.

### Native auxiliary geometry

The build123d/OCCT driver evaluates declared geometry-role node IDs through the same existing recursive `evaluate_node` DAG cache used for the primary result.

A second cache stores tessellated evaluated-body payloads by stable node ID so a node used by the primary result or multiple semantic roles is tessellated at most once per sandbox evaluation.

The geometry-role body contract reuses `BrepEvaluatedBody`:

- stable Brepia node ID;
- native bounds;
- bounded viewer mesh.

The result JSON may contain the same body payload under more than one semantic role when the source intentionally assigns one node to multiple roles. Overall sandbox output remains bounded by the existing output-size limit.

### Sandbox trust boundary

Native output remains untrusted until validated by the host.

5B validation requires:

- returned `projectId` and `resultNodeId` to match the normalized request;
- the first primary body ID to remain the requested `resultNodeId`;
- every primary and auxiliary body to satisfy the existing bounds/mesh limits;
- each returned semantic geometry role to match exactly the node ID declared for that role;
- no undeclared geometry role to appear;
- resolved placement, metadata and semantic points to equal the deterministic host-side resolution of the normalized source and parameter values;
- no unknown project-object result keys or geometry-role keys.

A mismatch is `output_invalid`; no untrusted project-object result reaches the API response.

### Provider/runtime versioning

The repository-native build123d/OCCT driver increments its provider version from `0.1.0` to `0.2.0` for the expanded result contract. The pinned build123d/OCCT image and security posture are otherwise unchanged; the driver continues to be mounted read-only into the sandbox.

### Exact STEP invariant

`model.step` continues to be exported from the shape returned for `resultNodeId`. Auxiliary-role evaluation does not alter the exported shape or create implicit multi-output STEP behavior.

### 5B non-goals

Do not add in 5B:

- direct project-object authoring UI;
- browser rendering/toggling of auxiliary geometry;
- multi-output STEP or new export formats;
- 3DM/rhino3dm;
- new BRep geometry node types;
- Rhino.Compute;
- Grasshopper component/runtime work;
- application of the placement plane as a local native-preview transform.

## 5C — Project-object authoring and AI product integration

Add direct project-object output authoring over the same canonical source revision lifecycle:

- assign/clear footprint, clearance and maintenance role nodes;
- add/edit/remove stable semantic points;
- use existing source-write guards and immutable CAS persistence;
- expose the complete project-object definition to AI snapshot editing without a second history model.

Graph/navigation UX may identify nodes that carry semantic output roles, but graph layout remains presentation-only.

## 5D — Minimum Rhino/3DM interoperability and Phase 5 closeout

After the neutral contract and native outputs are accepted, add only the minimum 3DM/rhino3dm capability needed to prove the later Grasshopper path.

Before adding a dependency, verify and record:

- exact rhino3dm/openNURBS package/version;
- Linux/headless support in the selected implementation path;
- licensing/distribution terms;
- what exact BRep/geometry conversion is possible from the existing OCCT result without introducing Rhino as the authoritative kernel.

Target Phase 5 interoperability acceptance should prove that a representative BRep project object can produce a 3DM-compatible artifact carrying useful geometry plus placement/object metadata/semantic project outputs where the selected library supports them.

Do not broaden 5D into a Grasshopper component/runtime; that is Phase 6+ work.

## Phase 5A acceptance closeout

Phase 5A was accepted and merged through PR #30. Quality Gates #367 and #368 passed; the slice had no new browser/native-execution product surface and therefore used contract/regression acceptance.

## Phase 5B acceptance

5B is complete only when all of the following hold:

1. A legacy BRep project with no declared semantic roles/points still evaluates successfully and returns primary `bodies`/`bounds` plus an empty project-object geometry/points envelope.
2. Declared footprint, clearance-envelope and maintenance-envelope nodes are evaluated into bounded bodies carrying their exact stable Brepia node IDs.
3. Semantic points resolve literals and published-parameter references under the exact current evaluation values.
4. Resolved placement includes the same origin/xAxis/yAxis and derived zAxis already validated by the shared provider contract; metadata is preserved exactly.
5. Top-level primary `bodies`, `bounds`, `resultNodeId` and existing browser viewer semantics remain unchanged when auxiliary roles are present.
6. The exact STEP artifact remains derived only from `resultNodeId` and imports independently as before.
7. A sandbox result with wrong project/result identity, undeclared/wrong role node, invalid auxiliary mesh, or tampered placement/metadata/point data fails closed as `output_invalid`.
8. Auxiliary evaluation reuses the existing shape/body caches and remains inside the accepted sandbox output/time/resource limits.
9. The repository-native smoke test proves primary geometry, semantic role bodies, resolved point data and exact STEP in one real build123d/OCCT sandbox run.
10. Ordinary BRep projects still preview/export normally in the browser and OpenSCAD behavior remains unchanged.
11. Repository tests/typecheck/lint/build/diff checks are green.
12. Focused native/browser acceptance is recorded before merge.
