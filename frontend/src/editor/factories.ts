// frontend/src/editor/factories.ts
//
// Schema-valid factories for new layers / variables (matches
// shared/template.schema.json so saves pass /api/templates/validate).

import { createDefaultTransform, type Layer, type LayerType, type TextStyle, type Transform, type Variable } from '@runtime';
import { createId } from '@/core/id';

export const LAYER_TYPES: LayerType[] = ['text', 'rect', 'image', 'video', 'clock', 'mask'];

export const LAYER_LABEL: Record<LayerType, string> = {
  text: 'Text',
  rect: 'Rectangle',
  image: 'Image',
  video: 'Video',
  clock: 'Clock',
  mask: 'Mask',
};

/** Editor default: origin at top-left pivot (anchor 0,0), position 0,0. */
export function createEditorTransform(width: number, height: number): Transform {
  return {
    ...createDefaultTransform(0, 0),
    width,
    height,
    anchorX: 0,
    anchorY: 0,
  };
}

function uuid(): string {
  return createId();
}

export function defaultTextStyle(): TextStyle {
  return {
    fontFamily: 'Inter',
    fontSize: 48,
    fontWeight: '600',
    fill: '#ffffff',
    align: 'left',
    lineHeight: 1.1,
    letterSpacing: 0,
    strokeColor: '#000000',
    strokeWidth: 0,
    dropShadow: false,
    dropShadowBlur: 6,
    dropShadowColor: '#000000',
    dropShadowDistance: 2,
  };
}

export function createLayer(type: LayerType, name: string): Layer {
  const base = {
    id: uuid(),
    name,
    visible: true,
    locked: false,
    opacity: 1,
    blendMode: 'normal' as const,
    groupId: null,
  };
  switch (type) {
    case 'text':
      return {
        ...base, type: 'text',
        transform: createEditorTransform(760, 96),
        content: 'New text',
        style: defaultTextStyle(),
      };
    case 'rect':
      return {
        ...base, type: 'rect',
        transform: createEditorTransform(480, 140),
        fill: '#1f2937',
        cornerRadius: 8,
        borderColor: '#000000',
        borderWidth: 0,
      };
    case 'image':
      return {
        ...base, type: 'image',
        transform: createEditorTransform(480, 270),
        src: '',
        cornerRadius: 0,
        fit: 'cover',
      };
    case 'video':
      return {
        ...base, type: 'video',
        transform: createEditorTransform(480, 270),
        src: '',
        loop: true,
        fit: 'cover',
      };
    case 'clock':
      return {
        ...base, type: 'clock',
        transform: createEditorTransform(300, 96),
        mode: 'clock',
        format: 'HH:mm:ss',
        style: { ...defaultTextStyle(), align: 'center' },
      };
    case 'mask':
      return {
        ...base, type: 'mask',
        transform: createEditorTransform(480, 320),
        maskMode: 'normal',
        shape: 'rect',
        fill: '#000000',
        cornerRadius: 0,
        borderColor: '#000000',
        borderWidth: 0,
      };
  }
}

export function createVariable(name: string): Variable {
  return {
    id: uuid(),
    name,
    label: name,
    type: 'text',
    defaultValue: '',
  };
}
