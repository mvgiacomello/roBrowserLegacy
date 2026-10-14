#version 300 es
precision highp float;
precision highp sampler3D;

uniform sampler2D uTexture;
uniform sampler3D uLut;
uniform float uLutSize;
uniform float uIntensity;

in vec2 vUv;
out vec4 fragColor;

void main() {
    vec3 color = texture(uTexture, vUv).rgb;

    // Sample texel centres: 0 and 1 map to the first and last texel, not to the cube's outer edge.
    vec3 coord = color * ((uLutSize - 1.0) / uLutSize) + 0.5 / uLutSize;
    vec3 graded = texture(uLut, coord).rgb;

    fragColor = vec4(mix(color, graded, uIntensity), 1.0);
}
