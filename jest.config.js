const base = {
  preset: 'ts-jest/presets/default-esm',
  testEnvironment: 'node',
  extensionsToTreatAsEsm: ['.ts'],
  moduleNameMapper: { '^(\\.{1,2}/.*)\\.js$': '$1' },
  transform: { '^.+\\.ts$': ['ts-jest', { useESM: true, tsconfig: 'tsconfig.test.json' }] },
};

export default {
  projects: [
    { ...base, displayName: 'unit', testMatch: ['<rootDir>/tests/unit/**/*.test.ts'] },
    {
      ...base,
      displayName: 'integration',
      testMatch: ['<rootDir>/tests/integration/**/*.test.ts'],
      setupFilesAfterEnv: ['<rootDir>/tests/setup/timeout.ts'],
    },
    {
      ...base,
      displayName: 'acceptance',
      testMatch: ['<rootDir>/tests/acceptance/**/*.test.ts'],
      setupFilesAfterEnv: ['<rootDir>/tests/setup/timeout.ts'],
    },
  ],
};
