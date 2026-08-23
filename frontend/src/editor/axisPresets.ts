import { anchorCompensatedUpdate, type Transform } from '@runtime';

export type AxisPreset = 0 | 0.5 | 1;
export type CanvasFitMode = 'screen' | 'width' | 'height';

export function axisPresetX(
  transform: Transform,
  preset: AxisPreset,
): Partial<Transform> {
  return anchorCompensatedUpdate(transform, { anchorX: preset });
}

export function axisPresetY(
  transform: Transform,
  preset: AxisPreset,
): Partial<Transform> {
  return anchorCompensatedUpdate(transform, { anchorY: preset });
}

export function canvasFitSize(
  canvas: { width: number; height: number },
  mode: CanvasFitMode,
  current: Pick<Transform, 'width' | 'height'>,
): Pick<Transform, 'width' | 'height'> {
  if (mode === 'screen') {
    return { width: canvas.width, height: canvas.height };
  }
  if (mode === 'width') {
    const scale = current.width === 0 ? 1 : canvas.width / current.width;
    return { width: canvas.width, height: current.height * scale };
  }
  const scale = current.height === 0 ? 1 : canvas.height / current.height;
  return { width: current.width * scale, height: canvas.height };
}

export function lockedScale(
  current: Pick<Transform, 'scaleX' | 'scaleY'>,
  next: Partial<Pick<Transform, 'scaleX' | 'scaleY'>>,
): Partial<Pick<Transform, 'scaleX' | 'scaleY'>> {
  if (next.scaleX !== undefined) {
    const ratio = current.scaleX === 0 ? 1 : next.scaleX / current.scaleX;
    return { scaleX: next.scaleX, scaleY: current.scaleY * ratio };
  }
  if (next.scaleY !== undefined) {
    const ratio = current.scaleY === 0 ? 1 : next.scaleY / current.scaleY;
    return { scaleY: next.scaleY, scaleX: current.scaleX * ratio };
  }
  return {};
}

export function has25dCost(transform: Transform): boolean {
  return (transform.z ?? 0) !== 0
    || transform.rotationX !== 0
    || transform.rotationY !== 0;
}
