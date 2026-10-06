import preset from '../../packages/app-core/build/tailwind-preset.cjs'
export default { ...preset, content: ['./src/**/*.{ts,tsx}', '../../packages/app-core/src/**/*.{ts,tsx}'] }
