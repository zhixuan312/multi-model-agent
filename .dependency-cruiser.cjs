module.exports = {
  forbidden: [
    {
      name: 'no-substrate-to-unified',
      severity: 'error',
      from: { path: '^packages/core/src/(transport|config|identity|stores|providers|bounded-execution|events)/' },
      to:   { path: '^packages/core/src/unified/' },
    },
    {
      name: 'no-circular',
      severity: 'error',
      from: {},
      to: { circular: true },
    },
  ],
  options: {
    doNotFollow: {
      path: 'node_modules',
      dependencyTypes: ['npm'],
    },
    includeOnly: '^packages/(core|server)/src/',
  },
};
