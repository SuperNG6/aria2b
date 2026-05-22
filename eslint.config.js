'use strict'
const globals = require('globals')

const commonRules = {
    'no-var': 'error',
    'prefer-const': ['error', { destructuring: 'all' }],
    'no-unused-vars': ['error', {
        args: 'none',
        caughtErrors: 'none',
        varsIgnorePattern: '^_'
    }],
    'no-undef': 'error',
    eqeqeq: ['error', 'always', { null: 'ignore' }],
    'no-empty': ['error', { allowEmptyCatch: true }],
    'no-constant-condition': ['error', { checkLoops: false }]
}

module.exports = [
    {
        ignores: ['node_modules/**', 'dist/**']
    },
    {
        files: ['app.js'],
        languageOptions: {
            ecmaVersion: 2024,
            sourceType: 'commonjs',
            globals: { ...globals.node }
        },
        rules: commonRules
    },
    {
        files: ['test/**/*.js', 'eslint.config.js'],
        languageOptions: {
            ecmaVersion: 2024,
            sourceType: 'commonjs',
            globals: { ...globals.node }
        },
        rules: {
            ...commonRules,
            // 测试文件里有意写 unused 解构很正常
            'no-unused-vars': ['warn', {
                args: 'none',
                caughtErrors: 'none',
                varsIgnorePattern: '^_'
            }]
        }
    }
]
