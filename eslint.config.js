export default [
  {
    files: ['src/**/*.js', 'tests/**/*.js', 'examples/**/*.js'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module'
    },
    rules: {
      'constructor-super': 'error',
      'no-dupe-args': 'error',
      'no-dupe-keys': 'error',
      'no-unreachable': 'error',
      'no-unsafe-finally': 'error',
      'valid-typeof': 'error'
    }
  }
];
