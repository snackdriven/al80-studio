import js from '@eslint/js';
import { defineConfig } from 'eslint/config';
import globals from 'globals';

export default defineConfig([
  // The wiki is generated from al80-lcd; host output is generated locally.
  { ignores: ['wiki/**', 'host/out/**'] },
  { files: ['**/*.{js,mjs,cjs}'], extends: [js.configs.recommended] },
  { files: ['src/**/*.js'], languageOptions: { globals: globals.browser } },
  { files: ['sw.js'], languageOptions: { globals: globals.serviceworker } },
  { files: ['host/**/*.{js,mjs}', 'test/**/*.mjs', '.github/**/*.cjs', 'eslint.config.mjs'], languageOptions: { globals: globals.node } },
]);
