// frontend/src/editor/rectGradientTimeline.ts
// Prune rectangle corner-weight tracks when leaving gradient fill mode.

import {
  timelineTrackKey,
  type AnimatableProp,
  type Template,
  RECT_GRADIENT_PROPS,
} from '@runtime';

/** Drop gradient keyframe bags + track directors when leaving gradient mode. */
export function removeRectGradientTracks(template: Template, layerId: string): void {
  for (const prop of RECT_GRADIENT_PROPS) {
    const key = timelineTrackKey({ kind: 'layer', id: layerId }, prop as AnimatableProp);
    delete template.timeline.trackDirectors[key];
    if (template.timeline.trackOrder) {
      for (const [did, order] of Object.entries(template.timeline.trackOrder)) {
        template.timeline.trackOrder[did] = order.filter((k) => k !== key);
      }
    }
  }
  for (const kf of template.timeline.keyframes) {
    const bag = kf.layers[layerId];
    if (!bag) continue;
    for (const prop of RECT_GRADIENT_PROPS) delete bag[prop];
    if (Object.keys(bag).length === 0) delete kf.layers[layerId];
  }
  template.timeline.keyframes = template.timeline.keyframes.filter(
    (k) => Object.keys(k.layers).length > 0 || Object.keys(k.groups).length > 0,
  );
}
