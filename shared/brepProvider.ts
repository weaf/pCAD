import {
  BREP_PROJECT_MAX_ABS_SCALAR,
  BrepProjectError,
  normalizeBrepProject,
  type BrepProject,
  type BrepProjectMetadata,
  type BrepProjectObjectPointKind,
  type BrepProjectPlacement,
  type BrepScalar,
  type BrepVector3,
} from './brepProject';

export const BREP_EVALUATION_MAX_BODY_COUNT = 64;
export const BREP_EVALUATION_MAX_VIEWER_VERTICES = 500_000;
export const BREP_EVALUATION_MAX_VIEWER_TRIANGLES = 1_000_000;
const BREP_PLACEMENT_MIN_SQUARED_LENGTH = 1e-18;
const BREP_PLACEMENT_MIN_SINE_SQUARED = 1e-12;

export type BrepParameterValues = Record<string, number>;

export type BrepEvaluationRequest = {
  project: BrepProject;
  parameterValues?: BrepParameterValues;
};

export type NormalizedBrepEvaluationRequest = {
  project: BrepProject;
  /** Complete, sorted, resolved public parameter values; the source project is never mutated. */
  parameterValues: BrepParameterValues;
};

export type BrepResolvedPlacement = {
  origin: [number, number, number];
  xAxis: [number, number, number];
  yAxis: [number, number, number];
  /** Derived from xAxis × yAxis; consumers may normalize it as needed. */
  zAxis: [number, number, number];
};

export type BrepResolvedProjectObjectPoint = {
  id: string;
  kind: BrepProjectObjectPointKind;
  position: [number, number, number];
  direction?: [number, number, number];
  label?: string;
};

export type BrepProviderMetadata = {
  id: string;
  providerVersion: string;
  kernelVersion: string;
};

export type BrepBounds = {
  min: [number, number, number];
  max: [number, number, number];
};

export type BrepViewerMesh = {
  /** Stable body/object identity, derived from Brepia feature IDs rather than OCCT indexes. */
  bodyId: string;
  positions: number[];
  normals: number[];
  indices: number[];
  color?: string;
};

export type BrepEvaluatedBody = {
  /** Brepia feature ID that produced this body. */
  id: string;
  bounds: BrepBounds;
  viewerMesh?: BrepViewerMesh;
};

export type BrepProjectObjectGeometryResult = {
  footprint?: BrepEvaluatedBody;
  clearanceEnvelope?: BrepEvaluatedBody;
  maintenanceEnvelope?: BrepEvaluatedBody;
};

/**
 * Kernel-neutral evaluated reusable-object contract. Primary geometry remains
 * in bodies/resultNodeId; semantic auxiliary geometry is isolated here so
 * existing viewer and exact STEP behavior keep their accepted meaning.
 */
export type BrepEvaluatedProjectObject = {
  placement: BrepResolvedPlacement;
  metadata?: BrepProjectMetadata;
  geometry: BrepProjectObjectGeometryResult;
  points: BrepResolvedProjectObjectPoint[];
};

export type BrepResolvedProjectObjectSemantics = Omit<
  BrepEvaluatedProjectObject,
  'geometry'
>;

export type BrepExactExportCapability = {
  format: 'step';
  available: boolean;
};

export type BrepEvaluationSuccess = {
  status: 'success';
  provider: BrepProviderMetadata;
  projectId: string;
  resultNodeId: string;
  bodies: BrepEvaluatedBody[];
  bounds: BrepBounds;
  projectObject: BrepEvaluatedProjectObject;
  warnings: string[];
  exactExport: BrepExactExportCapability;
};

export type BrepEvaluationFailure = {
  status: 'failure';
  provider: BrepProviderMetadata;
  code:
    | 'invalid_project'
    | 'unsupported_operation'
    | 'ambiguous_selection'
    | 'evaluation_failed'
    | 'sandbox_unavailable'
    | 'timeout';
  message: string;
  warnings: string[];
};

export type BrepEvaluationResult =
  | BrepEvaluationSuccess
  | BrepEvaluationFailure;

/** This boundary is intentionally process-agnostic. Native implementations live behind a sandbox runner. */
export interface BrepProvider {
  readonly metadata: BrepProviderMetadata;
  evaluate(
    request: NormalizedBrepEvaluationRequest,
    signal?: AbortSignal,
  ): Promise<BrepEvaluationResult>;
}

export class BrepEvaluationRequestError extends Error {
  constructor(
    public readonly code:
      | 'invalid_request'
      | 'invalid_parameter_value'
      | 'invalid_placement',
    message: string,
  ) {
    super(message);
    this.name = 'BrepEvaluationRequestError';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function normalizeOverride(value: unknown, parameterId: string): number {
  if (
    typeof value !== 'number' ||
    !Number.isFinite(value) ||
    Math.abs(value) > BREP_PROJECT_MAX_ABS_SCALAR
  ) {
    throw new BrepEvaluationRequestError(
      'invalid_parameter_value',
      `BRep parameter ${parameterId} override must be a finite bounded number.`,
    );
  }
  return Object.is(value, -0) ? 0 : value;
}

function resolveScalar(
  value: BrepScalar,
  parameterValues: Readonly<BrepParameterValues>,
): number {
  return typeof value === 'number' ? value : parameterValues[value.parameter];
}

function resolveVector(
  value: BrepVector3,
  parameterValues: Readonly<BrepParameterValues>,
): [number, number, number] {
  return [
    resolveScalar(value[0], parameterValues),
    resolveScalar(value[1], parameterValues),
    resolveScalar(value[2], parameterValues),
  ];
}

function squaredLength(vector: readonly number[]): number {
  return vector.reduce((sum, component) => sum + component * component, 0);
}

function cross(
  left: readonly [number, number, number],
  right: readonly [number, number, number],
): [number, number, number] {
  return [
    left[1] * right[2] - left[2] * right[1],
    left[2] * right[0] - left[0] * right[2],
    left[0] * right[1] - left[1] * right[0],
  ];
}

/**
 * Resolve the kernel-neutral placement using the same published parameter
 * values as geometry evaluation and reject planes that Rhino/Grasshopper could
 * not represent reliably. Axis magnitudes are intentionally preserved; only
 * zero/near-zero and collinear/near-collinear axes are rejected.
 */
export function resolveBrepProjectPlacement(
  placement: BrepProjectPlacement,
  parameterValues: Readonly<BrepParameterValues>,
): BrepResolvedPlacement {
  const origin = resolveVector(placement.origin, parameterValues);
  const xAxis = resolveVector(placement.xAxis, parameterValues);
  const yAxis = resolveVector(placement.yAxis, parameterValues);
  const xLengthSquared = squaredLength(xAxis);
  const yLengthSquared = squaredLength(yAxis);

  if (
    xLengthSquared <= BREP_PLACEMENT_MIN_SQUARED_LENGTH ||
    yLengthSquared <= BREP_PLACEMENT_MIN_SQUARED_LENGTH
  ) {
    throw new BrepEvaluationRequestError(
      'invalid_placement',
      'BRep placement axes must have non-zero length.',
    );
  }

  const zAxis = cross(xAxis, yAxis);
  const crossLengthSquared = squaredLength(zAxis);
  if (
    crossLengthSquared <=
    BREP_PLACEMENT_MIN_SINE_SQUARED * xLengthSquared * yLengthSquared
  ) {
    throw new BrepEvaluationRequestError(
      'invalid_placement',
      'BRep placement xAxis and yAxis must not be collinear.',
    );
  }

  return { origin, xAxis, yAxis, zAxis };
}

/** Resolve non-kernel project-object data under the exact evaluation values. */
export function resolveBrepProjectObjectSemantics(
  project: BrepProject,
  parameterValues: Readonly<BrepParameterValues>,
): BrepResolvedProjectObjectSemantics {
  return {
    placement: resolveBrepProjectPlacement(project.placement, parameterValues),
    ...(project.metadata ? { metadata: project.metadata } : {}),
    points: (project.projectObject?.points ?? []).map((point) => ({
      id: point.id,
      kind: point.kind,
      position: resolveVector(point.position, parameterValues),
      ...(point.direction
        ? { direction: resolveVector(point.direction, parameterValues) }
        : {}),
      ...(point.label ? { label: point.label } : {}),
    })),
  };
}

export function normalizeBrepEvaluationRequest(
  value: unknown,
): NormalizedBrepEvaluationRequest {
  if (!isRecord(value)) {
    throw new BrepEvaluationRequestError(
      'invalid_request',
      'BRep evaluation request must be an object.',
    );
  }

  let project: BrepProject;
  try {
    project = normalizeBrepProject(value.project);
  } catch (error) {
    if (error instanceof BrepProjectError) {
      throw new BrepEvaluationRequestError('invalid_request', error.message);
    }
    throw error;
  }

  if (value.parameterValues != null && !isRecord(value.parameterValues)) {
    throw new BrepEvaluationRequestError(
      'invalid_request',
      'BRep parameterValues must be an object.',
    );
  }
  const overrides = value.parameterValues ?? {};
  const parametersById = new Map(
    project.parameters.map((parameter) => [parameter.id, parameter]),
  );
  const overrideEntries = Object.entries(overrides);
  if (overrideEntries.length > project.parameters.length) {
    throw new BrepEvaluationRequestError(
      'invalid_request',
      'BRep request has too many parameter overrides.',
    );
  }
  for (const [id] of overrideEntries) {
    if (!parametersById.has(id)) {
      throw new BrepEvaluationRequestError(
        'invalid_parameter_value',
        `Unknown BRep published parameter: ${id}.`,
      );
    }
  }

  const parameterValues: BrepParameterValues = {};
  for (const parameter of project.parameters) {
    const rawValue = Object.prototype.hasOwnProperty.call(
      overrides,
      parameter.id,
    )
      ? overrides[parameter.id]
      : parameter.default;
    const normalized = normalizeOverride(rawValue, parameter.id);
    if (parameter.min != null && normalized < parameter.min) {
      throw new BrepEvaluationRequestError(
        'invalid_parameter_value',
        `BRep parameter ${parameter.id} is below its minimum.`,
      );
    }
    if (parameter.max != null && normalized > parameter.max) {
      throw new BrepEvaluationRequestError(
        'invalid_parameter_value',
        `BRep parameter ${parameter.id} exceeds its maximum.`,
      );
    }
    parameterValues[parameter.id] = normalized;
  }

  resolveBrepProjectObjectSemantics(project, parameterValues);

  return { project, parameterValues };
}
