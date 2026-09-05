import { describe, expect, it } from 'vitest';
import {
  BrepEvaluationRequestError,
  normalizeBrepEvaluationRequest,
  resolveBrepProjectObjectSemantics,
  resolveBrepProjectPlacement,
  type BrepEvaluationSuccess,
} from '../shared/brepProvider';
import {
  BREP_PROJECT_SCHEMA_VERSION,
  type BrepProject,
} from '../shared/brepProject';

function project(): BrepProject {
  return {
    schemaVersion: BREP_PROJECT_SCHEMA_VERSION,
    id: 'cabinetA42',
    name: 'Cabinet A42',
    units: 'mm',
    placement: { origin: [0, 0, 0], xAxis: [1, 0, 0], yAxis: [0, 1, 0] },
    parameters: [
      {
        id: 'height',
        label: 'Height',
        type: 'number',
        unit: 'mm',
        default: 1800,
        min: 800,
        max: 3000,
      },
      {
        id: 'width',
        label: 'Width',
        type: 'number',
        unit: 'mm',
        default: 1200,
        min: 600,
        max: 2400,
      },
    ],
    nodes: [
      {
        id: 'body',
        type: 'box',
        width: { parameter: 'width' },
        depth: 600,
        height: { parameter: 'height' },
      },
    ],
    resultNodeId: 'body',
  };
}

function expectRequestError(
  action: () => unknown,
  code: BrepEvaluationRequestError['code'],
): void {
  try {
    action();
  } catch (error) {
    expect(error).toBeInstanceOf(BrepEvaluationRequestError);
    expect((error as BrepEvaluationRequestError).code).toBe(code);
    return;
  }
  throw new Error(`Expected BrepEvaluationRequestError with code ${code}.`);
}

describe('BRep provider contract', () => {
  it('resolves sorted defaults and overrides without mutating the canonical project', () => {
    const source = project();
    const normalized = normalizeBrepEvaluationRequest({
      project: source,
      parameterValues: { width: 1500 },
    });

    expect(normalized.parameterValues).toEqual({ height: 1800, width: 1500 });
    expect(
      source.parameters.find((parameter) => parameter.id === 'width')?.default,
    ).toBe(1200);
    expect(normalized.project).not.toBe(source);
  });

  it('rejects unknown and out-of-range overrides before a provider can execute', () => {
    expectRequestError(
      () =>
        normalizeBrepEvaluationRequest({
          project: project(),
          parameterValues: { missing: 1 },
        }),
      'invalid_parameter_value',
    );
    expectRequestError(
      () =>
        normalizeBrepEvaluationRequest({
          project: project(),
          parameterValues: { width: 1 },
        }),
      'invalid_parameter_value',
    );
  });

  it('resolves a valid placement into an explicit future Grasshopper plane basis', () => {
    const source = project();
    const normalized = normalizeBrepEvaluationRequest({ project: source });
    expect(
      resolveBrepProjectPlacement(
        normalized.project.placement,
        normalized.parameterValues,
      ),
    ).toEqual({
      origin: [0, 0, 0],
      xAxis: [1, 0, 0],
      yAxis: [0, 1, 0],
      zAxis: [0, 0, 1],
    });
  });

  it('resolves semantic project-object points under current parameter overrides', () => {
    const source = project();
    source.metadata = { objectType: 'cabinet', classification: 'equipment' };
    source.projectObject = {
      footprintNodeId: 'body',
      points: [
        {
          id: 'cableEntry',
          kind: 'cable',
          label: 'Cable entry',
          position: [{ parameter: 'width' }, 25, 0],
          direction: [0, 0, 1],
        },
      ],
    };
    const normalized = normalizeBrepEvaluationRequest({
      project: source,
      parameterValues: { width: 1500 },
    });

    expect(
      resolveBrepProjectObjectSemantics(
        normalized.project,
        normalized.parameterValues,
      ),
    ).toEqual({
      placement: {
        origin: [0, 0, 0],
        xAxis: [1, 0, 0],
        yAxis: [0, 1, 0],
        zAxis: [0, 0, 1],
      },
      metadata: { objectType: 'cabinet', classification: 'equipment' },
      points: [
        {
          id: 'cableEntry',
          kind: 'cable',
          label: 'Cable entry',
          position: [1500, 25, 0],
          direction: [0, 0, 1],
        },
      ],
    });
  });

  it('rejects zero-length and collinear placement axes before provider execution', () => {
    const zeroAxis = project();
    zeroAxis.placement.xAxis = [0, 0, 0];
    expectRequestError(
      () => normalizeBrepEvaluationRequest({ project: zeroAxis }),
      'invalid_placement',
    );

    const collinear = project();
    collinear.placement.yAxis = [2, 0, 0];
    expectRequestError(
      () => normalizeBrepEvaluationRequest({ project: collinear }),
      'invalid_placement',
    );
  });

  it('validates placement after published parameter overrides are resolved', () => {
    const source = project();
    source.parameters.push({
      id: 'axisY',
      label: 'Placement Y axis',
      type: 'number',
      unit: 'none',
      default: 1,
      min: 0,
      max: 1,
    });
    source.placement.yAxis = [0, { parameter: 'axisY' }, 0];

    expect(
      normalizeBrepEvaluationRequest({ project: source }).parameterValues.axisY,
    ).toBe(1);
    expectRequestError(
      () =>
        normalizeBrepEvaluationRequest({
          project: source,
          parameterValues: { axisY: 0 },
        }),
      'invalid_placement',
    );
  });

  it('has a kernel-neutral success payload with stable Brepia body identities', () => {
    const result: BrepEvaluationSuccess = {
      status: 'success',
      provider: {
        id: 'build123d-occt',
        providerVersion: '0.2.0',
        kernelVersion: 'OCCT-7.8',
      },
      projectId: 'cabinetA42',
      resultNodeId: 'body',
      bodies: [{ id: 'body', bounds: { min: [0, 0, 0], max: [1, 1, 1] } }],
      bounds: { min: [0, 0, 0], max: [1, 1, 1] },
      projectObject: {
        placement: {
          origin: [0, 0, 0],
          xAxis: [1, 0, 0],
          yAxis: [0, 1, 0],
          zAxis: [0, 0, 1],
        },
        geometry: {},
        points: [],
      },
      warnings: [],
      exactExport: { format: 'step', available: true },
    };
    expect(result.bodies[0].id).toBe('body');
    expect(result.projectObject.geometry).toEqual({});
  });
});
