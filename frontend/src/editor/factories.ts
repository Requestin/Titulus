// frontend/src/editor/factories.ts
//
// Schema-valid factories for new layers / variables (matches
// shared/template.schema.json so saves pass /api/templates/validate).

import { createDefaultTransform, type Layer, type LayerType, type TextStyle, type Variable } from '@runtime';
import { createId } from '@/core/id';

export const LAYER_TYPES: LayerType[] = ['text', 'rect', 'image', 'video', 'clock', 'mask', 'crawl'];

export const LAYER_LABEL: Record<LayerType, string> = {
  text: 'Text',
  rect: 'Rectangle',
  image: 'Image',
  video: 'Video',
  clock: 'Clock',
  mask: 'Mask',
  crawl: 'Crawl',
};

export const LAYER_DEFAULT_DIMENSIONS: Record<LayerType, Pick<Layer['transform'], 'width' | 'height'>> = {
  text: { width: 760, height: 96 },
  rect: { width: 480, height: 140 },
  image: { width: 480, height: 270 },
  video: { width: 480, height: 270 },
  clock: { width: 300, height: 96 },
  mask: { width: 480, height: 320 },
  crawl: { width: 760, height: 96 },
};

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
        transform: { ...createDefaultTransform(0, 0), ...LAYER_DEFAULT_DIMENSIONS.text },
        content: 'New text',
        style: defaultTextStyle(),
      };
    case 'rect':
      return {
        ...base, type: 'rect',
        transform: { ...createDefaultTransform(0, 0), ...LAYER_DEFAULT_DIMENSIONS.rect },
        fill: '#1f2937',
        cornerRadius: 8,
        borderColor: '#000000',
        borderWidth: 0,
      };
    case 'image':
      return {
        ...base, type: 'image',
        transform: { ...createDefaultTransform(0, 0), ...LAYER_DEFAULT_DIMENSIONS.image },
        src: '',
        cornerRadius: 0,
        fit: 'cover',
      };
    case 'video':
      return {
        ...base, type: 'video',
        transform: { ...createDefaultTransform(0, 0), ...LAYER_DEFAULT_DIMENSIONS.video },
        src: '',
        loop: true,
        fit: 'cover',
      };
    case 'clock':
      return {
        ...base, type: 'clock',
        transform: { ...createDefaultTransform(0, 0), ...LAYER_DEFAULT_DIMENSIONS.clock },
        mode: 'clock',
        format: 'HH:mm:ss',
        style: { ...defaultTextStyle(), align: 'center' },
      };
    case 'mask':
      return {
        ...base, type: 'mask',
        transform: { ...createDefaultTransform(0, 0), ...LAYER_DEFAULT_DIMENSIONS.mask },
        maskMode: 'normal',
        shape: 'rect',
        fill: '#000000',
        cornerRadius: 0,
        borderColor: '#000000',
        borderWidth: 0,
      };
    case 'crawl':
      return {
        ...base, type: 'crawl',
        transform: { ...createDefaultTransform(0, 0), ...LAYER_DEFAULT_DIMENSIONS.crawl },
        content: 'New crawl',
        style: defaultTextStyle(),
        crawlDirectorId: uuid(),
        crawl: {
          type: 'ticker',
          directionIn: 'right',
          directionOut: 'left',
          speed: 5,
          pause: 0,
          separatorMode: 'none',
          separatorText: '',
          separatorImage: '',
          animationType: 'batch',
          useFile: false,
          filePath: '',
          maxTextLengthEnabled: false,
          maxTextLength: 80,
        },
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
