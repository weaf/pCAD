"""Constrained build123d evaluator. Input is normalized Brepia JSON, never user Python."""
import json
import sys
from pathlib import Path

from build123d import Box, Cylinder, Location, export_step

PROVIDER = {"id": "build123d-occt", "providerVersion": "0.2.0", "kernelVersion": "build123d-0.11.1/OCCT-7.9.3.1"}

def scalar(value, parameters):
    return parameters[value["parameter"]] if isinstance(value, dict) else value

def vector(value, parameters):
    return tuple(scalar(item, parameters) for item in value)

def cross(left, right):
    return (
        left[1] * right[2] - left[2] * right[1],
        left[2] * right[0] - left[0] * right[2],
        left[0] * right[1] - left[1] * right[0],
    )

def resolved_placement(placement, parameters):
    origin = vector(placement["origin"], parameters)
    x_axis = vector(placement["xAxis"], parameters)
    y_axis = vector(placement["yAxis"], parameters)
    return {"origin": origin, "xAxis": x_axis, "yAxis": y_axis, "zAxis": cross(x_axis, y_axis)}

def resolved_point(point, parameters):
    result = {
        "id": point["id"],
        "kind": point["kind"],
        "position": vector(point["position"], parameters),
    }
    if "direction" in point:
        result["direction"] = vector(point["direction"], parameters)
    if "label" in point:
        result["label"] = point["label"]
    return result

def bounds(shape):
    box = shape.bounding_box()
    return {"min": [box.min.X, box.min.Y, box.min.Z], "max": [box.max.X, box.max.Y, box.max.Z]}

def mesh(shape, body_id):
    vertices, triangles = shape.tessellate(0.25)
    positions = [coordinate for vertex in vertices for coordinate in (vertex.X, vertex.Y, vertex.Z)]
    indices = [index for triangle in triangles for index in triangle]
    # build123d tessellation does not guarantee normals. Browser consumers can
    # compute them; this bounded neutral payload explicitly represents that.
    return {"bodyId": body_id, "positions": positions, "normals": [0.0] * len(positions), "indices": indices}

def axis_edges(shape, axis):
    wanted = {"x": (1, 0, 0), "y": (0, 1, 0), "z": (0, 0, 1)}[axis]
    selected = []
    for edge in shape.edges():
        tangent = edge.tangent_at(0.5)
        length = (tangent.X ** 2 + tangent.Y ** 2 + tangent.Z ** 2) ** 0.5
        if length and abs(abs(tangent.X / length) - wanted[0]) < 1e-6 and abs(abs(tangent.Y / length) - wanted[1]) < 1e-6 and abs(abs(tangent.Z / length) - wanted[2]) < 1e-6:
            selected.append(edge)
    if not selected:
        raise ValueError(f"ambiguous_selection: no edges parallel to {axis}")
    return selected

def evaluate(request):
    project = request["project"]
    parameters = request["parameterValues"]
    shapes = {}
    body_payloads = {}
    nodes = {node["id"]: node for node in project["nodes"]}

    def evaluate_node(node_id):
        if node_id in shapes:
            return shapes[node_id]
        node = nodes[node_id]
        kind = node["type"]
        if kind == "box": shape = Box(scalar(node["width"], parameters), scalar(node["depth"], parameters), scalar(node["height"], parameters))
        elif kind == "cylinder": shape = Cylinder(scalar(node["radius"], parameters), scalar(node["height"], parameters))
        elif kind == "transform":
            shape = evaluate_node(node["input"])
            translation = vector(node.get("translate", [0, 0, 0]), parameters)
            rotation = vector(node.get("rotateDeg", [0, 0, 0]), parameters)
            shape = shape.moved(Location(translation, rotation))
        elif kind == "subtract":
            shape = evaluate_node(node["base"])
            for tool in node["tools"]: shape = shape - evaluate_node(tool)
        elif kind == "fillet":
            input_shape = evaluate_node(node["input"])
            shape = input_shape.fillet(scalar(node["radius"], parameters), axis_edges(input_shape, node["selector"]["axis"]))
        else: raise ValueError(f"unsupported_operation: {kind}")
        shapes[node_id] = shape
        return shape

    def evaluated_body(node_id):
        if node_id in body_payloads:
            return body_payloads[node_id]
        shape = evaluate_node(node_id)
        payload = {"id": node_id, "bounds": bounds(shape), "viewerMesh": mesh(shape, node_id)}
        body_payloads[node_id] = payload
        return payload

    result_id = project["resultNodeId"]
    result = evaluate_node(result_id)
    primary_body = evaluated_body(result_id)

    definition = project.get("projectObject") or {}
    geometry = {}
    role_fields = (
        ("footprint", "footprintNodeId"),
        ("clearanceEnvelope", "clearanceEnvelopeNodeId"),
        ("maintenanceEnvelope", "maintenanceEnvelopeNodeId"),
    )
    for role, field in role_fields:
        node_id = definition.get(field)
        if node_id:
            geometry[role] = evaluated_body(node_id)

    project_object = {
        "placement": resolved_placement(project["placement"], parameters),
        "geometry": geometry,
        "points": [resolved_point(point, parameters) for point in definition.get("points", [])],
    }
    if "metadata" in project:
        project_object["metadata"] = project["metadata"]

    return result, {
        "status": "success",
        "provider": PROVIDER,
        "projectId": project["id"],
        "resultNodeId": result_id,
        "bodies": [primary_body],
        "bounds": primary_body["bounds"],
        "projectObject": project_object,
        "warnings": [],
        "exactExport": {"format": "step", "available": True},
    }

if __name__ == "__main__":
    try:
        request = json.loads(Path(sys.argv[1]).read_text())
        output = Path(sys.argv[2]); output.mkdir(parents=True, exist_ok=True)
        shape, result = evaluate(request)
        export_step(shape, output / "model.step")
        (output / "result.json").write_text(json.dumps(result, separators=(",", ":")))
    except Exception as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
