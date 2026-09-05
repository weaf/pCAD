import { execFile } from 'node:child_process';
import { lstat, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import {
  BREP_EVALUATION_MAX_BODY_COUNT,
  BREP_EVALUATION_MAX_VIEWER_TRIANGLES,
  BREP_EVALUATION_MAX_VIEWER_VERTICES,
  normalizeBrepEvaluationRequest,
  resolveBrepProjectObjectSemantics,
  type BrepEvaluatedBody,
  type BrepEvaluationResult,
  type BrepEvaluationSuccess,
  type BrepParameterValues,
  type NormalizedBrepEvaluationRequest,
} from '@shared/brepProvider';
import type { BrepProject } from '@shared/brepProject';

const execFileAsync = promisify(execFile);
export const BREP_EVALUATION_TIMEOUT_MS = 45_000;
export const BREP_EVALUATION_OUTPUT_LIMIT_BYTES = 64 * 1024 * 1024;
export const BREP_EVALUATION_DEFAULT_MAX_CONCURRENT = 1;
const BREP_EVALUATION_MAX_CONCURRENT_LIMIT = 4;
let activeEvaluations = 0;

export class BrepEvaluationError extends Error {
  constructor(
    public readonly code:
      | 'provider_unavailable'
      | 'capacity_exceeded'
      | 'evaluation_failed'
      | 'evaluation_timeout'
      | 'evaluation_cancelled'
      | 'output_invalid'
      | 'output_too_large',
    message: string,
  ) {
    super(message);
    this.name = 'BrepEvaluationError';
  }
}

function runner(): string {
  const configured = process.env.PCAD_BREP_RUNNER?.trim();
  if (!configured)
    throw new BrepEvaluationError(
      'provider_unavailable',
      'BRep evaluation is not configured on this server.',
    );
  return configured;
}

function maxConcurrent(): number {
  const value = Number.parseInt(process.env.PCAD_BREP_MAX_CONCURRENT ?? '', 10);
  return !Number.isFinite(value) || value < 1
    ? BREP_EVALUATION_DEFAULT_MAX_CONCURRENT
    : Math.min(value, BREP_EVALUATION_MAX_CONCURRENT_LIMIT);
}

function acquireSlot(): () => void {
  if (activeEvaluations >= maxConcurrent())
    throw new BrepEvaluationError(
      'capacity_exceeded',
      'BRep evaluation capacity is currently busy. Try again shortly.',
    );
  activeEvaluations += 1;
  let released = false;
  return () => {
    if (!released) {
      released = true;
      activeEvaluations = Math.max(0, activeEvaluations - 1);
    }
  };
}

function throwIfEvaluationAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new BrepEvaluationError(
      'evaluation_cancelled',
      'BRep evaluation was cancelled.',
    );
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function finiteVector(value: unknown): value is [number, number, number] {
  return (
    Array.isArray(value) &&
    value.length === 3 &&
    value.every((item) => typeof item === 'number' && Number.isFinite(item))
  );
}

function valuesEqual(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    return (
      Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((item, index) => valuesEqual(item, right[index]))
    );
  }
  if (isRecord(left) || isRecord(right)) {
    if (!isRecord(left) || !isRecord(right)) return false;
    const leftKeys = Object.keys(left).sort();
    const rightKeys = Object.keys(right).sort();
    return (
      valuesEqual(leftKeys, rightKeys) &&
      leftKeys.every((key) => valuesEqual(left[key], right[key]))
    );
  }
  return false;
}

function validEvaluatedBody(value: unknown): value is BrepEvaluatedBody {
  if (!isRecord(value)) return false;
  const body = value as unknown as BrepEvaluatedBody;
  if (
    typeof body.id !== 'string' ||
    !finiteVector(body.bounds?.min) ||
    !finiteVector(body.bounds?.max)
  )
    return false;
  const mesh = body.viewerMesh;
  return (
    !mesh ||
    (mesh.bodyId === body.id &&
      Array.isArray(mesh.positions) &&
      Array.isArray(mesh.normals) &&
      Array.isArray(mesh.indices) &&
      mesh.positions.length / 3 <= BREP_EVALUATION_MAX_VIEWER_VERTICES &&
      mesh.normals.length === mesh.positions.length &&
      mesh.indices.length / 3 <= BREP_EVALUATION_MAX_VIEWER_TRIANGLES &&
      mesh.positions.every(Number.isFinite) &&
      mesh.normals.every(Number.isFinite) &&
      mesh.indices.every(
        (index) =>
          Number.isInteger(index) &&
          index >= 0 &&
          index < mesh.positions.length / 3,
      ))
  );
}

function validProjectObjectResult(
  value: unknown,
  request: NormalizedBrepEvaluationRequest,
): boolean {
  if (!isRecord(value)) return false;
  const allowedKeys = new Set(['placement', 'metadata', 'geometry', 'points']);
  if (Object.keys(value).some((key) => !allowedKeys.has(key))) return false;

  const expected = resolveBrepProjectObjectSemantics(
    request.project,
    request.parameterValues,
  );
  if (!valuesEqual(value.placement, expected.placement)) return false;
  if (!valuesEqual(value.metadata, expected.metadata)) return false;
  if (!valuesEqual(value.points, expected.points)) return false;
  if (!isRecord(value.geometry)) return false;

  const allowedGeometryKeys = new Set([
    'footprint',
    'clearanceEnvelope',
    'maintenanceEnvelope',
  ]);
  if (
    Object.keys(value.geometry).some((key) => !allowedGeometryKeys.has(key))
  )
    return false;

  const rolePairs = [
    ['footprint', request.project.projectObject?.footprintNodeId],
    [
      'clearanceEnvelope',
      request.project.projectObject?.clearanceEnvelopeNodeId,
    ],
    [
      'maintenanceEnvelope',
      request.project.projectObject?.maintenanceEnvelopeNodeId,
    ],
  ] as const;
  for (const [role, expectedNodeId] of rolePairs) {
    const body = value.geometry[role];
    if (!expectedNodeId) {
      if (body != null) return false;
      continue;
    }
    if (!validEvaluatedBody(body) || body.id !== expectedNodeId) return false;
  }
  return true;
}

function validSuccess(
  value: unknown,
  request: NormalizedBrepEvaluationRequest,
): value is BrepEvaluationSuccess {
  if (!isRecord(value)) return false;
  const result = value as unknown as BrepEvaluationSuccess;
  if (
    result.status !== 'success' ||
    result.projectId !== request.project.id ||
    result.resultNodeId !== request.project.resultNodeId ||
    !Array.isArray(result.bodies) ||
    result.bodies.length < 1 ||
    result.bodies.length > BREP_EVALUATION_MAX_BODY_COUNT ||
    result.bodies[0]?.id !== request.project.resultNodeId ||
    !finiteVector(result.bounds?.min) ||
    !finiteVector(result.bounds?.max) ||
    !validProjectObjectResult(result.projectObject, request)
  )
    return false;
  return result.bodies.every(validEvaluatedBody);
}

export type BrepEvaluationArtifact = {
  result: BrepEvaluationResult;
  stepBytes?: Uint8Array;
};

export async function evaluateBrepProject(
  project: BrepProject,
  parameterValues?: BrepParameterValues,
  signal?: AbortSignal,
): Promise<BrepEvaluationArtifact> {
  const request = normalizeBrepEvaluationRequest({ project, parameterValues });
  return evaluateNormalizedBrepProject(request, signal);
}

/**
 * Return the exact STEP artifact emitted by the isolated native evaluator.
 * This deliberately shares the same constrained request and Podman runner as
 * viewer evaluation; it never routes native BRep through the OpenSCAD export
 * provider.
 */
export async function exportBrepProjectToStep(
  project: BrepProject,
  parameterValues?: BrepParameterValues,
  signal?: AbortSignal,
): Promise<Uint8Array> {
  const artifact = await evaluateBrepProject(project, parameterValues, signal);
  if (
    artifact.result.status !== 'success' ||
    !artifact.result.exactExport.available ||
    !artifact.stepBytes
  )
    throw new BrepEvaluationError(
      'output_invalid',
      'BRep sandbox did not produce a valid exact STEP artifact.',
    );
  return artifact.stepBytes;
}

export async function evaluateNormalizedBrepProject(
  request: NormalizedBrepEvaluationRequest,
  signal?: AbortSignal,
): Promise<BrepEvaluationArtifact> {
  // Resolve configuration before entering the child-process error mapping so
  // missing configuration remains a stable fail-closed provider error.
  const configuredRunner = runner();
  throwIfEvaluationAborted(signal);
  const release = acquireSlot();
  let workspace: string | undefined;
  try {
    workspace = await mkdtemp(path.join(tmpdir(), 'brepia-brep-'));
    const inputPath = path.join(workspace, 'request.json');
    const outputDir = path.join(workspace, 'output');
    const resultPath = path.join(outputDir, 'result.json');
    const stepPath = path.join(outputDir, 'model.step');

    await writeFile(inputPath, JSON.stringify(request), 'utf8');
    throwIfEvaluationAborted(signal);
    try {
      await execFileAsync(
        configuredRunner,
        ['--input', inputPath, '--output', outputDir],
        {
          timeout: BREP_EVALUATION_TIMEOUT_MS,
          maxBuffer: 4 * 1024 * 1024,
          env: process.env,
          signal,
        },
      );
    } catch (error) {
      const detail =
        typeof (error as { stderr?: unknown }).stderr === 'string'
          ? (error as { stderr: string }).stderr.trim().slice(0, 1200)
          : '';
      const failure = error as {
        code?: string | number;
        killed?: boolean;
        signal?: string;
        name?: string;
      };
      if (failure.name === 'AbortError' || failure.code === 'ABORT_ERR')
        throw new BrepEvaluationError(
          'evaluation_cancelled',
          'BRep evaluation was cancelled.',
        );
      if (failure.code === 'ENOENT' || failure.code === 69)
        throw new BrepEvaluationError(
          'provider_unavailable',
          detail || 'BRep sandbox is unavailable on this server.',
        );
      if (
        failure.code === 124 ||
        failure.killed ||
        failure.signal === 'SIGTERM'
      )
        throw new BrepEvaluationError(
          'evaluation_timeout',
          'BRep evaluation exceeded the server time limit.',
        );
      throw new BrepEvaluationError(
        'evaluation_failed',
        detail
          ? `BRep evaluation failed: ${detail}`
          : 'BRep evaluation failed.',
      );
    }

    throwIfEvaluationAborted(signal);
    const stat = await lstat(resultPath).catch(() => undefined);
    if (!stat || !stat.isFile() || stat.isSymbolicLink())
      throw new BrepEvaluationError(
        'output_invalid',
        'BRep sandbox did not produce a valid result object.',
      );
    if (stat.size > BREP_EVALUATION_OUTPUT_LIMIT_BYTES)
      throw new BrepEvaluationError(
        'output_too_large',
        'BRep sandbox result exceeds the output limit.',
      );
    const parsed: unknown = JSON.parse(await readFile(resultPath, 'utf8'));
    if (!validSuccess(parsed, request))
      throw new BrepEvaluationError(
        'output_invalid',
        'BRep sandbox produced an invalid result contract.',
      );
    const stepStat = await lstat(stepPath).catch(() => undefined);
    let stepBytes: Uint8Array | undefined;
    if (
      stepStat?.isFile() &&
      !stepStat.isSymbolicLink() &&
      stepStat.size <= BREP_EVALUATION_OUTPUT_LIMIT_BYTES
    ) {
      const bytes = await readFile(stepPath);
      if (bytes.subarray(0, 128).toString('ascii').includes('ISO-10303-21'))
        stepBytes = new Uint8Array(bytes);
    }
    return { result: parsed, ...(stepBytes ? { stepBytes } : {}) };
  } finally {
    release();
    if (workspace) {
      await rm(workspace, { recursive: true, force: true }).catch(
        () => undefined,
      );
    }
  }
}
