import React from 'react';
import {AbsoluteFill, useCurrentFrame, interpolate} from 'remotion';

export const Test = () => {
  const frame = useCurrentFrame();
  const opacity = interpolate(frame, [0, 20], [0, 1], {extrapolateRight: 'clamp'});
  return (
    <AbsoluteFill style={{backgroundColor: '#08090A', justifyContent: 'center', alignItems: 'center'}}>
      <div style={{color: '#3FE5A0', fontSize: 120, fontFamily: 'monospace', opacity, letterSpacing: 4}}>
        kolm
      </div>
    </AbsoluteFill>
  );
};
