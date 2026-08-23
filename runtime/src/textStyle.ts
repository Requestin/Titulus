import type { TextStyle, TextTransformMode } from './schema.js';

export function applyTextTransform(text: string, mode?: TextTransformMode): string {
  if (!mode || mode === 'none') return text;
  if (mode === 'uppercase') return text.toLocaleUpperCase();
  if (mode === 'lowercase') return text.toLocaleLowerCase();
  return text.replace(/(\p{L})(\p{L}*)/gu, (_, first: string, rest: string) => (
    first.toLocaleUpperCase() + rest.toLocaleLowerCase()
  ));
}

export function textShadowCss(style: Pick<
  TextStyle,
  'dropShadow' | 'dropShadowBlur' | 'dropShadowColor' | 'dropShadowDistance' | 'dropShadowOffsetX' | 'dropShadowOffsetY'
>): string {
  if (!style.dropShadow) return '';
  const x = style.dropShadowOffsetX ?? 0;
  const y = style.dropShadowOffsetY ?? style.dropShadowDistance ?? 0;
  return `${x}px ${y}px ${style.dropShadowBlur}px ${style.dropShadowColor}`;
}
