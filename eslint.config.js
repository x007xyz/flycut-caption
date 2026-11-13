import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import tseslint from 'typescript-eslint'
import { globalIgnores } from 'eslint/config'

export default tseslint.config([
  globalIgnores(['dist', 'dist-host', 'dist-cli', 'experiments', '.venv*', 'core', 'server/lib', 'src-tauri/host', 'src-tauri/target', 'src-tauri/sidecars/funasr-asr/target']),
  {
    files: ['**/*.{ts,tsx}'],
    extends: [
      js.configs.recommended,
      tseslint.configs.recommended,
      reactHooks.configs['recommended-latest'],
      reactRefresh.configs.vite,
    ],
    languageOptions: {
      ecmaVersion: 2020,
      globals: globals.browser,
    },
  },
  { files: ['tests/architecture/**/*.ts'], rules: { '@typescript-eslint/no-explicit-any': 'off' } },
])
