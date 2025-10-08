// ESLint configuration for ClaudeBox
// Uses ESLint 9+ flat config format

export default [
  {
    ignores: [
      'node_modules/**',
      'out/**',
      'dist/**',
      'build/**',
      'worktree-*/**',
      '*.config.js'
    ]
  },
  {
    files: ['src/**/*.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: {
        // Node.js globals
        process: 'readonly',
        __dirname: 'readonly',
        __filename: 'readonly',
        require: 'readonly',
        module: 'readonly',
        exports: 'writable',
        console: 'readonly',
        // Browser globals
        window: 'readonly',
        document: 'readonly',
        navigator: 'readonly',
        alert: 'readonly',
        prompt: 'readonly',
        setTimeout: 'readonly',
        setInterval: 'readonly',
        clearTimeout: 'readonly',
        clearInterval: 'readonly',
        ResizeObserver: 'readonly',
        requestAnimationFrame: 'readonly'
      }
    },
    rules: {
      // Possible errors
      'no-console': 'off', // We use console.log/warn/error for logging
      'no-unused-vars': ['warn', {
        argsIgnorePattern: '^_',
        varsIgnorePattern: '^_'
      }],
      'no-undef': 'error',

      // Best practices
      'eqeqeq': ['warn', 'always'],
      'no-var': 'warn',
      'prefer-const': 'warn',

      // Style
      'semi': ['warn', 'always'],
      'quotes': ['warn', 'single', { avoidEscape: true }],
      'indent': ['warn', 2, { SwitchCase: 1 }],
      'comma-dangle': ['warn', 'only-multiline']
    }
  },
  {
    files: ['src/main/**/*.js', 'src/preload/**/*.js'],
    languageOptions: {
      sourceType: 'commonjs'
    }
  },
  {
    files: ['src/renderer/**/*.js'],
    languageOptions: {
      sourceType: 'module'
    }
  }
];
