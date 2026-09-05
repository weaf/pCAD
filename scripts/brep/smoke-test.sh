#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
RUNNER="${PCAD_BREP_RUNNER:-$SCRIPT_DIR/pcad-brep-sandbox}"
WORKSPACE="$(mktemp -d "${TMPDIR:-/tmp}/brepia-brep-smoke.XXXXXX")"
trap 'rm -rf "$WORKSPACE"' EXIT

cat > "$WORKSPACE/request.json" <<'JSON'
{"project":{"schemaVersion":1,"id":"nativeSmoke","name":"Native smoke","units":"mm","placement":{"origin":[0,0,0],"xAxis":[1,0,0],"yAxis":[0,1,0]},"metadata":{"objectType":"smoke-object","classification":"brep-test"},"projectObject":{"footprintNodeId":"body","clearanceEnvelopeNodeId":"finished","maintenanceEnvelopeNodeId":"body","points":[{"id":"cableEntry","kind":"cable","label":"Cable entry","position":[{"parameter":"width"},10,0],"direction":[0,0,1]}]},"parameters":[{"id":"width","label":"Width","type":"number","unit":"mm","default":40,"min":20,"max":80}],"nodes":[{"id":"body","type":"box","width":{"parameter":"width"},"depth":20,"height":20},{"id":"finished","type":"fillet","input":"body","radius":2,"selector":{"kind":"parallelToAxis","axis":"z"}},{"id":"hole","type":"cylinder","radius":4,"height":30},{"id":"holeAt","type":"transform","input":"hole","translate":[20,10,-5]},{"id":"cut","type":"subtract","base":"finished","tools":["holeAt"]}],"resultNodeId":"cut"},"parameterValues":{"width":50}}
JSON

"$RUNNER" --input "$WORKSPACE/request.json" --output "$WORKSPACE/output"
grep -q 'ISO-10303-21' "$WORKSPACE/output/model.step"
node -e "const r=require('$WORKSPACE/output/result.json'); const p=r.projectObject; if(r.status!=='success'||r.resultNodeId!=='cut'||r.bodies?.length!==1||!r.bodies[0]?.viewerMesh?.indices?.length||p?.geometry?.footprint?.id!=='body'||p?.geometry?.clearanceEnvelope?.id!=='finished'||p?.geometry?.maintenanceEnvelope?.id!=='body'||p?.points?.[0]?.position?.[0]!==50||p?.placement?.zAxis?.[2]!==1) process.exit(1); console.log(JSON.stringify({result:r.resultNodeId,triangles:r.bodies[0].viewerMesh.indices.length/3,roles:Object.keys(p.geometry),point:p.points[0]}));"