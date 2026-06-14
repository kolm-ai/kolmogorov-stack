import React from 'react';
import {Composition} from 'remotion';
import {registerRoot} from 'remotion';
import {Test} from './Test.jsx';
import {Pipeline, PIPELINE_DURATION, FPS, WIDTH, HEIGHT} from './Pipeline.jsx';

export const Root = () => {
  return (
    <>
      <Composition
        id="test"
        component={Test}
        durationInFrames={60}
        fps={30}
        width={1280}
        height={720}
      />
      <Composition
        id="Pipeline"
        component={Pipeline}
        durationInFrames={PIPELINE_DURATION}
        fps={FPS}
        width={WIDTH}
        height={HEIGHT}
      />
    </>
  );
};

registerRoot(Root);
