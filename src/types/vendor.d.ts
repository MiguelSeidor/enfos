/** Ambient declarations for dependencies that ship no TypeScript types. */

declare module 'n8ao' {
  import type { Camera, Color, Scene, WebGLRenderer, WebGLRenderTarget } from 'three';
  import { Pass } from 'postprocessing';

  export interface N8AOConfiguration {
    aoRadius: number;
    distanceFalloff: number;
    intensity: number;
    color: Color;
    aoSamples: number;
    denoiseSamples: number;
    denoiseRadius: number;
    halfRes: boolean;
    screenSpaceRadius: boolean;
    renderMode: number;
    gammaCorrection: boolean;
    transparencyAware: boolean;
  }

  export class N8AOPostPass extends Pass {
    constructor(scene: Scene, camera: Camera, width: number, height: number);
    configuration: N8AOConfiguration;
    enabled: boolean;
    setQualityMode(mode: 'Performance' | 'Low' | 'Medium' | 'High' | 'Ultra'): void;
    setSize(width: number, height: number): void;
    setDisplayMode(mode: string): void;
    render(
      renderer: WebGLRenderer,
      inputBuffer: WebGLRenderTarget,
      outputBuffer: WebGLRenderTarget,
      deltaTime?: number,
      stencilTest?: boolean,
    ): void;
  }

  export class N8AOPass extends N8AOPostPass {}
}
